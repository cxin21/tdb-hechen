/**
 * 记忆内核 v3 元数据 HTTP fetch（Panel 专用）。
 */
import { randomUUID } from 'node:crypto';
import type { Logger } from '../infra/logger.js';
import type { MetaEnvelope } from './envelope.js';
import { mapHttpStatusFromEnvelopeCode } from './envelope.js';
import {
  META_HEADER_REQUEST_ID,
  META_HEADER_SERVICE_ID,
  META_HEADER_USER_KEY,
} from './headers.js';

export { mapHttpStatusFromEnvelopeCode };

const SENSITIVE_KEYS = new Set([
  'password',
  'initial_password',
  'default_user_key',
  'user_key',
  'key_value',
  'granted_by_key',
  'owner_user_key',
  'creator_user_key',
  'authorization',
  'api_key',
  'token',
  'secret',
  'bearer',
]);
const MAX_LOG_FIELD_CHARS = 300;
const MAX_LOG_JSON_CHARS = 1200;

function maskSecret(value: string): string {
  if (!value) return '';
  if (value.length <= 8) return `${value}…`;
  return `${value.slice(0, 8)}…`;
}

function truncateString(value: string): string {
  if (value.length <= MAX_LOG_FIELD_CHARS) return value;
  return `${value.slice(0, MAX_LOG_FIELD_CHARS)}…[truncated ${value.length - MAX_LOG_FIELD_CHARS} chars]`;
}

function sanitizeMetaBody(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[max_depth]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return truncateString(value);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeMetaBody(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      out[key] = typeof raw === 'string' && raw.length > 0 ? maskSecret(raw) : '[redacted]';
      continue;
    }
    out[key] = sanitizeMetaBody(raw, depth + 1);
  }
  return out;
}

function serializeForLog(value: unknown): string {
  try {
    const json = JSON.stringify(sanitizeMetaBody(value));
    if (json.length <= MAX_LOG_JSON_CHARS) return json;
    return `${json.slice(0, MAX_LOG_JSON_CHARS)}…[truncated ${json.length - MAX_LOG_JSON_CHARS} chars]`;
  } catch {
    return '[unserializable]';
  }
}

/** 内核 HTTP 调用失败（网络/超时/无效信封）。 */
export class KernelFetchError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'KernelFetchError';
  }

  get httpStatus(): number {
    return mapHttpStatusFromEnvelopeCode(this.code);
  }
}

export interface MetaFetchConfig {
  endpoint: string;
  apiKey: string;
  serviceId: string;
  userKey?: string;
  timeoutMs?: number;
  logger?: Logger;
  /** 透传为 x-request-id；缺省则生成 UUID。 */
  requestId?: string;
}

interface RawEnvelope<T> {
  code: number;
  message?: string;
  request_id?: string;
  data?: T;
}

function logRemoteMeta(
  logger: Logger | undefined,
  phase: 'request' | 'response' | 'error',
  requestId: string,
  fields: Record<string, unknown>,
): void {
  if (!logger) return;
  const msg = `[${requestId}] api.remote.${phase}`;
  if (phase === 'error') {
    logger.warn(msg, fields);
    return;
  }
  logger.info(msg, fields);
}

/** 单次内核元数据请求（POST 带 body / GET 带 query，响应信封解析完全一致）。 */
interface MetaRequestInit {
  method: 'POST' | 'GET';
  /** POST body（executeMetaFetch 恒传，保持原 `body ?? {}` 语义）。 */
  body?: unknown;
  /** GET query；空值不序列化（不发 `?team=` 这种空参）。 */
  query?: Record<string, string>;
}

function buildRequestUrl(
  base: string,
  path: string,
  query: Record<string, string> | undefined,
): string {
  if (!query) return `${base}${path}`;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === 'string' && value.length > 0) params.set(key, value);
  }
  const qs = params.toString();
  return qs ? `${base}${path}?${qs}` : `${base}${path}`;
}

/**
 * 内核元数据请求的公共实现，返回完整信封。
 * - mode=envelope：业务 code≠0 不抛错（透明代理用）
 * - mode=data：code≠0 抛 KernelFetchError
 *
 * GET 专属补丁（仅 method=GET 生效，POST 行为不变）：内核 checkAuth 失败时回的是
 * **纯文本** 401/403（server.ts:1698 sendError），不是信封。这种响应若按「无效信封」
 * 一律折成 502，会把 401 吞成上游不可用；因此 GET 下把 401/403 原样抛出为
 * KernelFetchError(401/403)，由调用方按错误码透传。
 */
async function executeMetaRequest<T>(
  cfg: MetaFetchConfig,
  path: string,
  init: MetaRequestInit,
  mode: 'data' | 'envelope',
): Promise<T> {
  const base = cfg.endpoint.replace(/\/+$/, '');
  const timeoutMs = cfg.timeoutMs ?? 15_000;
  const log = cfg.logger;
  const startedAt = Date.now();
  const reqId = cfg.requestId ?? randomUUID();
  logRemoteMeta(log, 'request', reqId, {
    path,
    serviceId: cfg.serviceId,
    request_id: reqId,
    ...(init.method === 'POST'
      ? { requestBody: serializeForLog(init.body ?? {}) }
      : { requestQuery: init.query ?? {} }),
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {
      [META_HEADER_SERVICE_ID]: cfg.serviceId,
      [META_HEADER_REQUEST_ID]: reqId,
    };
    if (init.method === 'POST') headers['Content-Type'] = 'application/json';
    if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
    if (cfg.userKey) headers[META_HEADER_USER_KEY] = cfg.userKey;
    const resp = await fetch(buildRequestUrl(base, path, init.query), {
      method: init.method,
      headers,
      ...(init.method === 'POST' ? { body: JSON.stringify(init.body ?? {}) } : {}),
      signal: ctrl.signal,
    });
    const rawText = await resp.text().catch(() => '');
    let env: RawEnvelope<unknown> | null = null;
    try {
      env = JSON.parse(rawText) as RawEnvelope<unknown>;
    } catch {
      env = null;
    }
    if (!env || typeof env.code !== 'number') {
      if (init.method === 'GET' && (resp.status === 401 || resp.status === 403)) {
        const authErr = new KernelFetchError(
          resp.status,
          rawText.trim() || `auth rejected from ${path} (http ${resp.status})`,
        );
        logRemoteMeta(log, 'error', reqId, {
          path,
          request_id: reqId,
          durationMs: Date.now() - startedAt,
          httpStatus: resp.status,
          error: authErr.message,
        });
        throw authErr;
      }
      const err = new KernelFetchError(502, `invalid envelope from ${path} (http ${resp.status})`);
      logRemoteMeta(log, 'error', reqId, {
        path,
        request_id: reqId,
        durationMs: Date.now() - startedAt,
        httpStatus: resp.status,
        error: err.message,
      });
      throw err;
    }
    const envelope: MetaEnvelope<unknown> = {
      code: env.code,
      message: env.message ?? (env.code === 0 ? 'ok' : `error ${env.code}`),
      request_id: env.request_id ?? reqId,
      data: (env.data ?? {}) as unknown,
    };
    if (mode === 'envelope') {
      if (env.code !== 0) {
        logRemoteMeta(log, 'error', envelope.request_id, {
          path,
          request_id: envelope.request_id,
          durationMs: Date.now() - startedAt,
          envelopeCode: env.code,
          envelopeMessage: envelope.message,
        });
      } else {
        logRemoteMeta(log, 'response', envelope.request_id, {
          path,
          durationMs: Date.now() - startedAt,
          request_id: envelope.request_id,
          responseBody: serializeForLog(env.data ?? {}),
        });
      }
      return envelope as T;
    }
    if (env.code !== 0) {
      const err = new KernelFetchError(env.code, envelope.message);
      logRemoteMeta(log, 'error', envelope.request_id, {
        path,
        request_id: envelope.request_id,
        durationMs: Date.now() - startedAt,
        envelopeCode: env.code,
        envelopeMessage: envelope.message,
        error: err.message,
      });
      throw err;
    }
    logRemoteMeta(log, 'response', envelope.request_id, {
      path,
      durationMs: Date.now() - startedAt,
      request_id: envelope.request_id,
      responseBody: serializeForLog(env.data ?? {}),
    });
    return (env.data ?? {}) as T;
  } catch (err) {
    if (err instanceof KernelFetchError) throw err;
    const isTimeout = (err as { name?: string }).name === 'AbortError';
    const message = isTimeout
      ? `remote metadata timeout at ${path}`
      : `remote metadata call failed at ${path}: ${(err as Error).message}`;
    const code = isTimeout ? 504 : 502;
    logRemoteMeta(log, 'error', reqId, {
      path,
      durationMs: Date.now() - startedAt,
      request_id: reqId,
      envelopeCode: code,
      error: message,
    });
    throw new KernelFetchError(code, message);
  } finally {
    clearTimeout(timer);
  }
}

/** POST 记忆内核元数据路径，返回完整信封（既有调用方行为不变）。 */
export async function executeMetaFetch<T>(
  cfg: MetaFetchConfig,
  path: string,
  body: unknown,
  mode: 'data' | 'envelope',
): Promise<T> {
  return executeMetaRequest<T>(cfg, path, { method: 'POST', body }, mode);
}

/** 裸响应：上游不套 {code,message,data} 信封时使用（如 GET /v3/soul/trait-state）。 */
export interface RawMetaResponse {
  /** 上游 HTTP 状态码（401/403/503 原样带回，由调用方决定怎么透出）。 */
  status: number;
  /** 已解析的 JSON body；非 JSON 响应为 null。 */
  body: unknown;
  /** 原始响应文本（body 非 JSON 时调用方从这里取 message）。 */
  text: string;
}

/**
 * GET 内核只读路径，**不解析信封**，原样返回 status + body。
 *
 * 为什么需要单独一条：GET /v3/soul/trait-state 回的是裸对象（200 {agentId,updatedAt,traits}、
 * 503 {error}），没有 {code,message,data}。走 executeMetaGet 会被判成 invalid envelope 折成
 * 502，把 503 soul_trait_state_unavailable 吞掉。这里只做 HTTP 层：
 *   - 网络/超时仍抛 KernelFetchError(502/504)；
 *   - 任何 HTTP 状态都正常返回，错误码与错误体交给调用方透传。
 */
export async function executeMetaGetRaw(
  cfg: MetaFetchConfig,
  path: string,
  query: Record<string, string>,
): Promise<RawMetaResponse> {
  const base = cfg.endpoint.replace(/\/+$/, '');
  const timeoutMs = cfg.timeoutMs ?? 15_000;
  const log = cfg.logger;
  const startedAt = Date.now();
  const reqId = cfg.requestId ?? randomUUID();
  logRemoteMeta(log, 'request', reqId, {
    path,
    serviceId: cfg.serviceId,
    request_id: reqId,
    requestQuery: query,
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {
      [META_HEADER_SERVICE_ID]: cfg.serviceId,
      [META_HEADER_REQUEST_ID]: reqId,
    };
    if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
    if (cfg.userKey) headers[META_HEADER_USER_KEY] = cfg.userKey;
    const resp = await fetch(buildRequestUrl(base, path, query), {
      method: 'GET',
      headers,
      signal: ctrl.signal,
    });
    const rawText = await resp.text().catch(() => '');
    let body: unknown = null;
    try {
      body = JSON.parse(rawText) as unknown;
    } catch {
      body = null;
    }
    logRemoteMeta(log, resp.ok ? 'response' : 'error', reqId, {
      path,
      request_id: reqId,
      durationMs: Date.now() - startedAt,
      httpStatus: resp.status,
      ...(resp.ok
        ? { responseBody: serializeForLog(body) }
        : { error: truncateString(rawText.trim() || `http ${resp.status}`) }),
    });
    return { status: resp.status, body, text: rawText };
  } catch (err) {
    const isTimeout = (err as { name?: string }).name === 'AbortError';
    const message = isTimeout
      ? `remote metadata timeout at ${path}`
      : `remote metadata call failed at ${path}: ${(err as Error).message}`;
    const code = isTimeout ? 504 : 502;
    logRemoteMeta(log, 'error', reqId, {
      path,
      durationMs: Date.now() - startedAt,
      request_id: reqId,
      envelopeCode: code,
      error: message,
    });
    throw new KernelFetchError(code, message);
  } finally {
    clearTimeout(timer);
  }
}

/** GET 记忆内核元数据路径（query 进 URL），返回完整信封。 */
export async function executeMetaGet<T>(
  cfg: MetaFetchConfig,
  path: string,
  query: Record<string, string>,
  mode: 'data' | 'envelope',
): Promise<T> {
  return executeMetaRequest<T>(cfg, path, { method: 'GET', query }, mode);
}
