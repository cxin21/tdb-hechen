import { describe, expect, it, vi } from 'vitest';
import { defaultServiceTable, findServiceSpec, SERVICE_NAMES } from '../src/services/service-table.js';
import { probeHealth, waitHealthy } from '../src/services/health.js';

describe('service table', () => {
  it('is the three-service stack, in start order, under the given repo root', () => {
    const table = defaultServiceTable({ repoRoot: 'D:/TDB/td-agemem' });
    expect(table.map((spec) => spec.name)).toEqual([...SERVICE_NAMES]);
    expect(table.map((spec) => spec.port)).toEqual([8420, 8421, 8123]);
    expect(table[0]!.dir).toBe('D:/TDB/td-agemem\\MemoryCore');
    expect(table[0]!.args).toEqual(['--import', 'tsx', 'src/gateway/server.ts']);
    expect(table[1]!.dir).toBe('D:/TDB/td-agemem\\MemoryKnowledge');
    expect(table[2]!.dir).toBe('D:/TDB/td-agemem\\MemoryPanel');
  });

  it('never carries the retired proxy row', () => {
    // The whole reason this table moved into the plugin: the running keeper held
    // stale four-service state and kept respawning tdai-proxy after it was deleted.
    const table = defaultServiceTable({ repoRoot: 'D:/TDB/td-agemem' });
    expect(table.some((spec) => spec.name.includes('proxy'))).toBe(false);
    expect(table.some((spec) => spec.port === 8096)).toBe(false);
  });

  it('honours a port override and ignores a nonsensical one', () => {
    const table = defaultServiceTable({
      repoRoot: 'D:/TDB/td-agemem',
      ports: { 'tdai-core': 9420, 'tdai-panel': 0 },
    });
    expect(table[0]!.port).toBe(9420);
    // 0/negative is a typo, not "disable this service": keep the built-in port.
    expect(table[2]!.port).toBe(8123);
  });

  it('tolerates a trailing separator on the repo root', () => {
    const table = defaultServiceTable({ repoRoot: 'D:/TDB/td-agemem/' });
    expect(table[0]!.dir).toBe('D:/TDB/td-agemem\\MemoryCore');
  });

  it('looks a spec up by name, and returns undefined for a stranger', () => {
    const table = defaultServiceTable({ repoRoot: 'D:/r' });
    expect(findServiceSpec(table, 'tdai-knowledge')?.port).toBe(8421);
    expect(findServiceSpec(table, 'tdai-proxy')).toBeUndefined();
  });
});

describe('health gate', () => {
  it('treats 200 as healthy and reads the body so the socket closes', async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    const fetchImpl = vi.fn(async () => ({ status: 200, arrayBuffer })) as unknown as typeof fetch;
    await expect(probeHealth(8420, { fetchImpl })).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:8420/health', expect.objectContaining({ method: 'GET' }));
    expect(arrayBuffer).toHaveBeenCalled();
  });

  it('treats a non-200 (warm-up 503) or a transport error as not healthy', async () => {
    const notReady = vi.fn(async () => ({ status: 503, arrayBuffer: async () => new ArrayBuffer(0) })) as unknown as typeof fetch;
    await expect(probeHealth(8420, { fetchImpl: notReady })).resolves.toBe(false);
    const refused = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    await expect(probeHealth(8420, { fetchImpl: refused })).resolves.toBe(false);
  });

  it('polls until healthy and reports how long it took', async () => {
    let clock = 0;
    const attempts: boolean[] = [false, false, true];
    const result = await waitHealthy(8420, {
      budgetMs: 10_000,
      intervalMs: 1_000,
      probe: async () => attempts.shift() ?? false,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    expect(result).toEqual({ ok: true, attempts: 3, elapsedMs: 2000 });
  });

  it('gives up when the next attempt would overshoot the budget', async () => {
    let clock = 0;
    const probe = vi.fn(async () => false);
    const result = await waitHealthy(8420, {
      budgetMs: 5_000,
      intervalMs: 1_000,
      probe,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    expect(result.ok).toBe(false);
    // t=0,1000,…,5000: the probe at 5000 is the last one whose *next* attempt
    // would overshoot the 5000ms budget, so the budget is used exactly once.
    expect(result.attempts).toBe(6);
    expect(result.elapsedMs).toBe(5_000);
    // A zero/negative budget still probes once: "no budget" must not mean "never check".
    const zero = await waitHealthy(8420, { budgetMs: 0, intervalMs: 1_000, probe, now: () => clock, sleep: async () => {} });
    expect(zero.attempts).toBe(1);
  });
});