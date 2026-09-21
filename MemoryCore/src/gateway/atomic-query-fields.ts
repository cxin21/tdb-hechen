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
    updated_at: r.updated_time,
    // 灵魂字段透传（时空网格 UI 依赖）——逐位既有行为
    occurred_at: r.occurred_at,
    valid_start: r.valid_start,
    valid_end: r.valid_end,
    certainty: r.certainty,
    source: r.source,
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
    timestamp_start: text(r.timestamp_start),
    timestamp_end: text(r.timestamp_end),
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
