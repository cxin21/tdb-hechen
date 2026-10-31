import type { LoggerLike } from './types.js';
import type { SegmentHealth } from './segment-health.js';
import { DEFAULT_ALLOWED_SCHEMES, DEFAULT_MAX_RESPONSE_BYTES, fetchJsonCapped } from './http-capped.js';
/**
 * Team knowledge segment for the volatile channel + the two-step tool bridge.
 *
 * The core already exposes the resource list (POST /v3/knowledge/list,
 * MemoryCore/src/gateway/knowledge-handlers.ts) and every resource is a
 * self-describing tool service (MemoryKnowledge, 8421):
 *
 *   POST {service_url}/tools/list  {knowledge_id}                 -> {code, data:{tools:[{name,description,params}]}}
 *   POST {service_url}/tools/call  {knowledge_id, tool_name, params} -> {code, data}
 *
 * `knowledge_id` travels in the BODY, never in the URL path: the service is
 * resource-agnostic and routes on the payload (measured 2026-11-01 against
 * 8421/v3/tools/list -> 8 tools: get_info, search, list_pages, read_page,
 * wiki_fetch, get_graph, list_raw, read_raw).
 *
 * What the DSH side must NOT copy from MemoryProxy
 * (MemoryProxy/src/injection/injectors/knowledge-tools-injector.ts:177-242):
 * its block teaches the model a curl recipe. A host agent already has native
 * tools, so the block here only names the assets and points at the two tools
 * this module ships (knowledge_search / knowledge_read, src/tools/knowledge.ts).
 *
 * Failure policy: fail-open. Every error path returns '' plus a structured
 * reason (transport / http_<status> / bad_envelope / bad_payload /
 * bad_scheme / too_large / empty_list / budget_zero / circuit_open) and never
 * throws: a knowledge outage must not break the host turn.
 *
 * Transport (task-101): the tool service is reached through
 * fetchJsonCapped (src/http-capped.ts:131) — scheme-gated BEFORE any socket and
 * byte-capped while reading, so a `service_url` that core hands back as
 * file:/data:/javascript: is refused unread (zero fetch) instead of being
 * requested. The breaker (src/segment-health.ts) always wraps that call, never
 * the other way around.
 */

/** Opening tag of the injected block (stable prompt shape, per the ticket). */
export const KNOWLEDGE_SEGMENT_OPEN = '<knowledge_tools>';
/** Closing tag of the injected block. */
export const KNOWLEDGE_SEGMENT_CLOSE = '</knowledge_tools>';

/** Core route that lists a team's knowledge resources. */
export const KNOWLEDGE_LIST_PATH = '/v3/knowledge/list';
/** Service-level discovery endpoints, appended to a resource's service_url. */
export const KNOWLEDGE_TOOLS_LIST_SUFFIX = '/tools/list';
export const KNOWLEDGE_TOOLS_CALL_SUFFIX = '/tools/call';

/**
 * Schemes a resource's service_url may use (task-101).
 *
 * Single source of truth is src/http-capped.ts:30 — a knowledge service is
 * reached over the network or not at all; file:/data:/javascript: URLs that a
 * compromised or misconfigured core could return must never reach fetch().
 */
export const KNOWLEDGE_ALLOWED_SCHEMES: readonly string[] = DEFAULT_ALLOWED_SCHEMES;

/** True when `raw` is an absolute http(s) URL, i.e. safe to fetch (task-101). */
export function isAllowedKnowledgeServiceUrl(raw: unknown): boolean {
  const url = oneLine(raw);
  if (url === '') return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return KNOWLEDGE_ALLOWED_SCHEMES.includes(parsed.protocol);
}

/** One resource as /v3/knowledge/list serializes it. */
export interface KnowledgeResource {
  knowledgeId: string;
  /** 'wiki' | 'code-graph' | anything the service adds later. */
  type: string;
  name: string;
  /** Base URL of the tool service, e.g. http://127.0.0.1:8421/v3. */
  serviceUrl: string;
  summary: string;
  status?: string;
}

/** One tool as {service_url}/tools/list serializes it (params is a JSON-Schema-ish map). */
export interface KnowledgeToolSpec {
  name: string;
  description: string;
  params: Record<string, unknown>;
}

export interface KnowledgeSegmentConfig {
  enabled: boolean;
  /** Hard cap for the whole block, in code points; 0 = inject nothing. */
  maxChars: number;
  /** How many resources may be rendered at most (1..32). */
  maxResources: number;
  /** Per-call budget for the list round trip. */
  timeoutMs: number;
  /** Tenant routing key sent as x-tdai-service-id; empty = caller's default. */
  serviceId?: string;
}

/**
 * Defaults per the ticket. Deliberately NOT in src/config.ts: dsh-plugin owns
 * the config surface and passes its resolved volatile.knowledge subtree here.
 */
export const DEFAULT_KNOWLEDGE_SEGMENT_CONFIG: KnowledgeSegmentConfig = {
  enabled: true,
  maxChars: 3000,
  maxResources: 8,
  timeoutMs: 2500,
};

/** Clamp windows: a bad config snaps instead of breaking a turn. */
export const KNOWLEDGE_SEGMENT_LIMITS = {
  maxChars: { min: 0, max: 20_000 },
  maxResources: { min: 1, max: 32 },
  timeoutMs: { min: 100, max: 30_000 },
} as const;

/** One rendered resource line may not exceed this many code points. */
export const KNOWLEDGE_ENTRY_MAX_CHARS = 260;

/** Result payload cap for the tools (measured: one wiki_fetch page is <=4000 chars). */
export const KNOWLEDGE_TOOL_RESULT_MAX_CHARS = 12_000;

const HINT_LINE = '以下为团队知识库资源（wiki 是设计文档，code-graph 是代码索引）；'
  + '用 knowledge_search 检索、knowledge_read 读正文。';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function oneLine(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function codePointLength(text: string): number {
  return Array.from(text).length;
}

/** n code points of text, with an ellipsis when it had to cut. */
export function cropCodePoints(text: string, max: number): string {
  const cps = Array.from(text);
  if (cps.length <= max) return text;
  if (max <= 1) return max <= 0 ? '' : '…';
  return cps.slice(0, max - 1).join('') + '…';
}

/**
 * Tolerant resolution of a volatile.knowledge subtree (or nothing at all).
 * Only an explicit enabled:false switches the segment off; a typo never does.
 * Mirrors resolveWikiSegmentConfig (src/wiki-segment.ts:139).
 */
export function resolveKnowledgeSegmentConfig(raw?: unknown): KnowledgeSegmentConfig {
  const src = isRecord(raw) ? raw : {};
  const d = DEFAULT_KNOWLEDGE_SEGMENT_CONFIG;
  const serviceId = oneLine(src.serviceId);
  return {
    enabled: typeof src.enabled === 'boolean' ? src.enabled : d.enabled,
    maxChars: clampInt(src.maxChars, d.maxChars, KNOWLEDGE_SEGMENT_LIMITS.maxChars.min, KNOWLEDGE_SEGMENT_LIMITS.maxChars.max),
    maxResources: clampInt(
      src.maxResources,
      d.maxResources,
      KNOWLEDGE_SEGMENT_LIMITS.maxResources.min,
      KNOWLEDGE_SEGMENT_LIMITS.maxResources.max,
    ),
    timeoutMs: clampInt(
      src.timeoutMs,
      d.timeoutMs,
      KNOWLEDGE_SEGMENT_LIMITS.timeoutMs.min,
      KNOWLEDGE_SEGMENT_LIMITS.timeoutMs.max,
    ),
    ...(serviceId !== '' ? { serviceId } : {}),
  };
}

/**
 * Normalise the list payload into resources.
 *
 * Ordering is the core's own (it already sorts stable); the plugin keeps it and
 * only drops rows that cannot be rendered/called: no id, no service_url, or a
 * service_url whose scheme is not http(s) (task-101). Rejection happens HERE,
 * at the data boundary, so every consumer of a KnowledgeResource — the injected
 * block, knowledge_search, knowledge_read, the tools/list leg — can only ever
 * see a fetchable URL. `onReject` exists for the caller's diagnostics; it is
 * never called for a row that merely lacked an id.
 */
export function selectKnowledgeResources(
  raw: unknown,
  maxResources: number,
  onReject?: (rejected: { knowledgeId: string; serviceUrl: string; reason: string }) => void,
): KnowledgeResource[] {
  if (!Array.isArray(raw)) return [];
  const limit = clampInt(maxResources, DEFAULT_KNOWLEDGE_SEGMENT_CONFIG.maxResources, 0, KNOWLEDGE_SEGMENT_LIMITS.maxResources.max);
  if (limit === 0) return [];
  const out: KnowledgeResource[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const knowledgeId = oneLine(item.knowledge_id ?? item.knowledgeId);
    const serviceUrl = oneLine(item.service_url ?? item.serviceUrl);
    if (knowledgeId === '' || serviceUrl === '') continue;
    // Scheme gate BEFORE the dedupe mark: a bad-scheme row must not shadow a
    // later, callable duplicate of the same knowledge_id.
    if (!isAllowedKnowledgeServiceUrl(serviceUrl)) {
      onReject?.({ knowledgeId, serviceUrl, reason: 'bad_scheme' });
      continue;
    }
    if (seen.has(knowledgeId)) continue;
    seen.add(knowledgeId);
    out.push({
      knowledgeId,
      type: oneLine(item.type) || 'unknown',
      name: oneLine(item.name) || knowledgeId,
      serviceUrl: serviceUrl.replace(/\/+$/u, ''),
      summary: oneLine(item.summary),
      ...(oneLine(item.status) !== '' ? { status: oneLine(item.status) } : {}),
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** One rendered line per resource: `- [type:id] name — summary` (proxy's shape, cropped). */
export function renderKnowledgeEntry(resource: KnowledgeResource, maxChars = KNOWLEDGE_ENTRY_MAX_CHARS): string {
  const head = '- [' + resource.type + ':' + resource.knowledgeId + '] ' + resource.name;
  const summary = resource.summary === '' ? '' : ' — ' + resource.summary;
  return cropCodePoints(head + summary, Math.max(0, maxChars));
}

/**
 * Render the <knowledge_tools> block under a hard code-point budget.
 *
 * Budget discipline (same as renderWikiBlock, src/wiki-segment.ts:259): reserve
 * the two tags first, then take lines greedily; a line that does not fit is
 * dropped whole, never cut in half. No resource fits -> '' (inject nothing).
 */
export function renderKnowledgeBlock(input: {
  resources: KnowledgeResource[];
  maxChars?: number;
}): string {
  const budget = clampInt(input.maxChars ?? DEFAULT_KNOWLEDGE_SEGMENT_CONFIG.maxChars, DEFAULT_KNOWLEDGE_SEGMENT_CONFIG.maxChars, 0, KNOWLEDGE_SEGMENT_LIMITS.maxChars.max);
  if (budget === 0 || input.resources.length === 0) return '';
  const open = KNOWLEDGE_SEGMENT_OPEN;
  const close = KNOWLEDGE_SEGMENT_CLOSE;
  const reserved = codePointLength(open) + codePointLength(close) + 2;
  if (budget <= reserved) return '';
  let used = reserved;
  const body: string[] = [];
  const hintCost = codePointLength(HINT_LINE) + 1;
  if (used + hintCost <= budget) {
    body.push(HINT_LINE);
    used += hintCost;
  }
  for (const resource of input.resources) {
    const line = renderKnowledgeEntry(resource);
    const cost = codePointLength(line) + 1;
    if (used + cost > budget) break;
    body.push(line);
    used += cost;
  }
  if (body.length === 0) return '';
  return open + '\n' + body.join('\n') + '\n' + close;
}

/** One unwrapped core envelope (MemoryClient.v3's shape, minus the generic parameter). */
export interface KnowledgeCoreResult {
  ok: boolean;
  status?: number;
  reason?: string;
  data?: unknown;
  code?: number;
  message?: string;
}

/**
 * Transport seam for the resource list. Non-generic on purpose: every caller
 * here treats `data` as unknown and narrows it itself, and a generic alias
 * would refuse the plain `(path, body) => client.v3<unknown>(...)` adapter.
 */
export type KnowledgeCoreCaller = (
  path: string,
  body: Record<string, unknown>,
  options?: { timeoutMs?: number; extraHeaders?: Record<string, string> },
) => Promise<KnowledgeCoreResult>;

/** Raw HTTP seam for the tool service (a different host/port than the core). */
export type KnowledgeHttpRequest = (
  url: string,
  body: Record<string, unknown>,
  options: {
    timeoutMs: number;
    serviceId?: string;
    /** Response byte cap; defaults to DEFAULT_MAX_RESPONSE_BYTES (2 MiB). */
    maxBytes?: number;
  },
) => Promise<{ status: number; json?: unknown; error?: string }>;

export interface KnowledgeIdentity {
  teamId?: string;
  userId?: string;
  serviceId?: string;
}

export type KnowledgeIdentitySource = KnowledgeIdentity | (() => KnowledgeIdentity | undefined);

function identityOf(source: KnowledgeIdentitySource | undefined): KnowledgeIdentity | undefined {
  if (typeof source === 'function') {
    try {
      const resolved = source();
      return resolved ?? undefined;
    } catch {
      return undefined;
    }
  }
  return source;
}

export interface KnowledgeSegmentDiagnostic {
  ok: boolean;
  /**
   * disabled | no_identity | transport | http_<status> | bad_envelope |
   * bad_payload | bad_scheme | too_large | empty_list | budget_zero | circuit_open
   */
  reason?: string;
  ms: number;
  /** Resources rendered into the block. */
  resources: number;
  /** Code points actually injected. */
  chars: number;
  /** Breaker state at completion (createSegmentHealth().describe()); absent when unwired. */
  health?: string;
  /** Resources dropped because their service_url was not http(s) (task-101). */
  rejected?: number;
}

export interface KnowledgeSegmentResult {
  text: string;
  diagnostic: KnowledgeSegmentDiagnostic;
  /** Resources parsed from the list call (also when the block came out empty). */
  available: KnowledgeResource[];
}

function emptyResult(
  reason: string,
  overrides: Partial<KnowledgeSegmentDiagnostic> = {},
  available: KnowledgeResource[] = [],
): KnowledgeSegmentResult {
  return {
    text: '',
    diagnostic: { ok: false, reason, ms: 0, resources: 0, chars: 0, ...overrides },
    available,
  };
}

/**
 * Fetch the knowledge segment.
 *
 * Fail-open by construction: disabled, no team id, transport error, non-2xx,
 * envelope code != 0, malformed payload, an empty list or a zero budget all
 * return {text: '', diagnostic} and never throw. No request is issued unless a
 * team id is present (a 422 per turn is pure waste).
 */
export async function fetchKnowledgeSegment(deps: {
  call: KnowledgeCoreCaller;
  identity: KnowledgeIdentitySource | undefined;
  config?: KnowledgeSegmentConfig;
  logger?: LoggerLike;
  maxChars?: number;
  /** Optional CORE-LEG breaker (task-98). The tools leg has its own instance. */
  health?: SegmentHealth;
}): Promise<KnowledgeSegmentResult> {
  const config = deps.config ?? DEFAULT_KNOWLEDGE_SEGMENT_CONFIG;
  if (!config.enabled) return emptyResult('disabled');
  const identity = identityOf(deps.identity);
  const teamId = identity !== undefined ? oneLine(identity.teamId) : '';
  if (teamId === '') return emptyResult('no_identity');
  const userId = identity !== undefined ? oneLine(identity.userId) : '';

  const body: Record<string, unknown> = { team_id: teamId };
  if (userId !== '') body.user_id = userId;

  const health = deps.health;
  const healthNote = (): { health?: string } => (health !== undefined ? { health: health.describe() } : {});
  if (health !== undefined && !health.shouldAttempt()) {
    deps.logger?.debug?.('agemem: knowledge core leg circuit open, request skipped');
    return emptyResult('circuit_open', { ...healthNote() });
  }

  const started = Date.now();
  let result: KnowledgeCoreResult;
  try {
    result = await deps.call(KNOWLEDGE_LIST_PATH, body, { timeoutMs: config.timeoutMs });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    deps.logger?.debug?.('agemem: knowledge list threw', detail);
    health?.recordFailure('transport');
    return emptyResult('transport', { ms: Date.now() - started, ...healthNote() });
  }
  const ms = Date.now() - started;
  if (result === undefined || result === null || result.ok !== true) {
    const status = result !== undefined && result !== null && typeof result.status === 'number' ? result.status : undefined;
    const code = result !== undefined && result !== null && typeof result.code === 'number' ? result.code : undefined;
    const reason = code !== undefined && code !== 0
      ? 'bad_envelope'
      : status !== undefined && status > 0
        ? 'http_' + status
        : 'transport';
    deps.logger?.debug?.(
      'agemem: knowledge list failed reason=' + reason + ' status=' + String(status ?? '-') +
      ' code=' + String(code ?? '-') + ' detail=' + String(result?.reason ?? '-'),
    );
    health?.recordFailure(reason);
    return emptyResult(reason, { ms, ...healthNote() });
  }

  const data = result.data;
  const items = isRecord(data) && Array.isArray(data.items) ? data.items : undefined;
  if (items === undefined) {
    deps.logger?.debug?.('agemem: knowledge list payload had no items[]');
    health?.recordFailure('bad_payload');
    return emptyResult('bad_payload', { ms, ...healthNote() });
  }
  let rejected = 0;
  const available = selectKnowledgeResources(items, config.maxResources, (drop) => {
    rejected += 1;
    deps.logger?.debug?.(
      'agemem: knowledge resource rejected reason=' + drop.reason + ' knowledge_id=' + drop.knowledgeId +
      ' service_url=' + drop.serviceUrl,
    );
  });
  const rejectedNote = (): { rejected?: number } => (rejected > 0 ? { rejected } : {});
  if (available.length === 0) {
    health?.recordSuccess();
    // The core answered fine, so this is not an outage: the list itself is
    // unusable. Name the cause instead of a bland empty_list.
    return emptyResult(rejected > 0 ? 'bad_scheme' : 'empty_list', { ms, ...healthNote(), ...rejectedNote() }, available);
  }

  const text = renderKnowledgeBlock({ resources: available, maxChars: deps.maxChars ?? config.maxChars });
  if (text === '') {
    health?.recordSuccess();
    return emptyResult('budget_zero', { ms, resources: available.length, ...healthNote(), ...rejectedNote() }, available);
  }

  health?.recordSuccess();
  return {
    text,
    diagnostic: {
      ok: true,
      ms,
      resources: available.length,
      chars: codePointLength(text),
      ...healthNote(),
      ...rejectedNote(),
    },
    available,
  };
}

export interface KnowledgeToolCallResult {
  ok: boolean;
  /**
   * disabled | bad_tool | bad_scheme | too_large | transport | http_<status> |
   * bad_envelope | bad_payload | circuit_open
   */
  reason?: string;
  code?: number;
  message?: string;
  data?: unknown;
  ms: number;
  /** Tools-leg breaker state at completion; absent when unwired. */
  health?: string;
}

/**
 * Map a transport-level error token onto the tools-leg reason vocabulary.
 *
 * `bad_scheme`/`bad_url` mean "we refused to dial", `too_large` means "the peer
 * answered with a body we will not hold", `bad_json` means "answered, but not
 * with JSON". Collapsing these into transport would re-hide exactly the
 * distinction the ticket asks for (cf. the http_0 bug fixed in task-98).
 */
function reasonFromRequestError(error: string): string {
  if (error === 'bad_scheme' || error === 'bad_url') return 'bad_scheme';
  if (error === 'too_large') return 'too_large';
  if (error === 'bad_json') return 'bad_payload';
  if (error === 'timeout') return 'timeout';
  return 'transport';
}

/**
 * Default transport: capped, scheme-gated POST with no credential
 * (8421 accepted an x-tdai-service-id header only, measured 2026-11-01).
 *
 * Task-101: this used to be `await response.text()` with no cap and no scheme
 * check, on a URL that came straight out of a core response. It now goes
 * through fetchJsonCapped (src/http-capped.ts:131), which refuses a
 * non-http(s) URL BEFORE calling fetch and cancels the read at the byte cap.
 * The union is folded back into the {status, json?, error?} shape so the
 * breaker and the callers keep their single failure-ordering path.
 */
export const defaultKnowledgeRequest: KnowledgeHttpRequest = async (url, body, options) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const serviceId = typeof options.serviceId === 'string' ? options.serviceId.trim() : '';
  if (serviceId !== '') headers['x-tdai-service-id'] = serviceId;
  const result = await fetchJsonCapped(
    url,
    { method: 'POST', headers, body: JSON.stringify(body) },
    {
      maxBytes: typeof options.maxBytes === 'number' ? options.maxBytes : DEFAULT_MAX_RESPONSE_BYTES,
      timeoutMs: Math.max(100, options.timeoutMs),
      allowSchemes: KNOWLEDGE_ALLOWED_SCHEMES,
    },
  );
  switch (result.kind) {
    case 'ok':
      return { status: 200, json: result.json };
    case 'http': {
      // A rejected request can still carry a (capped) JSON envelope; keep it so
      // the caller can tell bad_envelope from a bare 4xx.
      let json: unknown;
      try {
        json = JSON.parse(result.text);
      } catch {
        json = undefined;
      }
      return { status: result.status, ...(json !== undefined ? { json } : {}) };
    }
    case 'too_large':
      return { status: 0, error: 'too_large' };
    case 'bad_scheme':
      return { status: 0, error: 'bad_scheme' };
    case 'bad_url':
      return { status: 0, error: 'bad_url' };
    case 'timeout':
      return { status: 0, error: 'timeout' };
    case 'bad_json':
      return { status: 0, error: 'bad_json' };
    default:
      return { status: 0, error: 'transport: ' + result.reason };
  }
};

/**
 * Execute one tool on a knowledge service: POST {service_url}/tools/call.
 *
 * `knowledge_id` stays in the body (a path form 404s: the endpoint is
 * service-level, not resource-scoped). HTTP failures and envelope failures are
 * reported separately, because the caller retries them differently.
 */
export async function executeKnowledgeTool(deps: {
  request?: KnowledgeHttpRequest;
  serviceUrl: string;
  knowledgeId: string;
  tools?: KnowledgeToolSpec[];
  toolName: string;
  params?: Record<string, unknown>;
  serviceId?: string;
  timeoutMs?: number;
  /** Response byte cap for the tools leg; defaults to 2 MiB (src/http-capped.ts:26). */
  maxBytes?: number;
  /** Optional TOOLS-LEG breaker (task-98); separate from the core leg on purpose. */
  health?: SegmentHealth;
}): Promise<KnowledgeToolCallResult> {
  const started = Date.now();
  const serviceUrl = oneLine(deps.serviceUrl).replace(/\/+$/u, '');
  const knowledgeId = oneLine(deps.knowledgeId);
  const toolName = oneLine(deps.toolName);
  if (serviceUrl === '' || knowledgeId === '' || toolName === '') {
    return { ok: false, reason: 'bad_tool', ms: 0 };
  }
  if (Array.isArray(deps.tools) && deps.tools.length > 0 && !deps.tools.some((tool) => tool.name === toolName)) {
    return { ok: false, reason: 'bad_tool', ms: 0 };
  }
  const request = deps.request ?? defaultKnowledgeRequest;
  const timeoutMs = clampInt(
    deps.timeoutMs,
    DEFAULT_KNOWLEDGE_SEGMENT_CONFIG.timeoutMs,
    KNOWLEDGE_SEGMENT_LIMITS.timeoutMs.min,
    KNOWLEDGE_SEGMENT_LIMITS.timeoutMs.max,
  );
  const health = deps.health;
  const healthNote = (): { health?: string } => (health !== undefined ? { health: health.describe() } : {});
  // Defence in depth (task-101): selectKnowledgeResources already rejects these,
  // but a caller may pass serviceUrl directly. Refused without a request, and
  // deliberately NOT counted as a breaker failure — a bad URL is a data defect,
  // not an outage (opening the circuit would hide the real cause).
  if (!isAllowedKnowledgeServiceUrl(serviceUrl)) {
    return { ok: false, reason: 'bad_scheme', ms: 0, ...healthNote() };
  }
  if (health !== undefined && !health.shouldAttempt()) {
    return { ok: false, reason: 'circuit_open', ms: 0, ...healthNote() };
  }
  let response: Awaited<ReturnType<KnowledgeHttpRequest>>;
  try {
    response = await request(
      serviceUrl + KNOWLEDGE_TOOLS_CALL_SUFFIX,
      { knowledge_id: knowledgeId, tool_name: toolName, params: isRecord(deps.params) ? deps.params : {} },
      {
        timeoutMs,
        ...(typeof deps.serviceId === 'string' && deps.serviceId !== '' ? { serviceId: deps.serviceId } : {}),
        ...(typeof deps.maxBytes === 'number' ? { maxBytes: deps.maxBytes } : {}),
      },
    );
  } catch (error) {
    health?.recordFailure('transport');
    return { ok: false, reason: 'transport', ms: Date.now() - started, ...healthNote() };
  }
  const ms = Date.now() - started;
  if (response === undefined || response === null || typeof response.status !== 'number' || response.status < 200 || response.status >= 300) {
    const status = response !== undefined && response !== null && typeof response.status === 'number' ? response.status : undefined;
    const errorText = response !== undefined && response !== null && typeof response.error === 'string' ? response.error : '';
    // A real HTTP status always wins; only status<=0 (no answer) is attributed
    // from the transport token, so http_404 / bad_scheme / too_large never blur.
    const reason = status !== undefined && status > 0
      ? 'http_' + status
      : errorText !== ''
        ? reasonFromRequestError(errorText)
        : 'transport';
    health?.recordFailure(reason);
    return { ok: false, reason, ms, ...healthNote() };
  }
  const envelope = isRecord(response.json) ? response.json : undefined;
  if (envelope === undefined) {
    health?.recordFailure('bad_payload');
    return { ok: false, reason: 'bad_payload', ms, ...healthNote() };
  }
  const code = typeof envelope.code === 'number' ? envelope.code : undefined;
  if (code !== undefined && code !== 0) {
    health?.recordFailure('bad_envelope');
    return {
      ok: false,
      reason: 'bad_envelope',
      code,
      message: oneLine(envelope.message),
      ms,
      ...healthNote(),
    };
  }
  if (!('data' in envelope)) {
    health?.recordFailure('bad_payload');
    return { ok: false, reason: 'bad_payload', ms, ...healthNote() };
  }
  health?.recordSuccess();
  return { ok: true, ms, ...(code !== undefined ? { code } : {}), data: envelope.data, ...healthNote() };
}

/** Parse {service_url}/tools/list payload into tool specs. */
export function parseToolList(raw: unknown): KnowledgeToolSpec[] {
  const tools = isRecord(raw) && Array.isArray(raw.tools) ? raw.tools : [];
  const out: KnowledgeToolSpec[] = [];
  for (const tool of tools) {
    if (!isRecord(tool)) continue;
    const name = oneLine(tool.name);
    if (name === '') continue;
    out.push({
      name,
      description: oneLine(tool.description),
      params: isRecord(tool.params) ? tool.params : {},
    });
  }
  return out;
}

/** One-line inventory entry: `name(params) — description`. */
export function renderToolInventory(tool: KnowledgeToolSpec): string {
  const params = Object.keys(tool.params);
  const signature = tool.name + '(' + (params.length > 0 ? params.join(',') : '') + ')';
  return cropCodePoints(tool.description === '' ? signature : signature + ' — ' + tool.description, 200);
}

/** knowledge=on resources=3 chars=412 ms=37 fail=- [reject=1] [circuit=open(...)] */
export function describeKnowledgeDiagnostic(diagnostic: KnowledgeSegmentDiagnostic): string {
  const state = diagnostic.ok ? 'on' : 'off';
  const fail = diagnostic.ok ? '-' : (diagnostic.reason ?? 'unknown');
  const circuit = diagnostic.health !== undefined ? ' circuit=' + diagnostic.health : '';
  const rejected = typeof diagnostic.rejected === 'number' && diagnostic.rejected > 0
    ? ' reject=' + diagnostic.rejected
    : '';
  return 'knowledge=' + state + ' resources=' + diagnostic.resources + ' chars=' + diagnostic.chars +
    ' ms=' + diagnostic.ms + ' fail=' + fail + rejected + circuit;
}

/** The one-line wiring seam: bind transport + identity + config once, then ask per turn. */
export interface KnowledgeSegmentHandle {
  readonly config: KnowledgeSegmentConfig;
  /** Core-leg breaker this handle feeds (task-98), when wired. */
  readonly health?: SegmentHealth;
  retrieve(options?: { maxChars?: number }): Promise<KnowledgeSegmentResult>;
  describe(result: KnowledgeSegmentResult): string;
}

/**
 * Register the volatile knowledge segment.
 *
 * dsh-plugin calls this once with its resolved volatile.knowledge subtree, the
 * MemoryClient v3() seam and an identity source, then asks retrieve() while
 * assembling the volatile block (after the wiki segment: it takes what is left).
 * Nothing here touches config.ts / index.ts (see docs/ops/knowledge-tools-wiring.md).
 */
export function registerVolatileKnowledgeSegment(deps: {
  call: KnowledgeCoreCaller;
  identity: KnowledgeIdentitySource;
  config?: unknown;
  logger?: LoggerLike;
  health?: SegmentHealth;
}): KnowledgeSegmentHandle {
  const config = resolveKnowledgeSegmentConfig(deps.config);
  return {
    config,
    ...(deps.health !== undefined ? { health: deps.health } : {}),
    async retrieve(options = {}) {
      const result = await fetchKnowledgeSegment({
        call: deps.call,
        identity: deps.identity,
        config,
        logger: deps.logger,
        maxChars: options.maxChars,
        ...(deps.health !== undefined ? { health: deps.health } : {}),
      });
      deps.logger?.debug?.('agemem: ' + describeKnowledgeDiagnostic(result.diagnostic));
      return result;
    },
    describe(result) {
      return describeKnowledgeDiagnostic(result.diagnostic);
    },
  };
}
