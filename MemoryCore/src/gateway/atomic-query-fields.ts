/**
 * D-0（2026-09-21）：/v3/atomic/query 出参映射补齐 7 字段——单一源纯函数。
 *
 * 设计依据：spec §4.1 十九列属性总表。scene_name/priority/session_key/session_id/
 * timestamp_str/timestamp_start/timestamp_end 属设计列，l1_records 落库已填
 * （2026-09-21 真数据探针：519-520/520），但 AtomicDetail 映射（v2-router.ts
 * handleAtomicQuery）此前丢弃 → UI 属性表"诚实缺列"。本模块补齐映射：
 * - 空串文本字段 → undefined（宁缺毋滥，UI 不造假值）；
 * - priority 为数值列（缺省 50 为有效值）原样透传；
 * - 既有字段（soul 六字段/三元组/version/metadata）映射逐位不回归。
 * 消费方：v2-router.ts handleAtomicQuery（唯一调用点——铁律 2 单一源）。
 */

import { parseSourceMessageIds } from "../core/store/l1-column-coerce.js";

/** 行形状：queryL1Paginated 返回的 L1RecordRow 子集（unknown 容错——列可为缺失）。 */
type RowLike = Record<string, unknown>;

const text = (v: unknown): string | undefined =>
  typeof v === "string" && v !== "" ? v : undefined;

const numOrUndef = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/**
 * AtomicDetail 行映射（D-0 扩展版）。
 * 与 v2-router.ts handleAtomicQuery 内联映射同构，但补齐 7 字段并抽出为
 * 可测纯函数；返回对象字段顺序与既有映射保持一致（增量追加在尾部）。
 */
export function handleAtomicQueryShape(r: RowLike): Record<string, unknown> {
  return {
    id: r.record_id ?? r.id,
    type: r.type,
    content: r.content,
    background: text(r.scene_name) ?? undefined,
    version: r.version ?? 0,
    team_id: r.team_id,
    user_id: r.user_id,
    agent_id: r.agent_id,
    task_id: r.task_id,
    created_at: r.created_time,
    // B 项：空串 = 未写（DDL DEFAULT ''）按缺省处理——出参恒为可用时间戳，不吐 ""。
    updated_at: text(r.updated_time) ?? text(r.timestamp_end),
    // 灵魂字段透传（时空网格 UI 依赖）——逐位既有行为
    occurred_at: r.occurred_at,
    valid_start: r.valid_start,
    valid_end: r.valid_end,
    certainty: r.certainty,
    // ADR-0025 C2：L1 source 列已删——API 字段名仍由 Kubb schema 声明，但已无任何来源（恒 undefined）。
    valence: r.valence,
    arousal: r.arousal,
    significance: r.significance,
    // C1 面板透传：metadata.coreRefs/recall_count 供 UI 价值标签与徽标
    metadata: parseMetadata(r.metadata_json),
    // ── D-0 新增七字段（spec §4.1 设计列补齐）──
    scene_name: text(r.scene_name),
    priority: numOrUndef(r.priority),
    session_key: text(r.session_key),
    session_id: text(r.session_id),
    timestamp_str: text(r.timestamp_str),
    // ADR-0025 C3：列已删，对外 timestamp_start 改取 timestamp_str（存量逐位相等，出参值不变）。
    timestamp_start: text(r.timestamp_str) ?? text(r.timestamp_start),
    timestamp_end: text(r.timestamp_end),
    // B 项（ADR-0025 决定 9，2026-11-04）：event_end_at = 事件结束时刻（新字段，与 updated_at
    // 「最近更新时间」分属两语义）。行上无 timestamp_end（search shape）时取行自带 event_end_at。
    event_end_at: text(r.timestamp_end) ?? text(r.event_end_at),
    // D-3：敏感性枚举透传（UI 属性表/徽章）
    sensitivity: text(r.sensitivity),
    // ADR-0025 复核补漏：importance 与行级溯源此前都没进入出参（面板因此恒缺两列）。
    // importance NULL=未评分 → undefined（宁缺毋滥，不伪造 0）；source_message_ids 恒为数组。
    importance: numOrUndef(r.importance),
    source_message_ids: parseSourceMessageIds(r.source_message_ids),
  };
}

/** v2-router 同名解析（原实现内联于此前的 handleAtomicQuery；语义逐位）。 */
function parseMetadata(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw !== "string" || raw === "") return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * D-0b（2026-09-21）：/v3/atomic/search 出参 shape——同族补 scene_name/priority。
 * 注意：搜索行类型（MemorySearchResultItem）不含 session_key/session_id/timestamp×3
 *（其 SELECT 面不含），故此处不透传这三组——诚实缺列，UI 宁缺毋滥。
 * 与 query shape 的差异：行含 score/created_at（ISO）且 metadata 已解析对象。
 */
export function handleAtomicSearchShape(r: RowLike): Record<string, unknown> {
  return {
    id: r.id,
    type: r.type,
    content: r.content,
    background: text(r.scene_name) ?? undefined,
    version: r.version ?? 0,
    team_id: r.team_id,
    user_id: r.user_id,
    agent_id: r.agent_id,
    task_id: r.task_id,
    created_at: r.created_at,
    // B 项：行内 updated_at 已按「updated_time || timestamp_end」解析；此处只归一空串。
    updated_at: text(r.updated_at) ?? text(r.event_end_at),
    // B 项（ADR-0025 决定 9，2026-11-04）：event_end_at = 事件结束时刻（memory_search 行已带
    // event_end_at=timestamp_end；query shape 同口径，两端属性表不再一端缺列）。
    event_end_at: text(r.timestamp_end) ?? text(r.event_end_at),
    score: r.score,
    occurred_at: r.occurred_at,
    valid_start: r.valid_start,
    valid_end: r.valid_end,
    certainty: r.certainty,
    // ADR-0025 C2：L1 source 列已删——API 字段名仍由 Kubb schema 声明，但已无任何来源（恒 undefined）。
    valence: r.valence,
    arousal: r.arousal,
    significance: r.significance,
    metadata: r.metadata,
    scene_name: text(r.scene_name),
    priority: numOrUndef(r.priority),
    sensitivity: text(r.sensitivity),
    // ADR-0025 复核补漏：搜索路与查询路同口径（面板搜索结果同样能看重要度与溯源）。
    importance: numOrUndef(r.importance),
    source_message_ids: parseSourceMessageIds(r.source_message_ids),
  };
}
