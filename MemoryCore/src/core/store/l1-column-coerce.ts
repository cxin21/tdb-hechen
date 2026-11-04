/**
 * L1 行级列的读侧归一化（单一取值源）。
 *
 * 背景：l1_records 的灵魂列在库里同时存在「空串」与「NULL」两种"未填"形态，
 * JSON 类列（source_message_ids / metadata_json）还可能是脏值。两处读侧
 * （rowToMemoryRecord 的查询链、getL1ByIds 的精确读回链）必须同一口径，
 * 否则同一条记录从两条链路读回来字段形状不一致（v2 编辑链据此重建再 upsert
 * 会把值刷空/漂移）。故提到此处共用，禁止各自复制。
 */

/** 空串 / NULL / 非字符串 → undefined（库里空串与 NULL 都表示"未填"）。 */
export function optionalText(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/** 非有限数（NULL / undefined / NaN）→ undefined；0 是合法值，必须原样保留。 */
export function optionalNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * source_message_ids 列（JSON 数组文本）→ string[]。
 * 容错铁律：非法 JSON / 空串 / NULL / 非数组 → []，绝不抛（存量行与脏数据必须能读出来）。
 */
export function parseSourceMessageIds(v: unknown): string[] {
  if (typeof v !== "string" || v.trim() === "") return [];
  try {
    const parsed: unknown = JSON.parse(v);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}
