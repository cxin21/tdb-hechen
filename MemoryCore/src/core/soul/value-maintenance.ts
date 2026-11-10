/**
 * P7 §4.9 价值层写者：soul_values + 写入侧红线 gate（shadow）+ 两难。
 *
 * 三条取舍写在这里，免得日后重推：
 *
 * 1) 价值只从**有证据的来源**投影，句子里的每个字都能回指到某条 episode 或某条人格条目：
 *    - declared：人格层 layer='values' 的条目（人自己说的/被反复确认过的取舍）。
 *    - observed：episode 里同时有「我选了什么」和「代价是什么」的那一类（真实的取舍行为）。
 *      没有代价的顺手动作不是价值——「我选了继续」这种句子谁都能说。
 *    value_id = 语句规范化哈希：同一句话再长一次不翻倍，改口径才出新 id。
 *
 * 2) 写入侧 gate 是 **shadow**：对本 tick 的 episode 跑一遍 generation 阶段的红线判定，
 *    命中就落 soul_gate_log，**但不拦写入**。现在拦它没有意义（episode 已经挖出来了，
 *    拦掉只会让记忆比现实更干净），等宿主 pre-tool 落地后再谈「生成前拦」。
 *    这里刻意不传 audience：写入侧没有听众，privacy 规则此刻判不了——判不了就不判，
 *    绝不拿「没有听众」当「对所有人公开」。
 *
 * 3) 两难只在**不同轴同时被要求**时记（例如「如实说」与「替他保密」），
 *    记当时两侧的理由与选择，regret 留给一周后回看；不合并进价值条目。
 */

import { createHash } from "node:crypto";

import type { CoreTenant } from "../store/types.js";
import type { SoulValueRow, SoulValueInsert, SoulValueSource } from "../store/soul-event-types.js";
import type { PersonaItem, SoulEpisode } from "./types.js";
import {
  buildSoulDilemma,
  buildSoulGateLogRow,
  evaluateSoulGate,
  toShadowOutcome,
  type SoulGateEvaluation,
  type SoulGateOutcome,
} from "./value-gate.js";

/** 模块只依赖这些方法，且全部可选：缺实现时各自跳过，绝不伪造价值。 */
export interface ValueStorePort {
  upsertSoulValue?: (
    tenant: CoreTenant | undefined,
    insert: SoulValueInsert,
  ) => Promise<SoulValueRow | null> | SoulValueRow | null;
  listSoulValues?: (
    tenant?: CoreTenant,
    opts?: { status?: "active" | "retired"; source?: SoulValueSource; limit?: number },
  ) => Promise<SoulValueRow[]> | SoulValueRow[];
  insertSoulGateLog?: (
    tenant: CoreTenant | undefined,
    rows: SoulGateLogInsertLike[],
  ) => Promise<{ inserted: number }> | { inserted: number };
  insertSoulDilemma?: (
    tenant: CoreTenant | undefined,
    insert: SoulDilemmaInsertLike,
  ) => Promise<unknown> | unknown;
  listSoulPersona?: (tenant?: CoreTenant, opts?: { includeSuperseded?: boolean }) => Promise<PersonaItem[]> | PersonaItem[];
}

/** 与 soul_gate_log / soul_dilemma 的插入载荷同形（此处只取用到的字段，避免把 store 类型搬进 soul 层）。 */
export type SoulGateLogInsertLike = ReturnType<typeof buildSoulGateLogRow>;
export type SoulDilemmaInsertLike = NonNullable<ReturnType<typeof buildSoulDilemma>>;

export interface ValueMaintenanceResult {
  /** 候选价值条数（去重后）。 */
  candidates: number;
  /** 其中来自人格层（declared）的条数。 */
  declared: number;
  /** 其中来自 episode 取舍（observed）的条数。 */
  observed: number;
  /** 真正写库的条数（新建 + 语句/优先级变化的更新）。 */
  written: number;
  /** 已有同 id 且语句未变、跳过的条数。 */
  unchanged: number;
  /** 因缺证据（没有取舍句/没有代价/空语句）被丢弃的候选数。 */
  skippedNoEvidence: number;
  /** 跑过 gate 的 episode 数。 */
  gateEvaluated: number;
  /** 其中命中至少一条红线的条数。 */
  gateHits: number;
  /** 落进 soul_gate_log 的行数。 */
  gateLogged: number;
  /** 记下的两难条数。 */
  dilemmas: number;
}

export interface ValueMaintenanceArgs {
  store: ValueStorePort;
  tenant?: CoreTenant;
  /** 本 tick 的事件源；缺省不挖 observed（只投影已声明价值）。 */
  episodes?: readonly SoulEpisode[];
  /** 本 tick 的人格条目快照；缺省时尝试从 store.listSoulPersona 读。 */
  persona?: readonly PersonaItem[];
  now?: string;
  logger?: { warn?: (msg: string) => void };
}

/** 价值语句上限：values 层注入成句用，超过就截断（不截断语义，只截长度）。 */
const VALUE_STATEMENT_MAX_CHARS = 160;

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** 规范化：判定「是不是同一句价值」时抹掉空白与包裹标点。 */
function squash(text: string): string {
  return String(text ?? "").replace(/[\s「」『』“”‘’"'…·,，。；;:：!！?？、]/g, "");
}

function shorten(text: string, max: number): string {
  const body = String(text ?? "").trim();
  if (body.length <= max) return body;
  return body.slice(0, Math.max(0, max - 1)) + "…";
}

/** 语句 → 稳定 id：同一句话重投影不翻倍；改字就是新一条（旧行由面板/后续 retire）。 */
export function soulValueIdFor(statement: string): string {
  const key = squash(statement);
  return "val-" + createHash("sha256").update(key).digest("hex").slice(0, 16);
}

/** 一条 episode 的取舍句。没有「选择 + 代价」就不算价值（宁可少一条，不可编一条）。 */
export function valueStatementFromEpisode(episode: SoulEpisode): string | null {
  const stance = String(episode.agentStance ?? "").trim();
  const cost = String(episode.cost ?? "").trim();
  if (stance === "" || cost === "") return null;
  const title = String(episode.title ?? "").trim();
  const head = title === "" ? "" : "在「" + title + "」上，";
  return shorten(head + "我选了「" + stance + "」，代价是「" + cost + "」。", VALUE_STATEMENT_MAX_CHARS);
}

interface ValueCandidate {
  statement: string;
  source: SoulValueSource;
  priority: number;
  evidenceEventIds: string[];
}

/** 一条 episode 只能证明一天；留成函数是为了日后按证据天数提权（当前恒 0/1）。 */
function numberOfEvidenceDays(episode: SoulEpisode): number {
  return String(episode.day ?? "") === "" ? 0 : 1;
}

function collectCandidates(
  args: ValueMaintenanceArgs,
  persona: readonly PersonaItem[],
): { candidates: ValueCandidate[]; declared: number; observed: number; skippedNoEvidence: number } {
  const byId = new Map<string, ValueCandidate>();
  let skippedNoEvidence = 0;
  let declared = 0;
  for (const item of persona) {
    if (item.layer !== "values") continue;
    if (item.state !== "active") continue;
    const statement = shorten(item.text, VALUE_STATEMENT_MAX_CHARS);
    if (squash(statement) === "") {
      skippedNoEvidence += 1;
      continue;
    }
    declared += 1;
    const id = soulValueIdFor(statement);
    const evidence = (item.evidenceIds ?? []).filter((x) => typeof x === "string" && x !== "");
    const existing = byId.get(id);
    if (existing) {
      // 同一句价值被两条人格条目支撑：证据并集，权重取高者。
      for (const eid of evidence) if (!existing.evidenceEventIds.includes(eid)) existing.evidenceEventIds.push(eid);
      existing.priority = Math.max(existing.priority, clamp01(item.weight));
      continue;
    }
    byId.set(id, {
      statement,
      source: "declared",
      priority: clamp01(item.weight),
      evidenceEventIds: [...evidence],
    });
  }
  let observed = 0;
  for (const episode of args.episodes ?? []) {
    const statement = valueStatementFromEpisode(episode);
    if (!statement) {
      // 只有「有立场没代价」的顺手动作为多数，不逐条计数成噪声；只统计有立场但无代价的那类。
      if (String(episode.agentStance ?? "").trim() !== "") skippedNoEvidence += 1;
      continue;
    }
    const id = soulValueIdFor(statement);
    const existing = byId.get(id);
    if (existing) {
      if (!existing.evidenceEventIds.includes(episode.episodeId)) existing.evidenceEventIds.push(episode.episodeId);
      continue;
    }
    observed += 1;
    byId.set(id, {
      statement,
      source: "observed",
      priority: clamp01(0.5 + 0.1 * Math.min(1, numberOfEvidenceDays(episode))),
      evidenceEventIds: [episode.episodeId],
    });
  }
  return { candidates: [...byId.values()], declared, observed, skippedNoEvidence };
}

export interface EpisodeWriteGateResult {
  evaluation: SoulGateEvaluation;
  outcome: SoulGateOutcome;
  logRow: SoulGateLogInsertLike;
  dilemma: SoulDilemmaInsertLike | null;
}

/**
 * 写入侧红线判定（shadow）。返回判定与将要落的日志/两难载荷；**不改变任何写入**。
 * 只判 agent 说的话（agentStance 优先，其次 assistant 侧原话）；没有说的话就没什么可判。
 */
export function evaluateEpisodeWriteGate(episode: SoulEpisode, now: string): EpisodeWriteGateResult | null {
  const quote = episode.quote && episode.quote.role === "assistant" ? episode.quote.text : "";
  const text = String(episode.agentStance ?? "").trim() || String(quote ?? "").trim();
  if (text === "") return null;
  const evaluation = evaluateSoulGate({ text, stage: "generation", eventId: episode.episodeId });
  const outcome = toShadowOutcome(evaluation);
  return {
    evaluation,
    outcome,
    logRow: buildSoulGateLogRow(evaluation, outcome, { now, eventId: episode.episodeId }),
    dilemma: buildSoulDilemma(evaluation, outcome, { now }),
  };
}

/**
 * 一轮价值维护。顺序：投影价值 → 写入侧 shadow gate → 两难。
 * 任何一步失败只 warn（调用方也在 try/catch 里兜一层），绝不让整轮 tick 失败。
 */
export async function runValueMaintenance(args: ValueMaintenanceArgs): Promise<ValueMaintenanceResult> {
  const { store } = args;
  const now = args.now ?? new Date().toISOString();
  const logger = args.logger;
  const result: ValueMaintenanceResult = {
    candidates: 0,
    declared: 0,
    observed: 0,
    written: 0,
    unchanged: 0,
    skippedNoEvidence: 0,
    gateEvaluated: 0,
    gateHits: 0,
    gateLogged: 0,
    dilemmas: 0,
  };

  // 1) 人格条目：本 tick 的快照优先；没给就向 store 要（读不到就当作没有 declared 价值）。
  let persona: readonly PersonaItem[] = args.persona ?? [];
  if (persona.length === 0 && typeof store.listSoulPersona === "function") {
    try {
      persona = (await store.listSoulPersona(args.tenant)) ?? [];
    } catch (err) {
      logger?.warn?.(
        "[soul-values] persona 读取失败（本轮只挖 observed）：" + (err instanceof Error ? err.message : String(err)),
      );
      persona = [];
    }
  }

  // 2) 投影价值。已有行只用于判断「要不要写」，不拿它当证据。
  const collected = collectCandidates(args, persona);
  result.candidates = collected.candidates.length;
  result.declared = collected.declared;
  result.observed = collected.observed;
  result.skippedNoEvidence = collected.skippedNoEvidence;

  let existing = new Map<string, SoulValueRow>();
  if (typeof store.listSoulValues === "function") {
    try {
      const rows = (await store.listSoulValues(args.tenant, { status: "active", limit: 1000 })) ?? [];
      existing = new Map(rows.map((row) => [row.value_id, row] as [string, SoulValueRow]));
    } catch (err) {
      logger?.warn?.(
        "[soul-values] 旧价值读取失败（按新建处理）：" + (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  if (typeof store.upsertSoulValue === "function") {
    for (const candidate of collected.candidates) {
      const id = soulValueIdFor(candidate.statement);
      const prev = existing.get(id);
      if (prev && prev.statement === candidate.statement && Math.abs(prev.priority - candidate.priority) < 1e-6) {
        result.unchanged += 1;
        continue;
      }
      try {
        const row = await store.upsertSoulValue(args.tenant, {
          value_id: id,
          statement: candidate.statement,
          priority: candidate.priority,
          source: candidate.source,
          evidence_event_ids_json: JSON.stringify(candidate.evidenceEventIds),
          status: "active",
        });
        if (row) result.written += 1;
      } catch (err) {
        logger?.warn?.("[soul-values] 写入失败（继续下一条）：" + (err instanceof Error ? err.message : String(err)));
      }
    }
  }

  // 3) 写入侧 shadow gate：判本 tick 的 episode，落日志与两难，**不拦写入**。
  // 判定按 episode 逐条写：单条的 inserted 就是「这条判定是不是新的」，于是重放同一批
  // episode 时既不重复记两难（判定行已在 ⇒ 当时的两侧理由已在），也不把历史判定算成本轮命中。
  const canLog = typeof store.insertSoulGateLog === "function";
  const canDilemma = typeof store.insertSoulDilemma === "function";
  for (const episode of args.episodes ?? []) {
    const judged = evaluateEpisodeWriteGate(episode, now);
    if (!judged) continue;
    result.gateEvaluated += 1;
    if (judged.evaluation.matched) result.gateHits += 1;
    if (!canLog) continue;
    let inserted = 0;
    try {
      const res = await store.insertSoulGateLog!(args.tenant, [judged.logRow]);
      inserted = Number(res?.inserted ?? 0);
      result.gateLogged += inserted;
    } catch (err) {
      logger?.warn?.(
        "[soul-gate] 写入侧判定落库失败（不拦写入）：" + (err instanceof Error ? err.message : String(err)),
      );
      continue;
    }
    if (inserted > 0 && judged.dilemma && canDilemma) {
      try {
        const row = await store.insertSoulDilemma!(args.tenant, judged.dilemma);
        if (row) result.dilemmas += 1;
      } catch (err) {
        logger?.warn?.("[soul-dilemma] 两难写入失败：" + (err instanceof Error ? err.message : String(err)));
      }
    }
  }

  return result;
}
