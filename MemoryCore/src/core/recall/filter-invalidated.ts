/**
 * GROW-EVO P2（§2.3）：失效记忆排除——召回默认不返回已被取代（valid_end ≤ now）的记忆。
 * 纯函数、零依赖；解析失败的 valid_end 保留（宁缺毋滥，不误删）。
 * 时间旅行语义由调用方负责：把 now 换成查询时点即可按"当时有效"过滤。
 */
export function isInvalidated(item: { valid_end?: string | null }, now: Date = new Date()): boolean {
  const ve = item.valid_end;
  if (!ve || typeof ve !== "string") return false;
  const t = Date.parse(ve);
  if (!Number.isFinite(t)) return false;
  return t <= now.getTime();
}

/**
 * Task 8（bi-temporal 补口，M4 #6）：完整效期窗口判定——行在 now 时点是否位于
 * [valid_start, valid_end) 窗口之外（未来生效 valid_start > now 同样排除）。
 * valid_end 半边语义完全复用 isInvalidated（null/""/解析失败保留、≤ now 排除）；
 * valid_start 解析失败/空值同样保留（宁缺毋滥，不误删）。
 * 钩子路（auto-recall 三处排除点）与工具路（memory-search filterByValidity）共用本谓词，
 * 一致性由 filter-invalidated.test.ts「钩子路/工具路一致性」套件钉死。
 */
export function isOutsideValidityWindow(
  item: { valid_start?: string | null; valid_end?: string | null },
  now: Date = new Date(),
): boolean {
  const vs = item.valid_start;
  if (vs && typeof vs === "string") {
    const t = Date.parse(vs);
    if (Number.isFinite(t) && t > now.getTime()) return true; // 未来生效（valid_start > now）
  }
  return isInvalidated(item, now);
}

/** 兼容保留（无生产 caller）：只看 valid_end 的旧口径过滤——召回排除请改用
 *  isOutsideValidityWindow（完整区间），否则未来生效行会泄漏。 */
export function filterInvalidated<T extends { valid_end?: string | null }>(items: T[], now: Date = new Date()): T[] {
  return items.filter((item) => !isInvalidated(item, now));
}