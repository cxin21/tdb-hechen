/**
 * P1-A：把一条聊天事件切成一个消息级根事件 + 最多两个行动子事件，
 * 并收口行动事件（工具/测试/提交/回滚）的写入形态。
 *
 * 边界（别越界）：
 *  - 只从 assistant 的逐字引文里切。用户说「帮我跑测试」是请求，不是已发生的测试；
 *    把它写成 source_kind=test 会让「验证过」失去可证伪性。
 *  - 自述不等于验证：即使有逐字引文，行动子事件也只能 inferred + confidence<=0.5，
 *    verified_by 留空；P1-B 拿到真实工具结果后再用同一 dedupe_key upsert 成 observed。
 *  - 行动写面只接受 args 或已计算好的 args_digest；原始参数在函数内摘要后丢弃，
 *    绝不让 token / 密码 / 文件内容进事件表。
 *
 * 语义真源：docs/specs/2026-11-10-soul-event-model-full-optimization.md §4.1–§4.3、§5.1。
 */
import { createHash } from "node:crypto";

import type { SoulEpisode } from "./types.js";
import type {
  SoulActionStatus,
  SoulEventActionInsert,
  SoulEventEvidenceInsert,
  SoulEventInsert,
  SoulEventStatus,
  SoulEvidenceRole,
} from "../store/soul-event-types.js";
import { SoulEventWriteError, type SoulEventWrite } from "../store/soul-event-store.js";

const ACTION_SOURCE_KINDS = ["tool", "test", "commit", "rollback"] as const;
export type SoulActionSourceKind = (typeof ACTION_SOURCE_KINDS)[number];

/** 一条消息最多再切两个行动子事件：再多就不是「一件事的几个动作」，而是把整段对话拆碎。 */
export const SOUL_CHAT_MAX_ACTION_EVENTS = 2;

/** 行动事件 id 的确定性摘要前缀（与聊天事件 ep- 区分，查询时一眼能看出这是行动）。 */
export function soulActionEventId(sourceKind: SoulActionSourceKind, sourceRef: string, action: string): string {
  const hash = createHash("sha1")
    .update(sourceKind)
    .update(String.fromCharCode(1))
    .update(sourceRef)
    .update(String.fromCharCode(1))
    .update(action)
    .digest("hex");
  return "act-" + hash.slice(0, 16);
}

/** 参数摘要：键排序后再 JSON 序列化，同一组参数不会因对象字面量顺序不同得到两个摘要。 */
export function digestSoulActionArgs(args: unknown): string {
  return "sha256:" + createHash("sha256").update(stableStringify(args)).digest("hex");
}

const DIGEST_PATTERN = /^(?:sha256:[0-9a-f]{64}|sha1:[0-9a-f]{40})$/;

function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return "{" + keys.map((key) => JSON.stringify(key) + ":" + stableStringify(record[key])).join(",") + "}";
}

function assertActionSourceKind(kind: string): asserts kind is SoulActionSourceKind {
  if (!(ACTION_SOURCE_KINDS as readonly string[]).includes(kind)) {
    throw new SoulEventWriteError(
      "行动事件的 source_kind 只能是 " + ACTION_SOURCE_KINDS.join("/") + "，收到 " + kind + "。",
    );
  }
}

function eventStatusFor(status: SoulActionStatus): SoulEventStatus {
  switch (status) {
    case "success":
      return "done";
    case "fail":
      return "failed";
    case "partial":
      return "partial";
    default:
      return "unknown";
  }
}

/** 行动事件写面：调用方给事实，本函数补事件基表/子表的共同形态。 */
export interface SoulActionEvidenceInput {
  recordId: string;
  role?: SoulEvidenceRole;
  /** 逐字证据（工具输出/报告行）。空串会被拒绝：空引文不是证据。 */
  quote: string;
  at?: string;
  confidence?: number;
}

export interface SoulActionReport {
  /** 不传则由 sourceKind + sourceRef + action 确定性生成；重派同一动作会 upsert 同一行。 */
  eventId?: string;
  at: string;
  /** 缺省按 at 的前 10 位取自然日。 */
  day?: string;
  sessionId?: string;
  parentEventId?: string | null;
  persons?: string[];
  sourceKind: SoulActionSourceKind;
  action: string;
  object?: string;
  intent?: string;
  outcome?: string;
  status?: SoulActionStatus;
  /** L0 record_id / tool_call_id / commit sha。 */
  sourceRef?: string;
  tool: string;
  toolCallId?: string | null;
  /** 原始参数：会在这里摘要，绝不落原文。 */
  args?: unknown;
  /** 已计算好的摘要；与 args 同时给时以 args 为准。 */
  argsDigest?: string | null;
  durationMs?: number | null;
  artifactRef?: string | null;
  errorCode?: string | null;
  environment?: string | null;
  verifiedBy?: string | null;
  evidence?: readonly SoulActionEvidenceInput[];
  ownership?: "mine" | "theirs" | "joint" | "observed";
  visibility?: "shared" | "private" | "relationship";
  /** 有证据时缺省 0.8；没有证据时强制 <=0.5。 */
  confidence?: number;
}

/**
 * 把一份行动报告变成可提交的 SoulEventWrite。
 *
 * 这里不写库、不碰事务：调用方用 store.commitSoulEvents 批量提交，P1-B 的 HTTP 端点
 * 也只是把 body 映射到本函数的入参，不复制一套字段。
 */
export function buildSoulActionWrite(report: SoulActionReport): SoulEventWrite {
  assertActionSourceKind(report.sourceKind);
  const at = String(report.at ?? "").trim();
  if (at === "") throw new SoulEventWriteError("行动事件必须有 at（事件发生时刻）。");
  const action = String(report.action ?? "").trim();
  if (action === "") throw new SoulEventWriteError("行动事件必须有 action（tested/committed/ran…）。");
  const tool = String(report.tool ?? "").trim();
  if (tool === "") throw new SoulEventWriteError("行动事件必须有 tool；不知道工具就不要假装知道。");

  const sourceRef = String(report.sourceRef ?? report.toolCallId ?? report.artifactRef ?? "").trim();
  const eventId = String(report.eventId ?? soulActionEventId(report.sourceKind, sourceRef || tool, action)).trim();
  if (eventId === "") throw new SoulEventWriteError("行动事件的 event_id 不能为空。");
  const day = String(report.day ?? at.slice(0, 10)).trim() || at.slice(0, 10);

  const rawEvidence = report.evidence ?? [];
  const evidence: SoulEventEvidenceInsert[] = rawEvidence.map((row, index) => {
    const recordId = String(row.recordId ?? "").trim();
    const quote = String(row.quote ?? "").trim();
    if (recordId === "") throw new SoulEventWriteError("evidence[" + index + "].recordId 不能为空。");
    if (quote === "") throw new SoulEventWriteError("evidence[" + index + "].quote 不能为空：空引文不是证据。");
    return {
      event_id: eventId,
      record_id: recordId,
      role: row.role ?? "tool",
      quote,
      at: row.at ?? at,
      confidence: row.confidence ?? 1,
    };
  });
  const observed = evidence.some((row) => row.role !== "unknown" && String(row.quote ?? "").trim() !== "");
  const status = report.status ?? "unknown";
  const confidence = observed
    ? Math.max(0, Math.min(1, report.confidence ?? 0.8))
    : Math.min(0.5, Math.max(0, report.confidence ?? 0.5));

  let argsDigest: string | null = null;
  if (report.args !== undefined) {
    argsDigest = digestSoulActionArgs(report.args);
  } else if (report.argsDigest !== undefined && report.argsDigest !== null && String(report.argsDigest).trim() !== "") {
    const candidate = String(report.argsDigest).trim();
    if (!DIGEST_PATTERN.test(candidate)) {
      throw new SoulEventWriteError(
        "args_digest 必须是 sha256:<64 hex> 或 sha1:<40 hex>；原始参数不能直接写进事件表。",
      );
    }
    argsDigest = candidate;
  }

  const event: SoulEventInsert = {
    event_id: eventId,
    at,
    day,
    valid_from: at,
    valid_to: null,
    actor: "self",
    actor_person_key: null,
    action,
    object: report.object ?? "",
    intent: report.intent ?? action,
    outcome: report.outcome ?? "",
    status: eventStatusFor(status),
    source_kind: report.sourceKind,
    source_ref: sourceRef || eventId,
    ownership: report.ownership ?? "mine",
    epistemic: observed ? "observed" : "inferred",
    confidence,
    visibility: report.visibility ?? "shared",
    session_id: report.sessionId ?? "",
    persons_json: report.persons && report.persons.length > 0 ? JSON.stringify(report.persons) : null,
    parent_event_id: report.parentEventId ?? null,
    dedupe_key: "soul-action:" + eventId,
    salience: 0.6,
    created_at: at,
    archived_at: null,
  };
  const actionRow: SoulEventActionInsert = {
    event_id: eventId,
    tool,
    tool_call_id: report.toolCallId ?? null,
    args_digest: argsDigest,
    result_status: status,
    duration_ms: report.durationMs ?? null,
    artifact_ref: report.artifactRef ?? null,
    error_code: report.errorCode ?? null,
    environment: report.environment ?? null,
    verified_by: report.verifiedBy ?? null,
  };
  return { event, evidence, action: actionRow };
}

/* ───────────────────────── 聊天切分 ───────────────────────── */

interface ActionCue {
  kind: SoulActionSourceKind;
  action: string;
  pattern: RegExp;
}

/** 顺序有意义：先认回滚/提交，再把「测试」当动作；tool 是兜底，避免把「跑了脚本」漏掉。 */
const ACTION_CUES: readonly ActionCue[] = [
  { kind: "rollback", action: "rolled_back", pattern: /(?:回滚|revert|撤销|退回)/i },
  {
    kind: "commit",
    action: "committed",
    // 「提交」在业务语料里常是「提交订单/表单/按钮」，不能单独当 git commit。
    // 只认明确的代码动作或带 sha 的提交；宁可漏切，不把业务动词写成已发生的提交。
    pattern:
      /(?:\bcommit\b|\bpush\b|\bmerge\b|提交(?:了)?\s*[0-9a-f]{7,40}|(?:代码|改动|修改|修复|补丁|变更)(?:已|已经)?提交|提交(?:代码|改动|修改|修复|补丁|变更)|已提交(?:代码|改动|修改|修复|补丁|变更)|合入(?:代码|改动|分支|主分支|主干))/i,
  },
  {
    kind: "test",
    action: "tested",
    // 「测试」是名词时不能单独当动作：必须同时出现「跑/执行」或一个可核对的结果。
    pattern:
      /(?:跑(?:了|过|完)?|执行(?:了|过)?|复跑|重跑|单测|测试)(?:[^，。；\n]{0,16})(?:测试|vitest|jest|npm\s+test|全量|单测|用例|门|通过|失败|挂了|红了|全绿|跑完|过了|干净)|(?:vitest|jest|npm\s+test|\btests?\b|tsc|lint|build)(?:[^，。；\n]{0,24})(?:通过|失败|挂了|红了|全绿|干净|exit|完成|\d+\s*(?:files|tests))|(?:测试|单测)(?:[^，。；\n]{0,8})(?:通过|失败|挂了|红了|全绿|跑了|跑完|过了)/i,
  },
  {
    kind: "tool",
    action: "ran",
    pattern: /(?:跑了|运行了|执行了|调用了|用了|跑过|执行过).{0,16}(?:脚本|命令|工具|探针|构建|编译|tsc|lint|build)/i,
  },
];

function firstActionCue(text: string): ActionCue | null {
  for (const cue of ACTION_CUES) if (cue.pattern.test(text)) return cue;
  return null;
}

function isRequestClause(text: string): boolean {
  return /^(?:帮我|请你|麻烦你?|能否|能不能|要不要|需要|建议|下一步|接下来|待会|稍后|准备|打算|计划|应该|记得)/.test(
    text.trim(),
  );
}

function isNegatedAction(text: string): boolean {
  return /(?:没|没有|未|尚未|还没|不|别|无需|不用).{0,8}(?:跑|测试|提交|回滚|执行|调用|改|扩|重写)/.test(text);
}

/** 规则、计划、清单、疑问都不是已发生的行动；它们和「做了」共用动词，必须整句拒掉。 */
function isPolicyOrPlanClause(text: string): boolean {
  const t = text.trim();
  if (/^(?:在那之前|另外记|附带|补充|说明|背景|现状|验收\s*[：:]|先说清楚)/.test(t)) return true;
  if (/^\s*"(?:title|content|value|text|summary)"\s*:/.test(t)) return true;
  return /(?:不会|不要|不能|不该|不需要|无需|禁止|必须|需要|只报告|不修|不改|不把|不做|不扩|不重写|不为了|不是|是否|检查(?:一下|下|是否)?|核对|盘点|列出|看下|确认(?:一下)?|如果|若|计划|打算|待办|应该|交付后|后我(?:会|要|将|再)|之后(?:再|会|将)|届时|下一次|下一步|以后|将来|后能|污染项|怎么(?:回滚|提交|测试)|如何(?:回滚|提交|测试)|回滚(?:方案|步骤|策略)|每段写|测试\s*(?:agent|人设|账号|环境|数据|文件|用例|桶|租户|实例|对象))/.test(
    text,
  );
}

function looksLikeUtteranceClosed(text: string): boolean {
  return /(?:了|过|完|已|刚刚|刚才|成功|失败|通过|全绿|干净|挂了|红了|报错|完成)/.test(text);
}

function resultStatus(text: string): SoulActionStatus {
  // 失败优先：同一句里「失败后通过」仍以失败为主事实，避免把失败悄悄抹掉。
  if (/(?:失败|挂了|红了|报错|不通过|没通过|failed|\bfail(?:ed|ure)?\b)/i.test(text)) return "fail";
  if (/(?:部分|一半|partial)/i.test(text)) return "partial";
  if (/(?:通过|全绿|过了|成功|passed|\bpass\b|完成|干净)/i.test(text)) return "success";
  return "unknown";
}

function commandOf(text: string): string | null {
  const match =
    text.match(/\b(?:npx|pnpm|npm|node)\s+[^\s，。；,;]+/i) ??
    text.match(/\b(?:vitest|jest|tsc|lint|build)\b/i) ??
    text.match(/(?:脚本|命令|工具|探针)/);
  return match ? match[0].trim() : null;
}

function commitShaOf(text: string): string | null {
  const match = text.match(/(?:提交|commit|push|合入)(?:了|过|完)?\s*([0-9a-f]{7,40})\b/i);
  return match ? match[1] : null;
}

/**
 * 把一段引文拆成「动作段」：句号/分号是硬边界，逗号只在两侧都有动作词时才切。
 * 这样「跑完全量测试，全绿」仍是一段（结果跟着动作），「测试挂了，我回滚了」是两段（两个动作）。
 */
function actionSegments(quote: string): string[] {
  const sentences = quote
    .split(/[。；;！!？?\n]+/)
    .map((part) => part.trim())
    .filter((part) => part !== "");
  const segments: string[] = [];
  for (const sentence of sentences) {
    const fragments = sentence
      .split(/[，,]+/)
      .map((part) => part.trim())
      .filter((part) => part !== "");
    let current = "";
    for (const fragment of fragments) {
      const hasCue = firstActionCue(fragment) !== null;
      if (current !== "" && hasCue) {
        segments.push(current);
        current = fragment;
      } else if (current !== "") {
        current = current + "，" + fragment;
      } else {
        current = fragment;
      }
    }
    if (current !== "") segments.push(current);
  }
  return segments;
}

/** 一条可切分的 assistant 原话：必须带 L0 record_id，否则不能当证据。 */
export interface SoulActionSourceMessage {
  recordId: string;
  text: string;
  at?: string;
  /** 缺省按 assistant 处理；显式给出 user 会被跳过。 */
  role?: string;
}

/**
 * 从一条聊天事件里切出行动子事件（不负责根事件——根事件仍由 P0 的双写映射生成）。
 *
 * 证据来源必须是 assistant 原话：episode.quote 在生产里几乎都是 user 那一侧（契機句），
 * 只读它会永远切不出行动。调用方负责从 episode.evidenceIds 里取回 assistant 的 L0 行，
 * 按 record_id + 原文传进来；本函数仍保持纯函数，不查库、不猜 record_id。
 *
 * 没有 sourceMessages 时保留单测/旧调用的少数路径：只有 quote 本身是 assistant 才切。
 */
export function splitChatActionEvents(
  episode: SoulEpisode,
  sourceMessages: readonly SoulActionSourceMessage[] = [],
): SoulEventWrite[] {
  const quote = episode.quote;
  const candidates: SoulActionSourceMessage[] =
    sourceMessages.length > 0
      ? sourceMessages.filter((message) => (message.role ?? "assistant") === "assistant")
      : quote && quote.role === "assistant"
        ? [{ recordId: quote.recordId, text: quote.text, at: quote.at, role: "assistant" }]
        : [];
  if (candidates.length === 0) return [];

  const writes: SoulEventWrite[] = [];
  const usedIds = new Set<string>();
  for (const source of candidates) {
    const recordId = String(source.recordId ?? "").trim();
    const text = String(source.text ?? "").trim();
    if (recordId === "" || text === "") continue;
    const at = source.at ?? quote?.at ?? episode.at;
    for (const segment of actionSegments(text)) {
      if (writes.length >= SOUL_CHAT_MAX_ACTION_EVENTS) break;
      if (isRequestClause(segment) || isNegatedAction(segment) || isPolicyOrPlanClause(segment)) continue;
      if (!looksLikeUtteranceClosed(segment)) continue;
      const cue = firstActionCue(segment);
      if (!cue) continue;

      const sha = commitShaOf(segment);
      let status = resultStatus(segment);
      // 提交 sha 是一份可回指的具体产物：引文里点了 sha，就不是「我提交了」的口头完成，
      // 至少能证明这条 commit 对象存在。回滚没有等价物，仍按 unknown 记账，不拔高。
      if (status === "unknown" && cue.kind === "commit" && sha) status = "success";
      const command = commandOf(segment);
      const baseId = episode.episodeId + ":" + cue.kind;
      let eventId = baseId;
      let ordinal = 1;
      while (usedIds.has(eventId)) {
        ordinal += 1;
        eventId = baseId + ":" + ordinal;
      }
      usedIds.add(eventId);

      const object =
        cue.kind === "test"
          ? "测试"
          : cue.kind === "commit"
            ? sha
              ? "提交 " + sha
              : "提交"
            : cue.kind === "rollback"
              ? "回滚"
              : (command ?? "命令");
      const tool = cue.kind === "test" ? (command ?? "test") : cue.kind === "tool" ? (command ?? "command") : "git";
      const evidence: SoulEventEvidenceInsert = {
        event_id: eventId,
        record_id: recordId,
        role: "assistant",
        quote: segment,
        at,
        confidence: 1,
      };
      const event: SoulEventInsert = {
        event_id: eventId,
        at,
        day: episode.day,
        valid_from: at,
        valid_to: null,
        actor: "self",
        actor_person_key: null,
        action: cue.action,
        object,
        intent: segment.slice(0, 160),
        outcome: status === "fail" ? "失败" : status === "success" ? "成功" : status === "partial" ? "部分完成" : "",
        status: eventStatusFor(status),
        source_kind: cue.kind,
        source_ref: recordId,
        ownership: "mine",
        // 自述不是验证：有逐字引文也只能是 inferred；P1-B 拿到工具结果再升级。
        epistemic: "inferred",
        confidence: 0.5,
        visibility: "shared",
        session_id: episode.sessionId ?? "",
        persons_json: episode.persons && episode.persons.length > 0 ? JSON.stringify(episode.persons) : null,
        parent_event_id: episode.episodeId,
        dedupe_key: "soul-episode:" + eventId,
        salience: 0.4,
        created_at: episode.at,
        archived_at: episode.archivedAt ?? null,
      };
      const action: SoulEventActionInsert = {
        event_id: eventId,
        tool,
        tool_call_id: null,
        args_digest: null,
        result_status: status,
        duration_ms: null,
        artifact_ref: sha,
        error_code: null,
        environment: null,
        verified_by: null,
      };
      writes.push({ event, evidence: [evidence], action });
    }
    if (writes.length >= SOUL_CHAT_MAX_ACTION_EVENTS) break;
  }
  return writes;
}
