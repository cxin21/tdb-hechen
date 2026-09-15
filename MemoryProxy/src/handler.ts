/** Core request handler: intercept → forward → parse usage → log. */

import type { Context } from "hono";
import { createHash } from "node:crypto";
import { writeLog, createPipeline } from "./logger.js";
import { log } from "./report/log.js";
import {
  apiKeyToKeyId,
  extractBearerToken,
  opikCreateLlmSpan,
  opikCreateTrace,
  opikUpdateTrace,
  uuidv7,
} from "./opik.js";
import {
  langfuseReportGeneration,
  langfuseReportFailure,
  langfuseTurnTraceId,
  type LangfuseTurnContext,
} from "./langfuse.js";
import {
  buildLangfuseInputChat,
  buildRequestDebugMetadata,
} from "./common/langfuse-debug.js";
import { countHumanTurns } from "./turnSeq.js";
import type { ProxyConfig } from "./types.js";
import {
  resolveForwardTarget,
  resolveSessionKey,
  resolveLatestUserQuery,
  reportAnalyzerTrace,
  type ForwardTarget,
} from "./guard-adapter.js";
import { hasCostGuardMarker, matchWhitelistEndpoint } from "./routes/whitelist.js";
import { writeRequestLog } from "./requestLog.js";
import { prepareUpstreamRequest, notifyUpstreamResponse } from "./request-prepare-adapter.js";
import { tryReportCreditFromPath, extractSpaceIdFromPath } from "./credit-reporter.js";
import { resolveModelId, enforceModelGate, gateForSystemUser } from "./pricing.js";
import { inspectAndRecord } from "./identity.js";
import { writeFailedReportRaw } from "./clickhouse.js";
import { verifyUserKey } from "./auth.js";
import { matchSystemUserByUserId, hasSystemUsers } from "./systemUser.js";
import { handleSystemUserPassthrough } from "./systemUserPassthrough.js";
import { TdaiClient } from "./tdai/client.js";
import { deriveTdaiIdentity } from "./tdai/identity.js";
import { extractLatestUserMessage, extractLatestDshUserMessage, recordTdaiTurn } from "./tdai/recorder.js";
import { trackWrite, withL0Retry } from "./tdai/pending-writes.js";
import type { TdaiIdentity, TdaiMessage } from "./tdai/types.js";
import { triggerSkillExtractIfReady } from "./skill/handler-glue.js";
import { emitModelIntentTelemetry } from "./session/model-intent-telemetry.js";
import { isExtractionAllowed, logExtractionSkipped } from "./extraction-gate.js";
import {
  enforceRateLimit,
  isRateLimitExceededError,
  recordInputTokenUsage,
} from "./rate-limit/guard.js";
import { getLlmProviderStore, type LlmProviderStoreWithCache } from "./member-llm/index.js";
import { resolveMemberUpstream, applyMemberModel, type MemberUpstream, type ResolveIdentity } from "./member-llm/resolver.js";

// ── Member-custom LLM provider: module-level lazy shared store ─────────────
// spec §3.1: 成员可在面板配自有 Provider,proxy 转发时按身份覆盖 url/apiKey/model。
// 优先级 agent 覆盖 > user 默认 > upstream.agents[agentFromPath] > 全局兜底。
// 缓存为进程内 per-module 单例(共享底层 ProxyStorage);路由写后显式 invalidate
// 无法跨模块清缓存,故成员改配置后最迟 spec §3.3 的 ≤30s TTL 收敛(已接受的取舍)。
let _memberStoreCache: LlmProviderStoreWithCache | undefined;
function memberStore(config: ProxyConfig): LlmProviderStoreWithCache {
  _memberStoreCache ??= getLlmProviderStore(config);
  return _memberStoreCache;
}

async function resolveMemberOverride(
  config: ProxyConfig,
  identity: ResolveIdentity,
): Promise<MemberUpstream | null> {
  if (!identity.userId && !identity.agentId) return null;
  return resolveMemberUpstream(memberStore(config), identity);
}

/**
 * Build a per-request TdaiClient. `spaceId` (extracted from the request path
 * `/{agent}/{spaceId}/...`) overrides `config.tdai.serviceId` so writes/recalls
 * land on the correct kernel tenant. Falls back to config when the request
 * carries no spaceId (older single-tenant deployments).
 */
function createTdaiClient(config: ProxyConfig, spaceId?: string): TdaiClient | null {
  if (!config.tdai.enabled || !config.tdai.memory.enabled || !config.tdai.endpoint) return null;
  return new TdaiClient({
    enabled: config.tdai.enabled && config.tdai.memory.enabled,
    endpoint: config.tdai.endpoint,
    apiKey: config.tdai.apiKey,
    serviceId: spaceId || config.tdai.serviceId,
    writeL0: config.tdai.memory.writeL0,
    recallL1: config.tdai.memory.recallL1,
    injectL2L3: config.tdai.memory.injectL2L3,
    l1Limit: config.tdai.memory.l1Limit,
    l2Limit: config.tdai.memory.l2Limit,
    timeoutMs: config.tdai.memory.timeoutMs,
  });
}

/**
 * Flatten messages into Opik-friendly chat messages (no truncation).
 */
function flattenMessagesForOpik(messages: unknown[]): unknown[] {
  const result: unknown[] = [];
  for (const msg of messages) {
    const m = msg as Record<string, unknown>;
    const role = m.role as string;
    const content = m.content;

    if (typeof content === "string") {
      result.push(msg);
      continue;
    }

    if (!Array.isArray(content)) {
      if (role === "assistant" && Array.isArray(m.tool_calls)) {
        if (typeof content === "string" && content) {
          result.push({ role: "assistant", content });
        }
        for (const tc of m.tool_calls as unknown[]) {
          const t = tc as Record<string, unknown>;
          const fn = t.function as Record<string, unknown> | undefined;
          let argsStr = "";
          if (fn?.arguments) {
            argsStr = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments);
          }
          result.push({
            role: "assistant",
            content: JSON.stringify({ tool_call_id: t.id, tool_name: fn?.name ?? "unknown", arguments: argsStr }, null, 2),
          });
        }
        continue;
      }
      result.push(msg);
      continue;
    }

    if (role === "assistant") {
      const textParts: string[] = [];
      const toolCalls: unknown[] = [];
      for (const block of content) {
        const b = block as Record<string, unknown>;
        if (b.type === "text") {
          textParts.push(b.text as string);
        } else if (b.type === "tool_use") {
          toolCalls.push(b);
        } else if (b.type === "thinking" && b.thinking) {
          textParts.push(`[thinking] ${b.thinking as string}`);
        }
      }
      if (textParts.length > 0) {
        result.push({ role: "assistant", content: textParts.join("\n") });
      }
      for (const tc of toolCalls) {
        const t = tc as Record<string, unknown>;
        const inputStr = typeof t.input === "string" ? t.input : JSON.stringify(t.input);
        result.push({
          role: "assistant",
          content: JSON.stringify({ tool_call_id: t.id, tool_name: t.name, input: inputStr }, null, 2),
        });
      }
      const topLevelToolCalls = m.tool_calls;
      if (Array.isArray(topLevelToolCalls)) {
        for (const tc of topLevelToolCalls) {
          const t = tc as Record<string, unknown>;
          const fn = t.function as Record<string, unknown> | undefined;
          let argsStr = "";
          if (fn?.arguments) {
            argsStr = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments);
          }
          result.push({
            role: "assistant",
            content: JSON.stringify({ tool_call_id: t.id, tool_name: fn?.name ?? "unknown", arguments: argsStr }, null, 2),
          });
        }
      }
    } else if (role === "user") {
      const textParts: string[] = [];
      const toolResults: unknown[] = [];
      for (const block of content) {
        const b = block as Record<string, unknown>;
        if (b.type === "text") {
          textParts.push(b.text as string);
        } else if (b.type === "tool_result") {
          toolResults.push(b);
        } else {
          textParts.push(JSON.stringify(b));
        }
      }
      if (textParts.length > 0) {
        result.push({ role: "user", content: textParts.join("\n") });
      }
      for (const tr of toolResults) {
        const t = tr as Record<string, unknown>;
        let resultContent: string;
        if (typeof t.content === "string") {
          resultContent = t.content;
        } else if (Array.isArray(t.content)) {
          resultContent = (t.content as Record<string, unknown>[])
            .map((c) => (c.type === "text" ? c.text : JSON.stringify(c)))
            .join("\n");
        } else {
          resultContent = JSON.stringify(t.content);
        }
        result.push({
          role: "tool",
          content: JSON.stringify({ tool_call_id: t.tool_use_id, is_error: t.is_error ?? false, result: resultContent }, null, 2),
        });
      }
    } else {
      const merged = content.map((b: unknown) => {
        const block = b as Record<string, unknown>;
        if (block.type === "text") return block.text as string;
        return JSON.stringify(block);
      }).join("\n");
      result.push({ role, content: merged });
    }
  }
  return result;
}

const SKIP_REQUEST_HEADERS = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  // hop-by-hop: undici rejects `Expect: 100-continue` (UND_ERR_NOT_SUPPORTED)
  "expect",
]);

const SKIP_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "transfer-encoding",
  "content-length",
  "connection",
]);

/** Extract usage object from a block of OpenAI SSE text. */
export function extractSseUsage(sseText: string): Record<string, unknown> | null {
  let lastUsage: Record<string, unknown> | null = null;

  for (const line of sseText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const dataStr = trimmed.slice(5).trim();
    if (!dataStr || dataStr === "[DONE]") continue;

    try {
      const evt = JSON.parse(dataStr) as Record<string, unknown>;
      if (evt.usage && typeof evt.usage === "object") {
        lastUsage = evt.usage as Record<string, unknown>;
      }
    } catch {
      // ignore malformed SSE lines
    }
  }

  return lastUsage;
}

/**
 * Build upstream body from original body + cost guard overrides.
 * The host does NOT branch on routing — it just applies overrides if present.
 */
function buildUpstreamBody(
  body: Record<string, unknown>,
  target: ForwardTarget,
): Record<string, unknown> {
  let upstreamBody = body;
  if (target.bodyOverrides) {
    upstreamBody = { ...body, ...target.bodyOverrides };
  }
  return upstreamBody;
}

/**
 * Build upstream headers from request headers + routing auth overrides.
 * If config.upstream.apiKey is set, it overrides the request's Authorization header
 * only for the default route (not alternate model route).
 */
function buildUpstreamHeaders(
  c: Context,
  _config: ProxyConfig,
  target: ForwardTarget,
  sessionKey?: string,
  effectiveApiKey?: string,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [k, v] of c.req.raw.headers.entries()) {
    if (!SKIP_REQUEST_HEADERS.has(k.toLowerCase())) {
      headers[k] = v;
    }
  }
  headers["content-type"] = "application/json";

  // `effectiveApiKey` is pre-resolved by the caller — see the resolveEffective
  // block near the call site. Non-empty → inject as server-side Bearer;
  // empty/undefined → passthrough (client's own Authorization survives).
  // cost-guard's `target.authHeaders` still gets to override everything.
  if (effectiveApiKey && !target.authHeaders) {
    headers["authorization"] = `Bearer ${effectiveApiKey}`;
  }

  if (target.authHeaders) {
    for (const [k, v] of Object.entries(target.authHeaders)) {
      headers[k] = v;
    }
  }

  if (sessionKey) {
    headers["x-vertex-ai-session-id"] = sessionKey;
  }
  return headers;
}

/**
 * Forward request to upstream and handle retry if retryTarget is set.
 */
async function forwardWithRetry(
  target: ForwardTarget,
  upstreamHeaders: Record<string, string>,
  upstreamBody: Record<string, unknown>,
  originalBody: Record<string, unknown>,
  originalHeaders: Record<string, string>,
  pipe: ReturnType<typeof createPipeline>,
  forwardTimeoutMs: number,
  sessionKeyForDebug?: string,
  rateLimitContext?: { config: ProxyConfig; instanceId?: string },
): Promise<{ resp: Response; retried: boolean }> {
  let upstreamResp: Response | undefined;
  let forwardFailed = false;

  // ── Optional full-body dump (dev only) ───────────────────────────────
  // 打开: PROXY_DEBUG_DUMP_BODY=/tmp/proxy-outbound
  // 每次 forward 落一个文件,方便排查上游 400。
  if (process.env.PROXY_DEBUG_DUMP_BODY) {
    try {
      const fs = await import("node:fs");
      const dir = process.env.PROXY_DEBUG_DUMP_BODY;
      fs.mkdirSync(dir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const fn = `${dir}/${ts}-${sessionKeyForDebug ?? "nosid"}.json`;
      fs.writeFileSync(fn, JSON.stringify({ url: target.url, headers: upstreamHeaders, body: upstreamBody }, null, 2));
      console.log(`[dump-body] wrote ${fn}`);
    } catch (e) {
      console.log(`[dump-body] error: ${(e as Error).message}`);
    }
  }

  // ── Optional outbound body md5 debug log (see anthropicHandler.ts) ─────
  // openai 协议侧没有 cache_control 概念，只算 sys + 整个 messages 数组两个 md5。
  if (process.env.PROXY_DEBUG_DUMP_OUTBOUND_MD5) {
    try {
      const msgs = (upstreamBody as { messages?: Array<{ role?: string; content?: unknown }> }).messages ?? [];
      const sysMsg = msgs.find((m) => m.role === "system");
      const sysStr = typeof sysMsg?.content === "string"
        ? sysMsg.content
        : sysMsg?.content ? JSON.stringify(sysMsg.content) : "";
      const msgsFullStr = JSON.stringify(msgs);
      const sysMd5 = createHash("md5").update(sysStr).digest("hex").slice(0, 12);
      const msgsFullMd5 = createHash("md5").update(msgsFullStr).digest("hex").slice(0, 12);
      // eslint-disable-next-line no-console
      console.log(
        `[outbound-md5] session=${sessionKeyForDebug ?? "?"} protocol=openai sysBytes=${sysStr.length} sysMd5=${sysMd5} msgsCount=${msgs.length} msgsFullBytes=${msgsFullStr.length} msgsFullMd5=${msgsFullMd5}`,
      );
    } catch (e) {
      // eslint-disable-next-line no-console
      console.log(`[outbound-md5] session=${sessionKeyForDebug ?? "?"} <error: ${(e as Error).message}>`);
    }
  }

  const fetchOpts: RequestInit = {
    method: "POST",
    headers: upstreamHeaders,
    body: JSON.stringify(upstreamBody),
  };
  if (forwardTimeoutMs > 0) {
    fetchOpts.signal = AbortSignal.timeout(forwardTimeoutMs);
  }

  if (rateLimitContext) {
    await enforceRateLimit({
      config: rateLimitContext.config,
      instanceId: rateLimitContext.instanceId,
      modelId: target.model,
      protocol: "openai",
    });
  }
  try {
    upstreamResp = await fetch(target.url, fetchOpts);
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      pipe.error("FORWARD", `Timeout after ${forwardTimeoutMs / 1000}s`);
    } else {
      pipe.error("FORWARD", err);
    }
    forwardFailed = true;
  }

  if (upstreamResp) {
    pipe.forwardDone(upstreamResp.status);
  }

  const shouldRetry = target.retryTarget &&
    (forwardFailed || (upstreamResp && upstreamResp.status >= 400 && upstreamResp.status < 500));

  if (shouldRetry && target.retryTarget) {
    const reason = forwardFailed ? "timeout/error" : `${upstreamResp!.status}`;
    pipe.info("RETRY", `Routed model failed (${reason}), retryUrl=${target.retryTarget.url} model=${target.retryTarget.model}`);

    const retryBody = { ...originalBody, model: target.retryTarget.model };
    const retryHeaders: Record<string, string> = { ...originalHeaders };
    retryHeaders["content-type"] = "application/json";
    if (sessionKeyForDebug) {
      retryHeaders["x-vertex-ai-session-id"] = sessionKeyForDebug;
    }

    try {
      if (rateLimitContext) {
        await enforceRateLimit({
          config: rateLimitContext.config,
          instanceId: rateLimitContext.instanceId,
          modelId: target.retryTarget.model,
          protocol: "openai",
        });
      }
      const retryFetchOpts: RequestInit = {
        method: "POST",
        headers: retryHeaders,
        body: JSON.stringify(retryBody),
      };
      if (forwardTimeoutMs > 0) {
        retryFetchOpts.signal = AbortSignal.timeout(forwardTimeoutMs);
      }
      upstreamResp = await fetch(target.retryTarget.url, retryFetchOpts);
      if (upstreamResp.ok) {
        pipe.info("RETRY_SUCCESS", `Retry returned ${upstreamResp.status}`);
      } else {
        pipe.error("RETRY_FAILED", `Retry returned ${upstreamResp.status}`);
      }
      return { resp: upstreamResp, retried: true };
    } catch (retryErr: unknown) {
      if (isRateLimitExceededError(retryErr)) throw retryErr;
      if (retryErr instanceof DOMException && retryErr.name === "TimeoutError") {
        pipe.error("RETRY_FORWARD", `Timeout after ${forwardTimeoutMs / 1000}s`);
      } else {
        pipe.error("RETRY_FORWARD", retryErr);
      }
      throw new Error("Upstream request failed");
    }
  }

  if (forwardFailed && !shouldRetry) {
    throw new Error("Upstream request failed");
  }

  if (!upstreamResp) {
    throw new Error("No upstream response available");
  }

  return { resp: upstreamResp, retried: false };
}

/** Main handler for POST /v1/chat/completions (OpenAI compat). */
export async function handleChatCompletions(
  c: Context,
  config: ProxyConfig,
): Promise<Response> {
  const startTime = new Date().toISOString();
  const traceId = uuidv7();

  // ── Early auth ──────────────────────────────────────────────────────────
  // Verify BEFORE parsing the body so a rejected caller never triggers body
  // parsing or the alias-gate. `earlyVerify.userId` is reused later for
  // both the systemUser short-circuit and the normal pipeline.
  const earlyAuthHeader = c.req.header("authorization") ?? c.req.header("Authorization") ?? "";
  const earlyApiKey = extractBearerToken(earlyAuthHeader);
  const earlySpaceId = extractSpaceIdFromPath(c.req.path) ?? "";
  const earlyVerify = await verifyUserKey(earlyApiKey, earlySpaceId);
  if (earlyVerify.rejected) {
    return c.json({ error: `Authentication failed: ${earlyVerify.rejectReason ?? "unknown"}` }, 401);
  }

  // ── Parse body ──────────────────────────────────────────────────────────
  // Body is parsed BEFORE the systemUser short-circuit so the alias-gate and
  // `resolveModelId` fire uniformly for internal AND external callers. The
  // parsed object is later handed to `handleSystemUserPassthrough` (which
  // serialises it) so we never double-read `c.req`.
  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  // ── Optional inbound body dump (dev only) ─────────────────────────
  // 打开: PROXY_DEBUG_DUMP_INBOUND=/tmp/proxy-inbound
  // 每个入站请求落一个文件,方便排查客户端 replay 时到底带没带某个字段。
  if (process.env.PROXY_DEBUG_DUMP_INBOUND) {
    try {
      const fs = await import("node:fs");
      const dir = process.env.PROXY_DEBUG_DUMP_INBOUND;
      fs.mkdirSync(dir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const hdrs: Record<string, string> = {};
      for (const [k, v] of c.req.raw.headers.entries()) hdrs[k] = v;
      const sid = hdrs["x-deepseek-harness-session-id"] ?? hdrs["x-session-id"] ?? "nosid";
      const fn = `${dir}/${ts}-${sid}.json`;
      fs.writeFileSync(fn, JSON.stringify({ path: c.req.path, headers: hdrs, body }, null, 2));
      console.log(`[dump-inbound] wrote ${fn}`);
    } catch (e) {
      console.log(`[dump-inbound] error: ${(e as Error).message}`);
    }
  }

  // ── DEBUG: dump tools/instructions/metadata（Phase 1 workbuddy 调研）──
  // 仅在 sessionInit.debugVerboseLogging=true 时启用，生产环境默认关闭。
  if (config.sessionInit?.debugVerboseLogging) {
  try {
    const dbgPath = c.req.path;
    if (dbgPath.includes("/workbuddy/")) {
      // 只保留精简字段（不 dump 原始 tools 数组，避免超长被截断）
      const dumpKeys = [
        "tool_choice",
        "toolset",
        "tool_config",
        "response_format",
        "metadata",
        "client_metadata",
      ];
      const dump: Record<string, unknown> = { path: dbgPath, model: body.model };
      for (const k of dumpKeys) {
        if (k in body) dump[k] = (body as Record<string, unknown>)[k];
      }
      const toolsField = (body as Record<string, unknown>).tools;
      if (Array.isArray(toolsField)) {
        dump.tools_summary = toolsField.map((t: unknown) => {
          const tt = t as Record<string, unknown>;
          const fn = (tt as any).function ?? {};
          const paramProps = fn.parameters?.properties;
          return {
            type: tt.type,
            name: (tt as any).name ?? fn.name,
            description:
              typeof (tt as any).description === "string"
                ? String((tt as any).description).slice(0, 400)
                : typeof fn.description === "string"
                  ? String(fn.description).slice(0, 400)
                  : undefined,
            param_keys: paramProps && typeof paramProps === "object"
              ? Object.keys(paramProps)
              : undefined,
          };
        });
      }
      // messages[0] 若是 system，一起 dump（可能声明 tool 用法）
      const msgs = (body as Record<string, unknown>).messages;
      if (Array.isArray(msgs) && msgs.length > 0) {
        const first = msgs[0] as Record<string, unknown>;
        if (first?.role === "system") {
          const content = typeof first.content === "string"
            ? first.content
            : JSON.stringify(first.content);
          dump.system_head = content.slice(0, 2000);
          dump.system_length = content.length;
        }
        dump.messages_count = msgs.length;
      }
      console.log(
        `[wb-tools-dump] path=${dbgPath} tools_count=${Array.isArray(toolsField) ? toolsField.length : 0}`,
      );
      console.log(`[wb-tools-dump-json] ${JSON.stringify(dump).slice(0, 60000)}`);

      // 额外：单独 dump AskUserQuestion 的完整 schema（Phase 1 关键调研）
      if (Array.isArray(toolsField)) {
        const askTool = toolsField.find((t: unknown) => {
          const tt = t as any;
          const name = tt?.name ?? tt?.function?.name;
          return name === "AskUserQuestion";
        });
        if (askTool) {
          console.log(
            `[wb-ask-user-schema] ${JSON.stringify(askTool).slice(0, 20000)}`,
          );
        }
      }
    }
  } catch (e) {
    console.log(`[wb-tools-dump] error: ${String(e)}`);
  }
  } // debugVerboseLogging gate

  // ── requestedModel 记录（原始值，别名改写前）──
  // 门禁已迁移至成员解析之后的转发缝（spec §8）：memberUpstream 命中即豁免。
  const requestedModel = typeof body.model === "string" ? body.model : "unknown";

  // ── Model alias: rewrite client-facing modelName → real model_id ──────────
  // Clients may put a human-readable name (e.g. "claude-opus-4.7") in `model`;
  // resolve it back to the real upstream model_id (e.g. "ep-pksklwtb") BEFORE
  // routing / logging / forwarding, so model_id stays the canonical identity
  // across the whole pipeline. No-op when `model` is already a real id/unknown.
  const modelId = resolveModelId(config.creditPricing, requestedModel);
  const modelAliasApplied = typeof body.model === "string" && modelId !== requestedModel;
  if (modelAliasApplied) body.model = modelId;

  // ── System-user short-circuit ────────────────────────────────────────────
  // Internal service accounts (see `systemUsers` config) bypass the entire
  // pipeline: no session-init, no injection, no routing. Matching key is
  // the userId resolved by verifyUserKey — NOT the raw apiKey. Auth-disabled
  // requests (userId == "") never match, so the short-circuit is inert unless
  // auth is on.
  //
  // We hand the already-parsed+alias-resolved `body` to the passthrough so
  // upstream sees the canonical model_id, aligning internal traffic with
  // external.
  if (hasSystemUsers()) {
    const sysMatch = matchSystemUserByUserId(earlyVerify.userId);
    if (sysMatch) {
      // ── Model gate（system-user 短路路径，spec §8 不变式）──
      // 门禁迁移至转发缝后，此路径在成员解析之前 return，需在此补回门禁。
      // 内部服务账号不走成员覆盖（memberUpstream 恒 null），与迁移前入口
      // 门禁一致：internal callers must also request by modelName。
      const sysGateError = gateForSystemUser(config.creditPricing, requestedModel);
      if (sysGateError) {
        return c.json(
          { error: { message: sysGateError, type: "invalid_request_error", code: "model_not_found" } },
          400,
        );
      }
      return handleSystemUserPassthrough(c, config, sysMatch, body);
    }
  }

  let messages = Array.isArray(body.messages) ? body.messages : [];
  const isStream = body.stream === true;

  // [debug] Log last 3 message roles and content types to diagnose session-init issues
  if (config.sessionInit?.enabled && messages.length > 2) {
    const tail = messages.slice(-3);
    const summary = tail.map((m: any, idx: number) => {
      const role = m.role;
      const ct = m.content;
      const contentType = typeof ct === "string" ? `string(${ct.slice(0, 80)})` :
        Array.isArray(ct) ? `array[${ct.map((b: any) => b.type).join(",")}]` :
        ct === null ? "null" : typeof ct;
      const tcid = m.tool_call_id;
      const tcs = m.tool_calls ? `tool_calls[${m.tool_calls.map((t: any) => t.id).join(",")}]` : "";
      return `[${idx}]role=${role} content=${contentType} tool_call_id=${tcid} ${tcs}`;
    }).join(" | ");
    console.log(`[session-init-debug] raw-tail msgs=${messages.length} ${summary}`);
  }

  // ── Resolve agent source from URL path (e.g. /claude-code/v1/chat/completions) ──
  const pathParts = c.req.path.split("/").filter(Boolean);
  const agentFromPath = pathParts[0] && !["v1", "proxy", "skill-bridge", "memory-bridge"].includes(pathParts[0])
    ? pathParts[0] : undefined;
  const agentSource = agentFromPath ?? "claude-code";

  // ── Identity inspection ──────────────────────────────────────────────────
  const reqHeaders: Record<string, string> = {};
  for (const [k, v] of c.req.raw.headers.entries()) {
    reqHeaders[k] = v;
  }
  inspectAndRecord("POST", c.req.path, reqHeaders, body as Record<string, unknown>, agentSource);

  // ── Resolve apiKey → project name ──────────────────────────────────────
  const authHeader = c.req.header("authorization") ?? c.req.header("Authorization") ?? "";
  const apiKey = extractBearerToken(authHeader);
  let keyId = apiKey ? apiKeyToKeyId(apiKey) : "unknown";

  // ── Lowercased headers for agent profile detection + session key ──────────
  const lcHeaders: Record<string, string> = {};
  for (const [k, v] of c.req.raw.headers.entries()) {
    lcHeaders[k.toLowerCase()] = v;
  }

  // ── Session key: prefer conversation header, fallback to agent profile ───────────
  const { resolveConversationId } = await import("./session/session-key.js");
  const conversationId = resolveConversationId(c);
  const sessionKey = conversationId ?? resolveSessionKey(config, lcHeaders, c.req.path, body, keyId);

  // ── Auth verification (user_key → user_id) ──────────────────────────────────────
  // Reuse the early verify result — it ran before body parse to decide the
  // system-user short-circuit; running verify again here would double the
  // network round-trip for every request.
  const spaceId = earlySpaceId;
  let userId = earlyVerify.userId
    || c.req.header("x-user-id")
    || c.req.header("x-cb-user-id")
    || c.req.header("x-tdai-user-token")
    || "";
  // DEBUG override：客户端传的 tokenhub-uid 与 kernel-uid 不一致（本地联调
  // 常见），配置 sessionInit.debugForceUserId 后用真实 kernel user_id 替换，
  // 让 CB 状态机能通过 kernel /team/list 拉到资产、正常弹表单。
  const debugForceUserId = config.sessionInit?.debugForceUserId;
  if (debugForceUserId) {
    console.log(
      `[handler] DEBUG override userId ${userId || "<empty>"} → ${debugForceUserId}`,
    );
    userId = debugForceUserId;
  }
  if (userId) keyId = userId;

  // Activate Redis storage early — must run BEFORE session init.
  if (config.redis?.enabled) {
    const { getInjectionPipeline } = await import("./injection/index.js");
    getInjectionPipeline(config);
  }

  // ── Request kind classification (auxiliary detection for OpenAI-chat clients) ──
  // dsh (deepseek-harness) 会在 compaction 请求带 `x-deepseek-harness-compact: 1`
  // header,title-gen 靠 body 特征三合一。这类请求**不能**走 session-init form,
  // 也不能触发 mem 拦截 / L0 写入 / skill 提取 —— 应该直接透传上游。
  // codebuddy / claude-code 客户端 adapter classifyRequest 恒返 "main",行为无变。
  const { resolveAgentAdapter } = await import("./agent-adapters/index.js");
  const _adapter = resolveAgentAdapter(agentSource);
  const _requestKind = _adapter.classifyRequest(body as Record<string, unknown>, c.req.path, lcHeaders);
  const isAuxiliary = _requestKind === "auxiliary";
  if (isAuxiliary) {
    console.log(`[request-classify] session=${sessionKey} agent=${agentSource} → auxiliary (skip session-init/mem/injection/L0/skill)`);
  }

  // ── dsh (deepseek-harness) CLI headless / no-preset bypass ──────────────
  // dsh 客户端在 headless bundle 或未挂 ask-user preset 时,body.tools 里
  // 不含 `ask_user_question` 工具。proxy 塞 fake `ask_user_question` tool_call
  // 会被 dsh agent-loop 校验为 unknown tool 直接抛错。此时直接 bypass
  // session-init 而非弹 form —— 没 UI 场景强弹表单没意义。
  //
  // 判定:agentSource=dsh 且 body.tools 非空且不含 ask_user_question。
  // (tools 空数组表示纯对话/aux,不用兜底;tools 里就有 ask_user_question 说明
  // 有 preset 挂 UI 工具,正常走 form。)
  //
  // NOTE(opencode): opencode CLI 同样不支持虚拟 ask_followup_question tool,
  // 但走独立的 header-driven session-init 分支(见下方 opencode 特化块),
  // 因此不需要走这里的 headless bypass —— opencode 能吃 mem 命令纯文本响应,
  // 也需要 injection / L0 / skill 提取,只是不能弹 form。
  const _dshHeadless = agentSource === "dsh" && (() => {
    const tools = (body as { tools?: unknown }).tools;
    if (!Array.isArray(tools) || tools.length === 0) return false;
    return !tools.some((t) => {
      const fn = (t as { function?: { name?: string }; name?: string })?.function;
      const n = fn?.name ?? (t as { name?: string })?.name;
      return n === "ask_user_question";
    });
  })();
  if (_dshHeadless) {
    console.log(`[request-classify] session=${sessionKey} agent=dsh headless/no-preset (no ask_user_question tool) → bypass session-init, direct passthrough`);
  }

  // C4-dsh Phase 2：one-shot 子 agent 显式标识——dsh harness 会给 spawn 的子 agent
  // 也自动挂 ask_user_question（工具声明存在但运行时无处理器），tools 启发式失效
  // （声明≠可执行）。改用显式 prompt 标记：插件在子 agent 系统提示词里加
  // [[one-shot-subagent]]，proxy 据此跳过 session-init 与全部注入。
  const _oneShotSubagent = agentSource === "dsh" && (() => {
    try {
      const msgs = (body as { messages?: Array<{ content?: unknown }> }).messages ?? [];
      for (const m of msgs) {
        const c = m.content;
        const text = typeof c === "string"
          ? c
          : Array.isArray(c)
            ? c.map((p) => (p as { text?: string })?.text ?? "").join("\n")
            : "";
        if (text.includes("[[one-shot-subagent]]")) return true;
      }
    } catch { /* non-fatal */ }
    return false;
  })();
  if (_oneShotSubagent) {
    console.log(`[request-classify] session=${sessionKey} agent=dsh one-shot-subagent (prompt marker) → bypass session-init/mem/injection`);
  }

  // C4-dsh Phase 3（指纹实测 2026-09-15 21:18）：spawn 子 agent 的判别字段 =
  // toolNames 为空（SESSION-INIT-FP 实测：主会话工具齐全，one-shot spawn 不带工具）。
  // 独立判据——不改 _dshHeadless 的“tools 空数组=纯对话”旧语义。
  const _emptyToolsSubagent = agentSource === "dsh"
    && (!Array.isArray((body as { tools?: unknown[] }).tools)
      || (body as { tools?: unknown[] }).tools!.length === 0);
  if (_emptyToolsSubagent) {
    console.log(`[request-classify] session=${sessionKey} agent=dsh empty-tools subagent (spawn one-shot) → bypass session-init/mem/injection`);
  }

  // ── mem:session-reset pre-hook ──
  // hermes / openclaw 走 header 预选身份, dsh headless 无 ask_user_question tool —
  // 三者都没有交互式 form UI 可以弹,reset 后 session 会永远卡在 pending_asset_confirm。
  // 直接返回"不支持"文案。
  const _headerOnlyAgents = new Set(["hermes", "openclaw"]);
  const _noFormAgent = _headerOnlyAgents.has(agentSource) || _dshHeadless;
  if (config.memCommand?.enabled && !isAuxiliary && _noFormAgent) {
    const { isSessionResetCommand } = await import("./mem-command/pre-intercept.js");
    if (isSessionResetCommand(body as Record<string, unknown>, agentSource)) {
      const { buildMemResponse } = await import("./mem-command/response-builder.js");
      console.log(`[mem-command:pre] session-reset unsupported for agent=${agentSource} dshHeadless=${_dshHeadless}`);
      const msg = _headerOnlyAgents.has(agentSource)
        ? `⚠️ mem:session-reset 不支持 ${agentSource} 客户端。\n\n`
          + `${agentSource} 通过 x-team-id / x-agent-id / x-task-id 请求头预选身份，没有交互式表单入口。\n`
          + `请在客户端配置中直接更改这些请求头来切换 Team / Agent / Task。`
        : "⚠️ mem:session-reset 不支持 dsh headless 模式。\n\n"
          + "dsh 客户端在 headless / no-preset 场景下不挂 ask_user_question tool，无法弹出资产选择表单。\n"
          + "请在带 ask_user_question preset 的 dsh 环境下使用。";
      return buildMemResponse(msg, {
        protocol: "openai",
        stream: isStream,
        requestId: `mem-reset-unsupported-${Date.now()}`,
      });
    }
  }
  if (config.memCommand?.enabled && !isAuxiliary && !_dshHeadless && !_headerOnlyAgents.has(agentSource)) {
    const { isSessionResetCommand } = await import("./mem-command/pre-intercept.js");
    if (isSessionResetCommand(body as Record<string, unknown>, agentSource)) {
      const { isMemCommandAllowed, parseMemCommand } = await import("./mem-command/index.js");
      const memCmd = parseMemCommand(body as Record<string, unknown>, agentSource);
      if (memCmd && isMemCommandAllowed(config.memCommand, memCmd.command)) {
        const { getSessionStore } = await import("./session/store.js");
        const store = getSessionStore();
        const compositeKey = `${agentSource}:${sessionKey}`;
        store.bind(compositeKey, { userId: userId || "anonymous", agentSource, sessionId: sessionKey, spaceId });

        // ── 强制归档旧 agent 的 skill buffer（best-effort）──
        // reset 前旧 agent 累积的对话片段可能还没达到阈值，不 flush 会永久丢失。
        const oldState = store.get(compositeKey);
        if (oldState?.status === "initialized" && oldState.sessionInfo && config.coreSkill?.endpoint) {
          const si = oldState.sessionInfo as unknown as Record<string, string>;
          if (si.space_id && si.user_id && si.team_id && si.agent_id) {
            import("./skill/core-client.js").then(({ getCoreSkillClient }) => {
              const client = getCoreSkillClient(config.coreSkill!);
              client.forceArchive(
                {
                  space_id: si.space_id,
                  user_id: si.user_id,
                  team_id: si.team_id,
                  agent_id: si.agent_id,
                  session_id: sessionKey,
                  task_id: si.task_id || undefined,
                  reason: "session-reset",
                },
                { serviceId: si.space_id },
              ).then((res) => {
                console.log(`[session-reset] force-archive old buffer: status=${res.status} session=${sessionKey} agent=${si.agent_id}`);
              }).catch((err) => {
                console.warn(`[session-reset] force-archive failed (best-effort): ${err instanceof Error ? err.message : String(err)}`);
              });
            }).catch(() => {});
          }
        }

        const resetEpoch = Date.now();
        await store.set(compositeKey, { status: "uninitialized", keyId: sessionKey, startedAt: resetEpoch, attemptCount: 0, userId: userId || "anonymous", resetEpoch, resetFlow: true });
        const bindingRepo = store.getBindingRepo();
        if (bindingRepo) await bindingRepo.deleteBinding(spaceId, sessionKey).catch(() => {});
        console.log(`[mem-command:pre] session-reset session=${sessionKey} → falling through to pop form`);
      }
    }
  }

  // ── Session Init (before injection pipeline) ─────────────────────────────
  // 历史 patch（已验证有效）：
  //   code / cordis 等 preset 下 dsh 客户端的 tools 列表不含 ask_user_question，
  //   _dshHeadless 会被判 true，于是 session-init gate 在这里直接 short-circuit
  //   → 不初始化 → sessionInfo 空 → proxy 注入 ask_user_question tool_call →
  //   dsh 端报 "unknown tool \"\""。所以从 session-init 入口移除 !_dshHeadless，
  //   保留它在 injection bypass（L732/L1045）/ mem-command（L989/L1114）/ skill
  //   extraction（L1804）等其它地方的过滤作用 —— 仅会话初始化阶段放开。
  let sessionInfo: Record<string, unknown> | null | undefined;
  let assetCapabilities: import("./injection/types.js").AssetCapabilityFlags | undefined;
  let injectedSkipped = !conversationId || isAuxiliary || _dshHeadless || _oneShotSubagent || _emptyToolsSubagent;
  let sessionJustRegistered = false;
  let _resetFlowResult: { agentName: string; agentIdShort: string; teamId: string; taskName?: string | null; bypassed?: boolean } | null = null;
  console.log(`[injection-debug] conversationId=${conversationId} sessionKey=${sessionKey} userId=${userId} agentSource=${agentSource} kind=${_requestKind} dshHeadless=${_dshHeadless} sessionInitEnabled=${config.sessionInit?.enabled} injectionEnabled=${config.injection?.enabled} injectors=${JSON.stringify(config.injection?.injectors)} injectedSkipped=${injectedSkipped} spaceId=${spaceId}`);
  // C4-dsh（用户 2026-09-15）：子 agent（一次性无头会话）跳过 session-init——
  // 历史阻塞（skip → sessionInfo 空 → 空注入 tool_call → unknown tool）已被
  // injectedSkipped 的 _dshHeadless bypass 消除（本函数上方，无头请求永不注入），
  // 现在跳过 init 是安全的：无头会话直接放行，不弹表单、不注册资产。
  // [SESSION-INIT-FP]（C4-dsh 诊断）：记录到达 gate 的每个请求的属性指纹——
  // 主会话 vs one-shot 子 agent 各留一份，diff 出可用的判别字段。诊断日志永不阻塞。
  try {
    const bfp = body as { model?: string; tools?: Array<{ function?: { name?: string }; name?: string }>; messages?: Array<{ role?: string; content?: unknown }> };
    const sysMsg = (bfp.messages ?? []).find((m) => m?.role === "system");
    const sysText = typeof sysMsg?.content === "string"
      ? sysMsg.content
      : Array.isArray(sysMsg?.content)
        ? (sysMsg!.content as Array<{ text?: string }>).map((p) => p?.text ?? "").join(" ")
        : "";
    const hdrsAll = (lcHeaders ?? {}) as Record<string, unknown>;
    const interestingHdrs: Record<string, unknown> = {};
    for (const [hk, hv] of Object.entries(hdrsAll)) {
      if (/^x-/i.test(hk)) interestingHdrs[hk] = hv;
    }
    const toolsDump = !("tools" in (body as Record<string, unknown>))
      ? "<absent>"
      : JSON.stringify((body as { tools?: unknown }).tools)?.slice(0, 400);
    console.log(`[SESSION-INIT-FP] ${JSON.stringify({
      sessionKey,
      conversationId,
      agentSource,
      kind: _requestKind,
      model: bfp.model,
      toolsDump,
      toolNames: (bfp.tools ?? []).map((t) => t?.function?.name ?? (t as { name?: string })?.name).filter(Boolean).slice(0, 25),
      msgCount: (bfp.messages ?? []).length,
      sysHead: sysText.slice(0, 160),
      dshHeadless: _dshHeadless,
      oneShotSubagent: _oneShotSubagent,
      xHeaders: interestingHdrs,
    })}`);
  } catch { /* 诊断日志永不阻塞 */ }
  if (config.sessionInit?.enabled && conversationId && !isAuxiliary && !_dshHeadless && !_oneShotSubagent && !_emptyToolsSubagent) {
    try {
      const { getSessionStore, handleSessionInit, parsePresetIdentity } = await import("./session/index.js");
      const { getMetadataClient } = await import("./meta/client.js");
      const store = getSessionStore();
      // kernel /v3/meta/* 走 x-tdai-user-key 鉴权，需要 sk-mem-* 用户 key。
      // 优先级：客户端 Authorization bearer > config.tdai.apiKey。
      // 说明：
      //   - workbuddy / codebuddy 等真实客户端会在 Authorization 里传合法的
      //     sk-mem-* 用户 key（形如 ck_ft1xxx.yyy），verifyUserKey 能解出 userId。
      //   - config.tdai.apiKey 常被本地/测试环境设成占位符（如 "local"），
      //     若用它覆盖客户端真实 key，会导致 kernel 401 invalid_user_key，
      //     session-init 直接 bypass，前端表单永不弹出。
      //   - 只有客户端未提供 apiKey 时（例如某些内部脚本），才回退到 config。
      // 与 workbuddyHandler.ts 里的 kernelUserKey 逻辑对齐（那里也是客户端优先）。
      const kernelUserKey = apiKey || config.tdai?.apiKey || "";
      const metadataClient = getMetadataClient(config.coreSkill, spaceId, kernelUserKey);
      const presetIdentity = parsePresetIdentity(config.sessionInit, lcHeaders);

      // ── Session Recovery: try L2b binding before falling into session-init form ──
      const compositeKey = `${agentSource}:${sessionKey}`;
      // Identity for repo/binding writes. userId 缺失时 fallback 到 `anonymous`
      // 复合键，保证 key path 分段合法（`u=anonymous` 走独立命名空间，天然与
      // 有 userId 的请求隔离）。参见 §4.4 边界处理。
      const identity = {
        userId: userId || "anonymous",
        agentSource,
        sessionId: sessionKey,
        spaceId,
      };
      const recovered = await store.getOrRecover(compositeKey, identity, {
        metadataClient,
        messages: body.messages as Array<Record<string, unknown>> ?? [],
        presetIdentity,
      });

      let initResult: Awaited<ReturnType<typeof handleSessionInit>>;
      // Only treat the session as "recovered" when it's in a terminal state
      // (initialized or bypassed). Pending / mid-form states MUST fall through
      // to handleSessionInit so the state machine can advance to the next form.
      const isTerminalState = recovered?.status === "initialized";
      // 记录本 turn 是否真的走了 handleSessionInit state machine（详见 anthropicHandler
      // 对称位置的注释）。sessionJustRegistered = wentThrough && justRegistered，覆盖
      // 正常注册 + bypass 两种终态转换（bypass 分支现在也带 justRegistered=true），让
      // mem-command 拦截块能在 bypass 转换那一 turn 通过 checkFirst 兜底捞出用户最初
      // 的 mem: 命令并返回"未初始化"文案，避免透传给上游 LLM 幻觉回答。
      // L2b recovery 分支 justRegistered=true 只是 prewarm 信号，走 recovered 分支时
      // wentThroughSessionInitStateMachine=false 会自然过滤掉，不进 sessionJustRegistered。
      let wentThroughSessionInitStateMachine = false;
      // Recovery hit source 决定是否需要 prewarm：
      //   - l1 / l2a：本 pod 内存 + storage 都热 —— hook-cache 大概率也在，跳过 prewarm；
      //   - l2b / history-scan：跨 pod 冷启 / 从 binding 重建 —— hook-cache 可能已过期，需 refill。
      // 之前无条件 `justRegistered: true` 会导致 L1 hit terminal 的常态轮次每次都跑一遍
      // skill/knowledge/tdai-memory 网络请求（~2s + 3 次外部调用），且 knowledge 首次
      // timeout 概率被反复放大。这里按 recovery source 精确判断。
      const needsPrewarm =
        recovered?.__recoverySource === "l2b" ||
        recovered?.__recoverySource === "history-scan";
      if (recovered && isTerminalState) {
        // Recovery hit: keep original messages, only re-inject <session_context>
        // so this turn's system message carries agent/task context again.
        // 用户对话永远保留原样，包括 session_init form 交互 — 不做任何删除。
        const { injectSessionContextWithToggles } = await import("./session/context-injector.js");
        const inMsgs = (body.messages as Array<Record<string, unknown>>) ?? [];
        const outMsgs = recovered.bypassed
          ? inMsgs
          : injectSessionContextWithToggles(
              inMsgs,
              recovered.agentDetail ?? null,
              recovered.taskDetail ?? null,
              config.sessionInit,
              sessionKey,
            );
        initResult = {
          intercepted: false,
          messages: outMsgs as Record<string, unknown>[],
          sessionInfo: recovered.sessionInfo,
          agentDetail: recovered.agentDetail,
          taskDetail: recovered.taskDetail,
          bypassed: recovered.bypassed,
          justRegistered: needsPrewarm, // 只在 L2b / history-scan recovery 时触发 prewarm
        };
      } else {
        // opencode 走跟 codebuddy 完全同构的通用 else 分支（复用 handleSessionInit +
        // ask_followup_question form）。验证 opencode 客户端对未知 tool_call 的真实反应。
        wentThroughSessionInitStateMachine = true;
        // 检测客户端 ask_followup_question schema 里 questions 字段是否声明为 array。
        // CB v1.106+ 声明为 array 且做 type check；老版本无 schema 或 questions 无 type 声明。
        let questionsAsArray = true; // 默认新版
        const clientTools = Array.isArray(body.tools) ? body.tools as unknown[] : [];
        const afqTool = clientTools.find((t: any) =>
          t?.function?.name === "ask_followup_question" || t?.name === "ask_followup_question"
        ) as Record<string, unknown> | undefined;
        if (afqTool) {
          const params = (afqTool as any).function?.parameters ?? (afqTool as any).parameters;
          const qType = params?.properties?.questions?.type;
          questionsAsArray = qType === "array";
        } else if (clientTools.length === 0) {
          // 无 tools 定义（极老客户端或 non-CB agent），保守走 string
          questionsAsArray = false;
        }
        initResult = await handleSessionInit(
          sessionKey,
          userId || null,
          body.messages as Array<Record<string, unknown>> ?? [],
          config.sessionInit,
          store,
          { stream: isStream, modelId: modelId as string, protocol: "openai", questionsAsArray },
          agentSource,
          metadataClient,
          kernelUserKey,
          spaceId,
          presetIdentity,
        );
      }

      // Case 1: Fake form returned → must not forward
      if (initResult.intercepted && initResult.response) {
        return initResult.response;
      }

      console.log(`[injection-debug] initResult session=${sessionKey} intercepted=${initResult.intercepted} bypassed=${initResult.bypassed} justRegistered=${initResult.justRegistered} resetFlow=${(initResult as any).resetFlow} hasSessionInfo=${!!initResult.sessionInfo} hasAgentDetail=${!!initResult.agentDetail}`);
      // 见 anthropicHandler 对称位置：只在真正走 sessionInit state machine 时继承。
      if (wentThroughSessionInitStateMachine && initResult.justRegistered) sessionJustRegistered = true;

      // Case 1.5: Bypass path → skip ALL injection hooks
      if (initResult.bypassed) {
        injectedSkipped = true;
        console.log(`[session-init] session=${sessionKey} bypassed → skipping all injection`);
        if (initResult.resetFlow) {
          _resetFlowResult = { agentName: "", agentIdShort: "", teamId: "", bypassed: true };
        }
      }

      if (!initResult.bypassed && initResult.sessionInfo) {
        try {
          const { fetchAssetCapabilities } = await import("./tdai/capabilities.js");
          assetCapabilities = await fetchAssetCapabilities({
            endpoint: config.tdai.endpoint,
            apiKey: config.tdai.apiKey,
            serviceId: config.tdai.serviceId,
            serviceIdOverride: spaceId,
            userId: (initResult.sessionInfo as { user_id?: string }).user_id,
            userKey: apiKey || null,
            timeoutMs: config.tdai.memory.timeoutMs,
          });
          console.log(`[asset-capability] user=${(initResult.sessionInfo as { user_id?: string }).user_id ?? "-"} flags=${JSON.stringify(assetCapabilities)}`);
        } catch (err) {
          console.warn(`[asset-capability] resolve failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Restore space_id from the URL BEFORE prewarm. Recovery paths and
      // legacy sessions can hydrate a SessionInfo whose `space_id` is empty;
      // prewarm calls (skill-injector, memory-injector) route to the correct
      // kernel tenant via this field, so a missing value at this point
      // silently poisons the prewarm cache with empty results.
      // See BUG-skill-injection-multinode.md §3.3(B).
      const { restoreSessionSpaceId } = await import("./session/restore-space-id.js");
      restoreSessionSpaceId(
        initResult.sessionInfo as Record<string, unknown> | null | undefined,
        spaceId,
      );

      // Prewarm 前置短路：mem-command 命中的 turn 不 forward 上游、也不消费
      // hook-cache，若照常 prewarm 会白白多花 2-3s + 3 次网络请求（knowledge
      // 33% timeout 会被放大）。这里先做纯字符串解析（<1ms、无副作用），
      // 命中就置 memCommandPending 让 prewarm 分支短路；实际 mem-command 执行
      // 仍在下方原位置进行，L0 write / skill extract / langfuse 全部保留。
      //
      // fallback 语义：sessionJustRegistered 在此已定型（见上文 L786），
      // checkFirst 场景可安全复用。
      let memCommandPending = false;
      if (config.memCommand?.enabled && !isAuxiliary && !_dshHeadless) {
        try {
          const { parseMemCommand, isMemCommandAllowed } = await import("./mem-command/index.js");
          let peek = parseMemCommand(body as Record<string, unknown>, agentSource);
          if (!peek && sessionJustRegistered) {
            peek = parseMemCommand(body as Record<string, unknown>, agentSource, { checkFirst: true });
          }
          if (peek && isMemCommandAllowed(config.memCommand, peek.command)) {
            memCommandPending = true;
            console.log(`[hook-cache] prewarm skipped: mem-command pending (cmd=${peek.command}) session=${sessionKey}`);
          }
        } catch (err) {
          console.warn(
            "[mem-command] pre-prewarm peek failed:",
            err instanceof Error ? err.message : String(err),
          );
          // peek 失败不阻塞主链路，退化为原有行为（正常 prewarm）。
        }
      }

      // Case 2 success → await prewarm so the first-turn pipeline always
      // hits the cache. A fire-and-forget void() here caused the bug where
      // the pipeline ran before the cache was populated, silently injecting
      // zero blocks for the entire first turn.
      if (
        !initResult.bypassed &&
        initResult.justRegistered &&
        initResult.sessionInfo &&
        !memCommandPending &&
        config.injection?.enabled &&
        (config.injection.injectors?.length ?? 0) > 0
      ) {
        try {
          const mod = await import("./injection/index.js");
          await mod.prewarmFromConfig(config, {
            keyId: sessionKey,
            userId: userId || "anonymous",
            agentSource,
            spaceId,
            sessionInfo: initResult.sessionInfo as import("./session/types.js").SessionInfo,
            agentDetail: initResult.agentDetail ?? null,
            taskDetail: initResult.taskDetail ?? null,
            assetCapabilities,
            callerUserKey: apiKey ?? undefined,
          }, { clearBefore: true });
        } catch (err) {
          console.warn(
            "[hook-cache] handler prewarm error:",
            err instanceof Error ? err.message : String(err),
          );
          // Don't re-throw: the pipeline's resolveHookBlocks has its own
          // cache-miss → execute() fallback as a safety net (see pipeline.ts).
        }
      }

      // Case 2: Messages were cleaned → update body
      if (initResult.messages) {
        body = { ...body, messages: initResult.messages };
        messages = initResult.messages as unknown[];
      }

      sessionInfo = initResult.sessionInfo as Record<string, unknown> | null | undefined;
      // Belt-and-suspenders: also restore on the local `sessionInfo` alias.
      // In practice this is the same object reference as
      // `initResult.sessionInfo` (already restored above), but the second
      // call is a no-op and guards against future refactors that copy
      // the object between these two lines.
      restoreSessionSpaceId(sessionInfo, spaceId);

      // 记录 resetFlow 信息到外层，session-init 块结束后用于返回确认响应
      if (initResult.resetFlow && initResult.justRegistered && !initResult.bypassed) {
        _resetFlowResult = {
          agentName: initResult.agentDetail?.name ?? "未知",
          agentIdShort: initResult.sessionInfo?.agent_id
            ? String(initResult.sessionInfo.agent_id).slice(-8) : "",
          teamId: initResult.sessionInfo?.team_id
            ? String(initResult.sessionInfo.team_id).slice(-8) : "",
          taskName: initResult.taskDetail?.name,
        };
      }
    } catch (err: unknown) {
      console.error("[session-init] Error in handleSessionInit:", err instanceof Error ? err.message : String(err));
      sessionInfo = undefined;
      injectedSkipped = true;
    }
  }

  // ── mem:session-reset 完成确认 ─────────────────────────────────────────────
  if (_resetFlowResult) {
    const { agentName, agentIdShort, teamId, taskName, bypassed } = _resetFlowResult;
    const lines = bypassed
      ? ["✅ 已跳过团队资产关联", "", "后续对话不注入任何团队资产（Skill / 记忆 / Knowledge）。"]
      : [
          "✅ 已重新绑定团队资产",
          "",
          `- **Agent**: ${agentName}${agentIdShort ? ` (${agentIdShort})` : ""}`,
          teamId ? `- **Team**: ${teamId}` : null,
          taskName ? `- **Task**: ${taskName}` : "- **Task**: 未关联",
          "",
          "后续对话将使用新 Agent 的 Skill、记忆和知识资产。",
        ].filter(Boolean);
    const text = (lines as string[]).join("\n");

    const { buildMemResponse } = await import("./mem-command/response-builder.js");
    console.log(`[mem-command:session-reset] completed: bypassed=${!!bypassed} agent=${agentName} (${agentIdShort})`);
    return buildMemResponse(text, {
      protocol: "openai",
      stream: isStream,
      requestId: `mem-reset-${Date.now()}`,
    });
  }

  // ── mem: command intercept ────────────────────────────────────────────────
  // 位置对齐 anthropicHandler.ts:847 —— session init 完成后、injection 之前。
  // 命中时：执行命令 → 写 L0 → 触发 skill extract → 伪造 OpenAI 响应返回，跳过
  // injection（不破坏 KV cache）和上游转发（零 token 消耗）。配置开关
  // memCommand.enabled 关闭时此段完全不执行，走原有链路。
  //
  // 解决的坑：CodeBuddy 走 OpenAI 协议命中本 handler，之前 mem-command intercept
  // 只挂在 anthropicHandler，CB 用户发 `mem:help` 会直接透传到上游 LLM，返回
  // LLM 幻觉出来的"帮助文本"（含 mem:atoms/mem:profile/mem:conversations 等
  // 根本不存在的命令）。本次抓包 (langfuse trace d814929a...) 实证后补齐。
  //
  // 请求分类：OpenAI 协议不做 CC 的 fork/sidequery 分流（handler.ts 没接 CC
  // routing），所有请求都视为 main —— 与 codebuddy adapter classifyRequest 一致。
  if (config.memCommand?.enabled && !isAuxiliary && !_dshHeadless) {
    const { parseMemCommand, isMemCommandAllowed, executeMemCommand, buildMemResponse, extractSimpleMessages, truncateArgs } = await import("./mem-command/index.js");
    // 常规检测：最后一条 user message
    let memCmd = parseMemCommand(body as Record<string, unknown>, agentSource);
    // Session init 状态机在本 turn 完成终态（初始化 or bypass）时，最后一条
    // user message 是 init 交互回答（比如"否"），额外检查第一条 user message
    // —— 用户最初的原始意图。bypass 场景下 sessionInfo=null 走"未初始化"分支
    // 返回文案，避免首条 mem: 命令被吞进历史后落到 LLM 透传里。
    if (!memCmd && sessionJustRegistered) {
      memCmd = parseMemCommand(body as Record<string, unknown>, agentSource, { checkFirst: true });
    }
    // session-reset 已经在 pre-hook 处理过，跳过防止重复执行，详见 anthropicHandler 同名段
    if (memCmd?.command === "session-reset") memCmd = null;
    if (memCmd && isMemCommandAllowed(config.memCommand, memCmd.command)) {
      // 会话未初始化时，命令不可用（同 anthropic 侧提示）
      if (!sessionInfo || injectedSkipped) {
        const errText = `⚠️ 会话未初始化，命令不可用。请先完成 session 初始化（选择 Team/Agent）后重试。`;
        const errResponse = buildMemResponse(errText, {
          protocol: "openai",
          stream: isStream,
          requestId: `mem-cmd-${Date.now()}`,
        });
        console.log(`[mem-command] cmd=${memCmd.command} args="${truncateArgs(memCmd.args)}" session=${sessionKey} blocked: session not initialized`);
        return errResponse;
      }
      const memResult = await executeMemCommand(memCmd, {
        sessionKey,
        agentSource,
        config,
        spaceId,
        userId,
        apiKey: apiKey || "",
        sessionInfo: sessionInfo as Record<string, unknown>,
        protocol: "openai",
        stream: isStream,
        args: memCmd.args,
        // task 命令族用最近对话生成草稿。OpenAI/CC/CB 协议直接从 body.messages 取。
        bodyMessages: extractSimpleMessages(body.messages),
        // OpenAI 协议无 extended thinking 概念，恒 false
      });

      // L0 写入 — 同步 await 保证落盘再返回（跟主对话路径的 trackWrite/withL0Retry
      // 兜底不同，这里 mem 命令是"仅这一次"路径，必须显式等）。
      const tdaiClientForMem = createTdaiClient(config, spaceId);
      const tdaiIdentityForMem = deriveTdaiIdentity({
        sessionInfo: sessionInfo as Record<string, unknown> | null | undefined,
        userId: userId || null,
        sessionKey,
      });
      if (tdaiClientForMem && tdaiIdentityForMem && isExtractionAllowed(config, "tdai-memory")) {
        const userMsg = { role: "user" as const, content: memCmd.rawMessage };
        try {
          await recordTdaiTurn(tdaiClientForMem, tdaiIdentityForMem, userMsg, memResult.messageText);
        } catch (err: unknown) {
          console.error("[mem-command] L0 write error:", err);
        }
      }

      // Skill extract trigger — 保证对话轮次计数正常累积（跟 anthropic 侧对称）
      if (isExtractionAllowed(config, "skill")) {
        try {
          // OpenAI 协议 assistant content 是字符串，normalize-conversation 那侧
          // 会走 convertOpenAIAssistant 兜底处理 string 形态。
          const assistantMsg = { role: "assistant", content: memResult.messageText };
          await triggerSkillExtractIfReady({
            config,
            sessionKey,
            agentSource,
            sessionInfo: sessionInfo as Record<string, unknown>,
            inputMessages: messages as unknown[],
            assistantMessage: assistantMsg,
            protocol: "openai",
            assetCapabilities,
          });
        } catch (err: unknown) {
          console.warn("[mem-command] skill extract trigger error:", err instanceof Error ? err.message : String(err));
        }
      }

      console.log(`[mem-command] cmd=${memCmd.command} args="${truncateArgs(memCmd.args)}" session=${sessionKey} success=${memResult.success}`);

      // Langfuse: 上报 mem-command（跟 anthropicHandler 对称）。
      //   lf 在 L955 才构造，这里 inline 推导 turnSeq → traceId。
      const memTurnSeq = countHumanTurns(messages, "openai");
      const memTraceId = langfuseTurnTraceId(sessionKey, memTurnSeq);
      langfuseReportGeneration({
        traceId: memTraceId,
        name: "memory-proxy",
        model: "memory-proxy",
        startTime,
        endTime: new Date().toISOString(),
        input: memCmd.rawMessage,
        output: memResult.messageText,
        usage: { input_tokens: 0, output_tokens: 0 },
        traceName: `memory-proxy / ${keyId}`,
        userId: keyId,
        sessionId: sessionKey,
        tags: [
          `agent_source:${agentSource}`,
          "protocol:openai",
          isStream ? "stream" : "non-stream",
          `session:${sessionKey}`,
          "mem-command",
        ],
        traceInput: memCmd.rawMessage,
        traceOutput: memResult.messageText,
      });

      return memResult.response;
    }
  }

  // aux 请求(compaction/title)/ dsh headless(无 UI 无 preset)不写 L0 —— 直接透传
  const tdaiClient = isAuxiliary || _dshHeadless || assetCapabilities?.chat_memory === false ? null : createTdaiClient(config, spaceId);
  const tdaiIdentity = injectedSkipped
    ? null
    : deriveTdaiIdentity({
        sessionInfo: sessionInfo as Record<string, unknown> | null | undefined,
        userId: userId || null,
        sessionKey,
      });
  // dsh 走独立的正向匹配提取（对齐 codex/workbuddy 的渠道提取设计）；
  // 其它渠道（claude/codebuddy/opencode/pi/unknown）继续用通用 extractLatestUserMessage。
  const tdaiUserMessage = agentSource === "dsh"
    ? extractLatestDshUserMessage(messages)
    : extractLatestUserMessage(messages);

  // [PROBE] dsh raw wire user messages — dump every user message content for matching analysis
  if (agentSource === "dsh") {
    const userMessages = (messages as Array<Record<string, unknown>>)
      .filter((m) => m?.role === "user")
      .map((m, idx) => {
        const c = m.content;
        let text = "";
        if (typeof c === "string") text = c;
        else if (Array.isArray(c)) text = c.map((p) => (p && typeof p === "object" ? (p as any).text ?? "" : String(p ?? ""))).join("");
        else if (c) text = String(c);
        return { idx, role: m.role, contentLen: text.length, head: text.slice(0, 120), src: (m as any).source?.kind ?? (m as any).src ?? null };
      });
    log.info("dsh-l0-rawwires", {
      session: sessionKey, totalMsgs: messages.length,
      userCount: userMessages.length,
      userMessages: userMessages.slice(-6), // last 6 user entries
    });
  }

  // [PROBE] dsh L0 decision diagnostics — DEBUG ONLY
  if (agentSource === "dsh") {
    const probeMsg = tdaiUserMessage ? String(tdaiUserMessage.content) : null;
    log.info("dsh-l0-probe", {
      session: sessionKey,
      requestKind: _requestKind,
      dshHeadless: _dshHeadless,
      injectedSkipped,
      hasSessionInfo: !!sessionInfo,
      chatMemory: assetCapabilities?.chat_memory,
      identity: tdaiIdentity ? { team: tdaiIdentity.teamId, user: tdaiIdentity.userId, agent: tdaiIdentity.agentId, session: tdaiIdentity.sessionId } : null,
      userMessageLen: probeMsg ? probeMsg.length : null,
      userMessagePreview: probeMsg ? probeMsg.slice(0, 80) : null,
      userRoleCount: messages.filter((m) => (m as { role?: string })?.role === "user").length,
      totalMsgs: messages.length,
      lastRole: (messages[messages.length - 1] as { role?: string })?.role,
    });
  }

  // ── Context injection (before cost guard) ──────────────────────────────
  if (!injectedSkipped && config.injection?.enabled && config.injection.injectors.length > 0) {
    try {
      const injectionTurnSeq = countHumanTurns(messages, "openai");
      const { getInjectionPipeline } = await import("./injection/index.js");
      const pipeline = getInjectionPipeline(config);
      const injectedBody = await pipeline.process(body, {
        protocol: "openai",
        traceId,
        keyId,
        modelId: modelId as string,
        stream: isStream,
        agentSource,
        userId: userId || "anonymous",
        spaceId,
        sessionKey,
        turnSeq: injectionTurnSeq,
        // 透传原始请求路径 —— AssetReflectionInjector 用它判断 `/analyse` marker。
        // 其它 injector 不依赖此字段。
        requestPath: c.req.path,
        custom: sessionInfo
          ? {
              session: sessionInfo,
              assetCapabilities,
              userKey: apiKey || undefined,
            }
          : undefined,
      });
      body = injectedBody;
      messages = Array.isArray(injectedBody.messages) ? injectedBody.messages : messages;
    } catch (err: unknown) {
      // Injection failure is non-fatal — fall back to original body
    }
  }

  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;

  // ── Resolve forward target (opaque extension — no routing logic here) ──
  // upstream.agents[agent] is a single map keyed by agent name — same lookup
  // as anthropicHandler. Empty / missing entry → fall back to upstream.url,
  // preserving legacy behavior for configs that don't declare `agents:` at all.
  // ── Member-custom provider override (spec §3.1) ─────────────────────────
  // agent 成员覆盖 > user 成员覆盖 > upstream.agents[agentFromPath] > global。
  // 命中成员覆盖时:转发 url / apiKey / body.model 全部取成员配置;未命中返回
  // null,下方所有解析与现状逐字一致(零侵入)。
  const memberUpstream = await resolveMemberOverride(config, {
    userId: userId || null,
    agentId: (sessionInfo as { agent_id?: string } | null | undefined)?.agent_id || null,
  });
  if (memberUpstream) applyMemberModel(body, memberUpstream);

  // ── Model gate（自入口迁入，spec §8）──
  const gateError = enforceModelGate(config.creditPricing, memberUpstream, requestedModel);
  if (gateError) {
    return c.json(
      { error: { message: gateError, type: "invalid_request_error", code: "model_not_found" } },
      400,
    );
  }

  const agentUpstreamEntry = agentFromPath ? config.upstream.agents?.[agentFromPath] : undefined;
  // Per-agent apiKey resolution — three cases:
  //   (a) no entry in agents map           → global upstream.apiKey (兜底)
  //   (b) entry present, apiKey empty      → "" (passthrough, keep client key)
  //   (c) entry present, apiKey non-empty  → agent.apiKey (server-side key)
  // Presence of an entry (case b/c) cuts the global fallback — that's what
  // lets one proxy serve mixed server-key / client-key agents at once.
  const effectiveApiKey = memberUpstream
    ? memberUpstream.apiKey
    : agentUpstreamEntry
      ? (agentUpstreamEntry.apiKey ?? "")
      : config.upstream.apiKey;
  // Normalize the request path to the canonical upstream endpoint so the
  // extension's URL joining matches the host whitelist behavior.
  const forwardEndpoint = matchWhitelistEndpoint(c.req.path)?.upstreamEndpoint ?? "/chat/completions";
  // Isolation key is user-namespaced (`${user}:${session}`) so two users that
  // share the same client session id can't contaminate each other's state /
  // turn counting. ClickHouse keeps the raw session_key (it has its own
  // user_id column); this composite is internal to the extension only.
  const target: ForwardTarget = await resolveForwardTarget(config, {
    keyId: `${keyId}:${sessionKey}`,
    messages,
    protocol: "openai",
    hasTools,
    body,
    modelId: memberUpstream ? memberUpstream.model : modelId,
    defaultUpstreamUrl: memberUpstream?.url ?? agentUpstreamEntry?.url ?? config.upstream.url,
    requestPath: forwardEndpoint,
    headers: lcHeaders,
    traceId,
    startTime,
    spaceId,
    // markerOptIn=false (default/prod): every request goes through the router
    //   regardless of the URL (`/cost-guard` routes are 404 in this mode).
    // markerOptIn=true (test env): only requests with the `/cost-guard`
    //   segment activate the router; bare paths passthrough.
    useGuard: config.costGuard.markerOptIn ? hasCostGuardMarker(c.req.path) : true,
    agentName: agentFromPath,
  });

  // ── Create pipeline logger ──────────────────────────────────────────────
  const pipe = createPipeline(config, traceId, target.model);
  pipe.requestReceived(messages.length, isStream);
  if (target.logLine) pipe.info("COST_GUARD", target.logLine);
  if (target.logLineExtra) pipe.info("COST_GUARD_DETAIL", target.logLineExtra);

  // ── Trace-level tags ──
  // agent_source 标明客户端族群（codebuddy / claude-code / codex / …），供
  // Langfuse 上按客户端筛选 trace；protocol 只区分 wire 协议，同一 wire
  // 可对应多个客户端。
  const traceTags: string[] = [
    `agent_source:${agentSource}`,
    "protocol:openai",
    isStream ? "stream" : "non-stream",
    `session:${sessionKey}`,
  ];

  // ── Langfuse turn context: one trace = one turn (deterministic traceId) ──
  // Same (sessionKey, turnSeq) across a turn's tool-loop requests → same trace.
  // Prefer the extension's monotonic per-session turnSeq (survives context
  // compaction); fall back to the stateless count when it's not tracked.
  const turnSeq = target.turnSeq > 0 ? target.turnSeq : countHumanTurns(messages, "openai");
  const lf: LangfuseTurnContext = {
    traceId: langfuseTurnTraceId(sessionKey, turnSeq),
    turnSeq,
    traceName: `${target.model} / ${keyId}`,
    userId: keyId,
    sessionId: sessionKey,
    tags: traceTags,
    routeTags: target.tags,
    userQuery: resolveLatestUserQuery(config, lcHeaders, c.req.path, body, messages),
  };
  if (target.analyzerTrace) {
    reportAnalyzerTrace(config, target.analyzerTrace, {
      traceId,
      langfuseTraceId: lf.traceId,
      traceName: lf.traceName,
      traceTags: lf.tags,
      keyId: `${keyId}:${sessionKey}`,
      sessionKey,
      turnSeq,
      startTime,
      spaceId,
    });
  }

  // ── Langfuse debug metadata (only when config.langfuse.debug=true) ────────
  // CB / cursor / windsurf 走 OpenAI 协议命中本 handler；开 debug 时把请求
  // 结构 + 客户端指纹塞进 Langfuse observationMetadata，供抓包分析用。
  // 默认关（{}），不污染线上 trace。详见 common/langfuse-debug.ts。
  const langfuseDebug = config.langfuse.debug === true;
  const debugMetadata = buildRequestDebugMetadata({
    debug: langfuseDebug,
    body: body as Record<string, unknown>,
    headers: reqHeaders,
    agentSource,
    // 本 handler 不做 CC 客户端的 fork/sidequery 分流（只 anthropicHandler 走那套）
    spaceId,
    turnSeq,
    requestPath: c.req.path,
    protocol: "openai",
  });

  // ── Opik: create trace ───────────────────────────────────────────────────
  const forkTraceId = opikCreateTrace(config, {
    traceId,
    projectName: keyId,
    name: `${target.model} / ${keyId}`,
    startTime,
    input: { messages: flattenMessagesForOpik(messages) },
    tags: [...traceTags, ...target.tags],
    forkProjectName: "request_log",
    forkMetadata: {
      keyId,
      modelId: target.model,
      stream: isStream,
      upstreamUrl: target.url,
    },
  });

  // ── Request debug log ────────────────────────────────────────────────────
  writeRequestLog(config, body);

  // ── Build upstream request ───────────────────────────────────────────────
  const upstreamHeaders = buildUpstreamHeaders(c, config, target, sessionKey, effectiveApiKey);

  // Optional private preparation stage. It rewrites `body` / `messages` in
  // place, so it has to land after every host-side mutation (injection, agent
  // overrides) and before the upstream body is assembled below. The host does
  // not interpret the returned stats — see request-prepare-adapter.ts.
  const preparedStats = await prepareUpstreamRequest({
    config,
    protocol: "openai",
    body,
    messages,
    sessionKey,
    pipe,
    upstreamCall: {
      upstreamUrl: target.url,
      headers: upstreamHeaders,
      model: target.model,
      tools: body.tools,
      bodyOverrides: target.bodyOverrides ?? undefined,
    },
    userQuery: lf.userQuery,
    spaceId,
    lf,
  });

  const upstreamBody = buildUpstreamBody(body, target);
  // Retry headers: preserve original client headers (x-request-id, user-agent,
  // etc.), then force the primary upstream's auth — retry always goes to the
  // default upstream (never the alternate route), so its apiKey must be applied
  // just like the first-attempt path. Without this, retry sends the
  // client's raw auth to tokenhub and gets 401.
  const originalHeaders: Record<string, string> = {};
  for (const [k, v] of c.req.raw.headers.entries()) {
    if (!SKIP_REQUEST_HEADERS.has(k.toLowerCase())) {
      originalHeaders[k] = v;
    }
  }
  // Retry uses the same effective key as the primary path — when it
  // resolves to "" (agent entry present but no apiKey), retry also runs
  // on the client's own key, preserving the passthrough intent.
  if (effectiveApiKey) {
    originalHeaders["authorization"] = `Bearer ${effectiveApiKey}`;
  }

  // Inject stream_options.include_usage for OpenAI compat
  if (isStream) {
    upstreamBody.stream_options = {
      ...(typeof upstreamBody.stream_options === "object" && upstreamBody.stream_options !== null
        ? (upstreamBody.stream_options as object)
        : {}),
      include_usage: true,
    };
  }

  // ── Forward to upstream (with automatic retry if configured) ──────────────
  const forwardTimeoutMs = config.server.forwardTimeoutMs ?? 600_000;
  // Pass target.url so the FORWARD log reflects the actual per-agent upstream
  // (otherwise it prints the global default and misleads triage).
  pipe.forwardStart(target.url);
  let upstreamResp: Response;
  let retried = false;

  try {
    const result = await forwardWithRetry(
      target, upstreamHeaders, upstreamBody,
      body, originalHeaders,
      pipe, forwardTimeoutMs,
      sessionKey,
      { config, instanceId: spaceId || undefined },
    );
    upstreamResp = result.resp;
    retried = result.retried;
  } catch (err: unknown) {
    if (isRateLimitExceededError(err)) {
      pipe.info("RATE_LIMIT", "TPM/QPM exceeded");
      return err.response;
    }
    langfuseReportFailure({
      lf,
      model: target.model,
      startTime,
      endTime: new Date().toISOString(),
      input: buildLangfuseInputChat(messages, langfuseDebug, flattenMessagesForOpik),
      statusMessage: err instanceof Error ? err.message : "Upstream request failed",
      extraTags: ["error"],
      observationMetadata: { stage: "forward", ...debugMetadata },
    });
    return c.json({ error: "Upstream request failed" }, 502);
  }

  // Build response headers (strip hop-by-hop)
  const respHeaders = new Headers();
  for (const [k, v] of upstreamResp.headers.entries()) {
    if (!SKIP_RESPONSE_HEADERS.has(k.toLowerCase())) {
      respHeaders.set(k, v);
    }
  }

  // Upstream request id from response header (tokenhub / OpenAI-compatible
  // gateways set `x-request-id`). Used for cross-system tracing/audit.
  const upstreamRequestId = upstreamResp.headers.get("x-request-id") ?? "";

  const effectiveModel = retried && target.retryTarget
    ? target.retryTarget.model
    : target.model;

  // A retry falls back to the model the client asked for, so the request ends
  // up costing what it would have cost unrouted — no saving to attribute.
  const routedFrom = retried ? "" : target.routedFrom;
  // `routedFrom` is also present in cost-guard's opaque logMeta. Keep the
  // normalized post-retry value authoritative so fallback requests never book
  // savings or carry stale route attribution.
  const { routedFrom: _ignoredRoutedFrom, ...routeLogMeta } = target.logMeta;
  const responseLogMeta = {
    ...routeLogMeta,
    ...(retried ? { retrySuccess: true } : {}),
  };

  // ── Streaming response ───────────────────────────────────────────────────
  if (isStream) {
    if (!upstreamResp.body) {
      pipe.streamDone(null);
      return new Response(null, { status: upstreamResp.status, headers: respHeaders });
    }

    // Log upstream error body for 4xx responses
    if (!retried && upstreamResp.status >= 400 && upstreamResp.status < 500) {
      const [errBodyStream, clientPassStream] = upstreamResp.body.tee();
      const errText = await new Response(errBodyStream).text();
      pipe.error("UPSTREAM_4xx", `status=${upstreamResp.status} body=${errText.slice(0, 1000)}`);
      writeLog(config, {
        timestamp: new Date().toISOString(),
        event: "usage",
        modelId: target.model,
        keyId,
        sessionKey,
        upstreamUrl: target.url,
        stream: true,
        usage: { error: true, status: upstreamResp.status, body: errText.slice(0, 500) },
        ...responseLogMeta,
        routedFrom,
        spaceId,
        upstreamRequestId,
      });
      langfuseReportFailure({
        lf,
        model: effectiveModel,
        startTime,
        endTime: new Date().toISOString(),
        input: buildLangfuseInputChat(messages, langfuseDebug, flattenMessagesForOpik),
        status: upstreamResp.status,
        statusMessage: errText.slice(0, 500),
        extraTags: ["error"],
        observationMetadata: { stage: "upstream", stream: true, ...debugMetadata },
      });
      pipe.streamDone(null);
      return new Response(clientPassStream, { status: upstreamResp.status, headers: respHeaders });
    }

    pipe.streamStart();

    const tapCtx: TapContext = {
      config,
      modelId: effectiveModel,
      keyId,
      sessionKey,
      upstreamUrl: target.url,
      requestPath: c.req.path,
      traceId,
      forkTraceId,
      startTime,
      inputMessages: messages,
      retried,
      logMeta: responseLogMeta,
      routedFrom,
      tdaiClient,
      tdaiIdentity,
      tdaiUserMessage,
      assetCapabilities,
      pipe,
      sessionKeyForSkill: sessionKey,
      agentSource,
      isAuxiliary,
      isDshHeadless: _dshHeadless,
      sessionInfo,
      lf,
      spaceId,
      upstreamRequestId,
      langfuseDebug,
      debugMetadata,
      preparedStats,
    };
    const passthrough = createUsageTapTransform(tapCtx);
    const tappedStream = upstreamResp.body.pipeThrough(passthrough);

    return new Response(tappedStream, { status: upstreamResp.status, headers: respHeaders });
  }

  // ── Non-streaming response ───────────────────────────────────────────────
  const respText = await upstreamResp.text();
  const endTime = new Date().toISOString();

  let usage: Record<string, unknown> | null = null;
  let assistantMessage: Record<string, unknown> | null = null;
  try {
    const respJson = JSON.parse(respText) as Record<string, unknown>;
    if (respJson.usage && typeof respJson.usage === "object") {
      usage = respJson.usage as Record<string, unknown>;
    }
    const choices = respJson.choices;
    if (Array.isArray(choices) && choices.length > 0) {
      const msg = (choices[0] as Record<string, unknown>).message;
      if (msg && typeof msg === "object") {
        assistantMessage = msg as Record<string, unknown>;
      }
    }
  } catch {
    // non-JSON upstream response
  }

  const logMeta = responseLogMeta;

  // Report the completed response to the extension (same signal the streaming
  // path emits from its tap). Fire-and-forget.
  void notifyUpstreamResponse(
    config,
    {
      protocol: "openai",
      sessionKey,
      model: effectiveModel,
      stream: false,
      turnSeq: lf.turnSeq,
      text: typeof assistantMessage?.content === "string" ? assistantMessage.content : "",
      toolCalls: (Array.isArray(assistantMessage?.tool_calls) ? assistantMessage.tool_calls : [])
        .map((tc) => {
          const t = tc as Record<string, unknown>;
          const fn = t.function as Record<string, unknown> | undefined;
          const argsVal = fn?.arguments;
          return {
            id: (t.id as string) ?? "",
            name: (fn?.name as string) ?? "",
            arguments: typeof argsVal === "string" ? argsVal : JSON.stringify(argsVal ?? ""),
          };
        })
        .filter((tc) => tc.id && tc.arguments),
      usage: usage ?? {},
    },
    pipe,
  );

  // 内部使用埋点：非流式响应里的 tool_calls 逐个记 model_intent。
  try {
    const toolCalls = assistantMessage?.tool_calls;
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      const intents = toolCalls
        .map((tc) => {
          const t = tc as Record<string, unknown>;
          const fn = t.function as Record<string, unknown> | undefined;
          const name = (fn?.name as string) ?? "";
          const argsVal = fn?.arguments;
          const argsStr = typeof argsVal === "string" ? argsVal : JSON.stringify(argsVal ?? "");
          return { name, arguments: argsStr };
        })
        .filter((i) => i.name);
      if (intents.length > 0) {
        emitModelIntentTelemetry({
          // 与 session_init_logs 对齐 compositeKey 形态
          sessionKey: `${agentSource}:${sessionKey}`,
          turnSeq: lf.turnSeq,
          spaceId,
          userId: keyId,
          agentSource,
          intents,
        });
      }
    }
  } catch {
    // 埋点绝不阻塞业务
  }

  if (usage) {
    await recordInputTokenUsage({
      config,
      instanceId: spaceId || undefined,
      modelId: effectiveModel,
      usage,
      protocol: "openai",
    });
    writeLog(config, {
      timestamp: endTime,
      event: "usage",
      modelId: effectiveModel,
      keyId,
      sessionKey,
      turnSeq: lf.turnSeq,
      userInput: lf.userQuery || undefined,
      upstreamUrl: target.url,
      stream: false,
      usage,
      extensionStats: preparedStats ?? undefined,
      ...logMeta,
      routedFrom,
      spaceId,
      upstreamRequestId,
    });

    const outputMessages = assistantMessage ? [assistantMessage] : [];
    opikUpdateTrace(config, {
      traceId,
      projectName: keyId,
      endTime,
      output: outputMessages,
      usage,
    });
    if (forkTraceId && !config.opik.stripRequestLogContent) {
      opikUpdateTrace(config, {
        traceId: forkTraceId,
        projectName: "request_log",
        endTime,
        output: outputMessages,
        usage,
      });
    }

    // [PROBE] non-stream write decision — DEBUG ONLY
    if (agentSource === "dsh") {
      log.info("dsh-l0-nonstream", {
        session: sessionKey, hasClient: !!tdaiClient, hasIdentity: !!tdaiIdentity,
        hasUserMsg: !!tdaiUserMessage, identity: tdaiIdentity ? { agent: tdaiIdentity.agentId, user: tdaiIdentity.userId } : null,
        extractionAllowed: isExtractionAllowed(config, "tdai-memory"),
      });
    }

    if (tdaiClient && isExtractionAllowed(config, "tdai-memory")) {
      await recordTdaiTurn(tdaiClient, tdaiIdentity, tdaiUserMessage, assistantContentForTdai(assistantMessage));
    } else if (tdaiClient) {
      logExtractionSkipped(config, "tdai-memory", sessionKey);
    }

    opikCreateLlmSpan(config, {
      traceId,
      projectName: keyId,
      name: effectiveModel,
      startTime,
      endTime,
      inputMessages: flattenMessagesForOpik(messages),
      outputMessage: assistantMessage,
      model: effectiveModel,
      usage,
      tags: [
        "non-stream",
        ...(retried ? ["retry"] : []),
      ],
      forkProjectName: "request_log",
      forkTraceId,
      forkMetadata: {
        keyId,
        modelId: effectiveModel,
        stream: false,
        upstreamUrl: target.url,
      },
    });

    // Langfuse: report this LLM call as a generation under the turn trace
    langfuseReportGeneration({
      traceId: lf.traceId,
      name: effectiveModel,
      model: effectiveModel,
      startTime,
      endTime,
      input: buildLangfuseInputChat(messages, langfuseDebug, flattenMessagesForOpik),
      output: assistantMessage,
      usage,
      traceName: lf.traceName,
      userId: lf.userId,
      sessionId: lf.sessionId,
      tags: lf.tags,
      traceInput: lf.userQuery || undefined,
      traceOutput: assistantMessage ?? undefined,
      traceMetadata: { stream: false, retried, upstreamUrl: target.url, ...logMeta, ...debugMetadata },
      observationMetadata: { retried, ...logMeta, ...debugMetadata },
    });
  } else if (upstreamResp.status >= 400) {
    pipe.error("UPSTREAM_4xx", `status=${upstreamResp.status} body=${respText.slice(0, 1000)}`);
    langfuseReportFailure({
      lf,
      model: effectiveModel,
      startTime,
      endTime,
      input: buildLangfuseInputChat(messages, langfuseDebug, flattenMessagesForOpik),
      status: upstreamResp.status,
      statusMessage: respText.slice(0, 500),
      extraTags: ["error"],
      observationMetadata: { stage: "upstream", stream: false, ...debugMetadata },
    });
  }

  pipe.responseDone(usage);

  // Skill extract trigger — count tool calls + buffer conversation.
  // 同步 await：直到 store 落盘再继续，保证下一轮跨节点读到最新数据。
  // aux 请求(compaction/title)/dsh headless 不触发 skill 提取 —— 保持归档 buffer 语义纯净
  if (!isAuxiliary && !_dshHeadless && isExtractionAllowed(config, "skill")) {
    await triggerSkillExtractIfReady({
      config,
      sessionKey,
      agentSource,
      sessionInfo,
      inputMessages: messages,
      assistantMessage,
      protocol: "openai",
      assetCapabilities,
    });
  } else if (!isAuxiliary && !_dshHeadless) {
    logExtractionSkipped(config, "skill", sessionKey);
  }

  // Credit usage reporting (non-streaming). Failures are surfaced to the client
  // via the `x-credit-report-error` response header but never replace the
  // upstream LLM response body — the user-facing answer is preserved.
  const creditOutcome = await tryReportCreditFromPath(
    config.creditReport,
    c.req.path,
    usage,
    config.creditPricing,
    effectiveModel,
    target.url,
    "usage",
  );
  if (creditOutcome.attempted && !creditOutcome.ok) {
    pipe.error("CREDIT_REPORT", creditOutcome.errorMessage ?? "unknown");
    if (creditOutcome.errorHeader) {
      respHeaders.set("x-credit-report-error", creditOutcome.errorHeader);
    }
    // Persist the failed report as a raw record for auditing / retry pipelines.
    writeFailedReportRaw(
      {
        timestamp: new Date().toISOString(),
        event: "usage",
        modelId: effectiveModel,
        keyId,
        sessionKey,
        upstreamUrl: target.url,
        stream: false,
        usage: usage === null ? undefined : usage,
        routedFrom,
        upstreamRequestId,
        pricingConfig: config.creditPricing,
      },
      creditOutcome.errorMessage ?? "unknown",
    );
  }

  return new Response(respText, { status: upstreamResp.status, headers: respHeaders });
}


function assistantContentForTdai(message: Record<string, unknown> | null): string | null {
  if (!message) return null;
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      const p = part as Record<string, unknown>;
      if (typeof p.text === "string") return p.text;
      if (typeof p.content === "string") return p.content;
      return "";
    }).filter(Boolean).join("\n") || null;
  }
  return content == null ? null : JSON.stringify(content);
}

function outputMessageContent(message: Record<string, unknown> | null): string | null {
  return assistantContentForTdai(message);
}

// ── Internal helpers ─────────────────────────────────────────────────────────

interface TapContext {
  config: ProxyConfig;
  modelId: string;
  keyId: string;
  sessionKey: string;
  upstreamUrl: string;
  traceId: string;
  forkTraceId: string;
  requestPath: string;
  startTime: string;
  inputMessages: unknown[];
  retried: boolean;
  logMeta: Record<string, unknown>;
  /** Requested model when the router forwarded elsewhere; "" otherwise. */
  routedFrom: string;
  tdaiClient: TdaiClient | null;
  tdaiIdentity: TdaiIdentity | null;
  tdaiUserMessage: TdaiMessage | null;
  assetCapabilities?: import("./injection/types.js").AssetCapabilityFlags;
  pipe: ReturnType<typeof createPipeline>;
  /** For skill extract trigger; null when session_init is disabled. */
  sessionKeyForSkill: string;
  /** Client type (URL path 第一段) — 透传给 extract trigger 作为三段隔离键之一。 */
  agentSource: string;
  /** True when this request was classified as auxiliary (compaction/title-gen) —
   * downstream L0/skill extract paths must skip to keep buffer semantics clean. */
  isAuxiliary: boolean;
  /** True when this dsh request came from CLI headless / no-preset (no ask_user_question
   * in tools) — behaves like aux for downstream side-effects. */
  isDshHeadless: boolean;
  sessionInfo: Record<string, unknown> | null | undefined;
  /** Langfuse turn-trace context (trace = one turn). */
  lf: LangfuseTurnContext;
  /** Space/tenant ID from request path. */
  spaceId?: string;
  /** Upstream response header `x-request-id` (empty when not returned). */
  upstreamRequestId?: string;
  /** `config.langfuse.debug === true` 的求值结果。 */
  langfuseDebug: boolean;
  /** buildRequestDebugMetadata 结果；debug=false 时为 {}。 */
  debugMetadata: Record<string, unknown>;
  /** Opaque counters from the request-preparation stage; null when it didn't run. */
  preparedStats: Record<string, unknown> | null;
}

/** Accumulated tool call state during SSE streaming. */
interface ToolCallAccumulator {
  id: string;
  type: string;
  functionName: string;
  functionArguments: string;
}

/** Result of extracting content + tool_calls from SSE text. */
interface SseExtractResult {
  content: string;
  toolCallDeltas: Array<{ index: number; id?: string; type?: string; functionName?: string; functionArguments?: string }>;
}

/** Extract assistant content and tool_call deltas from OpenAI SSE text. */
function extractSseContentAndTools(sseText: string): SseExtractResult {
  let content = "";
  const toolCallDeltas: SseExtractResult["toolCallDeltas"] = [];

  for (const line of sseText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const dataStr = trimmed.slice(5).trim();
    if (!dataStr || dataStr === "[DONE]") continue;
    try {
      const evt = JSON.parse(dataStr) as Record<string, unknown>;
      const choices = evt.choices;
      if (Array.isArray(choices) && choices.length > 0) {
        const delta = (choices[0] as Record<string, unknown>).delta as Record<string, unknown> | undefined;
        if (typeof delta?.content === "string") {
          content += delta.content;
        }
        const tcArr = delta?.tool_calls;
        if (Array.isArray(tcArr)) {
          for (const tc of tcArr) {
            const t = tc as Record<string, unknown>;
            const idx = typeof t.index === "number" ? t.index : 0;
            const fn = t.function as Record<string, unknown> | undefined;
            toolCallDeltas.push({
              index: idx,
              id: typeof t.id === "string" ? t.id : undefined,
              type: typeof t.type === "string" ? t.type : undefined,
              functionName: typeof fn?.name === "string" ? fn.name : undefined,
              functionArguments: typeof fn?.arguments === "string" ? fn.arguments : undefined,
            });
          }
        }
      }
    } catch {
      // ignore malformed SSE lines
    }
  }
  return { content, toolCallDeltas };
}

/** Merge accumulated tool_call deltas into complete tool_call objects. */
function mergeToolCallDeltas(
  accumulators: Map<number, ToolCallAccumulator>,
  deltas: SseExtractResult["toolCallDeltas"],
): void {
  for (const d of deltas) {
    let acc = accumulators.get(d.index);
    if (!acc) {
      acc = { id: "", type: "function", functionName: "", functionArguments: "" };
      accumulators.set(d.index, acc);
    }
    if (d.id) acc.id = d.id;
    if (d.type) acc.type = d.type;
    if (d.functionName) acc.functionName += d.functionName;
    if (d.functionArguments) acc.functionArguments += d.functionArguments;
  }
}

/** Create a TransformStream that passes bytes through unchanged,
 *  while extracting usage/content/tool_calls from SSE events in-band.
 */
function createUsageTapTransform(ctx: TapContext): TransformStream<Uint8Array, Uint8Array> {
  const { config, modelId, keyId, sessionKey, upstreamUrl, traceId, forkTraceId, startTime, inputMessages, retried, logMeta, pipe, lf, spaceId, upstreamRequestId } = ctx;

  const decoder = new TextDecoder();
  let sseBuf = "";
  let lastUsage: Record<string, unknown> | null = null;
  let assistantContent = "";
  const toolCallAccumulators = new Map<number, ToolCallAccumulator>();

  // ── L0 写入兜底（对齐 claude/codex 的超时兜底，解决 dsh 流式不触发 flush 导致 L0 丢失）──
  // dsh 的 SSE 工具循环可能不会读到流末 EOF（客户端提前关闭/回合中断），TransformStream
  // 的 flush() 因此不执行 → recordTdaiTurn 不调用 → L0(user+assistant)整体丢失。
  // 这里提供幂等的 L0 写入，并挂一个超时定时器：assistant 内容已产生但流迟迟不 flush 时，
  // 兜底触发一次写入。只对本 OpenAI 通道（dsh/workbuddy/codebuddy/opencode/pi）生效，
  // 不影响 claude(anthropicHandler)/codex(codexHandler) 各自独立的 L0 写链路。
  let l0Flushed = false;
  const flushL0 = (): void => {
    if (l0Flushed) return;
    l0Flushed = true;
    clearTimeout(l0Timer);
    if (!ctx.tdaiClient || ctx.isAuxiliary || ctx.isDshHeadless || !isExtractionAllowed(ctx.config, "tdai-memory")) return;
    // 用当前已累积的 assistantContent 组装 outputMessage（与 finalize 一致）
    let outputMsg: Record<string, unknown> | null = null;
    if (assistantContent.trim() || toolCallAccumulators.size > 0) {
      outputMsg = { role: "assistant", content: assistantContent.trim() };
    }
    trackWrite(
      withL0Retry(() => recordTdaiTurn(
        ctx.tdaiClient!, ctx.tdaiIdentity, ctx.tdaiUserMessage,
        outputMessageContent(outputMsg),
      )).catch((err: unknown) => pipe.error("TDAI_L0", err))
    );
  };
  // 兜底超时：流在 30s 内没有正常 flush 但已产生 assistant 内容 → 触发一次 L0 写入。
  // 用 setTimeout 的返回值作为描述符（node 版返回 Timeout 对象）。
  // eslint-disable-next-line prefer-const
  let l0Timer: ReturnType<typeof setTimeout> = setTimeout(() => {
    if (!l0Flushed && assistantContent.trim()) {
      pipe.info("TDAI_L0_TIMEOUT_FALLBACK", `session=${ctx.sessionKeyForSkill} producing fallback L0 write`);
      flushL0();
    }
  }, 30_000);

  function processSseChunk(chunk: string): void {
    sseBuf += chunk;
    const parts = sseBuf.split("\n\n");
    sseBuf = parts.pop() ?? "";
    for (const part of parts) {
      const usage = extractSseUsage(part);
      if (usage) lastUsage = usage;
      const { content, toolCallDeltas } = extractSseContentAndTools(part);
      assistantContent += content;
      mergeToolCallDeltas(toolCallAccumulators, toolCallDeltas);
    }
  }

  async function finalize(): Promise<void> {
    // [PROBE] streaming finalize reached — DEBUG ONLY (dsh)
    if (ctx.agentSource === "dsh") {
      log.info("dsh-l0-finalize", {
        session: ctx.sessionKeyForSkill,
        hasClient: !!ctx.tdaiClient, hasIdentity: !!ctx.tdaiIdentity,
        hasUserMsg: !!ctx.tdaiUserMessage,
        sseLen: sseBuf.length, assistantLen: assistantContent.length,
        extractionAllowed: isExtractionAllowed(ctx.config, "tdai-memory"),
      });
    }
    if (sseBuf.trim()) {
      const usage = extractSseUsage(sseBuf);
      if (usage) lastUsage = usage;
      const { content, toolCallDeltas } = extractSseContentAndTools(sseBuf);
      assistantContent += content;
      mergeToolCallDeltas(toolCallAccumulators, toolCallDeltas);
    }

    const endTime = new Date().toISOString();

    let outputMessage: Record<string, unknown> | null = null;
    if (assistantContent || toolCallAccumulators.size > 0) {
      if (toolCallAccumulators.size > 0) {
        const toolCallEntries = Array.from(toolCallAccumulators.entries())
          .sort(([a], [b]) => a - b)
          .map(([, acc]) => JSON.stringify({ tool_call_id: acc.id, tool_name: acc.functionName, arguments: acc.functionArguments }, null, 2))
          .join("\n\n");
        const parts: string[] = [];
        if (assistantContent) parts.push(assistantContent);
        parts.push(toolCallEntries);
        outputMessage = { role: "assistant", content: parts.join("\n\n") };
      } else {
        outputMessage = { role: "assistant", content: assistantContent };
      }
    }

    // Report the completed response to the extension. Fire-and-forget; the
    // client has already been served by this point.
    void notifyUpstreamResponse(
      config,
      {
        protocol: "openai",
        sessionKey,
        model: modelId,
        stream: true,
        turnSeq: lf.turnSeq,
        text: assistantContent,
        toolCalls: Array.from(toolCallAccumulators.values())
          .filter((acc) => acc.id && acc.functionArguments)
          .map((acc) => ({
            id: acc.id,
            name: acc.functionName,
            arguments: acc.functionArguments,
          })),
        usage: lastUsage ?? {},
      },
      pipe,
    );

    // 内部使用埋点：每个 tool_use 意图一条 model_intent（fan-out）。
    // 详见 docs/design/2026-08-03-internal-usage-telemetry-plan.md §7.2 E。
    if (toolCallAccumulators.size > 0) {
      const intents = Array.from(toolCallAccumulators.values())
        .filter((acc) => acc.functionName)
        .map((acc) => ({ name: acc.functionName, arguments: acc.functionArguments }));
      emitModelIntentTelemetry({
        // 与 session_init_logs 对齐 compositeKey 形态
        sessionKey: `${ctx.agentSource}:${sessionKey}`,
        turnSeq: lf.turnSeq,
        spaceId: spaceId,
        userId: keyId,
        agentSource: ctx.agentSource,
        intents,
      });
    }

    if (lastUsage) {
      await recordInputTokenUsage({
        config,
        instanceId: spaceId || undefined,
        modelId,
        usage: lastUsage,
        protocol: "openai",
      });
      try {
        writeLog(config, {
          timestamp: endTime,
          event: "usage",
          modelId,
          keyId,
          sessionKey,
          turnSeq: lf.turnSeq,
          userInput: lf.userQuery || undefined,
          upstreamUrl,
          stream: true,
          usage: lastUsage,
          extensionStats: ctx.preparedStats ?? undefined,
          ...ctx.logMeta,
          routedFrom: ctx.routedFrom,
          spaceId,
          upstreamRequestId,
        });
      } catch (logErr: unknown) {
        pipe.error("LOG_WRITE", logErr);
      }

      try {
        const outputMessages = outputMessage ? [outputMessage] : [];
        opikUpdateTrace(config, {
          traceId,
          projectName: keyId,
          endTime,
          output: outputMessages,
          usage: lastUsage,
        });
        if (ctx.forkTraceId && !config.opik.stripRequestLogContent) {
          opikUpdateTrace(config, {
            traceId: ctx.forkTraceId,
            projectName: "request_log",
            endTime,
            output: outputMessages,
            usage: lastUsage,
          });
        }

        opikCreateLlmSpan(config, {
          traceId,
          projectName: keyId,
          name: modelId,
          startTime,
          endTime,
          inputMessages,
          outputMessage,
          model: modelId,
          usage: lastUsage,
          tags: [
            "stream",
            ...(retried ? ["retry"] : []),
          ],
          forkProjectName: "request_log",
          forkTraceId: ctx.forkTraceId,
          forkMetadata: {
            keyId,
            modelId,
            stream: true,
            upstreamUrl,
          },
        });
      } catch (opikErr: unknown) {
        pipe.error("OPIK_SPAN", opikErr);
      }

      // Langfuse: report this LLM call as a generation under the turn trace
      // 流式路径 inputMessages 保持原样（其它下游流水线也用同一份引用）；
      // debug=true 时把 tool_call 累积计数塞进 metadata 兜底。
      try {
        const streamDebugExtra = ctx.langfuseDebug
          ? {
              stream_tool_call_count: toolCallAccumulators.size,
              stream_assistant_content_len: assistantContent.length,
            }
          : {};
        langfuseReportGeneration({
          traceId: lf.traceId,
          name: modelId,
          model: modelId,
          startTime,
          endTime,
          input: buildLangfuseInputChat(inputMessages, ctx.langfuseDebug, flattenMessagesForOpik),
          output: outputMessage,
          usage: lastUsage,
          traceName: lf.traceName,
          userId: lf.userId,
          sessionId: lf.sessionId,
          tags: lf.tags,
          traceInput: lf.userQuery || undefined,
          traceOutput: outputMessage ?? undefined,
          traceMetadata: {
            stream: true, retried, upstreamUrl, ...logMeta,
            ...ctx.debugMetadata, ...streamDebugExtra,
          },
          observationMetadata: {
            retried, ...logMeta,
            ...ctx.debugMetadata, ...streamDebugExtra,
          },
        });
      } catch (langfuseErr: unknown) {
        pipe.error("LANGFUSE_SPAN", langfuseErr);
      }
    }

    if (ctx.tdaiClient && isExtractionAllowed(ctx.config, "tdai-memory")) {
      // 走统一的幂等 L0 写入（含超时兜底）。finalize 里调用确保 flush 正常时照常落库；
      // 若流因 dsh 工具循环未读到 EOF，由 timeout 兜底触发。对齐 claude/codex 设计。
      flushL0();
    } else if (ctx.tdaiClient) {
      logExtractionSkipped(ctx.config, "tdai-memory", ctx.sessionKeyForSkill);
      // [PROBE] streaming L0 write blocked by extraction gate — DEBUG ONLY
      log.info("dsh-l0-stream-blocked", { session: ctx.sessionKeyForSkill, extraction: { enabled: ctx.config.extraction?.enabled, extractors: ctx.config.extraction?.extractors } });
    }

    pipe.streamDone(lastUsage);

    // Skill extract trigger — after stream finalization.
    // 同步 await：直到 store 落盘再继续，保证下一轮跨节点读到最新数据。
    // aux 请求(compaction/title)/dsh headless 跳过 skill 触发,保持归档 buffer 语义纯净。
    if (!ctx.isAuxiliary && !ctx.isDshHeadless && isExtractionAllowed(ctx.config, "skill")) {
      await triggerSkillExtractIfReady({
        config: ctx.config,
        sessionKey: ctx.sessionKeyForSkill,
        agentSource: ctx.agentSource,
        sessionInfo: ctx.sessionInfo,
        inputMessages: ctx.inputMessages,
        assistantMessage: outputMessage,
        protocol: "openai",
        assetCapabilities: ctx.assetCapabilities,
        toolCallCountOverride: toolCallAccumulators.size,
      });
    } else if (!ctx.isAuxiliary && !ctx.isDshHeadless) {
      logExtractionSkipped(ctx.config, "skill", ctx.sessionKeyForSkill);
    }

    // Credit usage reporting for streaming responses. The stream has already
    // been forwarded to the client; failures here are best-effort and can
    // only be observed via server logs (no way to retro-add response headers).
    tryReportCreditFromPath(
      ctx.config.creditReport,
      ctx.requestPath,
      lastUsage,
      ctx.config.creditPricing,
      ctx.modelId,
      ctx.upstreamUrl,
      "usage",
    )
      .then((outcome) => {
        if (outcome.attempted && !outcome.ok) {
          pipe.error("CREDIT_REPORT", `[stream] ${outcome.errorMessage ?? "unknown"}`);
          // Persist failed report as a raw record.
          writeFailedReportRaw(
            {
              timestamp: new Date().toISOString(),
              event: "usage",
              modelId: ctx.modelId,
              keyId: ctx.keyId,
              sessionKey: ctx.sessionKey,
              upstreamUrl: ctx.upstreamUrl,
              stream: true,
              usage: lastUsage === null ? undefined : lastUsage,
              routedFrom: ctx.routedFrom,
              upstreamRequestId: ctx.upstreamRequestId,
              pricingConfig: ctx.config.creditPricing,
            },
            outcome.errorMessage ?? "unknown",
          );
        }
      })
      .catch((err: unknown) => pipe.error("CREDIT_REPORT", err));
  }

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      try {
        processSseChunk(decoder.decode(chunk, { stream: true }));
      } catch (err: unknown) {
        pipe.error("STREAM_TAP", err);
      }
    },
    async flush() {
      try {
        await finalize();
      } catch (err: unknown) {
        pipe.error("STREAM_FINALIZE", err);
      }
    },
  });
}
