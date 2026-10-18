/**
 * #59（S21，ADR0003 G1，2026-10-18）：身份漂移再锚定注入器（driftTrigger="auto"）。
 *
 * 动机（ADR0003 gap G1 + 文献 adaptive re-injection）：长会话尾部对会话头身份块的
 * 注意力稀释是人设漂移的主因之一 —— 在动作点近端按轮次节流重注入「短身份锚块」
 * （identity/self_identity 行级摘要），预防性再锚定。轮次深度驱动，非阈值触发
 * （#57 定标结论：scorer ε 是锚选择刻度，与本票的 drift 触发正交）。
 *
 * 合同：
 *   - point = tools.before_call（动作点近端，与红线注入器同位；per-identity
 *     轮次计数 = 本实例 execute 调用序，Map cap 1000 防泄漏）；
 *   - 时机 config-first：driftTrigger 缺省 "off"（/ "shadow"）→ 零块零触网；
 *     "auto" 才挂块；首轮注入、之后每 intervalTurns 轮一次（clamp [1,200]，
 *     缺省 20；soulTiming.reanchor?.intervalTurns 条件材料化）；
 *   - 内容 = core identity/self_identity 槽行级渲染（identity 在前、逐行剥弹头
 *     打 tag、行数 ≤8、每行含 tag ≤120 字）——短注入，宁缺毋滥：空槽零块；
 *   - 其余 Gate 与红线注入器同链：资产位关 / 无身份 / 非动作点 → 零块；
 *   - cacheStrategy = "none"：动作点现场渲染不进指纹缓存；复用 loadCoreMemorySlots
 *     的 60s 租户分桶缓存；块带 cacheKey 内容指纹由 pipeline 落位层去重（#34/#32 先例）。
 */
import type { AgentContext, ContextBlock, SoulTimingConfig } from "../types.js";
import { DEFAULT_SOUL_TIMING, HOOK_PRIORITY } from "../types.js";
import { isToolResultTail } from "../context.js";
import { fnv1a32 } from "../soul-overlap-journal.js";
import { TdaiClient } from "../../tdai/client.js";
import { getTdaiIdentity } from "../../tdai/identity.js";
import type { TdaiMemoryConfig } from "../../tdai/types.js";
import { loadCoreMemorySlots } from "./tdai-profile-memory-injector.js";

export const REANCHOR_SECTION_TITLE = "## 身份基线（再锚定）";
export const REANCHOR_EVENT_KIND = "reanchor";
export const REANCHOR_MAX_LINES = 8;
export const REANCHOR_LINE_MAX_CHARS = 120;
const DEFAULT_REANCHOR_INTERVAL_TURNS = 20;
// 渲染序（与 ADR D2 身份层语义一致）：identity（我心中的他）在前，self_identity（我是谁）在后。
const REANCHOR_SLOT_ORDER = ["identity", "self_identity"] as const;

export function renderReanchorLines(slots: ReadonlyArray<{ slot?: unknown; content?: unknown }>): string[] {
  const lines: string[] = [];
  for (const key of REANCHOR_SLOT_ORDER) {
    for (const slot of slots ?? []) {
      if (!slot || slot.slot !== key) continue;
      const content = typeof slot.content === "string" ? slot.content : "";
      const prefix = "- [" + key + "] ";
      const maxBody = REANCHOR_LINE_MAX_CHARS - [...prefix].length;
      for (const raw of content.split("\n")) {
        if (lines.length >= REANCHOR_MAX_LINES) return lines;
        const body = raw
          .replace(/^\s*[-*+·•]\s*/, "")
          .replace(/^\s*\d+[.、]\s*/, "")
          .trim();
        if (body.length === 0) continue;
        const cps = [...body];
        lines.push(prefix + (cps.length > maxBody ? cps.slice(0, maxBody).join("") : body));
      }
    }
  }
  return lines;
}

export class TdaiSoulReanchorInjector {
  readonly id = "tdai-soul-reanchor-injector";
  readonly point = "tools.before_call" as const;
  readonly priority = HOOK_PRIORITY.MEMORY;
  readonly description =
    "TDAI soul identity re-anchor proximal injection at action points (driftTrigger=auto, #59)";
  readonly cacheStrategy = "none" as const;

  private readonly turnCounters = new Map<string, number>();

  constructor(
    private readonly baseConfig: TdaiMemoryConfig,
    private readonly soulTiming: SoulTimingConfig = DEFAULT_SOUL_TIMING,
  ) {}

  private resolveIntervalTurns(): number {
    const n = this.soulTiming.reanchor?.intervalTurns;
    const base = typeof n === "number" && Number.isFinite(n) ? n : DEFAULT_REANCHOR_INTERVAL_TURNS;
    return Math.min(200, Math.max(1, Math.floor(base)));
  }

  async execute(ctx: AgentContext): Promise<ContextBlock[]> {
    // ── Gate 1: 时机 config-first（缺省关 = 逐位现状，不触网）───────────────
    if (this.soulTiming.driftTrigger !== "auto") return [];

    // ── Gate 2: 资产位（面板关停 → 整链静默）────────────────────────────────
    const custom = (ctx.metadata.custom ?? {}) as Record<string, unknown>;
    const caps = custom.assetCapabilities as { chat_memory?: boolean } | undefined;
    if (caps?.chat_memory === false) return [];

    // ── Gate 3: 身份（无身份则无 core 数据源）───────────────────────────────
    const identity = getTdaiIdentity(ctx.metadata.custom);
    if (!identity) return [];

    // ── Gate 4: 动作点判定（尾消息携带 tool_result = agentic loop 中）────────
    if (!isToolResultTail(ctx)) return [];

    // ── 轮次节流：per-identity 计数，首轮 + 之后每 intervalTurns 轮 ──────────
    const key = JSON.stringify(identity);
    if (this.turnCounters.size >= 1000 && !this.turnCounters.has(key)) {
      this.turnCounters.clear(); // 泄漏护栏：身份数超限整体重置（会话粒度足够）
    }
    const turn = (this.turnCounters.get(key) ?? 0) + 1;
    this.turnCounters.set(key, turn);
    const interval = this.resolveIntervalTurns();
    if (turn !== 1 && (turn - 1) % interval !== 0) return [];

    // ── 数据源：core identity/self_identity 槽（60s 租户分桶缓存）────────────
    const session = (custom.session ?? {}) as Record<string, unknown>;
    const spaceId = typeof session.space_id === "string" ? session.space_id : "";
    const client = new TdaiClient({ ...this.baseConfig, serviceId: spaceId || this.baseConfig.serviceId });
    const slots = await loadCoreMemorySlots(client, identity);
    const lines = renderReanchorLines(slots);
    if (lines.length === 0) return []; // 宁缺毋滥：身份槽全空整块省略

    const section = REANCHOR_SECTION_TITLE + "\n" + lines.join("\n");
    const content = '<soul-event kind="' + REANCHOR_EVENT_KIND + '">\n' + section + "\n</soul-event>";
    return [
      {
        type: "text",
        content,
        metadata: {
          source: this.id,
          soulBlockKind: "soul.event",
          cacheKey: "soul-reanchor-event:" + fnv1a32(section),
        },
      },
    ];
  }
}
