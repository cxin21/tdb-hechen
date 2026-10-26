/**
 * T5（用户 2026-09-22 拍板定案）：召回/灵魂注入日志 BFF 直读测试。
 * POST /api/v1/chat-memory/recall-journal → 直读 <dir>/recall-journal-{team}-{agent}.jsonl(+轮转)，
 * 分页倒序 + 租户过滤；构造方式照抄 tests/chat-memory-path.test.ts（不触达真实网关）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PanelDeps } from '../src/panel/panel-deps.js';
import { registerChatMemoryRoutes } from '../src/panel/http/routes/chat-memory.js';

interface InvokeEnvelope { code: number; message: string; request_id: string; data: unknown }
function okEnvelope(data: unknown): InvokeEnvelope {
  return { code: 0, message: 'ok', request_id: 'test-req', data };
}

function makeDeps(callerUserId?: string): { deps: PanelDeps } {
  const uid = callerUserId === undefined ? 'u1' : callerUserId;
  const deps = {
    config: { knowledge: { baseUrl: 'http://ks-test:1', authToken: 'ks-tok', timeoutMs: 1000 }, metadataRemoteTimeoutMs: 1000 },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    instanceRegistry: { resolve: () => ({ instance_id: 'inst-1', gateway_endpoint: 'http://core-test:2', api_key: 'core-key' }) },
    metaKernel: {
      invoke: vi.fn(async (action: string): Promise<InvokeEnvelope> => {
        if (action === 'auth/verify') return okEnvelope({ valid: true, user: { user_id: uid, user_type: 'member' } });
        return okEnvelope(null);
      }),
    },
    kernelHttp: { postEnvelope: vi.fn() },
    ingestProgressStore: { get: () => null },
  } as unknown as PanelDeps;
  return { deps };
}

afterEach(() => { vi.restoreAllMocks(); delete process.env.TDAI_RECALL_JOURNAL_DIR; delete process.env.TDAI_DATA_DIR; });

function writeJournal(dir: string, team: string, agent: string, entries: string): void {
  const name = `recall-journal-${encodeURIComponent(team)}-${encodeURIComponent(agent)}.jsonl`;
  writeFileSync(path.join(dir, name), entries, 'utf8');
}

/** skip 行样本（writer 侧 #74 双留痕：query 恒空、rawQuery 留原文）。 */
const S = (ts: string, rawQuery: string, team = 't1', agent = 'agt-a') =>
  JSON.stringify({ ts, query: '', strategy: 'scaffold-skip', teamId: team, agentId: agent, sessionReused: false, layered: false, conclusionCount: 0, experienceCount: 0, searchTiming: { ftsMs: 0, embeddingMs: 0, ftsHits: 0, embeddingHits: 0 }, skipReason: 'scaffold-query', rawQuery, rawLen: rawQuery.length, rawHash8: 'deadbeef', residualChars: 0, memoryLines: [] });

const E = (ts: string, query: string, team = 't1', agent = 'agt-a') =>
  JSON.stringify({ ts, query, strategy: 'hybrid', teamId: team, agentId: agent, sessionReused: false, layered: true, conclusionCount: 1, experienceCount: 2, searchTiming: { ftsMs: 1, embeddingMs: 1, ftsHits: 1, embeddingHits: 1 }, memoryLines: ['x'] });

async function call(deps: PanelDeps, body: unknown): Promise<Response> {
  const app = new Hono();
  const api = new Hono();
  registerChatMemoryRoutes(api, deps);
  app.route('/api/v1', api);
  return app.request('/api/v1/chat-memory/recall-journal', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tdai-service-id': 'inst-1', 'x-tdai-user-key': 'uk-1' },
    body: JSON.stringify(body),
  });
}

describe('T5: POST /chat-memory/recall-journal（BFF 直读）', () => {
  it('倒序+分页+has_more', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rjb-'));
    writeJournal(dir, 't1', 'agt-a', [E('2026-09-22T00:03:00Z', 'q3'), E('2026-09-22T00:02:00Z', 'q2'), E('2026-09-22T00:01:00Z', 'q1')].join('\n') + '\n');
    process.env.TDAI_RECALL_JOURNAL_DIR = dir;
    const { deps } = makeDeps();
    const res = await call(deps, { team_id: 't1', agent_id: 'agt-a', page: 1, page_size: 2 });
    const j = (await res.json()) as { code: number; data: { items: Array<{ query: string }>; total: number; has_more: boolean } };
    expect(j.code).toBe(0);
    expect(j.data.items.map((x) => x.query)).toEqual(['q3', 'q2']);
    expect(j.data.total).toBe(3);
    expect(j.data.has_more).toBe(true);
  });

  it('租户过滤：他租户条目不返回', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rjb-'));
    writeJournal(dir, 't1', 'agt-a', [E('2026-09-22T00:03:00Z', 'mine'), E('2026-09-22T00:04:00Z', 'other', 't2')].join('\n'));
    process.env.TDAI_RECALL_JOURNAL_DIR = dir;
    const { deps } = makeDeps();
    const res = await call(deps, { team_id: 't1', agent_id: 'agt-a' });
    const j = (await res.json()) as { data: { items: Array<{ query: string }>; total: number } };
    expect(j.data.total).toBe(1);
    expect(j.data.items[0]!.query).toBe('mine');
  });

  it('目录缺失 → 空结果不报错', async () => {
    process.env.TDAI_RECALL_JOURNAL_DIR = path.join(tmpdir(), 'rj-nonexistent-zz');
    const { deps } = makeDeps();
    const res = await call(deps, { team_id: 't1', agent_id: 'agt-a' });
    const j = (await res.json()) as { code: number; data: { items: unknown[] } };
    expect(j.code).toBe(0);
    expect(j.data.items).toEqual([]);
  });

  it('缺租户参数 → 400；坏 key → 401', async () => {
    const { deps } = makeDeps();
    const res2 = await call(deps, { team_id: 't1' });
    expect(((await res2.json()) as { code: number }).code).toBe(400);
    const { deps: deps2 } = makeDeps('');
    const res3 = await call(deps2, { team_id: 't1', agent_id: 'agt-a' });
    expect(((await res3.json()) as { code: number }).code).toBe(401);
  });

  // ── 同源解析合同（用户 2026-10-14 拍板：同源修、不硬编码）──
  it('TDAI_RECALL_JOURNAL_DIR 显式覆盖优先于 TDAI_DATA_DIR 派生', async () => {
    const explicitDir = mkdtempSync(path.join(tmpdir(), 'rj-explicit-'));
    const dataDir = mkdtempSync(path.join(tmpdir(), 'rj-datadir-'));
    const derivedDir = path.join(dataDir, 'logs', 'recall');
    mkdirSync(derivedDir, { recursive: true });
    writeJournal(explicitDir, 't1', 'agt-a', E('2026-10-14T00:00:00Z', 'from-explicit'));
    writeJournal(derivedDir, 't1', 'agt-a', E('2026-10-14T00:00:00Z', 'from-derived'));
    process.env.TDAI_DATA_DIR = dataDir;
    process.env.TDAI_RECALL_JOURNAL_DIR = explicitDir;
    const { deps } = makeDeps();
    const res = await call(deps, { team_id: 't1', agent_id: 'agt-a' });
    const j = (await res.json()) as { data: { items: Array<{ query: string }> } };
    expect(j.data.items.map((x) => x.query)).toEqual(['from-explicit']);
  });

  it('无显式 env：TDAI_DATA_DIR 派生 <dataDir>/logs/recall（与 core writer 同源）', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'rj-datadir2-'));
    const derivedDir = path.join(dataDir, 'logs', 'recall');
    mkdirSync(derivedDir, { recursive: true });
    writeJournal(derivedDir, 't1', 'agt-a', E('2026-10-14T00:00:00Z', 'from-datadir'));
    process.env.TDAI_DATA_DIR = dataDir;
    const { deps } = makeDeps();
    const res = await call(deps, { team_id: 't1', agent_id: 'agt-a' });
    const j = (await res.json()) as { data: { items: Array<{ query: string }> } };
    expect(j.data.items.map((x) => x.query)).toEqual(['from-datadir']);
  });

  // ── filter（2026-10-26 拍板 A：skip 行不再混进真实召回列表）──
  it('filter=recall 排除 skip 行；counts 三口径齐全', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rj-filter-'));
    writeJournal(dir, 't1', 'agt-a', [S('2026-10-26T13:00:00Z', 'Time sampled while preparing turn 1'), E('2026-10-26T13:00:10Z', 'q-real')].join('\n') + '\n');
    process.env.TDAI_RECALL_JOURNAL_DIR = dir;
    const { deps } = makeDeps();
    const res = await call(deps, { team_id: 't1', agent_id: 'agt-a', filter: 'recall' });
    const j = (await res.json()) as {
      data: { items: Array<{ query: string }>; total: number; filter: string; counts: { all: number; recall: number; skipped: number } };
    };
    expect(j.data.items.map((x) => x.query)).toEqual(['q-real']);
    expect(j.data.total).toBe(1);
    expect(j.data.filter).toBe('recall');
    expect(j.data.counts).toEqual({ all: 2, recall: 1, skipped: 1 });
  });

  it('filter=skipped 只回 skip 行，且分页按过滤后总量算', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rj-filter2-'));
    writeJournal(dir, 't1', 'agt-a', [
      S('2026-10-26T13:00:00Z', 'scaffold-a'),
      E('2026-10-26T13:00:10Z', 'q-real'),
      S('2026-10-26T13:00:20Z', 'scaffold-b'),
    ].join('\n') + '\n');
    process.env.TDAI_RECALL_JOURNAL_DIR = dir;
    const { deps } = makeDeps();
    const res = await call(deps, { team_id: 't1', agent_id: 'agt-a', filter: 'skipped', page: 1, page_size: 5 });
    const j = (await res.json()) as { data: { items: Array<{ rawQuery?: string }>; total: number; has_more: boolean } };
    expect(j.data.items.map((x) => x.rawQuery)).toEqual(['scaffold-b', 'scaffold-a']);
    expect(j.data.total).toBe(2);
    expect(j.data.has_more).toBe(false);
  });

  it('非法/缺省 filter → all（向后兼容旧调用方）', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rj-filter3-'));
    writeJournal(dir, 't1', 'agt-a', [S('2026-10-26T13:00:00Z', 'scaffold-a'), E('2026-10-26T13:00:10Z', 'q-real')].join('\n') + '\n');
    process.env.TDAI_RECALL_JOURNAL_DIR = dir;
    const { deps } = makeDeps();
    const res = await call(deps, { team_id: 't1', agent_id: 'agt-a', filter: 'bogus' });
    const j = (await res.json()) as { data: { total: number; filter: string } };
    expect(j.data.total).toBe(2);
    expect(j.data.filter).toBe('all');
  });

  it('TDAI_DATA_DIR 亦缺失 → 503 loud（不再静默读空/猜路径）', async () => {
    delete process.env.TDAI_DATA_DIR;
    delete process.env.TDAI_RECALL_JOURNAL_DIR;
    const { deps } = makeDeps();
    const res = await call(deps, { team_id: 't1', agent_id: 'agt-a' });
    const j = (await res.json()) as { code: number; message: string };
    expect(j.code).toBe(503);
    expect(j.message).toContain('RECALL_JOURNAL_DIR_UNRESOLVED');
  });
});
