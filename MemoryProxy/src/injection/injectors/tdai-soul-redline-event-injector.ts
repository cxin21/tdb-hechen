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
 *   - 红线近端去重门（soul-dedupe 镜像，2026-10-19）：SoulTimingConfig.redlineDedup
 *     .enabled=true 时对渲染行做近重复整行选择（drop 变体、kept 行体逐字），缺省 off=逐位现状；
 *   - redlineCadence 轮首锚定节流（2026-10-23，#39 终判 revisit 后用户拍板 D=8）：
 *     mode="turn_head" 时每轮首个动作点必注全文；链内每 depthOverflow 个动作点
 *     溢出重锚一次（clamp [1,200] 缺省 8）；null 态 fail-open / 红线指纹变更 /
 *     风险工具命中强制全文兜底；缺省 every_action_point=逐位现状（每动作点全文）。
 *     gate 置于渲染之后：指纹恒取自本轮渲染（红线变更立即可见，不因节流延迟到
 *     下一轮首），loadCoreMemorySlots 60s 租户缓存使跳过轮成本可忽略；
 *   - 语用附带句（rider，2026-10-23 用户拍板）：块尾「以上为既有红线近端复现，
 *     无需复述确认，直接继续当前步骤。」——显式解除逐次复述确认的语用压力
 *     （#39 挂起的「习惯化效应」假设活体证据：截图 5/5 思考条目全是红线记账、
 *     零任务推理）。rider 进内容指纹（变更=新键），不进渲染单一源
 *     （soul-identity 会话头是原始段、不是复现，不加此句）；
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
// soul-dedupe（2026-10-19）：红线近端去重单一源镜像副本（与 MemoryCore 逐位等价+parity 契约测试）。
import { dedupeNearDuplicateLines } from "./soul-dedupe.js";

// REDLINE_SECTION_TITLE 由 ./soul-redline-render.js 单一源提供（与 #24-C1 soul-identity
// 红线段同源；本文件原私有常量于 #52 P1 收敛，防双源漂移）。
const REDLINE_EVENT_KIND = "redline";

/** 语用附带句（2026-10-23 用户拍板）：事件块定位为「既有红线的近端复现」，显式
 *  解除逐次复述确认的语用压力（#39 习惯化效应/确认税活体证据）。段尾附加、进内容
 *  指纹；不进渲染单一源（soul-identity 会话头是原始段、不是复现，不加此句）。 */
const REDLINE_EVENT_RIDER = "以上为既有红线近端复现，无需复述确认，直接继续当前步骤。";

/** redlineCadence 链深溢出缺省（2026-10-23 用户拍板 D=8；clamp [1,200]）。 */
const DEFAULT_REDLINE_CADENCE_DEPTH = 8;

/** turn_head 节流状态（per-session）：轮键 + 链内已跳过步数 + 上次注入的内容指纹。 */
interface RedlineCadenceState {
  turnKey: number;
  steps: number;
  lastFingerprint: string;
}

/** 节流状态 LRU cap（#88 先例）：会话数超限逐最旧（单会话 null 态 fail-open），
 *  不整表清空（避免集体漏闸式重注风暴）。 */
const REDLINE_CADENCE_STATE_CAP = 200;

export class TdaiSoulRedlineEventInjector {
  readonly id = "tdai-soul-redline-event-injector";
  readonly point = "tools.before_call" as const;
  readonly priority = HOOK_PRIORITY.MEMORY;
  readonly description =
    "TDAI soul redline proximal re-injection at action points (tools.before_call, ADR0003-P3 #39)";
  readonly cacheStrategy = "none" as const;

  /** turn_head 节流状态表（Map 插入序=LRU 序；cap REDLINE_CADENCE_STATE_CAP）。 */
  private readonly cadenceStates = new Map<string, RedlineCadenceState>();

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

    const redlineLinesRaw = renderStrictRuleTaggedLines(slots);
    // soul-dedupe 去重门（config-first，缺省 off=逐位现状）：只做整行选择（drop 近重复
    // 变体、kept 行体逐字），不截断不改写——红线「不软化」约束针对行体内容，选择≠改写。
    const dedupCfg = this.soulTiming.redlineDedup;
    const redlineLines =
      dedupCfg?.enabled === true && redlineLinesRaw.length > 1
        ? dedupeNearDuplicateLines(redlineLinesRaw, { jaccardThreshold: dedupCfg.jaccardThreshold }).kept
        : redlineLinesRaw;
    if (redlineLines.length === 0) return []; // 宁缺毋滥：无红线整块省略

    // 与 #24-C1 同源渲染：段名 + 逐 slot 一行，多行原文逐字直出（无截断/无转写）。
    const section = `${REDLINE_SECTION_TITLE}\n${redlineLines.join("\n")}`;
    // 语用附带句（2026-10-23 用户拍板）：段尾附加（见 REDLINE_EVENT_RIDER 注），
    // 进内容指纹（变更=新键，pipeline 落位层去重不受影响）。
    const body = `${section}\n\n${REDLINE_EVENT_RIDER}`;
    const fingerprint = fnv1a32(body);

    // cadence 节流门（2026-10-23，#39 终判 revisit 后用户拍板）：置于渲染之后——
    // 指纹恒取自本轮渲染（红线变更立即可见，不因节流延迟到下一轮首）。
    if (
      this.soulTiming.redlineCadence?.mode === "turn_head" &&
      !this.shouldInjectForCadence(ctx, custom, identity, fingerprint)
    ) {
      return [];
    }

    const content = `<soul-event kind="${REDLINE_EVENT_KIND}">\n${body}\n</soul-event>`;

    return [
      {
        type: "text",
        content,
        metadata: {
          source: this.id,
          soulBlockKind: "soul.event",
          cacheKey: `soul-redline-event:${fingerprint}`,
        },
      },
    ];
  }

  // ── redlineCadence 节流（2026-10-23，#39 终判 revisit 后用户拍板 D=8）────────
  //
  // 会话键：session_id 优先（proxy 逐请求可读），缺失回退 identity 全量串
  // （#59 先例；per-session 与 #59 per-identity 键的偏差系 #39 v2.2 骨架已声明项）。
  // 轮键 = 真实用户轮计数：user 角色且含非空 text 块的消息数——tool_result-only
  // 消息不算（agentic loop 每步都新增 user(tool_result) 载体，naive 计数会把每个
  // 动作点都当新轮首，节流失效）。
  //
  // 决策式：inject = null 态 fail-open ∨ 风险工具命中 ∨ 轮首 ∨ 红线指纹变更
  //          ∨ 链深溢出(steps >= depthOverflow - 1)。
  //          steps=自上次注入起的已跳过步数；注入发生于 visits 1, 1+D, 1+2D…
  //          （链内跳过 D-1 个动作点，无保护窗 ≤ D-1；D=1 → 每动作点都注）。
  // 写回：inject → { turnKey, steps: 0, lastFingerprint }；skip → steps+1（指纹沿用）。
  private shouldInjectForCadence(
    ctx: AgentContext,
    custom: Record<string, unknown>,
    identity: unknown,
    fingerprint: string,
  ): boolean {
    const depth = this.resolveDepthOverflow();
    const session = (custom.session ?? {}) as Record<string, unknown>;
    const sessionId =
      typeof session.session_id === "string" && session.session_id.length > 0 ? session.session_id : "";
    const key = sessionId || JSON.stringify(identity);
    const turnKey = this.countRealUserTurns(ctx);
    const prev = this.takeCadenceState(key);

    let inject: boolean;
    let next: RedlineCadenceState;
    if (!prev) {
      // null 态 fail-open（#39 v2.2 前提②）：新会话/重启/LRU 驱逐后首访强制全文。
      inject = true;
      next = { turnKey, steps: 0, lastFingerprint: fingerprint };
    } else {
      inject =
        this.matchesRiskTool(ctx) ||
        prev.turnKey !== turnKey || // 轮首
        prev.lastFingerprint !== fingerprint || // 红线指纹变更（规则变更立即可见）
        prev.steps >= depth - 1; // 链深溢出重锚（visits 1, 1+D, 1+2D…）
      next = inject
        ? { turnKey, steps: 0, lastFingerprint: fingerprint }
        : { turnKey, steps: prev.steps + 1, lastFingerprint: prev.lastFingerprint };
    }
    this.cadenceStates.set(key, next);
    return inject;
  }

  /** depthOverflow clamp [1,200] floor（0→1、999→200、1.7→1），非数值回退缺省 8。 */
  private resolveDepthOverflow(): number {
    const n = this.soulTiming.redlineCadence?.depthOverflow;
    const base = typeof n === "number" && Number.isFinite(n) ? n : DEFAULT_REDLINE_CADENCE_DEPTH;
    return Math.min(200, Math.max(1, Math.floor(base)));
  }

  /** 轮键：真实用户轮计数（user 角色且含非空 text 块的消息数；tool_result-only 不算）。 */
  private countRealUserTurns(ctx: AgentContext): number {
    return ctx.messages.filter(
      (m) =>
        m.role === "user" &&
        m.blocks.some((b) => b.type === "text" && b.content.trim().length > 0),
    ).length;
  }

  /** 风险工具名恢复：尾 tool_result.metadata.tool_use_id 反查前置 tool_use 块
   *  （metadata.tool_id 相等）→ JSON.parse 其 content 取 .name；命中
   *  riskToolPatterns（大小写不敏感子串）→ true。patterns 空/缺失 → 恒 false。 */
  private matchesRiskTool(ctx: AgentContext): boolean {
    const patterns = this.soulTiming.redlineCadence?.riskToolPatterns;
    if (!Array.isArray(patterns) || patterns.length === 0) return false;
    const msgs = ctx.messages;
    if (msgs.length === 0) return false;
    const tail = msgs[msgs.length - 1];
    let toolUseId: string | undefined;
    for (const b of tail.blocks) {
      const meta = b.metadata as Record<string, unknown> | undefined;
      if (b.type === "tool_result" && meta && typeof meta.tool_use_id === "string") {
        toolUseId = meta.tool_use_id;
        break;
      }
    }
    if (toolUseId === undefined) return false;
    for (const m of msgs) {
      for (const b of m.blocks) {
        if (b.type !== "tool_use") continue;
        const meta = b.metadata as Record<string, unknown> | undefined;
        if (!meta || meta.tool_id !== toolUseId) continue;
        let name = "";
        try {
          const parsed = JSON.parse(b.content) as { name?: unknown };
          if (typeof parsed?.name === "string") name = parsed.name;
        } catch {
          return false;
        }
        return patterns.some(
          (p) => typeof p === "string" && p.length > 0 && name.toLowerCase().includes(p.toLowerCase()),
        );
      }
    }
    return false;
  }

  /** LRU 取态（#88 先例）：命中重插尾部续命；miss 且超 cap 逐最旧（随后新键写入，
   *  总量守恒；被逐会话下次访问走 null 态 fail-open 注入）。 */
  private takeCadenceState(key: string): RedlineCadenceState | undefined {
    const prev = this.cadenceStates.get(key);
    if (prev) {
      this.cadenceStates.delete(key);
      this.cadenceStates.set(key, prev);
    } else if (this.cadenceStates.size >= REDLINE_CADENCE_STATE_CAP) {
      const oldest = this.cadenceStates.keys().next();
      if (!oldest.done) this.cadenceStates.delete(oldest.value);
    }
    return prev;
  }
}
