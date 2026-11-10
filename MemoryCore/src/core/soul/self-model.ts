/**
 * P4 自我模型与校准的派生（spec §4.5/§4.6）。
 *
 * 与情绪层的取舍一样：派生是确定性的，不调 LLM。错误模式只从可核对的事实长出来——
 * 工具/测试/提交/回滚事件的失败与后续成功、重复失败、用户的当场纠正——
 * 不是从「用户批评了一句」推断我的性格。每条认识都必须留反例：只存支持证据的
 * 自我模型永远不会被推翻（DDL 注释原话），所以这里的行自带 counterexample ids 与
 * probation/retired 两个可被推翻的状态。
 *
 * 校准只入账「有预测、有结果」的事件（工具/测试/提交/回滚），chat 事件没有可信结果，
 * 不拿来充样本；误差一律由读侧算，派生侧只写 predicted 与 actual。
 */

import type {
  SoulCalibrationInsert,
  SoulCalibrationRow,
  SoulEventRow,
  SoulEventReflectionInsert,
  SoulSelfModelInsert,
  SoulSelfModelRow,
} from "../store/soul-event-types.js";
import { selfModelId, summarizeCalibration } from "../store/soul-self-store.js";

/** 派生窗口：单次 tick 最多看这么多条事件（新表默认按 at 倒序读）。 */
export const SELF_MODEL_EVENT_WINDOW = 400;

/** 领域词表：先按任务语义分，认不出再退回来源类（tool/test/commit/rollback）。 */
const DOMAIN_RULES: ReadonlyArray<readonly [string, RegExp]> = [
  ["测试", /(?:vitest|jest|\btest\b|测试|用例)/iu],
  ["召回", /(?:召回|recall|检索|retriev)/iu],
  ["人格卡", /(?:人格卡|卡面|persona[-_ ]?card|card-v13|\bcard\b)/iu],
  ["迁移", /(?:迁移|migrat|ddl|alter table)/iu],
  ["配置", /(?:配置|config|\.ya?ml\b|环境变量)/iu],
  ["提交", /(?:commit|git |提交|分支)/iu],
  ["回滚", /(?:rollback|回滚|revert)/iu],
  ["文档", /(?:文档|spec|adr|\.md\b)/iu],
];

const TOOL_KINDS = new Set(["tool", "test", "commit", "rollback"]);
const FAILED_STATUSES = new Set(["failed"]);
const SUCCESS_STATUSES = new Set(["done"]);

function oneLine(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function shortText(text: string, max = 36): string {
  const s = oneLine(text);
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

/** 一条事件落在哪个「领域」：先按任务语义匹配，认不出退回来源类。 */
export function domainOfEvent(event: Pick<SoulEventRow, "action" | "object" | "outcome" | "intent" | "source_kind">): string {
  const hay = [event.action, event.object, event.outcome, event.intent].join(" ");
  for (const [label, rule] of DOMAIN_RULES) {
    if (rule.test(hay)) return label;
  }
  if (event.source_kind === "chat") return "对话";
  return event.action || event.source_kind || "通用";
}

function isToolBacked(event: SoulEventRow): boolean {
  return TOOL_KINDS.has(event.source_kind);
}

function isFailure(event: SoulEventRow): boolean {
  return isToolBacked(event) && FAILED_STATUSES.has(event.status);
}

function isSuccess(event: SoulEventRow): boolean {
  return isToolBacked(event) && SUCCESS_STATUSES.has(event.status);
}

function latest<T extends { at: string }>(items: readonly T[]): T | null {
  let out: T | null = null;
  for (const item of items) if (out === null || item.at > out.at) out = item;
  return out;
}

function uniq(ids: readonly string[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= max) break;
  }
  return out;
}

/** 新证据优先、旧证据补位：并集撞到上限时先丢最旧的，不让存量行把新事实挤出去。 */
function mergeIds(a: readonly string[], b: readonly string[], max: number): string[] {
  return uniq([...a, ...b], max);
}

/** 用户当场纠正：chat 事件里 user 说的「不对/错了/搞错/又坏/怎么回事」。 */
const USER_CORRECTION = /(?:不对|错了|搞错|又坏|又错|点不动|糊弄|是不是你|你弄错|你改坏|你的问题|怎么回事|到底|没跑通|没过)/u;

function isUserCorrection(event: SoulEventRow): boolean {
  if (event.source_kind !== "chat" || event.actor !== "user") return false;
  return USER_CORRECTION.test(oneLine(`${event.intent} ${event.outcome} ${event.object}`));
}

export interface SelfModelDerivationInput {
  events: readonly SoulEventRow[];
  /** 已有行：反例与证据取并集，不让「窗口里没出现的旧反例」被覆盖掉。 */
  previous?: readonly SoulSelfModelRow[];
  /** 已有校准行 + 本次新行（调用方合并后传入）：领域分要跨 tick 累积，不能只看这一轮。 */
  calibrations?: readonly SoulCalibrationRow[];
  now: string;
}

export interface SelfModelDerivationResult {
  selfModels: SoulSelfModelInsert[];
  calibrationRows: SoulCalibrationInsert[];
  reflections: SoulEventReflectionInsert[];
  scanned: number;
  patterns: number;
  capabilities: number;
  calibrationInsights: number;
  probation: number;
  retired: number;
}

/**
 * 从事件窗口派生自我模型 / 校准 / 反思。
 *
 * 只读纯函数：不写库、不看配置、不取当前时间（now 由调用方给，重放可复现）。
 */
export function deriveSelfModel(input: SelfModelDerivationInput): SelfModelDerivationResult {
  const events = [...input.events].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.event_id < b.event_id ? -1 : 1));
  const previousById = new Map((input.previous ?? []).map((row) => [row.id, row]));
  const selfModels: SoulSelfModelInsert[] = [];
  const calibrationRows: SoulCalibrationInsert[] = [];
  const reflections: SoulEventReflectionInsert[] = [];
  let patterns = 0;
  let capabilities = 0;
  let calibrationInsights = 0;
  let probation = 0;
  let retired = 0;

  // ── 校准入账：有预测（confidence>0）、有结果（done/failed/partial）的工具类事件 ──
  for (const event of events) {
    if (!isToolBacked(event)) continue;
    if (!SUCCESS_STATUSES.has(event.status) && event.status !== "failed" && event.status !== "partial") continue;
    const actual = event.status === "done" ? "success" : event.status === "failed" ? "fail" : "partial";
    calibrationRows.push({
      id: `cal:${event.event_id}`,
      domain: domainOfEvent(event),
      predicted_confidence: Math.max(0, Math.min(1, event.confidence)),
      actual_outcome: actual,
      event_id: event.event_id,
      at: event.at,
      note: shortText(event.outcome, 60),
    });
  }

  // ── 按领域聚合失败/成功 ──
  const domains = new Map<
    string,
    { failures: SoulEventRow[]; successes: SoulEventRow[]; corrections: SoulEventRow[]; successesAfterFirstFail: SoulEventRow[] }
  >();
  for (const event of events) {
    const domain = domainOfEvent(event);
    const bucket = domains.get(domain) ?? { failures: [], successes: [], corrections: [], successesAfterFirstFail: [] };
    if (isFailure(event)) bucket.failures.push(event);
    else if (isSuccess(event)) bucket.successes.push(event);
    if (isUserCorrection(event)) bucket.corrections.push(event);
    domains.set(domain, bucket);
  }
  for (const [, bucket] of domains) {
    const firstFail = latest([...bucket.failures].sort((a, b) => (a.at < b.at ? -1 : 1)));
    if (firstFail) bucket.successesAfterFirstFail = bucket.successes.filter((s) => s.at > firstFail.at);
  }

  for (const [domain, bucket] of domains) {
    const fails = bucket.failures.length;
    const successes = bucket.successes.length;
    const successesAfter = bucket.successesAfterFirstFail.length;
    const patternId = selfModelId("error_pattern", domain);
    const prev = previousById.get(patternId);

    if (fails > 0) {
      const status: SoulSelfModelRow["status"] =
        successesAfter >= 2 && successesAfter > fails ? "retired" : successesAfter >= 1 ? "probation" : "active";
      const confidence = Math.max(
        0.2,
        Math.min(0.85, (0.3 + 0.15 * fails) * (status === "probation" ? 0.8 : status === "retired" ? 0.5 : 1)),
      );
      const lastFail = latest(bucket.failures)!;
      const pointedOut = bucket.corrections.length;
      const statement =
        status === "retired"
          ? `在${domain}这类活上，我以前 ${fails} 次没成，后来 ${successesAfter} 次都成了`
          : status === "probation"
            ? `在${domain}这类活上，我 ${fails} 次没成，后来 ${successesAfter} 次成了（最近一次没成：${shortText(lastFail.outcome)}）`
            : `在${domain}这类活上，我最近 ${fails} 次没成（最近一次：${shortText(lastFail.outcome)}）` +
              (pointedOut > 0 ? `，被当场指出 ${pointedOut} 次` : "");
      selfModels.push({
        id: patternId,
        kind: "error_pattern",
        scope: domain,
        statement,
        confidence,
        evidence_event_ids_json: JSON.stringify(
          mergeIds(
            [...bucket.failures, ...bucket.corrections].map((e) => e.event_id),
            prev ? JSON.parse(prev.evidence_event_ids_json) as string[] : [],
            20,
          ),
        ),
        counterexample_event_ids_json: JSON.stringify(
          mergeIds(
            bucket.successesAfterFirstFail.map((e) => e.event_id),
            prev ? (JSON.parse(prev.counterexample_event_ids_json) as string[]) : [],
            20,
          ),
        ),
        status,
        last_confirmed_at: lastFail.at,
        created_at: prev?.created_at ?? input.now,
        updated_at: input.now,
      });
      patterns += 1;
      if (status === "probation") probation += 1;
      if (status === "retired") retired += 1;

      // 反思子表：重复失败、或已经有后续修复成功，才值得写一条「下次改什么」。
      if (fails >= 2 || successesAfter > 0) {
        const latestCounter = latest(bucket.successesAfterFirstFail);
        reflections.push({
          event_id: lastFail.event_id,
          about_event_ids_json: JSON.stringify(uniq(bucket.failures.map((e) => e.event_id), 12)),
          lesson:
            successesAfter > 0
              ? `${domain}上没成过 ${fails} 次，后来 ${successesAfter} 次是改出来的（最近一次没成：${shortText(lastFail.outcome)}）`
              : `${domain}上连着 ${fails} 次没成，不是偶发（最近一次：${shortText(lastFail.outcome)}）`,
          behavior_change:
            successesAfter > 0
              ? `改完的已经成了：下次在${domain}上先按改法走一遍，再报完成`
              : `下次先在${domain}上验过再报完成，不先给结论`,
          verified_at: latestCounter ? latestCounter.at : null,
          confidence: Math.max(0.3, Math.min(0.9, 0.4 + 0.1 * Math.max(fails, successesAfter))),
        });
      }
    } else if (prev && prev.status !== "retired" && successes === 0) {
      // 窗口里这个领域一条成功都没有：不改旧行（可能是窗口外的旧事实），等下次证据。
    }

    // ── 能力：连续成功且没有失败；一旦出现失败，把旧能力行退休而不是删掉 ──
    const capabilityId = selfModelId("capability", domain);
    const prevCapability = previousById.get(capabilityId);
    if (successes >= 2 && fails === 0) {
      const lastSuccess = latest(bucket.successes)!;
      selfModels.push({
        id: capabilityId,
        kind: "capability",
        scope: domain,
        statement: `在${domain}这类活上，我最近 ${successes} 次都成了`,
        confidence: Math.max(0.4, Math.min(0.9, 0.4 + 0.15 * successes)),
        evidence_event_ids_json: JSON.stringify(uniq(bucket.successes.map((e) => e.event_id), 20)),
        counterexample_event_ids_json: "[]",
        status: "active",
        last_confirmed_at: lastSuccess.at,
        created_at: prevCapability?.created_at ?? input.now,
        updated_at: input.now,
      });
      capabilities += 1;
    } else if (fails > 0 && prevCapability && prevCapability.status !== "retired") {
      selfModels.push({
        ...prevCapability,
        id: capabilityId,
        kind: "capability",
        scope: domain,
        statement: `在${domain}这类活上，我以前连着成了 ${successes} 次，最近没成`,
        confidence: Math.max(0.2, Math.min(0.5, prevCapability.confidence * 0.6)),
        counterexample_event_ids_json: JSON.stringify(
          mergeIds(bucket.failures.map((e) => e.event_id), JSON.parse(prevCapability.counterexample_event_ids_json) as string[], 20),
        ),
        status: "retired",
        updated_at: input.now,
      });
      retired += 1;
    }
  }

  // ── 校准认知：领域分样本够、偏差够大，才写成一条可行动的自我模型 ──
  // 本轮新算的行与存量行按 id 去重后再聚合：否则同一事件在同一 tick 里被算两次，
  // 会让领域样本数虚高、bias 被同一行重复加权。
  const freshIds = new Set(calibrationRows.map((row) => row.id));
  const carried = (input.calibrations ?? []).filter((row) => !freshIds.has(row.id));
  // 本轮行还没有租户键（由 store 补），这里只补读侧聚合需要的字段。
  const freshRows: SoulCalibrationRow[] = calibrationRows.map((row) => ({
    id: row.id,
    team_id: "",
    user_id: "",
    agent_id: "",
    domain: row.domain,
    predicted_confidence: row.predicted_confidence,
    actual_outcome: row.actual_outcome,
    event_id: row.event_id ?? null,
    at: row.at,
    error: row.error ?? null,
    note: row.note ?? "",
  }));
  const byDomain = summarizeCalibration([...carried, ...freshRows]);
  for (const item of byDomain) {
    if (item.samples < 2) continue;
    const gap = Math.abs(item.bias);
    if (gap < 0.15) continue;
    const direction = item.bias > 0 ? "高" : "低";
    const insightId = selfModelId("calibration", item.domain);
    const prev = previousById.get(insightId);
    selfModels.push({
      id: insightId,
      kind: "calibration",
      scope: item.domain,
      statement: `在${item.domain}上，我给的把握比实际结果${direction}约 ${gap.toFixed(2)}（${item.samples} 次可算）`,
      confidence: Math.max(0.3, Math.min(0.9, 1 - gap)),
      evidence_event_ids_json: JSON.stringify(uniq(item.eventIds, 20)),
      counterexample_event_ids_json: prev ? prev.counterexample_event_ids_json : "[]",
      status: "active",
      last_confirmed_at: input.now,
      created_at: prev?.created_at ?? input.now,
      updated_at: input.now,
    });
    calibrationInsights += 1;
  }

  return {
    selfModels,
    calibrationRows,
    reflections,
    scanned: events.length,
    patterns,
    capabilities,
    calibrationInsights,
    probation,
    retired,
  };
}

/** 卡面上的低置信度标记：写出来的「推测」不是装饰，是给读者降低权重的信号。 */
export function selfModelConfidenceMarker(row: Pick<SoulSelfModelRow, "confidence" | "last_confirmed_at">): string {
  if (row.confidence < 0.5) return "（推测）";
  if (row.last_confirmed_at === null) return "（没验过）";
  return "";
}

/**
 * 卡面行（memory/self 段）：只取能改变行为的短句，最多 max 条。
 * 优先级：错误模式（active/probation）→ 校准 → 能力；退休行不进卡。
 */
export function selfModelCardLines(
  rows: readonly SoulSelfModelRow[],
  max = 2,
): Array<{ text: string; evidenceIds?: string[] }> {
  const rank = (row: SoulSelfModelRow): number => {
    if (row.kind === "error_pattern") return row.status === "active" ? 0 : 1;
    if (row.kind === "calibration") return 2;
    if (row.kind === "capability") return 3;
    return 4;
  };
  const usable = rows
    .filter((row) => row.status !== "retired" && row.statement.trim() !== "")
    .sort((a, b) => rank(a) - rank(b) || b.confidence - a.confidence);
  const out: Array<{ text: string; evidenceIds?: string[] }> = [];
  for (const row of usable) {
    if (out.length >= max) break;
    const evidence = (() => {
      try {
        const arr = JSON.parse(row.evidence_event_ids_json) as unknown;
        return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string").slice(0, 3) : [];
      } catch {
        return [];
      }
    })();
    let text: string;
    if (row.kind === "error_pattern") {
      const n = evidence.length > 0 ? evidence.length : 1;
      text = `在${row.scope}这类活上我容易没成（${n} 次）`;
    } else if (row.kind === "calibration") {
      text = row.statement;
    } else if (row.kind === "capability") {
      text = row.statement;
    } else {
      text = `${row.scope}：${row.statement}`;
    }
    text = `${text}${selfModelConfidenceMarker(row)}`.replace(/用户/gu, "你");
    if (text.length > 80) text = text.slice(0, 79) + "…";
    out.push(evidence.length > 0 ? { text, evidenceIds: evidence } : { text });
  }
  return out;
}
