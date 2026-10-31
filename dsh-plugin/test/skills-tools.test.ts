import { describe, expect, it, vi } from 'vitest';
import { normalizeConfig } from '../src/config.js';
import type { SkillClient } from '../src/skill-client.js';
import { buildSkillTools, WRITE_TOOL_NAMES } from '../src/tools/skills.js';
// Importing the barrel is what registers the modules; `index.ts` does the same.
import { enabledToolModules, toolModules } from '../src/tools/index.js';
import { assertObjectJsonSchema } from './fixtures/host-json-schema/json-schema.js';

/**
 * The skill surface as model tools. Two things are pinned here:
 *
 *  1. the host's registration subset — an optional property must OMIT
 *     `required`, otherwise the whole tool is dropped with UNSUPPORTED_SCHEMA;
 *  2. the read/write split — the six mutating tools only ship when the operator
 *     turned `skill.allowLlmWrite` on, because they edit shared team state.
 */

const config = (patch: Record<string, unknown> = {}) => normalizeConfig(patch).config;

function fakeSkillClient(overrides: Record<string, unknown> = {}): SkillClient {
  const base: Record<string, unknown> = {
    listing: vi.fn(async () => ({ ok: true })),
    search: vi.fn(async () => ({ ok: true, data: [] })),
    get: vi.fn(async () => ({ ok: true, data: {} })),
    getByName: vi.fn(async () => ({ ok: true, data: {} })),
    filesRead: vi.fn(async () => ({ ok: true, data: { path: 'a', content: 'x' } })),
    forceArchive: vi.fn(async () => ({ ok: true, data: { status: 'archived' } })),
    create: vi.fn(async () => ({ ok: true, data: {} })),
    update: vi.fn(async () => ({ ok: true, data: {} })),
    patch: vi.fn(async () => ({ ok: true, data: {} })),
    delete: vi.fn(async () => ({ ok: true, data: {} })),
    filesWrite: vi.fn(async () => ({ ok: true, data: {} })),
    filesRemove: vi.fn(async () => ({ ok: true, data: {} })),
  };
  return { ...base, ...overrides } as unknown as SkillClient;
}

const limits = { searchTopK: 10, maxResultChars: 20000 };

function tools(client: SkillClient) {
  return buildSkillTools({ client, config: limits });
}

function byName(list: Array<{ name: string }>, name: string): any {
  const found = list.find((tool) => tool.name === name);
  if (found === undefined) throw new Error('tool not built: ' + name);
  return found;
}

describe('skill tool schemas', () => {
  it('passes the host JSON Schema subset it enforces before registration', () => {
    for (const tool of tools(fakeSkillClient())) {
      expect(() => assertObjectJsonSchema((tool as any).parameters), tool.name).not.toThrow();
    }
  });

  it('leaves optional properties without a required key (required:false drops the tool)', () => {
    const search = byName(tools(fakeSkillClient()), 'skill_search');
    expect(search.parameters.required).toEqual(['query']);
    expect(Object.hasOwn(search.parameters.properties.top_k, 'required')).toBe(false);
  });
});

describe('skill module gating', () => {
  it('builds only the four read tools when allowLlmWrite is off', () => {
    const module = toolModules().find((entry) => entry.name === 'skills')!;
    const built = module.build({ skillClient: fakeSkillClient(), config: config() } as any);
    expect(built.map((tool) => tool.name)).toEqual(['skill_search', 'skill_view', 'skill_files_read', 'skill_extract']);
    for (const write of WRITE_TOOL_NAMES) expect(built.map((tool) => tool.name)).not.toContain(write);
  });

  it('adds the six write tools when allowLlmWrite is on', () => {
    const module = toolModules().find((entry) => entry.name === 'skills')!;
    const built = module.build({
      skillClient: fakeSkillClient(),
      config: config({ skill: { allowLlmWrite: true } }),
    } as any);
    expect(built).toHaveLength(10);
    for (const write of WRITE_TOOL_NAMES) expect(built.map((tool) => tool.name)).toContain(write);
  });

  it('follows skill.enabled and needs a client to build anything', () => {
    const module = toolModules().find((entry) => entry.name === 'skills')!;
    expect(module.enabled(config())).toBe(true);
    expect(module.enabled(config({ skill: { enabled: false } }))).toBe(false);
    expect(enabledToolModules(config({ skill: { enabled: false } })).map((entry) => entry.name)).not.toContain('skills');
    // No client (the skill surface never wired) → no tools, no network.
    expect(module.build({ config: config() } as any)).toEqual([]);
  });
});

describe('skill_search', () => {
  it('renders one line per hit with id, version, score and a clamped snippet', async () => {
    const client = fakeSkillClient({
      search: vi.fn(async () => ({
        ok: true,
        data: [{ skill_id: 'skl-1', name: 'ncc-ct-to-order', version: 3, score: 12.876, snippet: 'line   numbers in orders' }],
      })),
    });
    const output = await byName(tools(client), 'skill_search').execute({ query: '采购订单 行号' });
    expect(output).toContain('ncc-ct-to-order [skl-1 v3] score=12.88');
    expect(output).toContain('line numbers in orders');
    expect((client.search as any).mock.calls[0]).toEqual(['采购订单 行号', 10]);
  });

  it('reports the core error verbatim with its business code', async () => {
    const client = fakeSkillClient({
      search: vi.fn(async () => ({ ok: false, code: 40001, error: 'SKILL_SCHEMA_INVALID: bad' })),
    });
    expect(await byName(tools(client), 'skill_search').execute({ query: 'x' }))
      .toBe('skill_search failed (code 40001): SKILL_SCHEMA_INVALID: bad');
  });

  it('refuses an empty query without a request', async () => {
    const client = fakeSkillClient();
    expect(await byName(tools(client), 'skill_search').execute({ query: '  ' })).toBe('skill_search failed: empty query');
    expect(client.search).not.toHaveBeenCalled();
  });
});

describe('skill_view', () => {
  it('reads by name when no id is given and keeps the header', async () => {
    const client = fakeSkillClient({
      getByName: vi.fn(async () => ({ ok: true, data: { skill_id: 'skl-9', name: 'proc', version: 2, content: 'BODY' } })),
    });
    const output = await byName(tools(client), 'skill_view').execute({ name: 'proc' });
    expect(output).toContain('proc [skl-9 v2]');
    expect(output).toContain('BODY');
    expect((client.getByName as any).mock.calls[0][0]).toBe('proc');
  });

  it('truncates a long body at maxResultChars and says how to get the rest', async () => {
    const client = fakeSkillClient({
      get: vi.fn(async () => ({ ok: true, data: { skill_id: 'skl-1', name: 'big', content: 'x'.repeat(5000) } })),
    });
    const narrow = buildSkillTools({ client, config: { searchTopK: 10, maxResultChars: 1000 } });
    const output = await byName(narrow, 'skill_view').execute({ skill_id: 'skl-1' });
    expect(output.length).toBe(1000);
    // Both numbers must be visible: how much was shown and how much existed.
    expect(output).toContain('[truncated: showing 1000 of ');
    expect(output).toContain('chars; call skill_files_read');
  });
});

describe('skill_files_read', () => {
  it('prints the path, the size and the content', async () => {
    const client = fakeSkillClient({
      filesRead: vi.fn(async () => ({ ok: true, data: { path: 'scripts/a.mts', content: 'hello', size_bytes: 5 } })),
    });
    const output = await byName(tools(client), 'skill_files_read').execute({ skill_id: 'skl-1', path: 'scripts/a.mts' });
    expect(output).toBe('scripts/a.mts (5 bytes)' + String.fromCharCode(10) + String.fromCharCode(10) + 'hello');
    expect((client.filesRead as any).mock.calls[0]).toEqual(['skl-1', 'scripts/a.mts', { encoding: 'utf-8', version: undefined }]);
  });
});

describe('write tools', () => {
  it('create forwards name, content and resources', async () => {
    const client = fakeSkillClient({
      create: vi.fn(async () => ({ ok: true, data: { skill_id: 'skl-new', name: 'probe', version: 1 } })),
    });
    const output = await byName(tools(client), 'skill_create').execute({
      name: 'probe',
      content: 'BODY',
      resources: [{ path: 'a.txt', content: 'x' }],
    });
    expect(output).toContain('probe [skl-new v1]');
    expect((client.create as any).mock.calls[0][0]).toEqual({ name: 'probe', content: 'BODY', resources: [{ path: 'a.txt', content: 'x' }] });
  });

  it('delete takes a skill_id and reports the summary', async () => {
    const client = fakeSkillClient({
      delete: vi.fn(async () => ({ ok: true, data: { skill_id: 'skl-1', name: 'old', version: 4, status: 'archived' } })),
    });
    const output = await byName(tools(client), 'skill_delete').execute({ skill_id: 'skl-1' });
    expect(output).toContain('old [skl-1 v4]');
    expect((client.delete as any).mock.calls[0]).toEqual(['skl-1']);
  });
});

describe('skill_extract', () => {
  it('needs a session id before it talks to the core', async () => {
    const client = fakeSkillClient();
    expect(await byName(tools(client), 'skill_extract').execute({}))
      .toBe('skill_extract failed: no active session');
    expect(client.forceArchive).not.toHaveBeenCalled();
  });
});
