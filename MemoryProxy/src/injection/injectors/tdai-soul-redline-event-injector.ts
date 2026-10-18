/**
 * #39（ADR0003-P3 / 接线票 A，2026-10-16）：红线动作点近端 event 注入器。
 *
 * 动机（ADR 0003 D3 + r5-37）：红线与「动作」之间隔整个上下文窗口，越到长会话
 * 尾部注意力越弱 —— 工具调用/不可逆操作前需要把 strict_rule 原文以 event 块形态
 * 近端重注入（proximate principle，抗稀释）。
 *
 * 合同：
 *   - point = tools.before_call（#37 首交付冻结的类型位，本票接通分发层）；
 *   - 时机 config-first：`SoulTimingConfig.redline` 缺省 "session_head"（= 现状逐位，
 *     本钩子零块零触网）；显式 "action_proximate" 才挂块；
 *   - 动作点判定：尾消息携带 tool_result（agentic loop 中模型下一步决策可能发起
 *     工具调用）；普通 user 尾（非 loop）不注入；
 *   - 内容源 = core strict_rule 槽原文（与 #24-C1 soul-identity 红线段同源同渲染：
 *     段名「## 不可逾越（红线）」+ 逐条红线独立成行、逐行携带 tag
 *     （#52 P1：多行槽逐行打 tag + 剥内容自身弹头，零 '- [strict_rule] - ' 畸形；
 *     渲染单一源 = ./soul-redline-render.ts 镜像）。行体逐字直出 ——
 *     真实性边界：无预算/无截断/无改写，红线不软化）；
 *   - cacheStrategy = "none"：动作点现场渲染，绝不进指纹缓存（#37 票面验收）；
 *     复用 loadCoreMemorySlots 的 60s 租户分桶缓存，不额外打 core；
 *   - 同管线同内容 event 块去重：块携带 cacheKey 内容指纹，由 pipeline 落位层
 *     按 cacheKey 去重（#34/#32 先例）；
 *   - 宁缺毋滥：无 strict_rule / 身份缺失 / 资产位关 / core 不可达 → 零块。
 */
import type { AgentContext, ContextBlock, SoulTimingConfig } from "../types.js";
import { DEFAULT_SOUL_TIMING, HOOK_PRIORITY } from "../types.js";
import { isToolResultTail } from "../context.js";
// 共享 FNV-1a 32bit（与 MemoryCore soul-assembler 同算法，跨包一致性）——
// 自审 F3（2026-10-16）：私有副本与 soul-overlap-journal 导出逐位等价，收敛为单一源。
import { fnv1a32 } from "../soul-overlap-journal.js";
import { TdaiClient } from "../../tdai/client.js";
import { getTdaiIdentity } from "../../tdai/identity.js";
import type { TdaiMemoryConfig } from "../../tdai/types.js";
import { loadCoreMemorySlots } from "./tdai-profile-memory-injector.js";
// #52 P1（2026-10-18）：红线渲染单一源（本包镜像副本，与 MemoryCore 逐位等价+契约测试）——
// 多行 strict_rule 槽逐行打 tag+剥行首自身弹头（旧 map 只给首行打 tag 且不剥弹头=生产畸形）。
import { REDLINE_SECTION_TITLE, renderStrictRuleTaggedLines } from "./soul-redline-render.js";

// REDLINE_SECTION_TITLE 由 ./soul-redline-render.js 单一源提供（与 #24-C1 soul-identity
// 红线段同源；本文件原私有常量于 #52 P1 收敛，防双源漂移）。
const REDLINE_EVENT_KIND = "redline";

export class TdaiSoulRedlineEventInjector {
  readonly id = "tdai-soul-redline-event-injector";
  readonly point = "tools.before_call" as const;
  readonly priority = HOOK_PRIORITY.MEMORY;
  readonly description =
    "TDAI soul redline proximal re-injection at action points (tools.before_call, ADR0003-P3 #39)";
  readonly cacheStrategy = "none" as const;

  constructor(
    private readonly baseConfig: TdaiMemoryConfig,
    private readonly soulTiming: SoulTimingConfig = DEFAULT_SOUL_TIMING,
  ) {}

  async execute(ctx: AgentContext): Promise<ContextBlock[]> {
    // ── Gate 1: 时机 config-first（缺省关 = 逐位现状，不触网）───────────────
    if (this.soulTiming.redline !== "action_proximate") return [];

    // ── Gate 2: 资产位（面板关停 → 整链静默）────────────────────────────────
    const custom = (ctx.metadata.custom ?? {}) as Record<string, unknown>;
    const caps = custom.assetCapabilities as { chat_memory?: boolean } | undefined;
    if (caps?.chat_memory === false) return [];

    // ── Gate 3: 身份（无身份则无 core 数据源）───────────────────────────────
    const identity = getTdaiIdentity(ctx.metadata.custom);
    if (!identity) return [];

    // ── Gate 4: 动作点判定（尾消息携带 tool_result = agentic loop 中）────────
    if (!isToolResultTail(ctx)) return [];

    // ── 数据源：core strict_rule 槽（60s 租户分桶缓存，与 profile injector 共享）──
    const session = (custom.session ?? {}) as Record<string, unknown>;
    const spaceId = typeof session.space_id === "string" ? session.space_id : "";
    const client = new TdaiClient({ ...this.baseConfig, serviceId: spaceId || this.baseConfig.serviceId });
    const slots = await loadCoreMemorySlots(client, identity);

    const redlineLines = renderStrictRuleTaggedLines(slots);
    if (redlineLines.length === 0) return []; // 宁缺毋滥：无红线整块省略

    // 与 #24-C1 同源渲染：段名 + 逐 slot 一行，多行原文逐字直出（无截断/无转写）。
    const section = `${REDLINE_SECTION_TITLE}\n${redlineLines.join("\n")}`;
    const content = `<soul-event kind="${REDLINE_EVENT_KIND}">\n${section}\n</soul-event>`;

    return [
      {
        type: "text",
        content,
        metadata: {
          source: this.id,
          soulBlockKind: "soul.event",
          cacheKey: `soul-redline-event:${fnv1a32(section)}`,
        },
      },
    ];
  }
}
