import type { MemoryClient } from '../memory-client.js';
import type { ToolDefinitionShape, LoggerLike } from '../types.js';
import {
  DEFAULT_KNOWLEDGE_SEGMENT_CONFIG,
  KNOWLEDGE_LIST_PATH,
  KNOWLEDGE_TOOL_RESULT_MAX_CHARS,
  KNOWLEDGE_TOOLS_LIST_SUFFIX,
  cropCodePoints,
  defaultKnowledgeRequest,
  executeKnowledgeTool,
  parseToolList,
  renderToolInventory,
  selectKnowledgeResources,
  type KnowledgeCoreCaller,
  type KnowledgeHttpRequest,
  type KnowledgeResource,
  type KnowledgeToolSpec,
} from '../knowledge-segment.js';
import { createSegmentHealth, type SegmentHealth } from '../segment-health.js';
import { registerToolModule, type ToolModule, type ToolModuleDeps } from './registry.js';

/**
 * The two native tools that stand in for MemoryProxy's curl recipe
 * (MemoryProxy/src/injection/injectors/knowledge-tools-injector.ts:177-242).
 *
 * Proxy teaches a two-step flow in prose (tools/list -> tools/call) because its
 * agent only has bash. A DSH agent has real tools, so the same flow is wrapped:
 *
 *   knowledge_search -> list resources -> tools/list (cached) -> tools/call
 *   knowledge_read   -> tools/call with an explicit tool_name/params
 *
 * Both are fail-open: every failure is a readable string, never a throw, so a
 * knowledge-service outage degrades to "no result" instead of a broken turn.
 * Schemas are raw JSON Schema (required-array only; an optional property omits
 * `required` entirely — host rule, docs/ops/dsh-plugin-probe-report.md).
 */

/** Tool names that mean "search this resource" across services; first match wins. */
export const KNOWLEDGE_SEARCH_TOOL_NAMES = ['search', 'wiki_search', 'query', 'explore'] as const;

/** How long a tools/list answer stays cached for one resource (a session-scale cache). */
const TOOL_LIST_TTL_MS = 10 * 60 * 1000;

export interface KnowledgeToolRuntime {
  /** MemoryClient.v3 seam: the core resource list lives on 8420. */
  call: KnowledgeCoreCaller;
  identity: { teamId?: string; userId?: string; serviceId?: string };
  log?: LoggerLike;
  /** Raw HTTP seam for the tool service (8421); injectable for tests. */
  request?: KnowledgeHttpRequest;
  /** How many resources one knowledge_search may fan out to. */
  maxResources?: number;
  /** Result cap in code points. */
  maxResultChars?: number;
}

function oneLine(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function capText(text: string, max: number): { text: string; truncated: boolean } {
  if (max <= 0) return { text: '', truncated: text !== '' };
  const cps = Array.from(text);
  if (cps.length <= max) return { text, truncated: false };
  return { text: cps.slice(0, max).join('') + '\n[truncated]', truncated: true };
}

/** Resource list for a team; [] on every failure (with one debug line). */
async function listResources(runtime: KnowledgeToolRuntime): Promise<KnowledgeResource[]> {
  const teamId = oneLine(runtime.identity?.teamId);
  if (teamId === '') return [];
  try {
    const result = await runtime.call(KNOWLEDGE_LIST_PATH, { team_id: teamId }, { timeoutMs: DEFAULT_KNOWLEDGE_SEGMENT_CONFIG.timeoutMs });
    if (result === undefined || result.ok !== true) {
      runtime.log?.debug?.('agemem: knowledge list for tools failed status=' + String(result?.status ?? '-'));
      return [];
    }
    const data = result.data;
    const items = typeof data === 'object' && data !== null && Array.isArray((data as { items?: unknown }).items)
      ? (data as { items: unknown[] }).items
      : [];
    return selectKnowledgeResources(items, runtime.maxResources ?? DEFAULT_KNOWLEDGE_SEGMENT_CONFIG.maxResources);
  } catch (error) {
    runtime.log?.warn?.('agemem: knowledge list threw', error);
    return [];
  }
}

interface ToolListCacheEntry {
  tools: KnowledgeToolSpec[];
  at: number;
}

/** Per-process tools/list cache, one entry per knowledge_id (proxy's session_init analogue). */
const toolListCache = new Map<string, ToolListCacheEntry>();

/**
 * Tools-leg breakers, one per service_url (task-98).
 *
 * Deliberately separate from the knowledge segment's core-leg breaker: a dead
 * 8420 (/v3/knowledge/list) says nothing about 8421, and vice versa. Keyed by
 * service_url so one sick knowledge service cannot silence its healthy siblings.
 */
const toolsHealth = new Map<string, SegmentHealth>();

function toolsHealthFor(serviceUrl: string): SegmentHealth {
  const key = oneLine(serviceUrl).replace(/\/+$/u, '');
  let health = toolsHealth.get(key);
  if (health === undefined) {
    health = createSegmentHealth({ name: 'knowledge-tools ' + (key === '' ? 'unknown' : key) });
    toolsHealth.set(key, health);
  }
  return health;
}

/** Test hook: forget cached tool lists and reset the per-service breakers. */
export function resetKnowledgeToolCacheForTests(): void {
  toolListCache.clear();
  toolsHealth.clear();
}

async function listTools(
  runtime: KnowledgeToolRuntime,
  resource: KnowledgeResource,
): Promise<KnowledgeToolSpec[]> {
  const cached = toolListCache.get(resource.knowledgeId);
  if (cached !== undefined && Date.now() - cached.at < TOOL_LIST_TTL_MS) return cached.tools;
  const health = toolsHealthFor(resource.serviceUrl);
  if (!health.shouldAttempt()) {
    runtime.log?.debug?.('agemem: knowledge tools leg circuit open, tools/list skipped');
    return [];
  }
  const request = runtime.request ?? defaultKnowledgeRequest;
  try {
    const response = await request(
      resource.serviceUrl + KNOWLEDGE_TOOLS_LIST_SUFFIX,
      { knowledge_id: resource.knowledgeId },
      {
        timeoutMs: DEFAULT_KNOWLEDGE_SEGMENT_CONFIG.timeoutMs,
        ...(oneLine(runtime.identity?.serviceId) !== '' ? { serviceId: oneLine(runtime.identity?.serviceId) } : {}),
      },
    );
    if (response.status < 200 || response.status >= 300 || typeof response.json !== 'object' || response.json === null) {
      runtime.log?.debug?.('agemem: knowledge tools/list failed status=' + String(response.status));
      health.recordFailure(response.status > 0 ? 'http_' + String(response.status) : 'transport');
      return [];
    }
    const envelope = response.json as { code?: unknown; data?: unknown };
    if (typeof envelope.code === 'number' && envelope.code !== 0) {
      runtime.log?.debug?.('agemem: knowledge tools/list envelope code=' + String(envelope.code));
      health.recordFailure('bad_envelope');
      return [];
    }
    const tools = parseToolList(envelope.data);
    health.recordSuccess();
    toolListCache.set(resource.knowledgeId, { tools, at: Date.now() });
    return tools;
  } catch (error) {
    runtime.log?.debug?.('agemem: knowledge tools/list threw');
    health.recordFailure('transport');
    return [];
  }
}

function pickSearchTool(tools: KnowledgeToolSpec[]): KnowledgeToolSpec | undefined {
  for (const name of KNOWLEDGE_SEARCH_TOOL_NAMES) {
    const hit = tools.find((tool) => tool.name === name);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** Render one search payload: `- [resource/path] title — snippet` lines, else compact JSON. */
export function formatKnowledgeSearchData(resource: KnowledgeResource, toolName: string, data: unknown): string {
  if (typeof data === 'string') return data;
  const record = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : undefined;
  const results = record !== undefined && Array.isArray(record.results) ? record.results : undefined;
  if (results !== undefined) {
    if (results.length === 0) return '[' + resource.name + '/' + toolName + '] 0 hits';
    const lines = results.map((raw) => {
      const hit = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
      const path = oneLine(hit.path) || oneLine(hit.id) || oneLine(hit.title);
      const title = oneLine(hit.title);
      const snippet = oneLine(hit.snippet) || oneLine(hit.text) || oneLine(hit.summary);
      const head = '[' + resource.name + '/' + path + ']' + (title === '' ? '' : ' ' + title);
      const tail = snippet === '' ? '' : ' — ' + snippet;
      return cropCodePoints('- ' + head + tail, 320);
    });
    return lines.join('\n');
  }
  return '[' + resource.name + '/' + toolName + '] ' + JSON.stringify(data);
}

/**
 * knowledge_search — one call that both discovers and queries.
 *
 * With `knowledge_id` it only touches that resource; otherwise it fans out to
 * the team's resources (bounded by maxResources). For every resource it asks
 * tools/list (cached), picks the search-capable tool and runs it. When no
 * resource exposes a search tool, the reply is the tool inventory so the agent
 * can still reach the data through knowledge_read.
 */
export function createKnowledgeSearchTool(runtime: KnowledgeToolRuntime): ToolDefinitionShape {
  const maxResultChars = runtime.maxResultChars ?? KNOWLEDGE_TOOL_RESULT_MAX_CHARS;
  return {
    name: 'knowledge_search',
    description:
      'Search the team knowledge base (wiki design docs and code-graph repo indexes) and return matching snippets. '
      + 'Lists the team resources, discovers each resource tool list, then runs its search tool. '
      + 'For design rationale / background / conventions use this; for code as it is right now, read the workspace source.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords or a natural-language question.' },
        knowledge_id: { type: 'string', description: 'Limit the search to one resource id (from <knowledge_tools>).' },
        limit: { type: 'number', description: 'Hits per resource (default 8).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args: Record<string, unknown>, value: unknown) => [{ type: 'text' as const, text: String(value) }],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const query = oneLine(args.query);
      if (query === '') return 'knowledge unavailable: empty query';
      const limit = clampInt(args.limit, 8, 1, 20);
      const wanted = oneLine(args.knowledge_id);
      let resources = await listResources(runtime);
      if (resources.length === 0) return 'knowledge unavailable: no resources for this team';
      if (wanted !== '') {
        resources = resources.filter((resource) => resource.knowledgeId === wanted);
        if (resources.length === 0) return 'knowledge unavailable: unknown knowledge_id ' + wanted;
      }
      const sections: string[] = [];
      const inventories: string[] = [];
      for (const resource of resources) {
        const tools = await listTools(runtime, resource);
        const searchTool = pickSearchTool(tools);
        if (tools.length > 0) {
          inventories.push('[' + resource.name + '] ' + tools.map((tool) => renderToolInventory(tool)).join(' | '));
        }
        if (searchTool === undefined) continue;
        const params: Record<string, unknown> = { query };
        if (Object.hasOwn(searchTool.params, 'limit')) params.limit = limit;
        const result = await executeKnowledgeTool({
          ...(runtime.request !== undefined ? { request: runtime.request } : {}),
          serviceUrl: resource.serviceUrl,
          knowledgeId: resource.knowledgeId,
          tools,
          toolName: searchTool.name,
          params,
          ...(oneLine(runtime.identity?.serviceId) !== '' ? { serviceId: oneLine(runtime.identity?.serviceId) } : {}),
          timeoutMs: DEFAULT_KNOWLEDGE_SEGMENT_CONFIG.timeoutMs,
          health: toolsHealthFor(resource.serviceUrl),
        });
        if (result.ok) {
          sections.push(formatKnowledgeSearchData(resource, searchTool.name, result.data));
        } else {
          sections.push('[' + resource.name + '] search failed: ' + (result.reason ?? 'unknown'));
          runtime.log?.debug?.('agemem: knowledge search failed resource=' + resource.knowledgeId + ' reason=' + (result.reason ?? 'unknown'));
        }
      }
      if (sections.length === 0) {
        if (inventories.length === 0) return 'knowledge unavailable: no tool list from any resource';
        return '这个团队的资源没有可直接检索的工具。可用工具清单（用 knowledge_read 指定 tool_name 调用）：\n'
          + inventories.join('\n');
      }
      const body = sections.join('\n\n');
      const capped = capText(body, maxResultChars);
      return capped.truncated
        ? capped.text
        : body;
    },
  };
}

/**
 * knowledge_read — run one tool on one resource (the tools/call half).
 *
 * `tool_name` comes from the inventory returned by knowledge_search; `params`
 * is passed through verbatim (wiki_fetch wants {doc_path|title, section},
 * read_page wants {refs}, ...). Result data is truncated at maxResultChars with
 * a [truncated] marker, and a miss (data.isError=true) is reported as a miss,
 * not as a failure.
 */
export function createKnowledgeReadTool(runtime: KnowledgeToolRuntime): ToolDefinitionShape {
  const maxResultChars = runtime.maxResultChars ?? KNOWLEDGE_TOOL_RESULT_MAX_CHARS;
  return {
    name: 'knowledge_read',
    description:
      'Run one tool of a team knowledge resource and return its data (e.g. wiki_fetch with doc_path to read a page). '
      + 'Discover tool names and params with knowledge_search first.',
    parameters: {
      type: 'object',
      properties: {
        tool_name: { type: 'string', description: 'Tool name exactly as the resource reported it.' },
        knowledge_id: { type: 'string', description: 'Resource id; only needed when the team has several.' },
        params: { type: 'object', description: 'Tool parameters as a JSON object ({} when the tool takes none).' },
        max_result_chars: { type: 'number', description: 'Result cap in characters (default ' + String(maxResultChars) + ').' },
      },
      required: ['tool_name'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args: Record<string, unknown>, value: unknown) => [{ type: 'text' as const, text: String(value) }],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const toolName = oneLine(args.tool_name);
      if (toolName === '') return 'knowledge unavailable: empty tool_name';
      const resources = await listResources(runtime);
      if (resources.length === 0) return 'knowledge unavailable: no resources for this team';
      const wanted = oneLine(args.knowledge_id);
      const resource = wanted === ''
        ? (resources.length === 1 ? resources[0] : undefined)
        : resources.find((entry) => entry.knowledgeId === wanted);
      if (resource === undefined) {
        return 'knowledge unavailable: pass knowledge_id (candidates: '
          + resources.map((entry) => entry.knowledgeId).join(', ') + ')';
      }
      const tools = await listTools(runtime, resource);
      const params = typeof args.params === 'object' && args.params !== null && !Array.isArray(args.params)
        ? (args.params as Record<string, unknown>)
        : {};
      const result = await executeKnowledgeTool({
        ...(runtime.request !== undefined ? { request: runtime.request } : {}),
        serviceUrl: resource.serviceUrl,
        knowledgeId: resource.knowledgeId,
        tools,
        toolName,
        params,
        ...(oneLine(runtime.identity?.serviceId) !== '' ? { serviceId: oneLine(runtime.identity?.serviceId) } : {}),
        timeoutMs: DEFAULT_KNOWLEDGE_SEGMENT_CONFIG.timeoutMs,
        health: toolsHealthFor(resource.serviceUrl),
      });
      if (!result.ok) {
        return 'knowledge tool ' + toolName + ' failed: ' + (result.reason ?? 'unknown')
          + (result.code !== undefined ? ' code=' + String(result.code) : '')
          + (result.message !== undefined && result.message !== '' ? ' message=' + result.message : '');
      }
      const payload = typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2);
      const capped = capText(payload, clampInt(args.max_result_chars, maxResultChars, 200, 200_000));
      return capped.text;
    },
  };
}

/** Build the registry module; the wiring caller may inject a runtime override. */
export function createKnowledgeToolModule(runtimeOverride?: KnowledgeToolRuntime): ToolModule {
  return {
    name: 'knowledge',
    // The switch lives on tools.enabled today; a dedicated tools.knowledge key
    // needs a src/config.ts line, which belongs to dsh-plugin (see the wiring doc).
    enabled: (config) => config.tools.enabled,
    build: (deps: ToolModuleDeps) => {
      const runtime: KnowledgeToolRuntime = runtimeOverride ?? {
        call: (path, body, options) => deps.client.v3<unknown>(path, body, options),
        identity: {
          teamId: deps.config.server.teamId,
          userId: deps.config.server.userId,
          serviceId: deps.config.server.serviceId,
        },
        ...(deps.log !== undefined ? { log: deps.log } : {}),
      };
      return [createKnowledgeSearchTool(runtime), createKnowledgeReadTool(runtime)];
    },
  };
}

/**
 * The one-line wiring seam dsh-plugin uses in src/tools/index.ts:
 *
 *   import { registerKnowledgeTools } from './knowledge.js';
 *   registerKnowledgeTools();
 *
 * Passing an `api` lets a caller with its own registry (tests, a future seam)
 * reuse the module without touching the global one.
 */
export function registerKnowledgeTools(
  api: { register(module: ToolModule): void } = { register: registerToolModule },
  runtimeOverride?: KnowledgeToolRuntime,
): void {
  api.register(createKnowledgeToolModule(runtimeOverride));
}

// Self-register on import so the barrel (src/tools/index.ts) needs one import line.
registerKnowledgeTools();
