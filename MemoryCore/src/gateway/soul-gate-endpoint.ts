/**
 * P7 §4.9：/v3/soul/gate —— 输出侧红线判定（shadow）+ 判定审计读面。
 *
 * 为什么是这个形状（§10 决策 7）：
 *   - 现在就能执行的两处 gate 是**输出侧**（插件把话说出去之前调这里）与**写入侧**
 *     （worker 的 value 维护对本 tick 的新 episode 判一遍）。行动前的硬拦截要等宿主 pre-tool
 *     钩子，本轮只把判定与接口先定下来。
 *   - POST 返回的 decision **恒为 allow**：shadow 期判了也不改输出。想改行为要换代码路径
 *     （value-gate.ts 的 toEnforcedOutcome），不是翻一个配置键——所以这个 handler 里没有开关。
 *   - wouldDecision 才是「如果强制会怎样」，给面板与抽检看，调用方**不许**据此改写正文。
 *   - 判定日志与两难都在这里落库，所以它同时是「判了什么」的唯一审计入口；GET 给抽检与误杀口径。
 *
 * 合同：
 *   - 鉴权：Bearer Core key（server 侧 checkAuth 先拦；handler 再兜一层信封 401 供直接调用）。
 *   - 租户：只认 x-tdai-team-id / x-tdai-agent-id / x-tdai-user-id，缺一 → 422 并列出缺项，
 *     **不回退 default 桶**——判错租户会把别人的私下原话当成本人的边界内外。
 *   - 不进正文：日志只存 action_digest（sha256 前 16 位）与命中规则；命中原文（密钥、引文）不落库、不回显。
 *   - 失败即降级：store 未就绪 → 503 soul_gate_unavailable；内部异常 → 500 且不把 SQL 细节回给调用方。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";

import { SOUL_GATE_STAGES, type SoulGateStage } from "../core/store/soul-event-types.js";
import type { CoreTenant, IMemoryStore } from "../core/store/types.js";
import {
  buildSoulDilemma,
  buildSoulGateLogRow,
  evaluateGateCalibration,
  evaluateSoulGate,
  toShadowOutcome,
  type SoulGateHit,
} from "../core/soul/value-gate.js";
import { errorEnvelope, resolveRequestId, successEnvelope } from "./v2-router.js";

export const SOUL_GATE_PATH = "/v3/soul/gate";

/** 一次判定最多吃多长的文本：够一段回复，不够一整份日志。 */
export const SOUL_GATE_MAX_TEXT_CHARS = 20000;
/** 抽检默认/上限行数。 */
export const SOUL_GATE_ROWS_DEFAULT = 50;
export const SOUL_GATE_ROWS_MAX = 200;

export interface SoulGateRouteDeps {
  getStore: () => IMemoryStore | null;
  isAuthorized?: (req: IncomingMessage) => boolean;
  logger?: { info?: (msg: string) => void; warn?: (msg: string) => void };
  now?: () => string;
}

type SendJson = (res: ServerResponse, status: number, payload: unknown) => void;

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function tenantOfQuery(url: URL): CoreTenant {
  const pick = (k: string): string => {
    const v = url.searchParams.get(k);
    return v && v.trim() !== "" ? v.trim() : "default";
  };
  return { teamId: pick("team"), userId: pick("user"), agentId: pick("agent") };
}

function asPersonList(value: unknown, max = 32): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (trimmed === "") continue;
    out.push(trimmed);
    if (out.length >= max) break;
  }
  return out;
}

/** 命中项对外只回规则与结构化证据：detail 里本来就不含原文，evidence 里也只有 eventId/字数。 */
function publicHit(hit: SoulGateHit): Record<string, unknown> {
  return {
    ruleId: hit.ruleId,
    axis: hit.axis,
    decision: hit.decision,
    confidence: hit.confidence,
    detail: hit.detail,
    ...(hit.evidence ? { evidence: hit.evidence } : {}),
  };
}

/**
 * POST /v3/soul/gate
 *   body: { text, stage?, audience?: string[], persons?: string[], eventId? }
 *   返回: { code:0, data:{ stage, decision:"allow", shadow:true, wouldDecision, matched, hits[],
 *                          conflict: "none"|"present", logged:{inserted}, dilemmaId, digest } }
 * GET /v3/soul/gate
 *   参数: team/user/agent、limit、decision、stage、ruleId、since、shadowOnly
 *   返回: { code:0, data:{ stats, calibration, rows[] } }
 */
export async function handleSoulGateRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  method: string,
  parseJsonBody: <T>(req: IncomingMessage) => Promise<T>,
  sendJson: SendJson,
  deps: SoulGateRouteDeps,
): Promise<boolean> {
  if (pathname !== SOUL_GATE_PATH) return false;
  const requestId = resolveRequestId(req.headers as Record<string, string | string[] | undefined>);
  const store = deps.getStore();

  // ── 读面：抽检清单 + 误杀口径（只读，租户走 URL 参数，与其它 soul 只读面同口径）──
  if (method === "GET") {
    if (!store || typeof store.listSoulGateLog !== "function") {
      sendJson(res, 503, errorEnvelope(503, "soul_gate_unavailable", requestId));
      return true;
    }
    const url = new URL(req.url ?? SOUL_GATE_PATH, "http://localhost");
    const tenant = tenantOfQuery(url);
    const rawLimitText = (url.searchParams.get("limit") ?? "").trim();
    const rawLimit = rawLimitText === "" ? Number.NaN : Number(rawLimitText);
    const limit = Number.isFinite(rawLimit)
      ? Math.max(1, Math.min(SOUL_GATE_ROWS_MAX, Math.floor(rawLimit)))
      : SOUL_GATE_ROWS_DEFAULT;
    const decisionRaw = (url.searchParams.get("decision") ?? "").trim();
    const stageRaw = (url.searchParams.get("stage") ?? "").trim();
    const ruleId = (url.searchParams.get("ruleId") ?? "").trim();
    const rawSince = (url.searchParams.get("since") ?? "").trim();
    const sinceIso = rawSince !== "" && Number.isFinite(Date.parse(rawSince)) ? rawSince : "";
    const shadowRaw = (url.searchParams.get("shadowOnly") ?? "").trim();
    const shadowOnly = shadowRaw === "true" ? true : shadowRaw === "false" ? false : undefined;
    try {
      const rows = await Promise.resolve(
        store.listSoulGateLog(tenant, {
          limit,
          ...(decisionRaw === "" ? {} : { decision: decisionRaw as never }),
          ...(stageRaw === "" ? {} : { stage: stageRaw as never }),
          ...(ruleId === "" ? {} : { ruleId }),
          ...(sinceIso === "" ? {} : { sinceIso }),
          ...(shadowOnly === undefined ? {} : { shadowOnly }),
        }),
      );
      const stats =
        typeof store.summarizeSoulGateLog === "function"
          ? await Promise.resolve(store.summarizeSoulGateLog(tenant, sinceIso === "" ? undefined : { sinceIso }))
          : null;
      sendJson(
        res,
        200,
        successEnvelope(
          {
            stats,
            // 误杀口径：语料回归的真值。线上 wouldBlockRate 只是代理，两数不可互推。
            calibration: evaluateGateCalibration(),
            rows: (rows ?? []).map((row) => ({
              id: row.id,
              at: row.at,
              stage: row.stage,
              decision: row.decision,
              ruleId: row.rule_id,
              reason: row.reason,
              confidence: row.confidence,
              eventId: row.event_id,
              digest: row.action_digest,
            })),
          },
          requestId,
        ),
      );
    } catch (err) {
      deps.logger?.warn?.(
        "[soul-gate] 读面失败：" + (err instanceof Error ? err.message : String(err)),
      );
      sendJson(res, 500, errorEnvelope(500, "soul_gate_read_failed", requestId));
    }
    return true;
  }

  if (method !== "POST") {
    sendJson(res, 405, errorEnvelope(405, "method_not_allowed", requestId));
    return true;
  }
  if (deps.isAuthorized && !deps.isAuthorized(req)) {
    sendJson(res, 401, errorEnvelope(401, "Unauthorized: missing or invalid Bearer token", requestId));
    return true;
  }

  // ── 租户三头（写面口径：缺一 422，不回退 default 桶）──
  const teamId = headerValue(req, "x-tdai-team-id");
  const userId = headerValue(req, "x-tdai-user-id");
  const agentId = headerValue(req, "x-tdai-agent-id");
  if (!teamId || !userId || !agentId) {
    const missing: string[] = [];
    if (!teamId) missing.push("x-tdai-team-id");
    if (!userId) missing.push("x-tdai-user-id");
    if (!agentId) missing.push("x-tdai-agent-id");
    sendJson(res, 422, errorEnvelope(422, "Tenant headers required: missing " + missing.join(", ") + ".", requestId, { missing }));
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

  const text = typeof body.text === "string" ? body.text : "";
  if (text.trim() === "") {
    sendJson(res, 400, errorEnvelope(400, "text is required (non-empty string)", requestId, { field: "text" }));
    return true;
  }
  if (text.length > SOUL_GATE_MAX_TEXT_CHARS) {
    sendJson(
      res,
      400,
      errorEnvelope(400, "text too long (max " + SOUL_GATE_MAX_TEXT_CHARS + " chars)", requestId, { field: "text" }),
    );
    return true;
  }
  const stageRaw = typeof body.stage === "string" ? body.stage.trim() : "";
  if (stageRaw !== "" && !(SOUL_GATE_STAGES as readonly string[]).includes(stageRaw)) {
    sendJson(
      res,
      400,
      errorEnvelope(400, "stage must be one of: " + SOUL_GATE_STAGES.join(", "), requestId, { field: "stage" }),
    );
    return true;
  }
  const stage: SoulGateStage = (stageRaw === "" ? "output" : stageRaw) as SoulGateStage;
  const audience = asPersonList(body.audience);
  const persons = asPersonList(body.persons);
  const eventId = typeof body.eventId === "string" && body.eventId.trim() !== "" ? body.eventId.trim() : undefined;
  const now = deps.now?.() ?? new Date().toISOString();

  // privacy 规则要「有边界的原话」才能判；读不到就不判 privacy（判不了不猜）。
  let privateQuotes: Awaited<ReturnType<NonNullable<IMemoryStore["listSoulPrivateEventQuotes"]>>> = [];
  if (typeof store?.listSoulPrivateEventQuotes === "function") {
    try {
      privateQuotes = (await Promise.resolve(store.listSoulPrivateEventQuotes(tenant))) ?? [];
    } catch (err) {
      deps.logger?.warn?.(
        "[soul-gate] 边界引文读取失败（本次不判 privacy）：" + (err instanceof Error ? err.message : String(err)),
      );
      privateQuotes = [];
    }
  }

  try {
    const evaluation = evaluateSoulGate({
      text,
      stage,
      ...(audience.length > 0 ? { audience } : {}),
      ...(persons.length > 0 ? { persons } : {}),
      ...(eventId ? { eventId } : {}),
      privateQuotes,
    });
    // shadow：判了也不改输出。这里必须走 toShadowOutcome 而不是 toEnforcedOutcome。
    const outcome = toShadowOutcome(evaluation);
    const logRow = buildSoulGateLogRow(evaluation, outcome, { now, ...(eventId ? { eventId } : {}) });
    let logged = 0;
    if (typeof store?.insertSoulGateLog === "function") {
      try {
        const inserted = await Promise.resolve(store.insertSoulGateLog(tenant, [logRow]));
        logged = Number(inserted?.inserted ?? 0);
      } catch (err) {
        deps.logger?.warn?.(
          "[soul-gate] 判定落库失败（输出不受影响）：" + (err instanceof Error ? err.message : String(err)),
        );
      }
    }
    const dilemma = buildSoulDilemma(evaluation, outcome, { now });
    let dilemmaId: string | null = null;
    if (dilemma && typeof store?.insertSoulDilemma === "function") {
      try {
        const row = await Promise.resolve(store.insertSoulDilemma(tenant, dilemma));
        if (row) dilemmaId = dilemma.id;
      } catch (err) {
        deps.logger?.warn?.(
          "[soul-dilemma] 两难落库失败：" + (err instanceof Error ? err.message : String(err)),
        );
      }
    }
    sendJson(
      res,
      200,
      successEnvelope(
        {
          stage: evaluation.stage,
          // 真实行为：shadow 期恒为 allow，调用方据此不改正文。
          decision: outcome.decision,
          shadow: outcome.shadow,
          // 如果强制会怎样：给面板/抽检看，调用方不许据此改写正文。
          wouldDecision: outcome.wouldDecision,
          matched: evaluation.matched,
          hits: evaluation.hits.map(publicHit),
          conflict: dilemmaId ? "present" : "none",
          digest: evaluation.digest,
          logged: { inserted: logged },
          dilemmaId,
        },
        requestId,
      ),
    );
  } catch (err) {
    deps.logger?.warn?.("[soul-gate] 判定失败：" + (err instanceof Error ? err.message : String(err)));
    sendJson(res, 500, errorEnvelope(500, "soul_gate_failed", requestId));
  }
  return true;
}
