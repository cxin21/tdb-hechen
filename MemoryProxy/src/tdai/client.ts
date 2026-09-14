import type {
  TdaiAgentCtx,
  TdaiIdentity,
  TdaiL1Memory,
  TdaiL2Entry,
  TdaiL2File,
  TdaiL3Core,
  TdaiMemoryConfig,
  TdaiMessage,
} from "./types.js";
import { log } from "../report/log.js";

interface TdaiEnvelope<T = unknown> {
  code?: number;
  message?: string;
  data?: T;
}

const TDAI_MESSAGE_CONTENT_MAX_CHARS = 8192;
const TDAI_CONVERSATION_MAX_MESSAGES = 100;

/**
 * Split messages to fit the gateway schema without losing content or breaking
 * UTF-16 surrogate pairs. The gateway validates string.length, so this limit
 * intentionally uses JavaScript code units rather than UTF-8 bytes.
 */
function chunkConversationMessages(messages: TdaiMessage[]): TdaiMessage[] {
  return messages.flatMap((message) => {
    if (message.content.length <= TDAI_MESSAGE_CONTENT_MAX_CHARS) return [message];

    const chunks: TdaiMessage[] = [];
    let start = 0;
    while (start < message.content.length) {
      let end = Math.min(start + TDAI_MESSAGE_CONTENT_MAX_CHARS, message.content.length);
      if (
        end < message.content.length
        && isHighSurrogate(message.content.charCodeAt(end - 1))
        && isLowSurrogate(message.content.charCodeAt(end))
      ) {
        end -= 1;
      }
      chunks.push({ role: message.role, content: message.content.slice(start, end) });
      start = end;
    }
    return chunks;
  });
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xD800 && code <= 0xDBFF;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xDC00 && code <= 0xDFFF;
}

// ── ACL types ─────────────────────────────────────────────────────────────
export type AclAction = "read" | "write" | "delete" | "grant";

export interface AclCheckParams {
  /**
   * 请求发起者的 user_key（原始 `sk-mem-...`）。
   *
   * tdai `/v3/meta/*` 路由要求 `x-tdai-user-key` header 才能通过 Layer 3
   * 用户鉴权（否则 401 missing_user_key）。这里传入的 user_key 会：
   *   1. 作为 `x-tdai-user-key` header 走鉴权（"你是谁"）
   *   2. tdai 服务端会用它解析出 user_id，用于 checkAssetPermission 判定
   *
   * 因此 body 里**不再需要** user_id —— tdai 从 header 自解析。
   */
  user_key: string;
  /** 目标资产 id，如 `chat_memory-{team}-{agent}`。 */
  asset_id: string;
  action: AclAction;
  /** 可选：显式限定检查作用于哪个 agent。 */
  agent_id?: string;
}

export interface AclCheckResult {
  allowed: boolean;
  reason?: string;
}

export class TdaiClient {
  constructor(private config: TdaiMemoryConfig) {}

  /** 本 client 的租户路由 service id（请求时作 `x-tdai-service-id`）。暴露给缓存按 service 维度分桶。 */
  get serviceId(): string {
    return this.config.serviceId;
  }

  /**
   * Bearer token 解析（P2-T13 鉴权必填配套）：
   *   1. config.apiKey（yaml `tdai.apiKey`）优先
   *   2. env `TDAI_GATEWAY_APIKEY` 兜底 —— 网关翻转"apiKey 缺失即生成临时密钥"后，
   *      跨进程调用方必须在 env/yaml 配置同一把 key，否则一律 401。
   *      env 透传让部署侧不必把密钥写进 yaml（对齐 core `TDAI_GATEWAY_API_KEY` 的运维习惯）。
   *   3. 都没有 → 历史 fallback "local-proxy"（本机无鉴权网关场景，行为不变）。
   */
  private bearerToken(): string {
    const envKey = (process.env.TDAI_GATEWAY_APIKEY ?? "").trim();
    return this.config.apiKey?.trim() || envKey || "local-proxy";
  }

  /**
   * /v3 严格 isolation 门禁头（P2-T13 拍板③：V3_STRICT_ISOLATION 默认 OFF→ON）。
   *
   * P2-T12（K-B4 请求侧）：core_memory/core_values 在 MemoryCore 侧已租户化，
   * 聚合读不再 hardcode default 三元组 —— 改传当前会话 identity（调用方显式传入，
   * 不在 client 内 fallback 到 default：default 桶读不到其它租户的行，静默空结果
   * 比显式 422 更难排查）。identity 三元组由 deriveTdaiIdentity 保证非空。
   */
  private isoGateHeaders(identity: TdaiIdentity): Record<string, string> {
    return {
      "x-tdai-team-id": identity.teamId || "default",
      "x-tdai-user-id": identity.userId || "default",
      "x-tdai-agent-id": identity.agentId || "default",
    };
  }

  isEnabled(): boolean {
    return this.config.enabled && !!this.config.endpoint;
  }

  async addConversation(identity: TdaiIdentity, messages: TdaiMessage[]): Promise<void> {
    if (!this.isEnabled() || !this.config.writeL0 || messages.length === 0) return;

    const chunkedMessages = chunkConversationMessages(messages);

    // [PROBE] addConversation reached — DEBUG ONLY
    if (identity.agentId === "agt-2t81sh9zdz" || identity.sessionId?.includes("f74dc5ac")) {
      log.info("dsh-l0-addconversation", {
        team: identity.teamId, agent: identity.agentId, user: identity.userId,
        session: identity.sessionId, task: identity.taskId,
        msgs: messages.length, chunks: chunkedMessages.length,
        writeL0: this.config.writeL0, enabled: this.config.enabled,
      });
    }

    log.info("tdai-recorder:write-l0", {
      team: identity.teamId,
      agent: identity.agentId,
      user: identity.userId,
      session: identity.sessionId,
      task: identity.taskId,
      msgs: messages.length,
      chunks: chunkedMessages.length,
      userLen: (messages[0]?.content ?? "").length,
    });

    for (let offset = 0; offset < chunkedMessages.length; offset += TDAI_CONVERSATION_MAX_MESSAGES) {
      const batch = chunkedMessages.slice(offset, offset + TDAI_CONVERSATION_MAX_MESSAGES);
      await this.postForCtx(
        "/v3/conversation/add",
        { teamId: identity.teamId, userId: identity.userId, agentId: identity.agentId },
        {
          team_id: identity.teamId,
          user_id: identity.userId,
          agent_id: identity.agentId,
          session_id: identity.sessionId,
          task_id: identity.taskId,
          messages: batch,
        },
        identity.sessionId,
        identity.taskId,
        { includeSession: true, includeTask: true },
      );
    }
  }

  async searchL1(identity: TdaiIdentity, query: string): Promise<TdaiL1Memory[]> {
    return this.searchL1ForCtx(
      { teamId: identity.teamId, userId: identity.userId, agentId: identity.agentId },
      query,
      identity.sessionId,
      identity.taskId,
    );
  }

  /**
   * Multi-agent variant: search L1 against a specific (team, user, agent)
   * triplet, while keeping the caller's session/task on the wire.
   *   - 用于"自有 + 借入"召回中的某一个 agent
   *   - 不带 query 直接返空（与原行为一致）
   */
  async searchL1ForCtx(
    ctx: TdaiAgentCtx,
    query: string,
    sessionId: string,
    taskId?: string,
    limit?: number,
  ): Promise<TdaiL1Memory[]> {
    if (!this.isEnabled() || !this.config.recallL1 || !query.trim()) return [];
    const data = await this.postForCtx<{ items?: Array<Record<string, unknown>> }>(
      "/v3/atomic/search",
      ctx,
      {
        team_id: ctx.teamId,
        user_id: ctx.userId,
        agent_id: ctx.agentId,
        session_id: sessionId,
        task_id: taskId,
        query: query.slice(0, 2048),
        limit: limit ?? this.config.l1Limit,
      },
      sessionId,
      taskId,
      { includeSession: true, includeTask: true },
    );
    return (data.items ?? [])
      .map((item) => ({
        id: String(item.id ?? ""),
        type: typeof item.type === "string" ? item.type : undefined,
        content: typeof item.content === "string" ? item.content : "",
        score: typeof item.score === "number" ? item.score : undefined,
        updatedAt: typeof item.updated_at === "string" ? item.updated_at : undefined,
        // 灵魂记忆 8 字段透传（P4-T21 D1）：网关 /v3/atomic/search 已透传，这里不再丢弃。
        occurredAt: typeof item.occurred_at === "string" ? item.occurred_at : undefined,
        validStart: typeof item.valid_start === "string" ? item.valid_start : undefined,
        validEnd: typeof item.valid_end === "string" ? item.valid_end : undefined,
        certainty: typeof item.certainty === "string" ? item.certainty : undefined,
        source: typeof item.source === "string" ? item.source : undefined,
        valence: typeof item.valence === "number" ? item.valence : undefined,
        arousal: typeof item.arousal === "number" ? item.arousal : undefined,
        significance: typeof item.significance === "number" ? item.significance : undefined,
      }))
      .filter((m) => m.id && m.content);
  }

  /**
   * DS-RECALL-MERGE-001（合并召回 · 代理瘦传输）：调核心单点 `/v3/recall`，拿
   * MemoryCore 组装好的最终注入块（与 auto-recall 钩子同一条 performLayeredRecall
   * 组装路径——分层/预算/幂等结论层全在核心），代理零渲染直接前插。
   *
   * 返回契约（调用方 TdaiL1RecallInjector 依赖）：
   *   - `{ block, meta }`：成功（block 为空串 = 核心本轮无命中——零注入语义，非失败）；
   *   - `null`：recallL1 关闭 / client 未启用（调用方零注入，**不降级**——recallL1
   *     开关语义不变：控制合并后的唯一代理注入链）；
   *   - 抛错：端点不可用（404/5xx/超时/网络/envelope code≠0）——调用方必须降级旧路
   *     （/v3/atomic/search 自行组装）+ loud 日志（防静默降级老纪律）。
   *
   * 与 postForCtx 的"网络/HTTP/envelope 错都吞掉返回空"语义**相反**（同 checkAcl 的
   * fail-loud 家族）——因此不复用 postForCtx，独立实现；但复用同一份 config
   * （endpoint / apiKey / serviceId / timeoutMs）与同一套隔离头族
   * （x-tdai-{team,user,agent,session,task}-id，会话标识沿 v3 隔离头族先例形态）。
   */
  async recallBlockForCtx(
    ctx: TdaiAgentCtx,
    query: string,
    sessionId: string,
    taskId?: string,
    maxResults?: number,
  ): Promise<{
    block: string;
    meta: { conclusionCount: number; experienceCount: number; sessionReused: boolean; layered: boolean };
  } | null> {
    if (!this.isEnabled() || !this.config.recallL1 || !query.trim()) return null;
    const base = this.config.endpoint.replace(/\/$/, "");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.bearerToken()}`,
        "x-tdai-service-id": this.config.serviceId || "default",
        "x-tdai-team-id": ctx.teamId,
        "x-tdai-user-id": ctx.userId,
        "x-tdai-agent-id": ctx.agentId,
      };
      if (sessionId) headers["x-tdai-session-id"] = sessionId;
      if (taskId) headers["x-tdai-task-id"] = taskId;
      const res = await fetch(`${base}/v3/recall`, {
        method: "POST",
        signal: controller.signal,
        headers,
        body: JSON.stringify(stripUndefined({
          query: query.slice(0, 2048),
          ...(maxResults !== undefined ? { maxResults } : {}),
        })),
      });
      if (!res.ok) {
        throw new Error(`/v3/recall http ${res.status}`);
      }
      const envelope = await res.json() as TdaiEnvelope<{
        block?: string;
        meta?: { conclusionCount?: unknown; experienceCount?: unknown; sessionReused?: unknown; layered?: unknown };
      }>;
      if (typeof envelope.code === "number" && envelope.code !== 0) {
        throw new Error(`/v3/recall envelope code=${envelope.code}: ${envelope.message ?? ""}`);
      }
      const data = envelope.data ?? {};
      const m = (data.meta ?? {}) as Record<string, unknown>;
      return {
        block: typeof data.block === "string" ? data.block : "",
        meta: {
          conclusionCount: typeof m.conclusionCount === "number" ? m.conclusionCount : 0,
          experienceCount: typeof m.experienceCount === "number" ? m.experienceCount : 0,
          sessionReused: m.sessionReused === true,
          layered: m.layered === true,
        },
      };
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`/v3/recall timeout after ${this.config.timeoutMs}ms`);
      }
      throw err instanceof Error ? err : new Error(String(err));
    } finally {
      clearTimeout(timer);
    }
  }

  async listL2(identity: TdaiIdentity): Promise<TdaiL2Entry[]> {
    return this.listL2ForCtx({
      teamId: identity.teamId,
      userId: identity.userId,
      agentId: identity.agentId,
    });
  }

  async listL2ForCtx(ctx: TdaiAgentCtx): Promise<TdaiL2Entry[]> {
    if (!this.isEnabled() || !this.config.injectL2L3) return [];
    const data = await this.postForCtx<{ entries?: Array<Record<string, unknown>> }>(
      "/v3/scenario/ls",
      ctx,
      {
        team_id: ctx.teamId,
        agent_id: ctx.agentId,
        path_prefix: "",
      },
      "",
      undefined,
      { includeSession: false, includeTask: false },
    );
    return (data.entries ?? [])
      .map((entry) => ({
        path: String(entry.path ?? ""),
        summary: typeof entry.summary === "string" ? entry.summary : undefined,
        updatedAt: typeof entry.updated_at === "string" ? entry.updated_at : undefined,
      }))
      .filter((entry) => entry.path && !entry.path.endsWith("/"))
      .slice(0, this.config.l2Limit);
  }

  async readL2(identity: TdaiIdentity, path: string): Promise<TdaiL2File | null> {
    return this.readL2ForCtx(
      { teamId: identity.teamId, userId: identity.userId, agentId: identity.agentId },
      path,
    );
  }

  async readL2ForCtx(ctx: TdaiAgentCtx, path: string): Promise<TdaiL2File | null> {
    if (!this.isEnabled() || !this.config.injectL2L3 || !path) return null;
    const data = await this.postForCtx<Record<string, unknown> | null>(
      "/v3/scenario/read",
      ctx,
      {
        team_id: ctx.teamId,
        agent_id: ctx.agentId,
        path,
      },
      "",
      undefined,
      { includeSession: false, includeTask: false },
    );
    const content = typeof data?.content === "string" ? data.content : "";
    if (!content) return null;
    return {
      path,
      content,
      updatedAt: typeof data?.updated_at === "string" ? data.updated_at : undefined,
    };
  }

  async readL3(identity: TdaiIdentity): Promise<TdaiL3Core | null> {
    return this.readL3ForCtx({
      teamId: identity.teamId,
      userId: identity.userId,
      agentId: identity.agentId,
    });
  }

  async readL3ForCtx(ctx: TdaiAgentCtx): Promise<TdaiL3Core | null> {
    if (!this.isEnabled() || !this.config.injectL2L3) return null;
    const data = await this.postForCtx<Record<string, unknown> | null>(
      "/v3/core/read",
      ctx,
      {
        team_id: ctx.teamId,
        agent_id: ctx.agentId,
      },
      "",
      undefined,
      { includeSession: false, includeTask: false },
    );
    const content = typeof data?.content === "string" ? data.content : "";
    if (!content) return null;
    return { content, updatedAt: typeof data?.updated_at === "string" ? data.updated_at : undefined };
  }

  /**
   * 价值锚（B1 单一源）：从 MemoryCore 拉 core_values（/v3/core-memory/read 返回 {slots, values}）。
   * P2-T12（K1）：按租户读 —— identity 三元组透传成 isolation 头。失败/空 → []（调用方 fallback config.yaml）。
   * C2：透传 valence（动机方向；缺省/非数字 → null=未判定，渲染侧不出方向行）。
   */
  async listCoreValues(identity: TdaiIdentity): Promise<Array<{ value_id: string; label: string; weight: number; created_by: string; valence?: number | null }>> {
    if (!this.isEnabled()) return [];
    const base = this.config.endpoint.replace(/\/$/, "");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const resp = await fetch(`${base}/v3/core-memory/read`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.bearerToken()}`,
          "x-tdai-service-id": this.config.serviceId || "default",
          ...this.isoGateHeaders(identity),
        },
        body: "{}",
        signal: controller.signal,
      });
      if (!resp.ok) return [];
      const env = (await resp.json()) as { data?: { values?: Array<{ value_id?: string; label?: string; weight?: number; created_by?: string; valence?: number | null }> } };
      return (env.data?.values ?? [])
        .filter((v) => typeof v.value_id === "string" && v.value_id && typeof v.label === "string" && v.label)
        .map((v) => ({ value_id: v.value_id as string, label: v.label as string, weight: typeof v.weight === "number" ? v.weight : 0, created_by: v.created_by ?? "core", valence: typeof v.valence === "number" ? v.valence : null }));
    } catch (err) {
      log.warn("[tdai-client] listCoreValues failed: " + (err instanceof Error ? err.message : String(err)));
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * K 核心记忆稳定块（设计 §3 / spec §6）：拉 /v3/core-memory/read 的 slots
   * （identity / core_value / strict_rule），供 session_init 稳定区注入（cache 友好）。
   * P2-T12（K1）：按租户读 —— identity 三元组透传成 isolation 头。失败/空 → []（宁缺毋滥，不注入空块）。
   */
  async listCoreMemories(identity: TdaiIdentity): Promise<Array<{ slot: string; content: string; source: string; version: number; updated_at: string }>> {
    if (!this.isEnabled()) return [];
    const base = this.config.endpoint.replace(/\/$/, "");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const resp = await fetch(`${base}/v3/core-memory/read`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.bearerToken()}`,
          "x-tdai-service-id": this.config.serviceId || "default",
          ...this.isoGateHeaders(identity),
        },
        body: "{}",
        signal: controller.signal,
      });
      if (!resp.ok) return [];
      const env = (await resp.json()) as { data?: { slots?: Array<{ slot?: string; content?: string; source?: string; version?: number; updated_at?: string }> } };
      return (env.data?.slots ?? [])
        .filter((s) => typeof s.slot === "string" && s.slot && typeof s.content === "string" && s.content.trim())
        .map((s) => ({ slot: s.slot as string, content: s.content as string, source: s.source ?? "core", version: s.version ?? 0, updated_at: s.updated_at ?? "" }));
    } catch (err) {
      log.warn("[tdai-client] listCoreMemories failed: " + (err instanceof Error ? err.message : String(err)));
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  private async postForCtx<T>(
    path: string,
    ctx: TdaiAgentCtx,
    body: Record<string, unknown>,
    sessionId: string,
    taskId: string | undefined,
    options: { includeSession: boolean; includeTask: boolean } = { includeSession: true, includeTask: true },
  ): Promise<T> {
    const base = this.config.endpoint.replace(/\/$/, "");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.bearerToken()}`,
        "x-tdai-service-id": this.config.serviceId || "default",
        "x-tdai-team-id": ctx.teamId,
        "x-tdai-user-id": ctx.userId,
        "x-tdai-agent-id": ctx.agentId,
      };
      if (options.includeSession && sessionId) headers["x-tdai-session-id"] = sessionId;
      if (options.includeTask && taskId) headers["x-tdai-task-id"] = taskId;

      const res = await fetch(`${base}${path}`, {
        method: "POST",
        signal: controller.signal,
        headers,
        body: JSON.stringify(stripUndefined(body)),
      });
      if (!res.ok) return {} as T;
      const envelope = await res.json() as TdaiEnvelope<T>;
      if (typeof envelope.code === "number" && envelope.code !== 0) return {} as T;
      return (envelope.data ?? {}) as T;
    } catch {
      return {} as T;
    } finally {
      clearTimeout(timer);
    }
  }

  // ── ACL check ──────────────────────────────────────────────────────────
  //
  // 与 memory 数据面调用（postForCtx）**语义相反**：
  //   - postForCtx 网络/HTTP/envelope 错都吞掉返回空 —— 让注入路径静默降级
  //   - checkAcl 网络/HTTP/envelope 错要抛出 —— 让上层 fail-closed 拒绝注入
  //     并打 error 日志（否则 acl 服务挂了会静默变成"全部允许"，越权）
  //
  // 因此本方法不复用 postForCtx，独立实现 —— 但仍然复用同一份 config
  // （endpoint / apiKey / serviceId / timeoutMs）。

  /**
   * 校验 user_id 对某 asset 的权限。
   *
   * 抛错场景（fetch/超时/HTTP 非 2xx/envelope code≠0/data.allowed 非 boolean）
   * 应当由调用方 catch 后按业务需要处理 —— 注入路径请用 checkAclOrDeny 便捷函数。
   */
  async checkAcl(params: AclCheckParams): Promise<AclCheckResult> {
    if (!this.isEnabled()) {
      // 未启用 tdai 时按"通过"处理，与其他 memory 方法在 disabled 下的返回一致。
      return { allowed: true, reason: "tdai_disabled" };
    }
    const base = this.config.endpoint.replace(/\/$/, "");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const res = await fetch(`${base}/v3/meta/acl/check`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.bearerToken()}`,
          "x-tdai-service-id": this.config.serviceId || "default",
          // Layer 3 用户鉴权：tdai v3 meta 路由要求此 header 才能通过，否则
          // 401 missing_user_key。Proxy 侧的当前请求发起者 user_key 直接用作
          // 调用者身份。
          "x-tdai-user-key": params.user_key,
        },
        body: JSON.stringify({
          // body user_key = 要**检查权限的目标用户**（这里跟调用者是同一个人 —— proxy
          // 场景下永远是自己给自己校验）。schema (userIdOrKeyFields.refine)
          // 要求 user_id 或 user_key 至少一个 —— 我们复用 header 那个 key。
          user_key: params.user_key,
          asset_id: params.asset_id,
          action: params.action,
          agent_id: params.agent_id,
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`acl/check http ${res.status}: ${body.slice(0, 200)}`);
      }
      const envelope = (await res.json()) as TdaiEnvelope<AclCheckResult>;
      if (typeof envelope.code === "number" && envelope.code !== 0) {
        throw new Error(`acl/check envelope code=${envelope.code} msg=${envelope.message ?? ""}`);
      }
      const data = envelope.data;
      if (!data || typeof data.allowed !== "boolean") {
        throw new Error(`acl/check malformed response: ${JSON.stringify(data).slice(0, 200)}`);
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * 注入路径便捷函数：包一层 try/catch + error 日志。
 *
 * 语义：
 *   - allowed=true                  → 放行
 *   - allowed=false                 → 拒绝（正常，由调用方决定是否 warn）
 *   - 底层调用抛错                  → 拒绝 + error 日志（fail-closed）
 *
 * 使用场景：resolveFixedAssetCtxs 里逐个 ctx 过滤时，不希望一次网络错就
 * 让整个注入路径抛异常，用这个便捷函数把异常转成"拒绝"信号即可。
 */
export async function checkAclOrDeny(
  client: TdaiClient,
  params: AclCheckParams,
): Promise<AclCheckResult> {
  try {
    return await client.checkAcl(params);
  } catch (err) {
    log.error(
      "[tdai-acl] check_failed",
      { user_key_masked: maskUserKey(params.user_key), asset_id: params.asset_id, action: params.action },
      err instanceof Error ? err : new Error(String(err)),
    );
    return { allowed: false, reason: "acl_check_error" };
  }
}

function stripUndefined(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));
}

/** 打印敏感 userKey 时脱敏：只保留前 6 位 + 后 4 位。 */
function maskUserKey(key: string | undefined): string {
  if (!key) return "";
  if (key.length <= 12) return "***";
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}
