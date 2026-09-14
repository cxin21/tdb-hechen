import type { AgentContext, ContextBlock, InjectionHook, HookPriority } from "../types.js";
import { HOOK_PRIORITY } from "../types.js";
import { getLastUserMessage, getMessageText } from "../context.js";
import type { TdaiClient } from "../../tdai/client.js";
import { getTdaiIdentity } from "../../tdai/identity.js";
import { extractUserQueryText } from "../../tdai/recorder.js";
import type { CoreSkillConfig } from "../../types.js";
import { getMetadataClient } from "../../meta/client.js";
import { resolveFixedAssetCtxs } from "./tdai-fixed-asset.js";
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
export class TdaiL1RecallInjector implements InjectionHook {
  id = "tdai-l1-recall-injector";
  point = "user.before" as const;
  priority: HookPriority = HOOK_PRIORITY.MEMORY;
  description = "Recall TDAI L1 memories from self + imported agents and prepend them to the current user turn";

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
    const query = extractUserQueryText(rawUserText).trim().slice(0, 2048);
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
      try {
        mergedChain = await this.recallViaEndpoint(ctxs, identity, query);
      } catch (err) {
        // 防静默降级老纪律：降级必须 loud（404 = 核心端点 enabled=false 关断档，同样降级）
        log.warn(
          `[tdai-l1-recall][DEGRADED] /v3/recall unavailable (${err instanceof Error ? err.message : String(err)}) — ` +
          `falling back to legacy /v3/atomic/search assembly for this turn (agent=${identity.agentId}, session=${identity.sessionId})`,
        );
        mergedChain = null;
      }
    }
    if (mergedChain !== null) return mergedChain;

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

  /**
   * 主链路：对每个 ctx 调 /v3/recall，非空块直接前插。
   *   - 任一 ctx 抛错 → 整体向上抛（execute 统一降级——保证注入块要么全主链路、
   *     要么全旧路，不混装两种形态）；
   *   - 任一 ctx 返回 null（recallL1 关闭）→ 整链零注入（开关语义：控制合并后的
   *     唯一代理注入链，不降级）；
   *   - 借入 ctx 的块前置 `[from <agent>]` 来源标注（沿降级路 fromTag 词汇），self
   *     ctx 原样透传（核心块自含 <relevant-memories> 包装，代理零渲染）。
   */
  private async recallViaEndpoint(
    ctxs: Array<{ teamId: string; userId: string; agentId: string; agentName?: string }>,
    identity: { agentId: string; sessionId: string; taskId?: string },
    query: string,
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
        ),
      })),
    );
    const parts: string[] = [];
    for (const { ctx: c, res } of results) {
      if (res === null) return []; // recallL1=false：零注入不变（不降级）
      if (!res.block) continue; // 核心"无命中"语义：本轮该 ctx 无可注入
      const isSelf = c.agentId === identity.agentId;
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
