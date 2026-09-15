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

export function filterInvalidated<T extends { valid_end?: string | null }>(items: T[], now: Date = new Date()): T[] {
  return items.filter((item) => !isInvalidated(item, now));
}