import { describe, expect, it, vi } from 'vitest';
import { SkillClient, type SkillCallResult } from '../src/skill-client.js';

const LF = String.fromCharCode(10);

interface Call {
  path: string;
  body: Record<string, unknown>;
}

/**
 * Scripted transport. The real v3 seam is MemoryClient.call (already covered by
 * memory-client.test.ts and turn-pipeline.integration.test.ts), so these tests
 * pin the CONTRACT the skill surface adds on top: which route, which body, and
 * above all the read-modify-write that keeps `expected_version` out of the
 * model's hands.
 */
function scriptedTransport(responses: Array<(body: Record<string, unknown>) => SkillCallResult<unknown> | undefined>) {
  const calls: Call[] = [];
  const call = async <T,>(path: string, body: Record<string, unknown>): Promise<SkillCallResult<T>> => {
    calls.push({ path, body });
    for (const respond of responses) {
      const result = respond(body);
      if (result !== undefined) return result as SkillCallResult<T>;
    }
    return { ok: true, data: {} as T };
  };
  return { calls, client: new SkillClient({ call, timeoutMs: 2500 }) };
}

const RECORD = {
  skill_id: 'skl-1',
  name: 'ct-to-order',
  description: '采购订单转单',
  version: 3,
  is_head: true,
  status: 'active',
};

describe('SkillClient reads', () => {
  it('asks for the listing with an explicit char budget and keeps the rendered string verbatim', async () => {
    const listing = '<available_skills>' + LF + '- ct-to-order' + LF + '</available_skills>';
    const { calls, client } = scriptedTransport([
      () => ({ ok: true, data: { listing, hits: [{ skill_id: 'skl-1', version: 3, name: 'ct-to-order' }], listing_len: listing.length, truncated: false } }),
    ]);

    const outcome = await client.listing(6000);

    expect(outcome.ok).toBe(true);
    // Verbatim: core renders the block (`<available_skills>` …) and the plugin
    // must not re-join it from hits — that is how parity was lost before.
    expect(outcome.data?.listing).toBe(listing);
    expect(outcome.data?.truncated).toBe(false);
    expect(calls[0]?.path).toBe('/v3/skill/listing');
    expect(calls[0]?.body).toMatchObject({ char_budget: 6000 });
  });

  it('clamps search top_k into the schema range and omits it when unset', async () => {
    const { calls, client } = scriptedTransport([
      () => ({ ok: true, data: { items: [{ ...RECORD, score: 12.88, snippet: '行号补全' }] } }),
    ]);

    const outcome = await client.search('采购订单 行号');
    await client.search('  第二个问题  ', 999);
    await client.search('第三个问题', 0);

    expect(outcome.data?.[0]?.score).toBe(12.88);
    // Unset means "let the core decide"; a value is clamped to 1..50 and the
    // query is trimmed (the schema rejects an all-space query).
    expect(calls[0]?.body).toEqual({ query: '采购订单 行号' });
    expect(calls[1]?.body).toEqual({ query: '第二个问题', top_k: 50 });
    expect(calls[2]?.body).toEqual({ query: '第三个问题', top_k: 1 });
  });

  it('reads a skill by name without asking for the body when the caller does not need it', async () => {
    const { calls, client } = scriptedTransport([() => ({ ok: true, data: RECORD })]);

    const outcome = await client.getByName('ct-to-order', { includeContent: false });

    expect(outcome.ok).toBe(true);
    expect(calls[0]?.path).toBe('/v3/skill/get-by-name');
    expect(calls[0]?.body).toMatchObject({ skill_name: 'ct-to-order', include_content: false });
  });

  it('reads one attached file through files/read', async () => {
    const { calls, client } = scriptedTransport([
      () => ({ ok: true, data: { path: 'overlap-snapshot.mts', content: 'export {};', encoding: 'utf-8', size_bytes: 10, version: 3 } }),
    ]);

    const outcome = await client.filesRead('skl-1', 'overlap-snapshot.mts');

    expect(outcome.data).toMatchObject({ path: 'overlap-snapshot.mts', content: 'export {};', size_bytes: 10 });
    expect(calls[0]?.path).toBe('/v3/skill/files/read');
    // Encoding only travels when asked for: the schema's own default is utf-8.
    expect(calls[0]?.body).toEqual({ skill_id: 'skl-1', path: 'overlap-snapshot.mts' });
    await client.filesRead('skl-1', 'bin.dat', { encoding: 'base64' });
    expect(calls[1]?.body).toEqual({ skill_id: 'skl-1', path: 'bin.dat', encoding: 'base64' });
  });
});

describe('SkillClient writes are model-transparent (read-modify-write)', () => {
  it('reads the head version, then updates with expected_version — no version from the model', async () => {
    const { calls, client } = scriptedTransport([
      (body) => ('include_content' in body ? { ok: true, data: RECORD } : undefined),
      () => ({ ok: true, data: { ...RECORD, version: 4 } }),
    ]);

    const outcome = await client.update('skl-1', 'new body');

    expect(outcome.ok).toBe(true);
    expect(calls.map((entry) => entry.path)).toEqual(['/v3/skill/get', '/v3/skill/update']);
    expect(calls[0]?.body).toMatchObject({ skill_id: 'skl-1', include_content: false, include_manifest: false });
    expect(calls[1]?.body).toMatchObject({ skill_id: 'skl-1', content: 'new body', expected_version: 3 });
  });

  it('re-reads once after 40901 and retries with the fresh version', async () => {
    let versionReads = 0;
    let patches = 0;
    const { calls, client } = scriptedTransport([
      (body) => {
        if ('include_content' in body) {
          versionReads += 1;
          return { ok: true, data: { ...RECORD, version: versionReads === 1 ? 3 : 4 } };
        }
        return undefined;
      },
      () => {
        patches += 1;
        // First write loses the race with another writer, second one wins.
        return patches === 1
          ? { ok: false, code: 40901, message: 'SKILL_VERSION_STALE' }
          : { ok: true, data: { ...RECORD, version: 5 } };
      },
    ]);

    const outcome = await client.patch('skl-1', 'old', 'new');

    expect(outcome.ok).toBe(true);
    expect(calls.map((entry) => entry.path)).toEqual([
      '/v3/skill/get',
      '/v3/skill/patch',
      '/v3/skill/get',
      '/v3/skill/patch',
    ]);
    const patchBodies = calls.filter((entry) => entry.path === '/v3/skill/patch').map((entry) => entry.body);
    expect(patchBodies[0]).toMatchObject({ expected_version: 3 });
    expect(patchBodies[1]).toMatchObject({ expected_version: 4 });
  });

  it('gives up after ONE retry and returns the core\'s own words for the second stale answer', async () => {
    const { calls, client } = scriptedTransport([
      (body) => ('include_content' in body ? { ok: true, data: RECORD } : { ok: false, code: 40901, message: 'SKILL_VERSION_STALE' }),
    ]);

    const outcome = await client.delete('skl-1');

    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe(40901);
    expect(outcome.error).toBe('SKILL_VERSION_STALE');
    // Two reads, two writes: never an unbounded retry loop on a hot skill.
    expect(calls).toHaveLength(4);
  });

  it('creates without any version read', async () => {
    const { calls, client } = scriptedTransport([() => ({ ok: true, data: { ...RECORD, version: 1 } })]);

    const outcome = await client.create({ name: 'probe', content: 'body', metadata: { description: 'd' } });

    expect(outcome.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe('/v3/skill/create');
    expect(calls[0]?.body).toMatchObject({ name: 'probe', content: 'body', metadata: { description: 'd' } });
  });

  it('writes and removes files with the same version handshake', async () => {
    const { calls, client } = scriptedTransport([(body) => ('include_content' in body ? { ok: true, data: RECORD } : { ok: true, data: { ...RECORD, version: 4 } })]);

    await client.filesWrite('skl-1', [{ path: 'a.mts', content: 'x' }]);
    await client.filesRemove('skl-1', ['a.mts']);

    expect(calls.map((entry) => entry.path)).toEqual([
      '/v3/skill/get',
      '/v3/skill/files/write',
      '/v3/skill/get',
      '/v3/skill/files/remove',
    ]);
    expect(calls[1]?.body).toMatchObject({ skill_id: 'skl-1', expected_version: 3 });
    expect(calls[1]?.body).toMatchObject({ files: [{ path: 'a.mts', content: 'x' }] });
    expect(calls[3]?.body).toMatchObject({ paths: ['a.mts'], expected_version: 3 });
  });
});

describe('SkillClient failure normalization', () => {
  it('surfaces a transport failure as the reason, never as a throw', async () => {
    const call = async () => ({ ok: false, reason: 'timeout after 2500ms' });
    const client = new SkillClient({ call, timeoutMs: 2500 });

    const outcome = await client.search('x');

    expect(outcome).toEqual({ ok: false, error: 'timeout after 2500ms', code: undefined, status: undefined });
  });

  it('prefers the core\'s message over the transport reason', async () => {
    const call = async () => ({ ok: false, status: 200, code: 40001, message: 'skill_id: Required', reason: 'rejected' });
    const client = new SkillClient({ call, timeoutMs: 2500 });

    const outcome = await client.create({ name: 'x', content: 'y' });

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe('skill_id: Required');
    expect(outcome.code).toBe(40001);
  });

  it('never writes when the version read itself failed', async () => {
    const { calls, client } = scriptedTransport([() => ({ ok: false, status: 404, code: 40401, message: 'SKILL_NOT_FOUND' })]);

    const outcome = await client.update('missing', 'body');

    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe(40401);
    // A missing skill must not turn into a blind write against version 0.
    expect(calls.map((entry) => entry.path)).toEqual(['/v3/skill/get']);
  });

  it('archives the skill buffer through force-archive and reports the task id', async () => {
    const { calls, client } = scriptedTransport([() => ({ ok: true, data: { status: 'queued', task_id: 'tsk-9' } })]);

    const outcome = await client.forceArchive('ses-1', 'too many skills pending');

    expect(outcome.data).toMatchObject({ status: 'queued', task_id: 'tsk-9' });
    expect(calls[0]?.path).toBe('/v3/skill/conversation/force-archive');
    expect(calls[0]?.body).toMatchObject({ session_id: 'ses-1', reason: 'too many skills pending' });
  });
});
