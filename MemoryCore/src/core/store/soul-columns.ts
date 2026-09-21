/** soul 8 字段单一事实源（P-A）：schema/FTS/SELECT/映射全部由它展开。
 *  新增字段只改这里——编译期强制所有消费端跟进（漏抄=类型错误而非静默 undefined）。 */
export const SOUL_COLUMNS = [
  { name: "occurred_at",  sqlType: "TEXT", ftsSuffix: "UNINDEXED" },
  { name: "valid_start",  sqlType: "TEXT", ftsSuffix: "UNINDEXED" },
  { name: "valid_end",    sqlType: "TEXT", ftsSuffix: "UNINDEXED" },
  { name: "certainty",    sqlType: "TEXT", ftsSuffix: "UNINDEXED" },
  { name: "source",       sqlType: "TEXT", ftsSuffix: "UNINDEXED" },
  { name: "valence",      sqlType: "REAL", ftsSuffix: "UNINDEXED" },
  { name: "arousal",      sqlType: "REAL", ftsSuffix: "UNINDEXED" },
  { name: "significance", sqlType: "REAL", ftsSuffix: "UNINDEXED" },
  // D-3（2026-09-21，用户拍板"全做"）：敏感性枚举 none/health/finance/relationship（缺省 none）。
  // 消费方=召回降权门（sensitivityPenalty）/遗忘敏感偏置（sensitivityBias）/注入行徽章/UI 属性表。
  { name: "sensitivity", sqlType: "TEXT", ftsSuffix: "UNINDEXED" },
] as const;
export type SoulColumnName = (typeof SOUL_COLUMNS)[number]["name"];
export const SOUL_COL_NAMES: SoulColumnName[] = SOUL_COLUMNS.map((c) => c.name);
/** FTS SELECT 片段（l1_records 主表 join/回查时用） */
export const SOUL_SELECT_FRAGMENT = SOUL_COL_NAMES.join(", ");
/** 便捷类型：soul 字段视图（可空）——v2-router handleAtomicUpdate 等消费方复用 */
export type SoulColumnsOf = Partial<Record<SoulColumnName, string | number | null>>;
