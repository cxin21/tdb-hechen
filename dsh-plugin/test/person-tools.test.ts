import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config.js';
import { MemoryClient, type MemoryClientDeps, type SoulPersonSearchOutcome } from '../src/memory-client.js';
import { createSoulPersonProfileTool, createSoulPersonSearchTool, formatSoulPersonProfile, formatSoulPersons } from '../src/tools.js';
import { assertObjectJsonSchema, validateJsonSchemaValue } from './fixtures/host-json-schema/json-schema.js';

function fakeClient(search: (query: string, limit: number, timeoutMs: number) => Promise<SoulPersonSearchOutcome>): MemoryClient {
  return { searchSoulPersons: search } as unknown as MemoryClient;
}

const tool = (
  search: (query: string, limit: number, timeoutMs: number) => Promise<SoulPersonSearchOutcome> = async () => ({ ok: true, hits: [] }),
  defaultLimit = 10,
  sessionId?: () => string | undefined,
) => createSoulPersonSearchTool({ client: fakeClient(search), defaultLimit, timeoutMs: 500, sessionId });

const HIT = {
  key: 'p_name_zhangsan',
  displayName: '张三',
  aliases: ['三哥'],
  platform: 'esn',
  platformId: 'u-1',
  fieldCount: 3,
  relationCount: 1,
  updatedAt: '2026-11-01T00:00:00Z',
  match: 'exact' as const,
  matchedOn: 'display_name' as const,
};

describe('soul_person_search tool', () => {
  it('formats hits one per line and says so when nothing matched', () => {
    expect(formatSoulPersons([])).toBe('no person match');
    expect(formatSoulPersons([HIT])).toBe('- 张三 (p_name_zhangsan) · 档案 3 项 · 关系 1 · 精确/显示名 · 别名: 三哥');
    expect(formatSoulPersons([{ ...HIT, aliases: [], match: 'contains', matchedOn: 'key' }]))
      .toBe('- 张三 (p_name_zhangsan) · 档案 3 项 · 关系 1 · 包含/key');
  });

  it('clamps the requested limit, trims the name and forwards the session id', async () => {
    const search = vi.fn(async () => ({ ok: true as const, hits: [HIT] }));
    const output = await tool(search, 10, () => 'sess-9').execute({ name: '  张三  ', limit: 500 });
    expect(output).toBe('- 张三 (p_name_zhangsan) · 档案 3 项 · 关系 1 · 精确/显示名 · 别名: 三哥');
    // Limit is clamped to the endpoint's ceiling (20), not to the tool default.
    expect(search).toHaveBeenCalledWith('张三', 20, 500, 'sess-9');
  });

  it('uses the configured default limit when none is given', async () => {
    const search = vi.fn(async () => ({ ok: true as const, hits: [] }));
    expect(await tool(search, 6).execute({ name: 'x' })).toBe('no person match');
    expect(search).toHaveBeenCalledWith('x', 6, 500, undefined);
  });

  it('refuses an empty name without calling the core', async () => {
    const search = vi.fn(async () => ({ ok: true as const, hits: [] }));
    expect(await tool(search).execute({ name: '   ' })).toBe('memory unavailable: empty person name');
    expect(await tool(search).execute({})).toBe('memory unavailable: empty person name');
    expect(search).not.toHaveBeenCalled();
  });

  it('reports a failed search as unavailable instead of "no match"', async () => {
    expect(await tool(async () => ({ ok: false, status: 503, reason: 'HTTP 503' })).execute({ name: '张三' }))
      .toBe('memory unavailable: person search failed (HTTP 503)');
  });

  it('degrades to a message when the core throws', async () => {
    expect(await tool(async () => { throw new Error('core down'); }).execute({ name: '张三' }))
      .toBe('memory unavailable: person search request failed');
  });

  it('declares a JSON Schema object the host accepts', () => {
    const definition = tool();
    expect(definition.name).toBe('soul_person_search');
    expect(() => assertObjectJsonSchema(definition.parameters)).not.toThrow();
    expect(definition.parameters).toMatchObject({
      type: 'object',
      required: ['name'],
      additionalProperties: false,
      properties: { name: { type: 'string' }, limit: { type: 'number' } },
    });
    expect(validateJsonSchemaValue(definition.parameters, { name: '张三' })).toEqual([]);
    expect(validateJsonSchemaValue(definition.parameters, {})).not.toEqual([]);
  });
});

describe('MemoryClient.searchSoulPersons', () => {
  function createClient(fetchImpl: typeof fetch, overrides: Partial<MemoryClientDeps> = {}): MemoryClient {
    return new MemoryClient({
      baseUrl: 'http://core.local:8420/',
      apiKeyRef: 'TDB_API_KEY',
      identity: { serviceId: 'default', teamId: 'team-1', agentId: 'agt-1', userId: 'usr-1' },
      requestTimeoutMs: 1000,
      paths: DEFAULT_CONFIG.paths,
      resolveApiKey: async () => 'secret-key',
      ...overrides,
      fetchImpl,
    });
  }

  it('GETs the search route with q and a clamped limit, then maps the rows', async () => {
    const seen: Array<{ url: string; method: string }> = [];
    const fetchImpl = (async (input: any, init: any = {}) => {
      seen.push({ url: String(input), method: String(init.method ?? 'GET') });
      return new Response(JSON.stringify({
        code: 0,
        message: 'ok',
        request_id: 'req-1',
        data: { query: '张三', count: 1, persons: [HIT] },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;

    const outcome = await createClient(fetchImpl).searchSoulPersons(' 张三 ', 999);

    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe('GET');
    const url = new URL(seen[0].url);
    expect(url.pathname).toBe(DEFAULT_CONFIG.paths.soulPersonSearch);
    expect(url.searchParams.get('q')).toBe('张三');
    expect(url.searchParams.get('limit')).toBe('20');
    // 身份三元组走 query（Core 的 tenantOf 只读 URL 参数）：缺 team 会 400，
    // 缺 user/agent 会退到 "default" 租户查空——两者都表现为「查不到人」。
    expect(url.searchParams.get('team')).toBe('team-1');
    expect(url.searchParams.get('user')).toBe('usr-1');
    expect(url.searchParams.get('agent')).toBe('agt-1');
    expect(outcome).toEqual({ ok: true, hits: [HIT] });
  });

  // 人物读面回 `{ ok: true, data }`（没有 code 字段），其它 v3 路由回 `{ code: 0, data }`。
  // 线上实测就是前者：客户端若只认 code===0，每次查人都会报「business code undefined」。
  it('unwraps the ok-envelope the person routes actually send', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({
      ok: true,
      data: { query: '张三', count: 1, persons: [HIT] },
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

    await expect(createClient(fetchImpl).searchSoulPersons('张三', 5))
      .resolves.toEqual({ ok: true, hits: [HIT] });
  });

  it('does not read ok:false as an empty result', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ ok: false, data: { persons: [] } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;

    const outcome = await createClient(fetchImpl).searchSoulPersons('张三', 5);
    expect(outcome.ok).toBe(false);
  });

  it('skips a blank name and never calls out', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('must not call'); }) as unknown as typeof fetch;
    await expect(createClient(fetchImpl).searchSoulPersons('   ', 5)).resolves.toEqual({ ok: true, hits: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps a failure diagnosable instead of folding it into an empty list', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch;
    await expect(createClient(fetchImpl).searchSoulPersons('张三', 5))
      .resolves.toEqual({ ok: false, status: 503, reason: 'HTTP 503' });
  });

  it('drops rows without a key or display name', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({
      code: 0,
      message: 'ok',
      request_id: 'req-2',
      data: { persons: [{ key: 'p_1' }, { displayName: 'x' }, { ...HIT, match: 'weird', matchedOn: 'other' }] },
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const outcome = await createClient(fetchImpl).searchSoulPersons('张', 5);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.hits).toHaveLength(1);
      // Unknown enum values fall back rather than leaking a bad union member.
      expect(outcome.hits[0]).toMatchObject({ match: 'contains', matchedOn: 'display_name' });
    }
  });
});

describe('soul_person_profile tool', () => {
  const PROFILE = {
    key: 'p_name_zhangsan',
    displayName: '张三',
    aliases: ['三哥'],
    fields: [
      { field: 'role', label: '角色', text: '产品经理', updatedAt: '2026-11-01T00:00:00Z', stale: false },
      { field: 'focus', label: '关注', text: '云文库', updatedAt: '2026-10-01T00:00:00Z', stale: true },
    ],
    relations: [
      { relId: 'r1', pred: '领导', direction: 'out' as const, counterpartKey: 'p_2', counterpartName: '李四', quote: '', validFrom: '' },
    ],
  };

  function profileTool(client: Partial<MemoryClient>, defaultLimit = 10) {
    return createSoulPersonProfileTool({
      client: client as MemoryClient,
      defaultLimit,
      timeoutMs: 500,
    });
  }

  it('formats fields (with staleness) and relation arrows', () => {
    expect(formatSoulPersonProfile(PROFILE)).toBe([
      '张三 (p_name_zhangsan) · 档案 2 项 · 关系 1',
      '别名: 三哥',
      '- 角色: 产品经理',
      '- 关注: 云文库（可能已过时）',
      '关系：',
      '- 领导 → 李四',
    ].join('\n'));
    expect(formatSoulPersonProfile({ ...PROFILE, fields: [], relations: [], aliases: [] }))
      .toBe('张三 (p_name_zhangsan) · 档案 0 项 · 关系 0\n- 还没有提炼出字段');
  });

  it('resolves a unique name to its key and then reads the profile', async () => {
    const searchSoulPersons = vi.fn(async () => ({ ok: true as const, hits: [HIT] }));
    const readSoulPerson = vi.fn(async () => ({ ok: true as const, profile: PROFILE }));
    const output = await profileTool({ searchSoulPersons, readSoulPerson }).execute({ name: '张三' });
    expect(searchSoulPersons).toHaveBeenCalledWith('张三', 10, 500, undefined);
    expect(readSoulPerson).toHaveBeenCalledWith('p_name_zhangsan', 500, undefined);
    expect(output).toContain('- 角色: 产品经理');
  });

  it('reads a person_key directly without a name search', async () => {
    const searchSoulPersons = vi.fn(async () => ({ ok: true as const, hits: [] }));
    const readSoulPerson = vi.fn(async () => ({ ok: true as const, profile: PROFILE }));
    expect(await profileTool({ searchSoulPersons, readSoulPerson }).execute({ name: 'p_name_zhangsan' }))
      .toContain('张三 (p_name_zhangsan)');
    expect(searchSoulPersons).not.toHaveBeenCalled();
  });

  it('lists candidates instead of guessing when several names match', async () => {
    // 两条都不是精确命中：这时才该把候选交回去，而不是挑「第一个看起来像」的。
    const searchSoulPersons = vi.fn(async () => ({
      ok: true as const,
      hits: [
        { ...HIT, match: 'prefix' as const },
        { ...HIT, key: 'p_2', displayName: '张三丰', match: 'prefix' as const },
      ],
    }));
    const readSoulPerson = vi.fn();
    const output = await profileTool({ searchSoulPersons, readSoulPerson }).execute({ name: '张三' });
    expect(output).toContain('several people match');
    expect(output).toContain('p_2');
    expect(readSoulPerson).not.toHaveBeenCalled();
  });

  it('reports a failed read as unavailable', async () => {
    expect(await profileTool({ readSoulPerson: async () => ({ ok: false, status: 404, reason: 'HTTP 404' }) }).execute({ name: 'p_x' }))
      .toBe('memory unavailable: person profile failed (HTTP 404)');
  });

  it('declares a JSON Schema object the host accepts', () => {
    const definition = profileTool({});
    expect(definition.name).toBe('soul_person_profile');
    expect(() => assertObjectJsonSchema(definition.parameters)).not.toThrow();
    expect(validateJsonSchemaValue(definition.parameters, { name: '张三' })).toEqual([]);
  });
});

describe('MemoryClient.readSoulPerson', () => {
  function createClient(fetchImpl: typeof fetch): MemoryClient {
    return new MemoryClient({
      baseUrl: 'http://core.local:8420/',
      apiKeyRef: 'TDB_API_KEY',
      identity: { serviceId: 'default', teamId: 'team-1', agentId: 'agt-1', userId: 'usr-1' },
      requestTimeoutMs: 1000,
      paths: DEFAULT_CONFIG.paths,
      resolveApiKey: async () => 'secret-key',
      fetchImpl,
    });
  }

  it('GETs /v3/soul/person with the key and maps fields and relations', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (input: any) => {
      seen.push(String(input));
      return new Response(JSON.stringify({
        code: 0,
        message: 'ok',
        request_id: 'req-3',
        data: {
          person: { key: 'p_name_zhangsan', displayName: '张三', aliases: ['三哥'] },
          fields: [{ field: 'role', label: '角色', text: '产品经理', evidence: [], updatedAt: '2026-11-01T00:00:00Z', stale: false }],
          relations: [{ relId: 'r1', pred: '领导', objKey: 'p_2', objName: '李四', direction: 'out', counterpartKey: 'p_2', quote: 'q', recordId: 'm1', validFrom: 'f' }],
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;

    const outcome = await createClient(fetchImpl).readSoulPerson('p_name_zhangsan');

    expect(new URL(seen[0]).pathname).toBe(DEFAULT_CONFIG.paths.soulPerson);
    expect(new URL(seen[0]).searchParams.get('key')).toBe('p_name_zhangsan');
    // 同 search：身份三元组必须同行，否则单人读面也查不到（404 person_not_found）。
    expect(new URL(seen[0]).searchParams.get('team')).toBe('team-1');
    expect(new URL(seen[0]).searchParams.get('user')).toBe('usr-1');
    expect(new URL(seen[0]).searchParams.get('agent')).toBe('agt-1');
    expect(outcome).toEqual({
      ok: true,
      profile: {
        key: 'p_name_zhangsan',
        displayName: '张三',
        aliases: ['三哥'],
        fields: [{ field: 'role', label: '角色', text: '产品经理', updatedAt: '2026-11-01T00:00:00Z', stale: false }],
        relations: [{ relId: 'r1', pred: '领导', direction: 'out', counterpartKey: 'p_2', counterpartName: '李四', quote: 'q', validFrom: 'f' }],
      },
    });
  });

  it('uses the read face counterpartName for in edges, and falls back to objName for an older core', async () => {
    const respond = (relation: Record<string, unknown>) => (async () => new Response(JSON.stringify({
      ok: true,
      data: {
        person: { key: 'p_me', displayName: '何辰', aliases: [] },
        fields: [],
        // in 边：objName 是本人名字，对方名字只在 counterpartName 里
        relations: [relation],
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

    const current = await createClient(respond({
      relId: 'r-in', pred: '下属', direction: 'in', subjKey: 'p_2', objKey: 'p_me', objName: '何辰',
      counterpartKey: 'p_2', counterpartName: '李四', quote: 'q', recordId: 'm1', validFrom: 'f',
    })).readSoulPerson('p_me');
    expect(current.ok).toBe(true);
    const inEdge = current.ok ? current.profile.relations[0]! : null;
    expect(inEdge).toEqual({
      relId: 'r-in', pred: '下属', direction: 'in', counterpartKey: 'p_2', counterpartName: '李四', quote: 'q', validFrom: 'f',
    });
    expect(formatSoulPersonProfile(current.ok ? current.profile : ({} as never))).toContain('- 下属 ← 李四');

    // 老 core 只回 objName：out 边仍能读回名字，不能变 null
    const legacy = await createClient(respond({
      relId: 'r-out', pred: '上级', direction: 'out', objKey: 'p_3', objName: '张总',
      counterpartKey: 'p_3', quote: 'q', recordId: 'm1', validFrom: 'f',
    })).readSoulPerson('p_me');
    expect(legacy.ok && legacy.profile.relations[0]!.counterpartName).toBe('张总');
  });

  it('keeps a 404 diagnosable', async () => {
    const fetchImpl = (async () => new Response('{"code":404,"message":"person_not_found"}', { status: 404 })) as unknown as typeof fetch;
    await expect(createClient(fetchImpl).readSoulPerson('p_missing'))
      .resolves.toEqual({ ok: false, status: 404, reason: 'HTTP 404' });
  });
});
