/** soul 字段单一事实源（P-A）：schema/FTS/SELECT/映射全部由它展开（ADR-0025 C2 删 `source` 后 9 列）。
 *  新增字段只改这里——编译期强制所有消费端跟进（漏抄=类型错误而非静默 undefined）。 */
export const SOUL_COLUMNS = [
  { name: "occurred_at",  sqlType: "TEXT", ftsSuffix: "UNINDEXED" },
  { name: "valid_start",  sqlType: "TEXT", ftsSuffix: "UNINDEXED" },
  { name: "valid_end",    sqlType: "TEXT", ftsSuffix: "UNINDEXED" },
  { name: "certainty",    sqlType: "TEXT", ftsSuffix: "UNINDEXED" },
  // ADR-0025 C2（2026-11-04）：原 `source` 列已删——全仓零判定读点（生产 4225 行里 959 行为 ''，
  // 其余仅有 extraction/reflection/consolidated 三个写入方各自赋值、无人消费）。行级"这话从哪来"
  // 已由 source_message_ids（原话 id 数组）+ memory_audit 承担，不需要第二个弱化副本。
  // 删这一行即单点瘦身：主表 DDL / FTS DDL / 全部 SELECT 片段 / 绑定值数组 / restore 列清单同步收窄。
  { name: "valence",      sqlType: "REAL", ftsSuffix: "UNINDEXED" },
  { name: "arousal",      sqlType: "REAL", ftsSuffix: "UNINDEXED" },
  { name: "significance", sqlType: "REAL", ftsSuffix: "UNINDEXED" },
  // D-3（2026-09-21，用户拍板"全做"）：敏感性枚举 none/health/finance/relationship（缺省 none）。
  // 消费方=注入门（core/recall/sensitivity-policy.ts：非 none 只在私有上下文注入）/注入行徽章/UI 属性表。
  // 2026-11-04 定案：旧 sensitivityPenalty / sensitivityBias 两个 0 值死乘子已删除（不参与排序与遗忘）。
  { name: "sensitivity", sqlType: "TEXT", ftsSuffix: "UNINDEXED" },
  // P1-T7（2026-10-13，worthiness importance，spec §6）：LLM/人工 importance 1-10。
  // TINYINT 无 DEFAULT → 旧库既有行 NULL = 未评分 = 永不降权（宁缺毋滥，不伪造默认分）。
  // 消费方=召回降权门（importancePenalty）/panel L1 详情/manual adjust 路由。
  { name: "importance", sqlType: "TINYINT", ftsSuffix: "UNINDEXED" },
] as const;
export type SoulColumnName = (typeof SOUL_COLUMNS)[number]["name"];
export const SOUL_COL_NAMES: SoulColumnName[] = SOUL_COLUMNS.map((c) => c.name);
/** FTS SELECT 片段（l1_records 主表 join/回查时用） */
export const SOUL_SELECT_FRAGMENT = SOUL_COL_NAMES.join(", ");
/** 便捷类型：soul 字段视图（可空）——v2-router handleAtomicUpdate 等消费方复用 */
export type SoulColumnsOf = Partial<Record<SoulColumnName, string | number | null>>;
