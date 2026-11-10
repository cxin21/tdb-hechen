/**
 * S4 特质漂移：判侧只对本轮新增事件投票（G3），读侧投影标签。
 *
 * 铁律（spec §3）：
 *  - 净票 s_j = tanh(net_j / 3)；state ← clamp(state + α·s, -1, 1)；|net| < 2 不动。
 *  - 单 tick 每轴 |Δ| ≤ TRAIT_MAX_STEP（0.05），超限整轴拒绝并记账。
 *  - Σ|state_j| ≤ TRAIT_L1_MAX（0.5）：超限按比例缩放（保方向），并标 l1Clamped。
 *  - 判侧只投「本轮新增」的 episode：窗口内旧事件重投会让漂移凭空加速。
 *  - 新标签必须先过余弦去重（≥0.85 并入），同义不许并排；证据 < minEvidence 不受理。
 */
import {
  SOUL_AXES,
  TRAIT_DRIFT_ALPHA,
  TRAIT_L1_MAX,
  TRAIT_LABEL_MERGE_SIM,
  TRAIT_MAX_STEP,
  TRAIT_MIN_NET,
  clamp,
  cosine,
  emptyAxisVector,
  l1Norm,
  normalizeDirection,
  normalizeTraitL1,
  type AxisVector,
  type SoulAxis,
} from "./traits.js";

export interface TraitVote {
  episodeId: string;
  axis: SoulAxis;
  delta: number;
  quote?: string;
  why?: string;
}

export interface TraitLabelProposal {
  label: string;
  definition: string;
  direction: AxisVector;
  evidenceIds: string[];
  gloss?: string;
}

export interface TraitProtocolOutput {
  votes: TraitVote[];
  labelProposals: TraitLabelProposal[];
  invalid: number;
}

export interface TraitAxisDrift {
  axis: SoulAxis;
  net: number;
  delta: number;
  reason?: "net_below_min" | "step_exceeded";
}

export interface TraitDriftResult {
  state: AxisVector;
  changed: boolean;
  axes: TraitAxisDrift[];
  votes: number;
  rejected: number;
  l1Clamped: boolean;
}

export interface DriftOptions {
  /** G3：只接受这些 episode 的票；缺省=全部接受（纯函数测试用）。 */
  newEpisodeIds?: Iterable<string>;
  alpha?: number;
  maxStep?: number;
  l1Max?: number;
  minNet?: number;
}

const round4 = (n: number): number => Number(n.toFixed(4));

/** 一票最多两轴：按输入顺序保留前两条，多余的计 rejected（判侧纪律，不是模型自觉）。 */
function capVotesPerEpisode(votes: TraitVote[]): { kept: TraitVote[]; rejected: number } {
  const seen = new Map<string, number>();
  const kept: TraitVote[] = [];
  let rejected = 0;
  for (const v of votes) {
    const n = seen.get(v.episodeId) ?? 0;
    if (n >= 2) {
      rejected += 1;
      continue;
    }
    seen.set(v.episodeId, n + 1);
    kept.push(v);
  }
  return { kept, rejected };
}

export function driftTraits(state: AxisVector, votes: TraitVote[], opts: DriftOptions = {}): TraitDriftResult {
  const alpha = opts.alpha ?? TRAIT_DRIFT_ALPHA;
  const maxStep = opts.maxStep ?? TRAIT_MAX_STEP;
  const l1Max = opts.l1Max ?? TRAIT_L1_MAX;
  const minNet = opts.minNet ?? TRAIT_MIN_NET;
  const allowed = opts.newEpisodeIds ? new Set(opts.newEpisodeIds) : null;

  let rejected = 0;
  const valid: TraitVote[] = [];
  for (const v of votes) {
    if (!SOUL_AXES.includes(v.axis)) { rejected += 1; continue; }
    if (v.delta !== 1 && v.delta !== -1 && v.delta !== 0) { rejected += 1; continue; }
    if (typeof v.episodeId !== "string" || !v.episodeId.startsWith("ep-")) { rejected += 1; continue; }
    // G3：窗口内旧事件不重投。
    if (allowed && !allowed.has(v.episodeId)) { rejected += 1; continue; }
    valid.push(v);
  }
  const capped = capVotesPerEpisode(valid);
  rejected += capped.rejected;

  const nets = emptyAxisVector();
  for (const v of capped.kept) nets[v.axis] += v.delta;

  // 入口 L1 归一（幂等）：存量行可能超预算（B2：种子绕过 L1），必须先回到预算内再走步长，
  // 否则「从 2.1 出发走 ±0.05」的位移会被末尾缩放大打折扣，步长约束形同虚设。
  const base = normalizeTraitL1(state, l1Max);
  const entryClamped = l1Norm(toAxisVectorLoose(state)) > l1Max + 1e-9;
  const next = { ...base };
  const axes: TraitAxisDrift[] = [];
  let changed = entryClamped;
  for (const axis of SOUL_AXES) {
    const net = nets[axis];
    if (Math.abs(net) < minNet) {
      axes.push({ axis, net, delta: 0, reason: "net_below_min" });
      continue;
    }
    const proposed = clamp(base[axis] + alpha * Math.tanh(net / 3), -1, 1);
    const delta = proposed - base[axis];
    if (Math.abs(delta) > maxStep) {
      axes.push({ axis, net, delta: 0, reason: "step_exceeded" });
      rejected += 1;
      continue;
    }
    if (Math.abs(delta) > 1e-9) changed = true;
    next[axis] = round4(proposed);
    axes.push({ axis, net, delta: round4(next[axis] - base[axis]) });
  }

  // L1 预算：超限等比缩放保方向（不整轴清零，避免「一轴涨就把另一轴抹平」）。
  let l1Clamped = entryClamped;
  const l1 = SOUL_AXES.reduce((s, a) => s + Math.abs(next[a]), 0);
  if (l1 > l1Max) {
    const factor = l1Max / l1;
    let total = 0;
    for (const a of SOUL_AXES) {
      // 向零截断到 4 位，防止四舍五入把总和又推回 0.5001。
      next[a] = Math.trunc(next[a] * factor * 1e4) / 1e4;
      total += Math.abs(next[a]);
    }
    if (total > l1Max) {
      const f2 = l1Max / total;
      for (const a of SOUL_AXES) next[a] = Math.trunc(next[a] * f2 * 1e4) / 1e4;
    }
    l1Clamped = true;
    changed = true;
  }

  return { state: next, changed, axes, votes: capped.kept.length, rejected, l1Clamped };
}

/** 只读取轴值做 L1 检查，容忍脏输入（不 clamp 单轴，保持「超限」可被判出）。 */
function toAxisVectorLoose(input: AxisVector): AxisVector {
  const out = emptyAxisVector();
  for (const axis of SOUL_AXES) {
    const v = Number(input[axis]);
    if (Number.isFinite(v)) out[axis] = v;
  }
  return out;
}

/** 从模型输出里取 JSON（允许三反引号围栏与前后废话）。 */
function extractJson(raw: string): unknown {
  const text = (raw ?? "").trim();
  if (text === "") return null;
  const fence = new RegExp(String.fromCharCode(96, 96, 96) + "(?:json)?\\s*([\\s\\S]*?)" + String.fromCharCode(96, 96, 96), "i");
  const matched = fence.exec(text);
  const body = matched ? matched[1] : text;
  try {
    return JSON.parse(body);
  } catch {
    const start = body.indexOf("{");
    const end = body.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(body.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function toAxisVector(raw: unknown): AxisVector | null {
  if (!raw || typeof raw !== "object") return null;
  const src = raw as Record<string, unknown>;
  const v = emptyAxisVector();
  let any = false;
  for (const a of SOUL_AXES) {
    const n = Number(src[a]);
    if (!Number.isFinite(n)) continue;
    v[a] = clamp(n, -1, 1);
    any = true;
  }
  return any ? normalizeDirection(v) : null;
}

/** [TRAIT-PROTOCOL v1] 输出解析：所有字段都过确定性校验，坏行丢弃并计数。 */
export function parseTraitProtocolOutput(raw: string): TraitProtocolOutput {
  const json = extractJson(raw) as { votes?: unknown; label_proposals?: unknown; labelProposals?: unknown } | null;
  if (!json || typeof json !== "object") return { votes: [], labelProposals: [], invalid: 1 };
  let invalid = 0;
  const votes: TraitVote[] = [];
  for (const item of Array.isArray(json.votes) ? json.votes : []) {
    const v = item as Record<string, unknown>;
    const axis = String(v.axis ?? "") as SoulAxis;
    const delta = Number(v.delta);
    const episodeId = String(v.episode_id ?? v.episodeId ?? "");
    if (!SOUL_AXES.includes(axis) || ![-1, 0, 1].includes(delta) || !episodeId.startsWith("ep-")) {
      invalid += 1;
      continue;
    }
    const quote = typeof v.quote === "string" ? v.quote.slice(0, 40) : undefined;
    const why = typeof v.why === "string" ? v.why.slice(0, 20) : undefined;
    votes.push({ episodeId, axis, delta, quote, why });
  }
  const proposalsRaw = Array.isArray(json.label_proposals)
    ? json.label_proposals
    : Array.isArray(json.labelProposals)
      ? json.labelProposals
      : [];
  const labelProposals: TraitLabelProposal[] = [];
  for (const item of proposalsRaw) {
    const p = item as Record<string, unknown>;
    const label = typeof p.label === "string" ? p.label.trim() : "";
    const definition = typeof p.definition === "string" ? p.definition.trim() : "";
    const direction = toAxisVector(p.direction);
    const evidenceIds = Array.isArray(p.evidence_ids)
      ? p.evidence_ids.filter((x): x is string => typeof x === "string")
      : [];
    if (label === "" || label.length > 8 || definition === "" || !direction || evidenceIds.length === 0) {
      invalid += 1;
      continue;
    }
    labelProposals.push({
      label,
      definition: definition.slice(0, 120),
      direction,
      evidenceIds,
      gloss: typeof p.gloss === "string" ? p.gloss.slice(0, 40) : undefined,
    });
  }
  return { votes, labelProposals, invalid };
}

export interface TraitLabelRow {
  label: string;
  definition: string;
  gloss: string;
  anchor: string;
  direction: AxisVector;
  evidence: number;
  status: "seed" | "proposed" | "admitted" | "dormant";
  firstSeen: string;
  lastSeen: string;
  aliases: string[];
  protocolVersion: string;
}

export interface LabelResolveResult {
  admitted: TraitLabelRow[];
  merged: Array<{ label: string; into: string; similarity: number }>;
  /** 被并入的既有行（已改名/追加别名/更新 lastSeen），供调用方整体 upsert。 */
  updated: TraitLabelRow[];
  rejected: Array<{ label: string; reason: "insufficient_evidence" }>;
}

/**
 * 判据 7：新标签不改代码也要能进；进之前必须余弦去重——同义不许并排。
 * 与既有（库内 + 种子）相似 ≥ TRAIT_LABEL_MERGE_SIM 即并入更早的那条，只追加证据与别名。
 */
export function resolveLabelProposals(
  proposals: TraitLabelProposal[],
  existing: TraitLabelRow[],
  opts: { now: string; minEvidence?: number; mergeSim?: number; protocolVersion?: string } = { now: "" },
): LabelResolveResult {
  const minEvidence = opts.minEvidence ?? 3;
  const mergeSim = opts.mergeSim ?? TRAIT_LABEL_MERGE_SIM;
  const pool = existing.map((r) => ({ ...r, aliases: [...r.aliases] }));
  const admitted: TraitLabelRow[] = [];
  const merged: LabelResolveResult["merged"] = [];
  const updated: TraitLabelRow[] = [];
  const rejected: LabelResolveResult["rejected"] = [];

  for (const p of proposals) {
    const evidence = new Set(p.evidenceIds);
    if (evidence.size < minEvidence) {
      rejected.push({ label: p.label, reason: "insufficient_evidence" });
      continue;
    }
    let best: { row: TraitLabelRow; sim: number } | undefined;
    for (const row of pool) {
      if (row.label === p.label) { best = { row, sim: 1 }; break; }
      const sim = cosine(p.direction, row.direction);
      if (sim >= mergeSim && (!best || sim > best.sim)) best = { row, sim };
    }
    if (best) {
      const row = best.row;
      row.aliases = Array.from(new Set([...row.aliases, p.label])).filter((a) => a !== row.label);
      row.evidence = Math.max(row.evidence, evidence.size);
      row.lastSeen = opts.now;
      merged.push({ label: p.label, into: row.label, similarity: Number(best.sim.toFixed(3)) });
      if (!updated.includes(row)) updated.push(row);
      continue;
    }
    const row: TraitLabelRow = {
      label: p.label,
      definition: p.definition,
      gloss: p.gloss ?? "",
      anchor: "",
      direction: p.direction,
      evidence: evidence.size,
      status: "admitted",
      firstSeen: opts.now,
      lastSeen: opts.now,
      aliases: [],
      protocolVersion: opts.protocolVersion ?? "v1",
    };
    pool.push(row);
    admitted.push(row);
  }
  return { admitted, merged, updated, rejected };
}

/** 种子标签转成库行（首次启动落 18 条），后续合并/退役都基于同一形状。
 *  S10 修订（2026-11-07）：evidence 不再对 18 条一律写 3。
 *  显示门槛是「evidence ≥ 3」，出厂词表本身不是证据——给全部种子写 3 等于让一个没设过
 *  任何特质的租户在卡里凭空宣告 5 条性格（生产实测：空 persona 仍渲染「倔/冷淡/体贴/务实/严谨 0.5」）。
 *  传 declared（表单里真正选中的标签）时，只有被选中的种子拿到证据；不传时保持旧行为（测试与迁移兼容）。 */
export function seedLabelRows(
  seed: ReadonlyArray<{ label: string; definition: string; gloss: string; anchor: string; direction: AxisVector }>,
  now: string,
  opts: { declared?: readonly string[] } = {},
): TraitLabelRow[] {
  const declared = opts.declared ? new Set(opts.declared) : null;
  return seed.map((s) => ({
    label: s.label,
    definition: s.definition,
    gloss: s.gloss,
    anchor: s.anchor,
    direction: s.direction,
    evidence: declared ? (declared.has(s.label) ? 3 : 0) : 3,
    status: "seed" as const,
    firstSeen: now,
    lastSeen: now,
    aliases: [],
    protocolVersion: "v1",
  }));
}
