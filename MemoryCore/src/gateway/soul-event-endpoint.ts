/**
 * P1-B（2026-11-10）：POST /v3/soul/event —— 外部（DSH 插件）上报灵魂事件的唯一写面。
 *
 * 为什么需要一个 Core 写面：P1-B 的工具事件（跑测试、提交、回滚）发生在插件/宿主侧，
 * Core 自己看不见。§10 决策 5 定的口径是「插件上报为主、Core 内部兜底采集」，
 * 于是这里必须有入口，且必须是**幂等**的——插件网络重试、宿主重启补发都会重放同一件事。
 *
 * 合同（改动即破坏下游，先读 docs/specs/2026-11-10-soul-event-model-full-optimization.md §4.2）：
 *   - 鉴权：Bearer Core key（与 /v3/* 同一把钥匙，server 侧 checkAuth 先拦；handler 再兜一层信封 401）。
 *   - 租户：只认 x-tdai-team-id / x-tdai-agent-id / x-tdai-user-id 三个头，缺一个 → 422 并列出缺项。
 *     **绝不回退 default 桶**：写错租户等于把别人的记忆烧进我的库里，事后无法区分。
 *   - 幂等：dedupe_key 必填（≤200）。命中 → 200 {event_id, duplicate:true}，不再写；
 *     未命中 → 写 → 200 {event_id, duplicate:false}；写时撞唯一索引（并发重放）同样按 duplicate 处理，不 500。
 *   - 错误一律走 v2 信封 {code,message,request_id,data}：400 字段非法 / 401 未鉴权 /
 *     422 缺租户 / 500 存储不可用或写入失败（不把 SQL 细节回给调用方）。
 *   - 不进正文：工具只上送 args_digest，本面也**不接收**原始参数（evidence.quote 是输出摘要）。
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";

import {
  SOUL_ACTION_STATUSES,
  SOUL_EVENT_ACTORS,
  SOUL_EVENT_EPISTEMICS,
  SOUL_EVENT_SOURCE_KINDS,
  SOUL_EVENT_STATUSES,
  SOUL_EVIDENCE_ROLES,
  type SoulActionStatus,
  type SoulEventActionInsert,
  type SoulEventActor,
  type SoulEventEpistemic,
  type SoulEventEvidenceInsert,
  type SoulEventInsert,
  type SoulEventSourceKind,
  type SoulEventStatus,
  type SoulEvidenceRole,
} from "../core/store/soul-event-types.js";
import {
  SOUL_TOOL_BACKED_SOURCE_KINDS,
  SoulEventWriteError,
  composeSoulEventDedupeKey,
  findSoulEventIdByDedupeKey,
  insertSoulEvent,
  type SoulEventWrite,
} from "../core/store/soul-event-store.js";
import type { CoreTenant, IMemoryStore } from "../core/store/types.js";
import { errorEnvelope, resolveRequestId, successEnvelope } from "./v2-router.js";

export const SOUL_EVENT_PATH = "/v3/soul/event";

/** 字段上限：dedupe_key/session_id 200、summary/quote 400——够装一句人话，不够装一整段日志。 */
const MAX_DEDUPE_KEY = 200;
const MAX_SESSION_ID = 200;
const MAX_SUMMARY = 400;
const MAX_QUOTE = 400;
const MAX_SHORT_TEXT = 200;
const MAX_PERSONS = 32;

export interface SoulEventRouteDeps {
  getStore: () => IMemoryStore | null;
  /**
   * 与 server.verifyAuth 同源（`verifyAuth(req) === "ok"`）。server 侧 checkAuth 已经拦过一次，
   * 这里再判一次是为了：直接调用 handler 的路径（测试/未来复用）也拿得到**信封** 401，
   * 而不是 server 的纯文本 401。
   */
  isAuthorized?: (req: IncomingMessage) => boolean;
  logger?: { info?: (msg: string) => void; warn?: (msg: string) => void };
  now?: () => Date;
}

/** 工具类来源的默认动作词：事实层要有可读的 action，缺省按来源给一个动词。 */
const DEFAULT_ACTION_BY_KIND: Record<SoulEventSourceKind, string> = {
  chat: "said",
  tool: "ran",
  test: "ran_tests",
  commit: "committed",
  rollback: "rolled_back",
  observation: "observed",
  reflection: "reflected",
  system: "noted",
};

/** action.result_status → status：成功闭合、失败记失败，"unknown" 不假装完成。 */
const STATUS_BY_RESULT: Record<SoulActionStatus, SoulEventStatus> = {
  success: "done",
  fail: "failed",
  partial: "partial",
  unknown: "unknown",
};

type SendJson = (res: ServerResponse, status: number, payload: unknown) => void;

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function asString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > max) return undefined;
  return trimmed;
}

function asIsoText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value.trim());
  if (!Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}

function asConfidence(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < 0 || value > 1) return undefined;
  return value;
}

/** 从 IMemoryStore 拿 DatabaseSync：store 层是「db 句柄进、行进出」的纯函数集合（见 soul-event-store 头部）。 */
function rawDbOf(store: IMemoryStore | null): DatabaseSync | null {
  const getter = (store as unknown as { getRawDb?: () => DatabaseSync } | null)?.getRawDb;
  if (typeof getter !== "function") return null;
  try {
    return getter.call(store) ?? null;
  } catch {
    return null;
  }
}

/** 并发重放：唯一索引才是幂等的最终裁决者（查与插之间总有窗口）。 */
function isDedupeUniqueConflict(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed: soul_events\.dedupe_key/.test(message);
}

/** 字段非法：一律 400 + 信封 data 里带 field/detail，调用方不必读日志就能修。 */
function rejectField(
  sendJson: SendJson,
  res: ServerResponse,
  requestId: string,
  field: string,
  detail: string,
): true {
  sendJson(res, 400, errorEnvelope(400, `invalid_field: ${field} ${detail}`, requestId, { field, detail }));
  return true;
}

export async function handleSoulEventRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  method: string,
  parseJsonBody: <T>(req: IncomingMessage) => Promise<T>,
  sendJson: SendJson,
  deps: SoulEventRouteDeps,
): Promise<boolean> {
  if (pathname !== SOUL_EVENT_PATH) return false;
  const requestId = resolveRequestId(req.headers as Record<string, string | string[] | undefined>);
  if (method !== "POST") {
    sendJson(res, 405, errorEnvelope(405, "method_not_allowed", requestId));
    return true;
  }
  if (deps.isAuthorized && !deps.isAuthorized(req)) {
    sendJson(res, 401, errorEnvelope(401, "Unauthorized: missing or invalid Bearer token", requestId));
    return true;
  }

  // ── 租户三头：缺一个就 422 并列出缺项（不回退 default 桶，理由见文件头）──
  const teamId = headerValue(req, "x-tdai-team-id");
  const userId = headerValue(req, "x-tdai-user-id");
  const agentId = headerValue(req, "x-tdai-agent-id");
  if (!teamId || !userId || !agentId) {
    const missing: string[] = [];
    if (!teamId) missing.push("x-tdai-team-id");
    if (!userId) missing.push("x-tdai-user-id");
    if (!agentId) missing.push("x-tdai-agent-id");
    sendJson(
      res,
      422,
      errorEnvelope(422, `Tenant headers required: missing ${missing.join(", ")}.`, requestId, { missing }),
    );
    return true;
  }
  const tenant: CoreTenant = { teamId, userId, agentId };

  let body: Record<string, unknown>;
  try {
    const parsed = await parseJsonBody<Record<string, unknown>>(req);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      sendJson(res, 400, errorEnvelope(400, "bad_json: body must be a JSON object", requestId));
      return true;
    }
    body = parsed;
  } catch {
    sendJson(res, 400, errorEnvelope(400, "bad_json", requestId));
    return true;
  }

  // ── 字段校验 ──
  const rawDedupeKey = asString(body.dedupe_key, MAX_DEDUPE_KEY);
  if (!rawDedupeKey) {
    return rejectField(sendJson, res, requestId, "dedupe_key", `required, 1..${MAX_DEDUPE_KEY} chars`);
  }

  const sourceKindRaw = asString(body.source_kind, 32);
  if (!sourceKindRaw || !(SOUL_EVENT_SOURCE_KINDS as readonly string[]).includes(sourceKindRaw)) {
    return rejectField(
      sendJson,
      res,
      requestId,
      "source_kind",
      `must be one of ${SOUL_EVENT_SOURCE_KINDS.join("|")}`,
    );
  }
  const sourceKind = sourceKindRaw as SoulEventSourceKind;

  const summary = asString(body.summary, MAX_SUMMARY);
  if (!summary) {
    return rejectField(sendJson, res, requestId, "summary", `required, 1..${MAX_SUMMARY} chars`);
  }

  const occurredAt = body.occurred_at === undefined ? undefined : asIsoText(body.occurred_at);
  if (body.occurred_at !== undefined && !occurredAt) {
    return rejectField(sendJson, res, requestId, "occurred_at", "must be an ISO-8601 timestamp");
  }
  // 事件时刻先定下来：证据行也要带 at（证据表 at 是必填列），不能等物化阶段再补。
  const now = deps.now?.() ?? new Date();
  const at = occurredAt ?? now.toISOString();

  const sessionId = body.session_id === undefined ? "" : asString(body.session_id, MAX_SESSION_ID);
  if (sessionId === undefined) {
    return rejectField(sendJson, res, requestId, "session_id", `must be 1..${MAX_SESSION_ID} chars`);
  }

  const persons = parsePersons(body.persons);
  if (persons === null) {
    return rejectField(sendJson, res, requestId, "persons", "must be an array of non-empty strings");
  }

  const evidenceRows = parseEvidence(body.evidence, at);
  if (evidenceRows === null) {
    return rejectField(sendJson, res, requestId, "evidence", "must be an array of {role, quote?, record_id}");
  }

  let action: Omit<SoulEventActionInsert, "event_id"> | null = null;
  if (body.action !== undefined) {
    action = parseAction(body.action);
    if (action === null) {
      return rejectField(sendJson, res, requestId, "action", "must be an object with a non-empty tool");
    }
  }

  const epistemicRaw = body.epistemic;
  if (epistemicRaw !== undefined && !(SOUL_EVENT_EPISTEMICS as readonly unknown[]).includes(epistemicRaw)) {
    return rejectField(sendJson, res, requestId, "epistemic", `must be one of ${SOUL_EVENT_EPISTEMICS.join("|")}`);
  }
  const confidence = body.confidence === undefined ? undefined : asConfidence(body.confidence);
  if (body.confidence !== undefined && confidence === undefined) {
    return rejectField(sendJson, res, requestId, "confidence", "must be a number in [0,1]");
  }

  const actorRaw = body.actor;
  if (actorRaw !== undefined && !(SOUL_EVENT_ACTORS as readonly unknown[]).includes(actorRaw)) {
    return rejectField(sendJson, res, requestId, "actor", `must be one of ${SOUL_EVENT_ACTORS.join("|")}`);
  }
  const statusRaw = body.status;
  if (statusRaw !== undefined && !(SOUL_EVENT_STATUSES as readonly unknown[]).includes(statusRaw)) {
    return rejectField(sendJson, res, requestId, "status", `must be one of ${SOUL_EVENT_STATUSES.join("|")}`);
  }

  // ── 物化写入载荷 ──
  const toolBacked = SOUL_TOOL_BACKED_SOURCE_KINDS.has(sourceKind);
  const eventId = `evt-${randomUUID()}`;
  // 没有证据时默认 inferred/0.5（§4.2 的唯一合法无证据形态）：插件可以只报一句结论，
  // 但库里得看得出「这是推测」；显式要 observed 会被 store 的准入判据拒成 400。
  const epistemic: SoulEventEpistemic | undefined =
    (epistemicRaw as SoulEventEpistemic | undefined) ?? (evidenceRows.length === 0 ? "inferred" : undefined);
  const effectiveConfidence = confidence ?? (evidenceRows.length === 0 ? 0.5 : undefined);
  const toolEvidence = evidenceRows.find((row) => row.role === "tool" && (row.quote ?? "").trim() !== "");
  // 证据行必须挂在本次事件上：store 的 assertChildEventIds 会逐行核对，这里一次补齐。
  const evidence: SoulEventEvidenceInsert[] = evidenceRows.map((row) => ({ ...row, event_id: eventId }));
  const actionRow: SoulEventActionInsert | null = action ? { event_id: eventId, ...action } : null;

  const event: SoulEventInsert = {
    event_id: eventId,
    at,
    day: at.slice(0, 10),
    valid_from: at,
    created_at: now.toISOString(),
    actor: (actorRaw as SoulEventActor | undefined) ?? (toolBacked ? "tool" : "self"),
    action: actionRow?.tool ?? DEFAULT_ACTION_BY_KIND[sourceKind],
    object: asString(body.object, MAX_SHORT_TEXT) ?? "",
    intent: asString(body.intent, MAX_SHORT_TEXT) ?? "",
    // summary 落 outcome：§4.1 的 outcome 就是「这件事的结果」，人话结论只有这一个合法落点。
    outcome: asString(body.outcome, MAX_SUMMARY) ?? summary,
    status:
      (statusRaw as SoulEventStatus | undefined) ??
      (action ? STATUS_BY_RESULT[action.result_status ?? "unknown"] : "unknown"),
    source_kind: sourceKind,
    // 工具类事件的源头是 tool_call_id（不是 L0 record_id，工具事件没有对应记忆行）。
    source_ref: actionRow?.tool_call_id ?? toolEvidence?.record_id ?? "",
    epistemic,
    confidence: effectiveConfidence,
    session_id: sessionId,
    persons_json: persons.length > 0 ? JSON.stringify(persons) : null,
    dedupe_key: composeSoulEventDedupeKey(tenant, rawDedupeKey),
  };
  const write: SoulEventWrite = {
    event,
    evidence,
    ...(actionRow ? { action: actionRow } : {}),
  };

  // ── 落库（先查后插，唯一索引兜底）──
  const db = rawDbOf(deps.getStore());
  if (!db) {
    deps.logger?.warn?.("[soul-event] store 未就绪或无 getRawDb，写入面降级 500");
    sendJson(res, 500, errorEnvelope(500, "store_unavailable", requestId));
    return true;
  }

  const dedupeKey = event.dedupe_key;
  if (dedupeKey) {
    const existing = findSoulEventIdByDedupeKey(db, tenant, dedupeKey);
    if (existing) {
      sendJson(res, 200, successEnvelope({ event_id: existing, duplicate: true }, requestId));
      return true;
    }
  }

  try {
    const row = insertSoulEvent(db, tenant, write);
    sendJson(res, 200, successEnvelope({ event_id: row.event_id, duplicate: false }, requestId));
  } catch (err) {
    if (isDedupeUniqueConflict(err)) {
      // 查与插之间被并发重放抢先：按幂等命中处理，绝不上抛成 500。
      const found = dedupeKey ? findSoulEventIdByDedupeKey(db, tenant, dedupeKey) : null;
      sendJson(res, 200, successEnvelope({ event_id: found ?? eventId, duplicate: true }, requestId));
      return true;
    }
    if (err instanceof SoulEventWriteError) {
      // 准入判据（§4.2）拒绝：调用方输入问题，不是服务端故障。
      sendJson(res, 400, errorEnvelope(400, err.message, requestId));
      return true;
    }
    deps.logger?.warn?.(`[soul-event] 写入失败: ${err instanceof Error ? err.message : String(err)}`);
    sendJson(res, 500, errorEnvelope(500, "soul_event_insert_failed", requestId));
  }
  return true;
}

/** persons：person_key 数组（≤32 个，去重保序）；不是数组或含非字符串 → null（调用方回 400）。 */
function parsePersons(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    const key = item.trim();
    if (key === "" || key.length > 128) return null;
    if (!out.includes(key)) out.push(key);
  }
  return out.slice(0, MAX_PERSONS);
}

/**
 * evidence：{role, quote, record_id}。
 * quote 超长截断到 400（不整条拒：引文长一点不该让一次工具事件丢掉整个上报），
 * role/record_id 非法则整条拒——证据行「长得不对」比缺一条更危险。
 */
function parseEvidence(value: unknown, at: string): SoulEventEvidenceInsert[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const out: SoulEventEvidenceInsert[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const row = item as Record<string, unknown>;
    const role = row.role;
    if (typeof role !== "string" || !(SOUL_EVIDENCE_ROLES as readonly string[]).includes(role)) return null;
    const recordId = asString(row.record_id, MAX_SHORT_TEXT);
    if (!recordId) return null;
    const quote = typeof row.quote === "string" ? row.quote.trim().slice(0, MAX_QUOTE) : "";
    // event_id 由 handler 统一改写成本次事件（parse 阶段还不知道它）；at 跟随事件时刻。
    out.push({ event_id: "", record_id: recordId, role: role as SoulEvidenceRole, quote, at });
  }
  return out;
}

/** action：{tool, tool_call_id, args_digest, result_status, duration_ms, error_code}。只收摘要，不收原始参数。 */
function parseAction(value: unknown): Omit<SoulEventActionInsert, "event_id"> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const tool = asString(row.tool, MAX_SHORT_TEXT);
  if (!tool) return null;
  const resultStatusRaw = row.result_status;
  let resultStatus: SoulActionStatus = "unknown";
  if (resultStatusRaw !== undefined) {
    if (typeof resultStatusRaw !== "string" || !(SOUL_ACTION_STATUSES as readonly string[]).includes(resultStatusRaw)) {
      return null;
    }
    resultStatus = resultStatusRaw as SoulActionStatus;
  }
  const durationRaw = row.duration_ms;
  let durationMs: number | null = null;
  if (durationRaw !== undefined) {
    if (typeof durationRaw !== "number" || !Number.isFinite(durationRaw) || durationRaw < 0) return null;
    durationMs = Math.floor(durationRaw);
  }
  return {
    tool,
    tool_call_id: asString(row.tool_call_id, MAX_SHORT_TEXT) ?? null,
    args_digest: asString(row.args_digest, MAX_SHORT_TEXT) ?? null,
    result_status: resultStatus,
    duration_ms: durationMs,
    artifact_ref: null,
    error_code: asString(row.error_code, MAX_SHORT_TEXT) ?? null,
    environment: null,
    verified_by: null,
  };
}
