import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_KNOWLEDGE_SEGMENT_CONFIG,
  KNOWLEDGE_SEGMENT_CLOSE,
  KNOWLEDGE_SEGMENT_OPEN,
  cropCodePoints,
  defaultKnowledgeRequest,
  describeKnowledgeDiagnostic,
  executeKnowledgeTool,
  fetchKnowledgeSegment,
  parseToolList,
  renderKnowledgeBlock,
  renderKnowledgeEntry,
  renderToolInventory,
  resolveKnowledgeSegmentConfig,
  selectKnowledgeResources,
  type KnowledgeCoreCaller,
  type KnowledgeHttpRequest,
} from '../src/knowledge-segment.js';
import {
  createKnowledgeReadTool,
  createKnowledgeSearchTool,
  formatKnowledgeSearchData,
  registerKnowledgeTools,
  resetKnowledgeToolCacheForTests,
} from '../src/tools/knowledge.js';

const RESOURCE = {
  knowledge_id: 'wiki-m6c41uvc',
  type: 'wiki',
  service_url: 'http://127.0.0.1:8421/v3/',
  name: 'scm-standards',
  summary: '供应链开发规范知识库，涵盖包命名、分层边界、分布式锁、幂等防重。',
  status: 'ready',
};

const TOOL_LIST = {
  knowledge_id: 'wiki-m6c41uvc',
  type: 'wiki',
  name: 'scm-standards',
  tools: [
    { name: 'get_info', description: '获取 wiki 元信息。', params: {} },
    {
      name: 'search',
      description: '混合检索 wiki 页面内容。',
      params: { query: { type: 'string', required: true }, limit: { type: 'integer', required: false, default: 20 } },
    },
    { name: 'wiki_fetch', description: '按 doc_path 取正文。', params: { doc_path: { type: 'string' }, title: { type: 'string' } } },
  ],
};

function fakeCall(
  reply: { ok: boolean; status?: number; data?: unknown; code?: number },
  seen?: Array<{ path: string; body: Record<string, unknown> }>,
): KnowledgeCoreCaller {
  return async (path, body) => {
    seen?.push({ path, body });
    return reply;
  };
}

function fakeRequest(
  handler: (url: string, body: Record<string, unknown>) => { status: number; json?: unknown },
  seen?: Array<{ url: string; body: Record<string, unknown> }>,
): KnowledgeHttpRequest {
  return async (url, body) => {
    seen?.push({ url, body });
    return handler(url, body);
  };
}

describe('knowledge segment: pure rendering', () => {
  it('renders one line per resource in the proxy shape and strips the trailing slash', () => {
    const [resource] = selectKnowledgeResources([RESOURCE], 8);
    expect(resource.serviceUrl).toBe('http://127.0.0.1:8421/v3');
    expect(renderKnowledgeEntry(resource)).toBe(
      '- [wiki:wiki-m6c41uvc] scm-standards — 供应链开发规范知识库，涵盖包命名、分层边界、分布式锁、幂等防重。',
    );
  });

  it('keeps the open/close tags and drops a line that does not fit whole', () => {
    const resources = selectKnowledgeResources(
      [RESOURCE, { ...RESOURCE, knowledge_id: 'wiki-2', name: 'second', summary: 'y'.repeat(400) }],
      8,
    );
    const block = renderKnowledgeBlock({ resources, maxChars: 220 });
    expect(block.startsWith(KNOWLEDGE_SEGMENT_OPEN + '\n')).toBe(true);
    expect(block.endsWith(KNOWLEDGE_SEGMENT_CLOSE)).toBe(true);
    // 220 is wide enough for the tag pair plus the first line, not the 400-char one.
    expect(block).toContain('[wiki:wiki-m6c41uvc]');
    expect(block).not.toContain('wiki-2');
    expect(block).not.toContain('y'.repeat(200));
  });

  it('returns zero blocks for a zero or tag-only budget, and for no resources', () => {
    const resources = selectKnowledgeResources([RESOURCE], 8);
    expect(renderKnowledgeBlock({ resources, maxChars: 0 })).toBe('');
    expect(renderKnowledgeBlock({ resources, maxChars: 10 })).toBe('');
    expect(renderKnowledgeBlock({ resources: [], maxChars: 3000 })).toBe('');
  });

  it('selectKnowledgeResources drops unusable rows, dedupes and caps', () => {
    const rows = [
      { ...RESOURCE, knowledge_id: '' },
      { ...RESOURCE, service_url: '' },
      RESOURCE,
      { ...RESOURCE, name: 'dup' },
      { ...RESOURCE, knowledge_id: 'wiki-2', name: 'second' },
    ];
    expect(selectKnowledgeResources(rows, 8).map((r) => r.knowledgeId)).toEqual(['wiki-m6c41uvc', 'wiki-2']);
    expect(selectKnowledgeResources(rows, 1)).toHaveLength(1);
    expect(selectKnowledgeResources(undefined, 8)).toEqual([]);
  });

  it('cropCodePoints counts code points, not UTF-16 units', () => {
    expect(cropCodePoints('abc', 3)).toBe('abc');
    expect(cropCodePoints('abcd', 3)).toBe('ab…');
    expect(Array.from(cropCodePoints('😀😀😀', 2)).length).toBe(2);
  });
});

describe('knowledge segment: config resolution', () => {
  it('uses defaults when nothing is configured', () => {
    expect(resolveKnowledgeSegmentConfig(undefined)).toEqual(DEFAULT_KNOWLEDGE_SEGMENT_CONFIG);
    expect(DEFAULT_KNOWLEDGE_SEGMENT_CONFIG).toEqual({
      enabled: true,
      maxChars: 3000,
      maxResources: 8,
      timeoutMs: 2500,
    });
  });

  it('clamps out-of-range values and only switches off on an explicit false', () => {
    const cfg = resolveKnowledgeSegmentConfig({ enabled: 'no', maxChars: 999_999, maxResources: 0, timeoutMs: 5 });
    expect(cfg.enabled).toBe(true);
    expect(cfg.maxChars).toBe(20_000);
    expect(cfg.maxResources).toBe(1);
    expect(cfg.timeoutMs).toBe(100);
    expect(resolveKnowledgeSegmentConfig({ enabled: false }).enabled).toBe(false);
  });

  it('propagates a non-empty serviceId only', () => {
    expect(resolveKnowledgeSegmentConfig({ serviceId: ' default ' }).serviceId).toBe('default');
    expect(resolveKnowledgeSegmentConfig({ serviceId: '   ' }).serviceId).toBeUndefined();
  });
});

describe('knowledge segment: fetch fail-open paths', () => {
  it('makes no request when disabled', async () => {
    const seen: Array<{ path: string }> = [];
    const result = await fetchKnowledgeSegment({
      call: fakeCall({ ok: true, data: { items: [RESOURCE] } }, seen),
      identity: { teamId: 'team-1' },
      config: { ...DEFAULT_KNOWLEDGE_SEGMENT_CONFIG, enabled: false },
    });
    expect(seen).toHaveLength(0);
    expect(result.diagnostic.reason).toBe('disabled');
    expect(result.text).toBe('');
  });

  it('makes no request without a team id', async () => {
    const seen: Array<{ path: string }> = [];
    const result = await fetchKnowledgeSegment({
      call: fakeCall({ ok: true, data: { items: [RESOURCE] } }, seen),
      identity: {},
    });
    expect(seen).toHaveLength(0);
    expect(result.diagnostic.reason).toBe('no_identity');
  });

  it('reports transport / http_<status> / bad_envelope / bad_payload separately', async () => {
    const throwing: KnowledgeCoreCaller = async () => {
      throw new Error('ECONNREFUSED');
    };
    expect((await fetchKnowledgeSegment({ call: throwing, identity: { teamId: 't' } })).diagnostic.reason).toBe('transport');
    expect(
      (await fetchKnowledgeSegment({ call: fakeCall({ ok: false, status: 500 }), identity: { teamId: 't' } })).diagnostic.reason,
    ).toBe('http_500');
    expect(
      (await fetchKnowledgeSegment({ call: fakeCall({ ok: false, code: 403 }), identity: { teamId: 't' } })).diagnostic.reason,
    ).toBe('bad_envelope');
    expect(
      (await fetchKnowledgeSegment({ call: fakeCall({ ok: true, data: {} }), identity: { teamId: 't' } })).diagnostic.reason,
    ).toBe('bad_payload');
  });

  it('distinguishes empty_list from budget_zero and still reports availability', async () => {
    const empty = await fetchKnowledgeSegment({
      call: fakeCall({ ok: true, data: { items: [] } }),
      identity: { teamId: 't' },
    });
    expect(empty.diagnostic.reason).toBe('empty_list');
    const tight = await fetchKnowledgeSegment({
      call: fakeCall({ ok: true, data: { items: [RESOURCE] } }),
      identity: { teamId: 't' },
      maxChars: 10,
    });
    expect(tight.diagnostic.reason).toBe('budget_zero');
    expect(tight.available).toHaveLength(1);
  });

  it('renders the block on success with the list path and team id', async () => {
    const seen: Array<{ path: string; body: Record<string, unknown> }> = [];
    const result = await fetchKnowledgeSegment({
      call: fakeCall({ ok: true, data: { items: [RESOURCE] } }, seen),
      identity: { teamId: 'team-2k12lgb650', userId: 'usr-1' },
    });
    expect(seen[0].path).toBe('/v3/knowledge/list');
    expect(seen[0].body).toEqual({ team_id: 'team-2k12lgb650', user_id: 'usr-1' });
    expect(result.text).toContain('[wiki:wiki-m6c41uvc] scm-standards');
    expect(result.diagnostic).toEqual({ ok: true, ms: expect.any(Number), resources: 1, chars: expect.any(Number) });
    expect(describeKnowledgeDiagnostic(result.diagnostic)).toMatch(/^knowledge=on resources=1 chars=\d+ ms=\d+ fail=-$/);
  });
});

describe('knowledge segment: executeKnowledgeTool', () => {
  it('posts knowledge_id in the body to {service_url}/tools/call', async () => {
    const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
    const result = await executeKnowledgeTool({
      request: fakeRequest(() => ({ status: 200, json: { code: 0, data: { ok: 1 } } }), seen),
      serviceUrl: 'http://127.0.0.1:8421/v3/',
      knowledgeId: 'wiki-m6c41uvc',
      toolName: 'get_info',
    });
    expect(result.ok).toBe(true);
    expect(seen[0].url).toBe('http://127.0.0.1:8421/v3/tools/call');
    expect(seen[0].body).toEqual({ knowledge_id: 'wiki-m6c41uvc', tool_name: 'get_info', params: {} });
  });

  it('rejects an unknown tool name before any request', async () => {
    const seen: Array<{ url: string }> = [];
    const result = await executeKnowledgeTool({
      request: fakeRequest(() => ({ status: 200, json: { code: 0, data: {} } }), seen),
      serviceUrl: 'http://127.0.0.1:8421/v3',
      knowledgeId: 'wiki-1',
      tools: parseToolList(TOOL_LIST),
      toolName: 'nope',
    });
    expect(result.reason).toBe('bad_tool');
    expect(seen).toHaveLength(0);
  });

  it('separates http failure, envelope failure and missing data', async () => {
    const base = { serviceUrl: 'http://h/v3', knowledgeId: 'k', toolName: 'search' };
    expect((await executeKnowledgeTool({ ...base, request: fakeRequest(() => ({ status: 503 })) })).reason).toBe('http_503');
    expect(
      (await executeKnowledgeTool({ ...base, request: fakeRequest(() => ({ status: 200, json: { code: 403, message: 'forbidden' } })) })),
    ).toMatchObject({ ok: false, reason: 'bad_envelope', code: 403, message: 'forbidden' });
    expect(
      (await executeKnowledgeTool({ ...base, request: fakeRequest(() => ({ status: 200, json: { code: 0 } })) })).reason,
    ).toBe('bad_payload');
    expect(
      (await executeKnowledgeTool({ ...base, request: fakeRequest(() => ({ status: 0, })) })).reason,
    ).toBe('transport');
  });

  it('parses tool lists and renders a compact inventory line', () => {
    const tools = parseToolList(TOOL_LIST);
    expect(tools.map((t) => t.name)).toEqual(['get_info', 'search', 'wiki_fetch']);
    expect(renderToolInventory(tools[1])).toBe('search(query,limit) — 混合检索 wiki 页面内容。');
    expect(parseToolList({ tools: [{ name: '' }, { name: 'x' }] })).toHaveLength(1);
  });

  it('exposes a default fetch transport that never throws', async () => {
    // Port 1 is closed: the transport must answer with a structured failure.
    const result = await defaultKnowledgeRequest('http://127.0.0.1:1/v3/tools/list', {}, { timeoutMs: 500 });
    expect(result.status).toBe(0);
    expect(typeof result.error).toBe('string');
  });
});

describe('knowledge tools: schemas honour the host rule', () => {
  const runtime = {
    call: fakeCall({ ok: true, data: { items: [RESOURCE] } }),
    identity: { teamId: 'team-1', serviceId: 'default' },
    request: fakeRequest(() => ({ status: 200, json: { code: 0, data: TOOL_LIST } })),
  };

  it('declares whole JSON Schemas with required as an array and no optional property in it', () => {
    const search = createKnowledgeSearchTool(runtime);
    expect(search.parameters).toMatchObject({
      type: 'object',
      required: ['query'],
      additionalProperties: false,
    });
    const properties = (search.parameters as { properties: Record<string, Record<string, unknown>> }).properties;
    expect(Object.keys(properties)).toEqual(['query', 'knowledge_id', 'limit']);
    for (const [, spec] of Object.entries(properties)) {
      expect(spec).not.toHaveProperty('required');
    }
    const read = createKnowledgeReadTool(runtime);
    expect((read.parameters as { required: string[] }).required).toEqual(['tool_name']);
  });

  it('registers through the passed api seam exactly once', () => {
    const registered: string[] = [];
    registerKnowledgeTools({ register: (module) => { registered.push(module.name); } }, runtime);
    expect(registered).toEqual(['knowledge']);
  });
});

describe('knowledge tools: behaviour', () => {
  beforeEach(() => {
    resetKnowledgeToolCacheForTests();
  });

  function searchRuntime(seenRequests: Array<{ url: string; body: Record<string, unknown> }>, toolListData: unknown = TOOL_LIST) {
    return {
      call: fakeCall({ ok: true, data: { items: [RESOURCE] } }),
      identity: { teamId: 'team-1', serviceId: 'default' },
      request: fakeRequest((url) => {
        if (url.endsWith('/tools/list')) return { status: 200, json: { code: 0, data: toolListData } };
        return {
          status: 200,
          json: {
            code: 0,
            data: {
              results: [
                { path: 'wiki/concepts/分布式锁.md', title: '分布式锁', snippet: '统一用 Redis 分布式锁，禁止自旋。', score: 0.6, absScore: 1.3 },
              ],
            },
          },
        };
      }, seenRequests),
    };
  }

  it('fans out list -> tools/list -> tools/call and formats hits', async () => {
    const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
    const tool = createKnowledgeSearchTool(searchRuntime(seen));
    const out = await tool.execute({ query: '分布式锁', limit: 3 });
    expect(seen[0].url).toBe('http://127.0.0.1:8421/v3/tools/list');
    expect(seen[1].url).toBe('http://127.0.0.1:8421/v3/tools/call');
    expect(seen[1].body).toMatchObject({ tool_name: 'search', params: { query: '分布式锁', limit: 3 } });
    expect(out).toContain('[scm-standards/wiki/concepts/分布式锁.md] 分布式锁 — 统一用 Redis 分布式锁，禁止自旋。');
  });

  it('does not send limit when the resource search tool has no such param', async () => {
    const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
    const toolList = { knowledge_id: 'wiki-m6c41uvc', tools: [{ name: 'query', description: 'q', params: { text: {} } }] };
    const tool = createKnowledgeSearchTool(searchRuntime(seen, toolList));
    await tool.execute({ query: 'x', limit: 5 });
    expect(seen[1].body).toMatchObject({ tool_name: 'query', params: { query: 'x' } });
  });

  it('answers with the tool inventory when no resource exposes a search tool', async () => {
    const toolList = { knowledge_id: 'wiki-m6c41uvc', tools: [{ name: 'wiki_fetch', description: '取正文', params: { doc_path: {} } }] };
    const tool = createKnowledgeSearchTool(searchRuntime([], toolList));
    const out = await tool.execute({ query: 'x' });
    expect(out).toContain('没有可直接检索的工具');
    expect(out).toContain('wiki_fetch(doc_path) — 取正文');
  });

  it('short-circuits on an empty query and on an unknown knowledge_id', async () => {
    const seen: Array<{ url: string }> = [];
    const tool = createKnowledgeSearchTool(searchRuntime(seen));
    expect(await tool.execute({ query: '   ' })).toBe('knowledge unavailable: empty query');
    expect(await tool.execute({ query: 'x', knowledge_id: 'nope' })).toBe('knowledge unavailable: unknown knowledge_id nope');
    expect(seen).toHaveLength(0);
  });

  it('reports a per-resource search failure instead of throwing', async () => {
    const runtime = {
      call: fakeCall({ ok: true, data: { items: [RESOURCE] } }),
      identity: { teamId: 'team-1' },
      request: fakeRequest((url) => url.endsWith('/tools/list')
        ? { status: 200, json: { code: 0, data: TOOL_LIST } }
        : { status: 200, json: { code: 500, message: 'boom' } }),
    };
    const out = await createKnowledgeSearchTool(runtime).execute({ query: 'x' });
    expect(out).toBe('[scm-standards] search failed: bad_envelope');
  });

  it('reads a page through knowledge_read and truncates oversized data', async () => {
    const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
    const runtime = {
      call: fakeCall({ ok: true, data: { items: [RESOURCE] } }),
      identity: { teamId: 'team-1' },
      request: fakeRequest(() => ({ status: 200, json: { code: 0, data: 'x'.repeat(500) } }), seen),
    };
    const tool = createKnowledgeReadTool(runtime);
    const out = await tool.execute({ tool_name: 'wiki_fetch', params: { doc_path: 'wiki/x.md' }, max_result_chars: 200 });
    expect(seen.at(-1)!.body).toMatchObject({ tool_name: 'wiki_fetch', params: { doc_path: 'wiki/x.md' } });
    expect(out.endsWith('[truncated]')).toBe(true);
    expect(Array.from(out).length).toBeLessThanOrEqual(200 + '[truncated]'.length + 1);
  });

  it('asks for knowledge_id when the team has several resources', async () => {
    const two = { ...RESOURCE, knowledge_id: 'wiki-2', name: 'other' };
    const runtime = {
      call: fakeCall({ ok: true, data: { items: [RESOURCE, two] } }),
      identity: { teamId: 'team-1' },
      request: fakeRequest(() => ({ status: 200, json: { code: 0, data: TOOL_LIST } })),
    };
    const out = await createKnowledgeReadTool(runtime).execute({ tool_name: 'get_info' });
    expect(out).toContain('pass knowledge_id');
    expect(out).toContain('wiki-m6c41uvc, wiki-2');
  });

  it('formats a string payload verbatim and a non-results payload as JSON', () => {
    const [resource] = selectKnowledgeResources([RESOURCE], 8);
    expect(formatKnowledgeSearchData(resource, 'x', 'plain')).toBe('plain');
    expect(formatKnowledgeSearchData(resource, 'get_info', { pages: 41 })).toBe('[scm-standards/get_info] {"pages":41}');
  });
});
