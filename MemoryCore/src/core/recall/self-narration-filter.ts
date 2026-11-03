/**
 * A3（P1，2026-11-02）：agent 自述行的**读侧注入面过滤**（纯函数 + 一个可注入的批量读）。
 *
 * 背景（研究文档 §A3）：L1 里混着"AI 于 X 完成了 Y"这类自述行——它们不是用户/项目的事实，
 * 却与事实行争同一份注入预算。写侧在命中 agent 自述形态时把 `metadata.actor` 写 "agent"
 * （`extraction.actorTagging`，缺省 false）；本模块决定这些行**要不要进注入面**。
 *
 * 契约（缺省逐位现状）：
 *  - `enabled=false` → 恒等返回，不查库（零 I/O）。
 *  - 查询自指（`isAssistantRecallQuery` 命中）→ **不过滤**：用户就是在问"你先前说了/做了什么"。
 *  - `actor === "agent"` → 丢；未知 actor / 行无 recordId / metas 缺失 → **保留**
 *    （宁留勿误杀：过滤是预算优化，不是安全门）。
 *  - `loadActorByIds` 的 fetch 抛错 → 整体降级为空表（等于全部未知 → 全部保留），绝不阻断召回。
 *
 * A4（2026-11-03）：**标签 ≠ 启发式**，两条口径必须分清（本文件的读侧只认标签）：
 *  - 标签（`metadata.actor="agent"`）是**写时裁决**：行落库那一刻按当时版本的
 *    `isAgentNarration` + `extraction.actorTagging` 开关决定，随后被冻结进 metadata；
 *  - 启发式（`narrationTagCoverage` 里的 `heuristicHits`）是**当前版本重判**同一行文本，
 *    用于对账写侧覆盖率，不参与过滤。
 * 两者必然有差：开关未开 / 判定版本演进（A4 收紧了误判）/ dedup `merged_content` 改写 /
 * 存量旧行未回填。读侧**绝不**按启发式 reinterpret 历史行——那会让一次判定规则变更
 * 静默改写已经落库的语义（且与写侧标签互相矛盾）；要收敛差异只能回填/重写写侧标签。
 */
import { isAgentNarration } from "../record/agent-narration.js";

/** 写侧标注值（与 `extraction.actorTagging` 同一字面量；两侧硬编码同值，不引依赖）。 */
export const SELF_NARRATION_ACTOR = "agent";

/** VDB `documentIds` 单次上限（见 L1QueryFilter.recordIds 注释：max 20）。 */
export const ACTOR_LOOKUP_CHUNK = 20;

export interface SelfNarrationFilterInput {
  lines: string[];
  /** 与 lines 平行的 #166 metas；缺省/更短 → 缺 meta 的行按未知保留。 */
  metas?: Array<{ recordId?: string } | undefined>;
  /** recordId → actor（缺键 = 未知）。 */
  actorOf: Map<string, string | undefined>;
  enabled: boolean;
  /** 查询自指（`isAssistantRecallQuery`）：true 时整段恒等返回。 */
  isSelfQuery: boolean;
}

export interface SelfNarrationFilterResult {
  keptIndexes: number[];
  dropped: number;
  /** 参与判定的行数（有 recordId 的行；不含未知行）。 */
  scanned: number;
  droppedRecordIds: string[];
  /** 提前退出原因（journal/日志用）：不填 = 正常过滤。 */
  skipped?: "disabled" | "self-query" | "empty";
}

/** 纯函数：返回保留下标（顺序不变）。调用方按 keptIndexes 重排 lines/metas/scores。 */
export function filterSelfNarrationLines(input: SelfNarrationFilterInput): SelfNarrationFilterResult {
  const { lines, metas, actorOf, enabled, isSelfQuery } = input;
  const all = lines.map((_, i) => i);
  if (!enabled) return { keptIndexes: all, dropped: 0, scanned: 0, droppedRecordIds: [], skipped: "disabled" };
  if (lines.length === 0) return { keptIndexes: [], dropped: 0, scanned: 0, droppedRecordIds: [], skipped: "empty" };
  if (isSelfQuery) return { keptIndexes: all, dropped: 0, scanned: 0, droppedRecordIds: [], skipped: "self-query" };

  const keptIndexes: number[] = [];
  const droppedRecordIds: string[] = [];
  let scanned = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const rid = metas?.[i]?.recordId;
    if (!rid) {
      keptIndexes.push(i); // 未知来源：保留
      continue;
    }
    scanned += 1;
    const actor = actorOf.get(rid);
    if (typeof actor === "string" && actor === SELF_NARRATION_ACTOR) {
      droppedRecordIds.push(rid);
      continue;
    }
    keptIndexes.push(i);
  }
  return { keptIndexes, dropped: droppedRecordIds.length, scanned, droppedRecordIds };
}

export interface ActorLookupRow {
  record_id: string;
  metadata_json?: string | null;
}

/**
 * 批量读 recordId → metadata.actor（**只读**，按 20 分片）。
 * 任何一片 fetch 抛错 → 该片视为未知（不阻断召回，也不造假值）。
 */
export async function loadActorByIds(
  recordIds: string[],
  fetchRows: (ids: string[]) => ActorLookupRow[] | Promise<ActorLookupRow[]>,
): Promise<Map<string, string | undefined>> {
  const actorOf = new Map<string, string | undefined>();
  const uniq = Array.from(new Set(recordIds.filter((id) => typeof id === "string" && id.length > 0)));
  for (let i = 0; i < uniq.length; i += ACTOR_LOOKUP_CHUNK) {
    const batch = uniq.slice(i, i + ACTOR_LOOKUP_CHUNK);
    let rows: ActorLookupRow[] = [];
    try {
      rows = await fetchRows(batch);
    } catch {
      continue; // 降级：本片未知
    }
    for (const row of rows ?? []) {
      if (!row || typeof row.record_id !== "string") continue;
      const raw = row.metadata_json;
      if (typeof raw !== "string" || raw.length === 0) continue;
      let meta: unknown;
      try {
        meta = JSON.parse(raw);
      } catch {
        continue; // 本仓容忍损坏 metadata_json：跳过该行
      }
      if (!meta || typeof meta !== "object") continue;
      const actor = (meta as Record<string, unknown>).actor;
      if (typeof actor === "string" && actor.length > 0) actorOf.set(row.record_id, actor);
    }
  }
  return actorOf;
}

/** `narrationTagCoverage` 的输入行：只看 content 与 metadata.actor，别的键不参与。 */
export interface NarrationCoverageRow {
  content?: string;
  /** 行 metadata.actor；缺省/非字符串 = 未标注。 */
  actor?: string;
}

export interface NarrationTagCoverage {
  /** 参与统计的行数（含缺 content 的行）。 */
  total: number;
  /** 真正带 `actor="agent"` 的行 —— 读侧过滤的唯一依据。 */
  tagged: number;
  /** 用**当前版本** isAgentNarration 重判会命中的行（判定版本口径）。 */
  heuristicHits: number;
  /** 命中启发式但没有 agent 标签 = 写侧覆盖缺口（开关未开/存量行/合并改写）。 */
  taggedMiss: number;
}

/**
 * A4（2026-11-03）：写侧标签覆盖率对账（**只读纯函数**，不做 I/O，不供过滤使用）。
 *
 * 三个数字回答三个不同问题，不可互相替代：
 *  - `tagged`：读侧真正会丢的行（标签是写时裁决的冻结产物）；
 *  - `heuristicHits`：当前判定版本会命中多少行（若现在开启开关，大致能覆盖多少）；
 *  - `taggedMiss`：`heuristicHits` 的子集 —— 命中却没标签，就是写侧缺口。
 * 注意 `taggedMiss` 只算"漏标"；"错标"（有标签但当前启发式不命中）不在此列，
 * 因为读侧仍会按标签丢它（口径差异由本模块头部注释解释，收敛只能靠回填写侧标签）。
 */
export function narrationTagCoverage(rows: ReadonlyArray<NarrationCoverageRow>): NarrationTagCoverage {
  let tagged = 0;
  let heuristicHits = 0;
  let taggedMiss = 0;
  for (const row of rows) {
    const isTagged = row?.actor === SELF_NARRATION_ACTOR;
    const hit = typeof row?.content === "string" && isAgentNarration(row.content);
    if (isTagged) tagged += 1;
    if (hit) {
      heuristicHits += 1;
      if (!isTagged) taggedMiss += 1;
    }
  }
  return { total: rows.length, tagged, heuristicHits, taggedMiss };
}
