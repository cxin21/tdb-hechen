/**
 * #169 证据包（recall.evidencePack）：命中行按「turn + 同会话相邻窗」向外扩邻接行。
 *
 * 设计取舍（2026-10-31，Lead 批准）：
 * - **零 schema 变更**：邻接关系靠已有的 l1_records.session_id + timestamp_str 现算，
 *   不新增边、不新增索引、不新增存储。
 * - **纯函数**：本文件只做「从会话行表里挑邻接行」，不碰 store、不渲染文本；
 *   接线（queryL1Records 批量读 + formatMemoryLine 渲染 + 插块）在 hooks/auto-recall.ts。
 * - **必须带时间窗**：实测（D:/TDB/data/vectors.db，3514 行 / 975 session）
 *   同 session 相邻行里 40.8% scene_name 不同 —— 纯位置邻接会把别的话题拖进注入块；
 *   ±3 位置邻接对里 33% 的 |Δt|>30min。故 windowMinutes 是硬约束，不是可选美化。
 * - **缺省关**：enabled=false 时本模块不被调用（auto-recall 早退），生产行为逐位不变。
 *
 * 边界（本票不扩）：只作用于**注入块**，不改召回候选集（memoryLines 本体）；
 * 工具路（tdai_memory_search）不扩；pack 行不计入 turnCov/sessionCov 等覆盖率口径，
 * 由 bench 单列 adjacencyLines（防「扩行刷高指标」的自我污染）。
 */

/** 注入块里邻接行的后缀标注；bench 归因据此把 pack 行与 seed 行分开计数。 */
export const EVIDENCE_PACK_BADGE = "·[邻]";

export interface EvidencePackConfig {
  /** 缺省 false：不开就零行为变化。 */
  enabled: boolean;
  /** 每侧扩展行数（位置窗口），clamp 0..3 —— 对应 bench 四档 +0/+1/+2/+3。 */
  adjacent: number;
  /** 时间窗（分钟）；两侧时间差超窗不扩。0 = 不限时间（只按位置）。 */
  windowMinutes: number;
  /** 总帽：一次召回最多额外插入多少行邻接，先到先得。 */
  maxExtraLines: number;
  /** 单会话行数硬上限：超过则整段不扩（防长会话把 queryL1Records 拖成批量读）。 */
  maxSessionRows: number;
}

export const DEFAULT_EVIDENCE_PACK: EvidencePackConfig = {
  enabled: false,
  adjacent: 1,
  windowMinutes: 30,
  maxExtraLines: 6,
  maxSessionRows: 400,
};

const clampInt = (v: unknown, lo: number, hi: number, dflt: number): number => {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : typeof v === "string" && v.trim() !== "" ? Math.round(Number(v)) : NaN;
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
};

/** 宽松解析（config.ts 已做一遍类型化解析；这里作为独立纯函数兜底，便于测试与 bench 复用）。 */
export function evidencePackConfigOf(raw: unknown): EvidencePackConfig {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    enabled: o.enabled === true,
    adjacent: clampInt(o.adjacent, 0, 3, DEFAULT_EVIDENCE_PACK.adjacent),
    windowMinutes: clampInt(o.windowMinutes, 0, 24 * 60, DEFAULT_EVIDENCE_PACK.windowMinutes),
    maxExtraLines: clampInt(o.maxExtraLines, 0, 24, DEFAULT_EVIDENCE_PACK.maxExtraLines),
    maxSessionRows: clampInt(o.maxSessionRows, 1, 5000, DEFAULT_EVIDENCE_PACK.maxSessionRows),
  };
}

/** 接线方喂进来的会话行（只带挑选需要的字段；渲染由调用方按 recordId 回查原始行）。 */
export interface EvidencePackRow {
  recordId: string;
  sessionId?: string | null;
  /** 事件时间（毫秒）。null/undefined = 时间未知：不参与时间窗判定（宁可多扩，也不因缺时间戳整段失效）。 */
  at?: number | null;
}

export interface EvidencePackStats {
  enabled: boolean;
  adjacent: number;
  windowMinutes: number;
  maxExtraLines: number;
  /** seed 行数（= memoryLines 条数，命中行）。 */
  seedLines: number;
  /** 其中带 recordId + sessionId、可参与扩展的 seed 数。 */
  seedWithSession: number;
  /** 实际插入的邻接行数。 */
  adjacencyLines: number;
  /** seed 缺 recordId/sessionId，无从定位（含结论行、无来源行）。 */
  skippedNoSession: number;
  /** seed 的 recordId 不在它自己的 session 行表里（库侧缺行/被归档）。 */
  skippedNoSeedRow: number;
  /** 越出时间窗被拒的候选行数。 */
  skippedWindow: number;
  /** 触达 maxExtraLines 后被拒的候选行数。 */
  skippedCap: number;
  /** 会话行数超 maxSessionRows 被整段跳过的 seed 数。 */
  skippedSessionTooLarge: number;
  /** 实际查询过的会话数（去重）。 */
  sessionsQueried: number;
}

export interface SelectEvidencePackArgs<T extends EvidencePackRow> {
  /** 命中行（注入顺序），只需 recordId/sessionId。 */
  seeds: Array<{ recordId?: string | null; sessionId?: string | null }>;
  /** session_id → 该会话全部行（顺序无所谓，本函数内部按 at 升序稳定排序）。 */
  rowsBySession: Map<string, T[]>;
  cfg: EvidencePackConfig;
}

const atOf = (r: EvidencePackRow): number | null =>
  typeof r.at === "number" && Number.isFinite(r.at) ? r.at : null;

/**
 * 挑邻接行。返回 extrasBySeed（seed 下标 → 该 seed 之后要插入的行，按距离由近到远、同距离左先右后）
 * 与恒定的统计块（enabled=true 时即使全零也要出现在 journal 里 —— Lead 要求③）。
 */
export function selectEvidencePackNeighbors<T extends EvidencePackRow>(
  args: SelectEvidencePackArgs<T>,
): { extrasBySeed: Map<number, T[]>; stats: EvidencePackStats } {
  const { seeds, rowsBySession, cfg } = args;
  const stats: EvidencePackStats = {
    enabled: cfg.enabled,
    adjacent: cfg.adjacent,
    windowMinutes: cfg.windowMinutes,
    maxExtraLines: cfg.maxExtraLines,
    seedLines: seeds.length,
    seedWithSession: 0,
    adjacencyLines: 0,
    skippedNoSession: 0,
    skippedNoSeedRow: 0,
    skippedWindow: 0,
    skippedCap: 0,
    skippedSessionTooLarge: 0,
    sessionsQueried: 0,
  };
  const extrasBySeed = new Map<number, T[]>();
  if (!cfg.enabled || cfg.adjacent <= 0 || cfg.maxExtraLines <= 0 || seeds.length === 0) return { extrasBySeed, stats };

  const seedIds = new Set<string>();
  for (const s of seeds) if (s.recordId) seedIds.add(s.recordId);
  // 同一行可能同时是两个 seed 的邻居：全局只注入一次（总帽也是全局的，口径一致）。
  const injectedIds = new Set<string>();

  // 会话行一次排序，多个 seed 复用（同一会话常被多行命中）。
  const sortedBySession = new Map<string, T[]>();
  const sortedOf = (sid: string): { kind: "ok"; rows: T[] } | { kind: "missing" } | { kind: "tooLarge" } => {
    const cached = sortedBySession.get(sid);
    if (cached) return { kind: "ok", rows: cached };
    const rows = rowsBySession.get(sid);
    if (!rows) return { kind: "missing" };
    if (rows.length > cfg.maxSessionRows) return { kind: "tooLarge" };
    const sorted = rows
      .map((r, i) => ({ r, i }))
      .sort((a, b) => {
        const x = atOf(a.r);
        const y = atOf(b.r);
        if (x === null && y === null) return a.i - b.i;
        if (x === null) return 1;
        if (y === null) return -1;
        return x - y || a.i - b.i;
      })
      .map((e) => e.r);
    sortedBySession.set(sid, sorted);
    return { kind: "ok", rows: sorted };
  };

  const windowMs = cfg.windowMinutes > 0 ? cfg.windowMinutes * 60_000 : 0;

  for (let si = 0; si < seeds.length; si++) {
    const seed = seeds[si];
    const recordId = seed.recordId ?? null;
    const sid = seed.sessionId ?? null;
    if (!recordId || !sid) {
      stats.skippedNoSession++;
      continue;
    }
    stats.seedWithSession++;
    const found = sortedOf(sid);
    if (found.kind === "tooLarge") {
      stats.skippedSessionTooLarge++;
      continue;
    }
    if (found.kind === "missing") {
      // 会话行表缺失（会话未被读到/已归档）：与「seed 不在行表」同口径，都是定位不到。
      stats.skippedNoSeedRow++;
      continue;
    }
    const sorted = found.rows;
    stats.sessionsQueried = sortedBySession.size;
    const idx = sorted.findIndex((r) => r.recordId === recordId);
    if (idx < 0) {
      stats.skippedNoSeedRow++;
      continue;
    }
    const seedAt = atOf(sorted[idx]);
    const picked: T[] = [];
    // 由近到远扩：同距离先左后右（位置序），与「按 turn 展开」的直觉一致。
    for (let d = 1; d <= cfg.adjacent; d++) {
      for (const j of [idx - d, idx + d]) {
        if (j < 0 || j >= sorted.length) continue;
        const cand = sorted[j];
        if (seedIds.has(cand.recordId)) continue; // 已在命中集：不重复注入
        if (injectedIds.has(cand.recordId)) continue; // 已被别的 seed 扩过：不重复注入
        const candAt = atOf(cand);
        if (windowMs > 0 && seedAt !== null && candAt !== null && Math.abs(candAt - seedAt) > windowMs) {
          stats.skippedWindow++;
          continue;
        }
        if (stats.adjacencyLines >= cfg.maxExtraLines) {
          stats.skippedCap++;
          continue;
        }
        picked.push(cand);
        injectedIds.add(cand.recordId);
        stats.adjacencyLines++;
      }
    }
    if (picked.length > 0) extrasBySeed.set(si, picked);
  }
  return { extrasBySeed, stats };
}
