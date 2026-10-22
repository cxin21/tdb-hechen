import type { AgentContext, ContextBlock, InjectionHook, HookPriority } from "../types.js";
import { HOOK_PRIORITY } from "../types.js";
import { getLastUserMessage, getMessageText } from "../context.js";
import type { TdaiClient } from "../../tdai/client.js";
import { getTdaiIdentity } from "../../tdai/identity.js";
import { extractUserQueryText } from "../../tdai/recorder.js";
import type { TurnContext } from "../../common/intent-classifier.js";
import { recordRecallOutcome, recordTurnIntentPresence, warnTurnContextMissing } from "../../tdai/sentinel.js";
import { createHash } from "node:crypto";
import { classifyShortIntent, normalizeIntentText, residualChars as intentResidual } from "../../common/short-intent.js";
import type { CoreSkillConfig } from "../../types.js";
import { getMetadataClient } from "../../meta/client.js";
import { resolveFixedAssetCtxs } from "./tdai-fixed-asset.js";
import { curateToolCapabilities } from "./tdai-tool-capabilities.js";
import { log } from "../../report/log.js";

/**
 * L1 召回（"自有 + 借入"跨 agent 合并）——DS-RECALL-MERGE-001（合并召回 · 核心单点）后：
 *
 *   主链路（瘦传输）：对每个 ctx 调核心 `/v3/recall`，拿 MemoryCore 组装好的最终注入块
 *   （与 auto-recall 钩子同一条 performLayeredRecall 组装路径：九通道 + R7 分层 + 预算 +
 *   幂等结论层 + CAL C1 截断），直接前插——代理零渲染，注入形态演进只改核心一处。
 *
 *   降级路（现状保留）：`/v3/recall` 404/5xx/超时 → 退回 `/v3/atomic/search` 自行组装 +
 *   loud 日志（防静默降级老纪律）；降级不改注入行为语义（同一检索语义，仅组装退回旧形态）。
 *
 *   `recallL1` 开关语义不变：false = 唯一代理注入链整体关闭（零注入，不降级）。
 *   `<relevant-memories>` 标记跳过逻辑保留（合并后降级为冗余保险）。
 *
 * 控制面不可达时（fixed-asset 解析降级）：仅查当前 agent 的 L1（与改造前的行为一致）。
 */
/** #87/#88 指纹闸：scope（userId:agentId:sessionKey 三级键）容量上限——LRU 仅逐出最旧 scope（#88 取代旧 clear() 整表清空=集体漏闸）。 */
const INTENT_FP_MAX_SCOPES = 200;
/** #88：单 scope 内意图指纹 LRU 容量（定案参数终表 N=32；超限逐出最旧意图槽）。 */
const INTENT_FP_MAX_INTENTS = 32;

/** #88 三级 scope 指纹状态：意图槽 LRU（Map 插入序=LRU 序，首键=最旧）+ last-known 焦点。 */
interface ScopeFingerprint {
  /** intentHash（归一化意图 sha256 前 12 hex）→ lastRecalledAt；重召回=刷新值（条目不删）。 */
  intents: Map<string, number>;
  /** last-known 焦点：最近一条可检索意图文本（S2 写入 / S1·null 轮消费 / S3 清除）。 */
  lastKnownText: string | null;
  /** lastKnownText 的最近刷新时刻（nowFn 时钟）；0=无焦点。 */
  lastKnownAt: number;
}

export class TdaiL1RecallInjector implements InjectionHook {
  id = "tdai-l1-recall-injector";
  point = "user.before" as const;
  priority: HookPriority = HOOK_PRIORITY.MEMORY;
  description = "Recall TDAI L1 memories from self + imported agents and prepend them to the current user turn";
  /** #88：scope → 指纹状态（意图 LRU + last-known 焦点；仅 intent 档写入与消费）。 */
  private fingerprintByScope = new Map<string, ScopeFingerprint>();

  /**
   * @param sessionInitConfig 用来调控制面拿 fixed-asset-agents；如果 null，
   *        injector 退化到"只查当前 agent"模式，保持向后兼容。
   * @param perAgentLimit 每个 agent 各自从 tdai 召回多少条（默认 = client 配置；仅降级路消费）
   * @param globalTopK 合并后保留多少条（默认 5；主链路作为 /v3/recall 的 maxResults 透传，
   *        块内预算由核心 cfg.recall.maxResults 决定）
   */
  constructor(
    private client: TdaiClient,
    private coreSkillCfg: Pick<CoreSkillConfig, "endpoint" | "serviceToken" | "serviceId" | "timeoutMs"> | null = null,
    private perAgentLimit: number | undefined = undefined,
    private globalTopK = 5,
    /**
     * ACL 校验客户端，通常与 `client` 是同一个 TdaiClient 实例。传入后每个
     * fixed-asset ctx 都会走 acl/check(read) 过滤。为 null 时保留旧行为。
     */
    private aclClient: TdaiClient | null = null,
    /**
     * #40-B（ADR0003 派生票 B）：config 显式能力策展行（injection.toolCapabilities.lines）。
     * 非空 → curateToolCapabilities 逐字 1:1 直出（config 即数据源，工具面实况不参与）；
     * 缺失/空 → undefined = 运行时策展（现状逐位）。
     *
     * kill switch（m00265）：能力段整段开关（injection.toolCapabilities.enabled）。
     * undefined/true = 现状逐位；false = curateToolCapabilities 返回空数组 → 请求体
     * 不带 capabilities → 核心不渲染「## 我能做什么」。
     */
    private capabilitiesLines?: readonly string[],
    private capabilitiesEnabled?: boolean,
    /**
     * #83 入口单点定源：query 来源三档（tdai.memory.recallQuerySource）。
     * legacy=现状裸取尾+提取器；shadow=分类器双跑对比日志（行为不变）；
     * intent=读 turnContext.turnIntent（缺 turnContext 时保持 legacy 行为）。
     */
    private querySource: "legacy" | "shadow" | "intent" = "legacy",
    /**
     * #87 同意图去重：intent 档下同 session 同意图已成功召回过 → 跳过 POST 零召回
     * （「一步一查」收敛为「一意图一查」）。缺省 true；legacy/shadow 行为逐位不变。
     */
    private recallIntentDedup = true,
    /**
     * #88 超窗语义（惰性刷新非自动重召回）：指纹 TTL 缺省 3600000ms=60min（定案参数终表 W）。
     * now−lastRecalledAt≤W → 同意图去重不 POST；>W → 失效重召回并刷新时间戳（条目不删）。
     */
    private recallIntentDedupTtlMs = 3_600_000,
    /** #88 可注入时钟（测试 fake clock；缺省 Date.now）。 */
    private nowFn: () => number = Date.now,
  ) {}

  async execute(ctx: AgentContext): Promise<ContextBlock[]> {
    const identity = getTdaiIdentity(ctx.metadata.custom);
    if (!identity) return [];

    const lastUser = getLastUserMessage(ctx);
    if (!lastUser) return [];
    // 用「干净的真实 user_query」作检索词，而不是整条原始消息 blob
    // （后者含 <user_info>/<additional_data>/<question_answer> 等噪声，
    //  会让 FTS5/向量检索命中率极低甚至 0，导致 L1 召不回）。
    const rawUserText = getMessageText(lastUser);
    const legacyQuery = extractUserQueryText(rawUserText).trim().slice(0, 2048);
    // ── #83 入口单点定源：query 来源三档（config tdai.memory.recallQuerySource，
    //    缺省 legacy=直接用 legacyQuery，行为逐位不变）──
    const turnContext = (ctx.metadata.custom as { tdaiTurnContext?: TurnContext | null } | undefined)?.tdaiTurnContext ?? null;
    let query = legacyQuery;
    // #88：三级 scope 键（userId:agentId:sessionKey）——跨用户/跨 agent 指纹串扰隔离（R7）。
    const sessionKey = ctx.metadata.sessionKey ?? "";
    const scopeKey = `${identity.userId}:${identity.agentId}:${sessionKey}`;
    if (this.querySource === "intent") {
      // #88 intent 档：短消息三分（S1 延续/S2 短新意图/S3 纯指令）+ last-known 焦点 + scope 指纹去重。
      if (!turnContext) {
        warnTurnContextMissing(sessionKey, this.querySource);
      }
      const state = this.getScopeState(scopeKey);
      const now = this.nowFn();
      const rawIntent = turnContext?.turnIntent ? turnContext.turnIntent.text.trim() : "";
      const normalized = normalizeIntentText(rawIntent);
      const kind = classifyShortIntent(normalized);
      if (rawIntent && kind === "command") {
        // S3 纯指令（「停/撤/？」）：检索区分度≈0 → 不召回；焦点切换=清 last-known；记账+哨兵。
        log.info("dsh-recall-short-command", {
          session: sessionKey,
          head: rawIntent.slice(0, 40),
          residual: intentResidual(normalized),
        });
        state.lastKnownText = null;
        recordTurnIntentPresence(sessionKey, false);
        return [];
      }
      if (rawIntent && kind === "retrievable") {
        // S2 短新意图（「换北京」）：原文可检索 → 正常召回 + 刷新 last-known 焦点。
        query = rawIntent.slice(0, 2048);
        state.lastKnownText = query;
        state.lastKnownAt = now;
        recordTurnIntentPresence(sessionKey, true);
      } else {
        // S1 延续/确认（词表命中，含「嗯嗯」归一化）与 turnIntent=null（续跑轮）：
        // 不独立召回，意图=last-known（去重闸裁决新鲜度）；无 last-known → intent-missing 哨兵。
        if (state.lastKnownText && now - state.lastKnownAt <= this.recallIntentDedupTtlMs) {
          query = state.lastKnownText;
          recordTurnIntentPresence(sessionKey, true);
        } else {
          recordTurnIntentPresence(sessionKey, false);
          log.info("dsh-recall-intent-missing", {
            session: sessionKey,
            rawHead: rawIntent.slice(0, 40),
            reason: rawIntent ? "continuation-no-focus" : "no-turn-intent",
          });
          return [];
        }
      }
      // #88 去重闸：同 scope 同意图 W 内已成功召回 → 跳过 POST；>W 失效 → 重召回（mark 刷新时间戳）。
      if (this.recallIntentDedup && query) {
        const hash = createHash("sha256").update(normalizeIntentText(query), "utf8").digest("hex").slice(0, 12);
        const lastRecalledAt = state.intents.get(hash);
        if (lastRecalledAt !== undefined && now - lastRecalledAt <= this.recallIntentDedupTtlMs) {
          log.info("dsh-recall-intent-dedup-skip", { session: sessionKey, intentHead: query.slice(0, 80) });
          return [];
        }
      }
    } else if (this.querySource === "shadow" && turnContext) {
      // shadow 档：双跑对比日志（影子期零行为变化，query 仍用 legacy）。
      const intentQuery = turnContext.turnIntent ? turnContext.turnIntent.text.trim().slice(0, 2048) : "";
      recordTurnIntentPresence(sessionKey, intentQuery.length > 0);
      log.info("dsh-recall-query-shadow", {
        legacyLen: legacyQuery.length,
        intentLen: intentQuery.length,
        match: legacyQuery === intentQuery,
        legacyHead: legacyQuery.slice(0, 80),
        intentHead: intentQuery.slice(0, 80),
      });
    } else if (this.querySource !== "legacy") {
      warnTurnContextMissing(sessionKey, this.querySource);
    }
    if (!query) return [];

    // 审查修补 I②（跨链路防重，最小方案）：MemoryCore before_prompt_build 链路的注入块
    // 带固定标记头 <relevant-memories>。当轮用户消息已携带该标记 = 同一轮已由 MemoryCore
    // 链路注入过 L1 记忆 → 本注入器退出，避免同一轮双重注入。检测范围仅限当轮用户消息
    // （MemoryCore openclaw-plugin 在消息落盘前会剥离该标记，历史消息不受污染）；
    // MemoryCore 链路未部署时标记恒不出现 → 本注入器行为零变化。
    // DS-RECALL-MERGE-001 后：合并链路的注入块本身即由核心产出（单一生产者，双注入风险
    // 架构性消除）；本标记跳过保留为冗余保险（同轮两链路并存的旧部署形态仍受保护）。
    // 残余风险（登记）：若两链路注入时序上本注入器先于 MemoryCore 执行，或 MemoryCore
    // 注入块不经过本请求的消息列表（跨进程管道直改 prompt），标记检测不可见——该部署
    // 形态仍应遵循"配置只开一条链路"（recallL1 缺省 false，见 src/config.ts）。
    if (rawUserText.includes("<relevant-memories>")) {
      return [];
    }

    // 拿 self + 借入 ≤2 个的 ctx 列表
    const session = (ctx.metadata.custom as any)?.session as { user_key?: string; space_id?: string } | undefined;
    const userKey = session?.user_key;
    // spaceId 来自 session 注册时保存的 URL path 中的 `/proxy/<spaceId>/...`；
    // 用作内核的 `x-tdai-service-id` 头做租户路由。
    const spaceId = session?.space_id ?? "";
    const mc = this.coreSkillCfg && userKey
      ? getMetadataClient(this.coreSkillCfg, spaceId, userKey)
      : null;
    const ctxs = await resolveFixedAssetCtxs(ctx, identity, mc);

    // ── DS-RECALL-MERGE-001 主链路：核心单点 /v3/recall 瘦传输 ──
    // 返回 null = 走降级路（端点不可用 / 老客户端无此能力）；返回数组 = 主链路结论
    // （可能为空数组 = 全部 ctx 无命中 → 零注入，非失败不降级）。
    let mergedChain: ContextBlock[] | null = null;
    const recallFn = (this.client as unknown as { recallBlockForCtx?: unknown }).recallBlockForCtx;
    if (typeof recallFn === "function") {
      // ── #40（ADR0003-P3 接线票 B）capabilities 数据源 ──
      // #40-B 修订：config lines 显式通道优先（injection.toolCapabilities.lines 非空
      // → 逐字 1:1 直出，工具面实况不参与）；缺失/空 → 工具面实况策展（≤5 行模板
      // 直出，零 LLM）。空清单 → undefined（请求体不带 capabilities 键=逐位现状）。
      // kill switch（m00265）：enabled=false → 空数组（同空清单语义=核心不渲染标题）。
      // 仅 self ctx 携带（见 recallViaEndpoint）：借入块出自他人 agent 身份，混入
      // 当前 agent 的能力自述会污染其 soul 前缀语义。
      const curated = curateToolCapabilities(ctx.tools, undefined, this.capabilitiesLines, this.capabilitiesEnabled);
      const capabilities = curated.length > 0 ? curated : undefined;
      try {
        mergedChain = await this.recallViaEndpoint(ctxs, identity, query, capabilities);
      } catch (err) {
        // 防静默降级老纪律：降级必须 loud（404 = 核心端点 enabled=false 关断档，同样降级）
        log.warn(
          `[tdai-l1-recall][DEGRADED] /v3/recall unavailable (${err instanceof Error ? err.message : String(err)}) — ` +
          `falling back to legacy /v3/atomic/search assembly for this turn (agent=${identity.agentId}, session=${identity.sessionId})`,
        );
        mergedChain = null;
      }
    }
    if (mergedChain !== null) {
      // #83 哨兵：recall 空响应采样（log-only）
      recordRecallOutcome(mergedChain.length === 0);
      // #87：主链召回成功（含空结果）→ 置会话意图指纹。
      this.markIntentRecalled(scopeKey, query);
      return mergedChain;
    }

    // ── 降级路（现状逐位保留）：并发对每个 ctx search L1，自行组装 ──
    const groups = await Promise.all(
      ctxs.map(async (c) => {
        const items = await this.client.searchL1ForCtx(
          { teamId: c.teamId, userId: c.userId, agentId: c.agentId, agentName: c.agentName },
          query,
          identity.sessionId,
          identity.taskId,
          this.perAgentLimit,
        );
        return items.map((m) => ({
          ...m,
          fromAgentId: c.agentId,
          fromAgentName: c.agentName,
        }));
      }),
    );
    // 合并所有命中，按 score 降序（缺 score 的排末尾）
    const merged = ([] as Array<(typeof groups)[number][number]>)
      .concat(...groups)
      .sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity))
      .slice(0, this.globalTopK);

    // #87：降级路召回成功（含空结果）→ 同样置指纹，避免每步重查。
    this.markIntentRecalled(scopeKey, query);
    if (merged.length === 0) return [];

    const lines: string[] = [
      "<tdai_recalled_l1_memories>",
      "以下是与本轮用户问题相关的 TDAI L1 记忆（自有 + 借入合集，按相关度排序），仅用于辅助回答当前这一轮，不要视为永久系统规则：",
    ];
    for (let i = 0; i < merged.length; i++) {
      const m = merged[i];
      const fromTag =
        m.fromAgentId === identity.agentId
          ? "self"
          : `from ${m.fromAgentName ?? m.fromAgentId}`;
      const score = typeof m.score === "number" ? ` score=${m.score.toFixed(3)}` : "";
      lines.push(`${i + 1}. [${m.type ?? "memory"}] [${fromTag}${score}] ${m.content}`);
    }
    lines.push("</tdai_recalled_l1_memories>");

    return [
      {
        type: "text",
        content: lines.join("\n"),
        metadata: {
          source: this.id,
          count: merged.length,
          sources: ctxs.map((c) => c.agentId),
        },
      },
    ];
  }

  /** #87：召回成功后更新会话级意图指纹（仅 intent 档 + dedup 开）。容量超限清空防泄漏。 */
  /** #88：召回成功后置指纹（仅 intent 档 + dedup 开）——意图 LRU + last-known 刷新（时间戳刷新非删除）。 */
  private markIntentRecalled(scopeKey: string, intent: string): void {
    if (this.querySource !== "intent" || !this.recallIntentDedup) return;
    const state = this.getScopeState(scopeKey);
    const hash = createHash("sha256").update(normalizeIntentText(intent), "utf8").digest("hex").slice(0, 12);
    // LRU 刷新：重插到尾部（首键=最旧）；超 N=32 逐出最旧意图槽。
    state.intents.delete(hash);
    state.intents.set(hash, this.nowFn());
    while (state.intents.size > INTENT_FP_MAX_INTENTS) {
      const oldest = state.intents.keys().next().value;
      if (oldest === undefined) break;
      state.intents.delete(oldest);
    }
    if (intent) {
      state.lastKnownText = intent;
      state.lastKnownAt = this.nowFn();
    }
  }

  /** #88：取（或建）scope 指纹状态；scope 级 LRU 200——命中重插尾部（真 LRU 非 FIFO），超限仅逐出最久未用 scope（取代旧 clear() 整表清空）。 */
  private getScopeState(scopeKey: string): ScopeFingerprint {
    const existing = this.fingerprintByScope.get(scopeKey);
    if (existing) {
      // 命中刷新：delete+set 重插尾部（与意图槽 markIntentRecalled 对称）——否则是 FIFO（按插入序驱逐，#88 M1）。
      this.fingerprintByScope.delete(scopeKey);
      this.fingerprintByScope.set(scopeKey, existing);
      return existing;
    }
    if (this.fingerprintByScope.size >= INTENT_FP_MAX_SCOPES) {
      const oldest = this.fingerprintByScope.keys().next().value;
      if (oldest !== undefined) this.fingerprintByScope.delete(oldest);
    }
    const fresh: ScopeFingerprint = { intents: new Map(), lastKnownText: null, lastKnownAt: 0 };
    this.fingerprintByScope.set(scopeKey, fresh);
    return fresh;
  }

  /**
   * 主链路：对每个 ctx 调 /v3/recall，非空块直接前插。
   *   - 任一 ctx 抛错 → 整体向上抛（execute 统一降级——保证注入块要么全主链路、
   *     要么全旧路，不混装两种形态）；
   *   - 任一 ctx 返回 null（recallL1 关闭）→ 整链零注入（开关语义：控制合并后的
   *     唯一代理注入链，不降级）；
   *   - 借入 ctx 的块前置 `[from <agent>]` 来源标注（沿降级路 fromTag 词汇），self
   *     ctx 原样透传（核心块自含 <relevant-memories> 包装，代理零渲染）；
   *   - #40：capabilities（工具面策展清单）仅随 self ctx 携带（他人身份不混当前
   *     agent 能力自述；undefined = 请求体不带键，行为逐位现状）。
   */
  private async recallViaEndpoint(
    ctxs: Array<{ teamId: string; userId: string; agentId: string; agentName?: string; isSelf?: boolean }>,
    identity: { agentId: string; sessionId: string; taskId?: string },
    query: string,
    capabilities?: readonly string[],
  ): Promise<ContextBlock[] | null> {
    const results = await Promise.all(
      ctxs.map(async (c) => ({
        ctx: c,
        res: await this.client.recallBlockForCtx(
          { teamId: c.teamId, userId: c.userId, agentId: c.agentId },
          query,
          identity.sessionId,
          identity.taskId,
          this.globalTopK,
          // 审查修补（#40-F1）：self 判定优先信任 resolveFixedAssetCtxs 显式携带的 isSelf
          // 旗标（FixedAssetCtx 恒有该字段），agentId 等值比较仅作旧形状兜底——防御
          // 跨租户同 agentId 的借入 ctx 被误判为 self 而混入当前请求的能力自述。
          (c.isSelf ?? c.agentId === identity.agentId) ? capabilities : undefined,
        ),
      })),
    );
    const parts: string[] = [];
    for (const { ctx: c, res } of results) {
      if (res === null) return []; // recallL1=false：零注入不变（不降级）
      if (!res.block) continue; // 核心"无命中"语义：本轮该 ctx 无可注入
      const isSelf = c.isSelf ?? c.agentId === identity.agentId; // 同上（#40-F1 同源旗标）
      parts.push(isSelf ? res.block : `[from ${c.agentName ?? c.agentId}]\n${res.block}`);
    }
    if (parts.length === 0) return [];
    return [
      {
        type: "text",
        content: parts.join("\n\n"),
        metadata: {
          source: this.id,
          count: parts.length,
          sources: ctxs.map((c) => c.agentId),
          via: "v3-recall",
        },
      },
    ];
  }
}
