/**
 * #136（W2 软失效）：效期（valid_start/valid_end）从"硬过滤"变成"融合特征"。
 *
 * 背景：GROW-EVO P2 的失效排除把 valid_end ≤ now 的行直接从候选池删掉。当
 * supersession 判错（多值属性被当单值取代），被删的是**唯一**还带旧值的行：
 *   - knowledge-update 之外的问题被误伤（temporal-reasoning 需要旧事件仍在池里）
 *   - 一旦删掉就无法回捞，拒答率上升（LME90 allon 档 temporal 桶拒答 13.3%）
 *
 * 新口径（issue #136 验收③）：
 *   - future（valid_start > now）恒丢——还没发生，任何问题都不该召回；
 *   - expired（valid_end ≤ now）默认**降权保留**（active 在前、expired 保原相对序），
 *     只把"新旧"变成排序分差，由 fusion 的 validity 特征表达；
 *   - 唯一硬丢条件：查询显式问"现在/最新"（presentIntent）**且**池里存在更新的有效行
 *     （存在 active 行的 valid_start ≥ 该 expired 行的 valid_end）。此时旧值确实被取代，
 *     硬过滤才安全；否则保留（"问最新"也可能问的是已过去的那段历史）。
 *
 * 纯函数、零依赖（presentIntent 由调用方用 recall-signals 的 detectPresentTemporalIntent
 * 判定后传入，避免本模块依赖工具层）。
 */

export type ValidityMode = "hard" | "soft";
export type ValidityState = "active" | "expired" | "future";

/**
 * 失效排除的三态口径（#136）：
 *  - true/undefined：硬过滤（逐位旧行为）
 *  - false：通道退出（不排、不降权）
 *  - "soft"：效期转为排序特征（钩子路重排；工具路只丢 future）
 * 单一映射点：调用方只传 (validity.mode, excludeInvalidated)，不各写一遍三元式。
 */
export type ExcludeInvalidated = boolean | "soft";

/** 效期策略是否生效（三态谓词的唯一写法：false=关闭；true/"soft"=启用）。 */
export function validityEnabled(flag: ExcludeInvalidated | undefined): boolean {
  return flag !== false;
}

/**
 * #174：三态映射的**唯一**实现。定序 = 显式退出优先于 mode——
 * `excludeInvalidated: false` 是"把效期通道关掉"的显式请求，任何 validity.mode
 * 都不能把它改写成 "soft"（旧实现 `mode === "soft" ? "soft" : flag` 会把关档吞成软档，
 * 使 bench 的 `--validity-off` 在 soft 配置下恒定失效）。
 */
export function excludeInvalidatedFor(
  mode: ValidityMode | undefined,
  flag: boolean | undefined,
): ExcludeInvalidated | undefined {
  if (flag === false) return false;
  return mode === "soft" ? "soft" : flag;
}

/**
 * 效期通道的**派生三态**（#174）：off = 显式关；hard = 硬过滤；soft = 降权保留。
 * 调用方（结论层预筛、池级过滤、工具路）一律从这里取，禁止各自写 mode/flag 三元式——
 * 否则"off 只关一半"（钩子路关了、结论层 FTS 预筛还在丢 expired）会反复复发。
 */
export type ValidityPolicy = "off" | "hard" | "soft";

export function validityPolicyOf(
  mode: ValidityMode | undefined,
  flag: boolean | undefined,
): ValidityPolicy {
  if (flag === false) return "off";
  return mode === "soft" ? "soft" : "hard";
}

export interface ValidityAccessors<T> {
  validStart?: (item: T) => string | null | undefined;
  validEnd?: (item: T) => string | null | undefined;
}

export interface SelectValidityOptions<T> {
  now: Date;
  mode: ValidityMode;
  /** 查询是否显式问"现在/最新"（detectPresentTemporalIntent(query)）。 */
  presentIntent?: boolean;
  /** soft 下是否允许"presentIntent + 有更新行"硬丢（缺省 true）。 */
  hardOnPresentIntent?: boolean;
  accessors?: ValidityAccessors<T>;
  /**
   * 「更新的有效行」是否真的取代了该 expired 行（缺省 = 只按时间判，任意更新的
   * active 行都算）。钩子路传入内容 token 重叠判定，避免"任意新记忆"把历史行一律硬丢：
   * 判定为 false 时宁可降权保留（安全方向：不误删）。
   */
  related?: (expired: T, active: T) => boolean;
}

/**
 * 软失效的降权系数：expired 行 relevance（rrfScore）乘以该系数后再进组合精排——
 * 「效期作为融合特征」的最小实现（不引入新的池级重排，保留相关度序）。
 */
export const SOFT_VALIDITY_PENALTY = 0.5;

/**
 * #148：soft 档降权系数的**唯一**解析点（`recall.validity.softPenalty`，clamp[0,1]，
 * 缺省 0.5）。两路（钩子路 relevance/rrfScore、工具路 score）都从这里取，
 * 保证"同语义同刻度"——不要再各写一遍 `?? 0.5`。
 */
export function resolveSoftValidityPenalty(raw?: number | null): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return SOFT_VALIDITY_PENALTY;
  return Math.min(1, Math.max(0, raw));
}

/** expired 行的分数乘子（active/future = 1）——两路共用的单一实现。 */
export function softValidityMultiplier(state: ValidityState, penalty?: number | null): number {
  return state === "expired" ? resolveSoftValidityPenalty(penalty) : 1;
}

export interface ValiditySelection<T> {
  /** 交给下游排序/融合的行：soft 时 = active + 降权保留的 expired；hard 时 = active。 */
  kept: T[];
  /** 被硬丢弃的行（future，或 hard 模式下的 expired）。 */
  dropped: T[];
  /** kept 里被降权的 expired 行（保序）。 */
  demoted: T[];
}

function readStart<T>(item: T, accessors?: ValidityAccessors<T>): string | null | undefined {
  if (accessors?.validStart) return accessors.validStart(item);
  return (item as { valid_start?: string | null } | null)?.valid_start;
}

function readEnd<T>(item: T, accessors?: ValidityAccessors<T>): string | null | undefined {
  if (accessors?.validEnd) return accessors.validEnd(item);
  return (item as { valid_end?: string | null } | null)?.valid_end;
}

function parseTime(raw: string | null | undefined): number | undefined {
  if (!raw || typeof raw !== "string") return undefined;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : undefined;
}

/** 行在 now 时点的效期状态；valid_start/valid_end 解析失败一律按 active（宁缺毋滥）。 */
export function validityStateOf<T>(item: T, now: Date, accessors?: ValidityAccessors<T>): ValidityState {
  const vs = parseTime(readStart(item, accessors));
  if (vs !== undefined && vs > now.getTime()) return "future";
  const ve = parseTime(readEnd(item, accessors));
  if (ve !== undefined && ve <= now.getTime()) return "expired";
  return "active";
}

/**
 * 硬丢判定（适合"无法重排序"的通道：结论层候选、放宽通道等）。
 * future 恒丢；expired 只在 hard 模式丢（soft 下交回调用方决定排序/预算）。
 */
export function shouldHardDropValidity<T>(
  item: T,
  now: Date,
  mode: ValidityMode | ValidityPolicy,
  accessors?: ValidityAccessors<T>,
): boolean {
  // #174：off = 通道完全退出，一律不丢（含 future）——与工具路
  // filterByValidity(..., excludeInvalidated=false) 的"原样返回"逐位一致，
  // 否则同一条 --validity-off 两路行为仍然不同。
  if (mode === "off") return false;
  const state = validityStateOf(item, now, accessors);
  if (state === "future") return true;
  return state === "expired" && mode === "hard";
}

export interface SoftValidityDemotion<T> {
  /** 交给下游排序/截断的行：active 在前，降权后的 expired 在后（各保输入相对序）。 */
  kept: T[];
  /** 被硬丢的行（只有 future——工具路无「当下意图」，不硬丢 expired）。 */
  dropped: T[];
  /** kept 里被降权的 expired 行（保序）。 */
  demoted: T[];
}

/**
 * #148：工具路/结论层的 soft 对齐——expired **沉底并降权**，future 硬丢（与钩子路
 * searchHybrid 同乘子、同顺序契约：active 在前、demoted 保原相对序）。
 *
 * 为什么不是「只丢 future、原样保留」：那样 soft 在工具路退化成 hard-off 的近义，
 * 同一条配置两路顺序不同（钩子路 expired ×penalty 沉底、工具路不动）——#148 的
 * 「对齐」要求就是消掉这个双口径。乘子与解析点统一由 validity-policy 提供，
 * 工具路不再自写 0.5。
 */
export function demoteSoftValidity<T extends { valid_start?: string | null; valid_end?: string | null; score: number }>(
  items: T[],
  now: Date,
  penalty?: number | null,
): SoftValidityDemotion<T> {
  const sel = selectByValidity(items, { now, mode: "soft", presentIntent: false });
  if (sel.demoted.length === 0) return { kept: sel.kept, dropped: sel.dropped, demoted: [] };
  const p = resolveSoftValidityPenalty(penalty);
  const demotedSet = new Set<T>(sel.demoted);
  const kept = sel.kept.map((item) => (demotedSet.has(item) ? { ...item, score: item.score * p } : item));
  return { kept, dropped: sel.dropped, demoted: sel.demoted };
}

/**
 * 按效期选择候选（hard = 逐位旧行为；soft = #136 新口径）。
 * 顺序契约：kept 中 active 在前、demoted 的 expired 在后且保持输入相对序。
 */
export function selectByValidity<T>(items: T[], opts: SelectValidityOptions<T>): ValiditySelection<T> {
  const { now, mode, presentIntent = false, hardOnPresentIntent = true, accessors } = opts;
  const active: T[] = [];
  const expired: { item: T; index: number }[] = [];
  /** dropped 保输入序（与 kept 的顺序契约一致，便于调用方对账）。 */
  const droppedIdx: { item: T; index: number }[] = [];

  for (const [index, item] of items.entries()) {
    const state = validityStateOf(item, now, accessors);
    if (state === "future") { droppedIdx.push({ item, index }); continue; }
    if (state === "expired") { expired.push({ item, index }); continue; }
    active.push(item);
  }

  if (mode === "hard") {
    droppedIdx.push(...expired);
    const dropped = droppedIdx.sort((a, b) => a.index - b.index).map((e) => e.item);
    return { kept: active, dropped, demoted: [] };
  }

  // soft：只有"问当下 + 存在**取代它**的更新行"才硬丢；否则降权保留。
  const hardDrop = presentIntent && hardOnPresentIntent;
  const related = opts.related;
  const demoted: T[] = [];
  for (const { item, index } of expired) {
    const end = parseTime(readEnd(item, accessors));
    let supersededByNewer = false;
    if (end !== undefined) {
      for (const candidate of active) {
        const start = parseTime(readStart(candidate, accessors));
        if (start === undefined || start < end) continue;
        if (!related || related(item, candidate)) { supersededByNewer = true; break; }
      }
    }
    if (hardDrop && supersededByNewer) droppedIdx.push({ item, index });
    else demoted.push(item);
  }
  const dropped = droppedIdx.sort((a, b) => a.index - b.index).map((e) => e.item);
  return { kept: [...active, ...demoted], dropped, demoted };
}
