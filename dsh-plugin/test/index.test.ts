import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apply, composeHeadPack, inject, name, personaBindTarget, unboundIdentityMessage } from '../src/index.js';
import { ATOMIC_ITEMS, PERSONA, SCENARIO_ENTRIES, callsTo, coreFixture, envelope } from './helpers/core-fixtures.js';
import { createFakeContext, runPreStep, type FakeContext } from './helpers/fake-ctx.js';
import { toolMessage, userMessage } from './helpers/messages.js';
import { VOLATILE_SOURCE_KIND } from '../src/volatile.js';
import {
  PERSONA_ANCHOR_SECTION_NAME,
  PERSONA_IDENTITY_SECTION_NAME,
  PERSONA_TURN_MAX_CHARS,
} from '../src/persona-card.js';
import { VOLATILE_HEADER } from '../src/recall-source.js';
import { createHash } from 'node:crypto';

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
import { resetSkillsSegmentHealthForTests } from '../src/segments/skills.js';


// The skill listing has a process-wide circuit breaker (task-98): a case that
// makes `/v3/skill/listing` fail three times would otherwise leave the next
// case with a skipped segment instead of the failure it is asserting on.
beforeEach(() => resetSkillsSegmentHealthForTests());

const tempDirs: string[] = [];
const LF = String.fromCharCode(10);

function tempOutbox(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'agemem-test-'));
  tempDirs.push(dir);
  return path.join(dir, 'outbox.jsonl');
}

/** Dead-letter rows, structured and free of conversation content. */
function readDead(outboxPath: string): any[] {
  const deadPath = outboxPath.replace(/\.jsonl$/, '.dead.jsonl');
  let raw = '';
  try {
    raw = readFileSync(deadPath, 'utf8');
  } catch {
    return [];
  }
  return raw.trim().split(String.fromCharCode(10)).filter((line) => line !== '').map((line) => JSON.parse(line));
}

function installFetch(options?: Parameters<typeof coreFixture>[0]) {
  const fixture = coreFixture(options);
  vi.stubGlobal('fetch', vi.fn(fixture.fetchImpl));
  return fixture;
}

const applied: FakeContext[] = [];


/** Test identity: the shipped defaults are empty on purpose (never the author's). */
const TEST_IDENTITY = { teamId: 'team-test', agentId: 'agt-test', userId: 'usr-test' };

async function startApp(config: Record<string, any> = {}, services?: Record<string, unknown>): Promise<FakeContext> {
  const { server, ...rest } = config;
  const fake = createFakeContext({ services });
  applied.push(fake);
  await apply(fake.ctx, {
    server: { ...TEST_IDENTITY, ...(server ?? {}) },
    writeback: { outboxPath: tempOutbox() },
    ...rest,
  });
  return fake;
}

/**
 * Drive an async mount to completion on a fake clock.
 *
 * Mount parks on real 25ms re-checks of sibling services the fake composition
 * never provides (src/index.ts:156 SEAM_WAIT_MS and :165 TOOLS_WAIT_MS, both
 * 800). Those two waits are product behaviour and stay untouched; here the
 * timers are merely advanced instead of slept through, so the same polling path
 * still runs and the clock is the only thing that changed. Returns the virtual
 * milliseconds consumed, which is itself asserted by the caller.
 */
async function settleOnFakeClock<T>(promise: Promise<T>, budgetMs = 5000, stepMs = 100): Promise<{ value: T; virtualMs: number }> {
  let settled = false;
  let value: T | undefined;
  let failure: unknown;
  promise.then(
    (settledValue) => { value = settledValue; settled = true; },
    (error: unknown) => { failure = error; settled = true; },
  );
  let virtualMs = 0;
  while (!settled && virtualMs < budgetMs) {
    await vi.advanceTimersByTimeAsync(stepMs);
    virtualMs += stepMs;
  }
  if (!settled) throw new Error('mount did not settle within ' + budgetMs + 'ms of virtual time');
  if (failure !== undefined) throw failure;
  return { value: value as T, virtualMs };
}

afterEach(() => {
  // Safety net: a test that throws mid-way must never leak fake timers into the
  // next one (vi.useRealTimers is idempotent).
  vi.useRealTimers();
  for (const fake of applied.splice(0)) {
    fake.emit('dispose');
    fake.dispose();
  }
  vi.unstubAllGlobals();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('plugin entry', () => {
  it('declares its name and only the required service', () => {
    expect(name).toBe('tdb-agemem-dsh');
    expect(inject).toEqual(['systemPrompt']);
  });

  it('registers the head-pack section after the deployment persona suffix', async () => {
    installFetch();
    const fake = await startApp();

    // task-15：答案口径段也是独立 section；S2 又加了人格卡段，故条数是 3（按 name 取，不依赖注册顺序）
    expect(fake.sections).toHaveLength(4); // P1-2: 口径 + head pack + identity + anchor
    const section = fake.sections.find((candidate) => candidate.name === 'tdb-agemem:head-pack')!;
    expect(section.name).toBe('tdb-agemem:head-pack');
    expect(section.order).toBe(10300);
    expect(section.interpolate).toBe(false);
    expect(typeof section.text).toBe('function');
    // Two listeners by design (task-117): the session-start identity picker runs
    // first, the volatile block second. One listener would mean the picker was
    // silently dropped (a card that never appears).
    expect(fake.listenerCount('agent/pre-step')).toBe(2);
    expect(fake.listenerCount('agent/turn-stopping')).toBe(1);
  });

  it('logs one ready line with the endpoint, key source and capabilities (no secrets)', async () => {
    installFetch();
    const fake = await startApp({ server: { apiKey: 'super-secret-key' } });

    const ready = fake.logs.filter((line) => line.includes('agemem: ready'));
    expect(ready).toHaveLength(1);
    const [line] = ready;
    expect(line.startsWith('info')).toBe(true);
    // Diagnosis without disclosure: endpoint, service, identity state, key
    // *source*, capability switches. Never a key value or an id.
    expect(line).toContain('endpoint=http://127.0.0.1:8420');
    expect(line).toContain('serviceId=default');
    expect(line).toContain('identity=configured');
    expect(line).toContain('keySource=config');
    expect(line).toContain('headPack=on');
    expect(line).toContain('volatile=recall');
    expect(line).toContain('writeback=on');
    expect(line).toContain('skillFeed=on');
    expect(line).toContain('debug=off');
    // Budgets print as raw milliseconds; rounding to seconds ('recallTimeout=2s')
    // hid exactly the value an operator tunes when the core is slow.
    expect(line).toContain('recallTimeout=2500ms');
    expect(line).toContain('volatileTimeout=3000ms');
    expect(line).toContain('headPackTimeout=10000ms');
    expect(line).toContain('requestTimeout=10000ms');
    expect(line).not.toMatch(/recallTimeout=\d+s/);
    expect(line).not.toContain('super-secret-key');
    expect(line).not.toContain('team-test');
    expect(line).not.toContain('usr-test');
    // Mount-time reachability: "mounted but the core is unreachable" and "no
    // memories matched" look identical everywhere else.
    expect(line).toContain('health=ok');
    // task-117: what the session-start picker did in this process. 'on' means
    // the card is armed; the off/inert forms are the boot-time readings an
    // operator compares an e2e run against.
    expect(line).toContain('sessionIdentity=on');
    // task-117: the settings-page loopback API is archived to
    // scratch/archive/identity-server.ts - the session popup replaced it, so no
    // port may appear in the ready line again.
    expect(line).not.toContain('identityApi=');
    expect(line).not.toContain('identityPort');
  });


  it('probes health exactly once at mount and reports a dead core in the ready line', async () => {
    const fixture = installFetch({
      fail: (path) => (path === '/health' ? new Response('down', { status: 503 }) : undefined),
    });
    const fake = await startApp();

    const line = fake.logs.find((entry) => entry.includes('agemem: ready'))!;
    expect(line).toContain('health=fail(no-answer)');
    // One shot, no polling loop: a cross-host outage must not turn into traffic.
    expect(callsTo(fixture.calls, '/health')).toHaveLength(1);
  });

  // The host hands every `.volatile()` field over as a cosmokit reference (the
  // Settings form writes through it), not as a plain value. `apply()` must unwrap
  // before validating: with a bare `normalizeConfig` the endpoint silently falls
  // back to the 8420 default and the config identity triple to empty — invisible
  // on a host whose defaults happen to work, fatal everywhere else.
  it('reads settings the host hands over as volatile references', async () => {
    const fixture = installFetch();
    const volatileRef = (value: unknown) => ({ [Symbol.for('cosmokit.volatile.write')]: true, get: () => value });
    await startApp({
      server: {
        baseUrl: volatileRef('http://127.0.0.1:19999'),
        teamId: volatileRef('team-vol'),
        agentId: volatileRef('agt-vol'),
        userId: volatileRef('usr-vol'),
      },
    });

    const health = callsTo(fixture.calls, '/health')[0];
    expect(health.url.startsWith('http://127.0.0.1:19999/')).toBe(true);
    expect(health.headers['x-tdai-team-id']).toBe('team-vol');
    expect(health.headers['x-tdai-agent-id']).toBe('agt-vol');
    expect(health.headers['x-tdai-user-id']).toBe('usr-vol');
  });
  it('reports a missing identity by field name only, and resolves the key source', async () => {
    installFetch();
    const resolve = vi.fn(async () => ({ value: 'from-store' }));
    const fake = await startApp({ server: { teamId: '' } }, { credentials: { resolve } });
    const line = fake.logs.find((entry) => entry.includes('agemem: ready'))!;
    expect(line).toContain('identity=missing(teamId)');
    expect(line).toContain('keySource=credentials:TDAI_GATEWAY_APIKEY');
    // Inert is not the same as unreachable: no probe is sent without an identity.
    expect(line).toContain('health=skipped(inert)');
    expect(line).not.toContain('from-store');
  });

  describe('identity from a user key (task-51)', () => {
    /** Serve the three metadata routes; everything else falls through to the v3 fixture. */
    function metaRoutes(routes: Record<string, unknown>, extra?: (path: string) => Response | undefined) {
      return (path: string) => {
        const key = Object.keys(routes).find((suffix) => path.endsWith(suffix));
        return key === undefined ? extra?.(path) : envelope(routes[key]);
      };
    }

    const RESOLVED = {
      '/v3/meta/auth/verify': { valid: true, user: { user_id: 'usr-key', username: 'alice' } },
      '/v3/meta/team/list': { items: [{ team_id: 'team-key', name: 'Alpha' }], total: 1 },
      '/v3/meta/agent/list': { items: [{ agent_id: 'agt-key', team_id: 'team-key', name: 'Main' }], total: 1 },
    };

    it('resolves the triple at mount and uses it on every data call', async () => {
      const fixture = installFetch({ fail: metaRoutes(RESOLVED) });
      const fake = await startApp({ server: { teamId: '', agentId: '', userId: '', userKey: 'user-key-abc' } });

      const ready = fake.logs.find((line) => line.includes('agemem: ready'))!;
      expect(ready).toContain('identity=resolved(user_key)');
      // One verify, then teams, then agents — with the user key as a HEADER on
      // the list routes (401 missing_user_key otherwise) and never in the body
      // of anything but auth/verify.
      expect(callsTo(fixture.calls, '/v3/meta/auth/verify')[0].body).toEqual({ user_key: 'user-key-abc' });
      expect(callsTo(fixture.calls, '/v3/meta/team/list')[0].headers['x-tdai-user-key']).toBe('user-key-abc');
      expect(callsTo(fixture.calls, '/v3/meta/agent/list')[0].body).toEqual({
        team_id: 'team-key',
        owner_user_id: 'usr-key',
        limit: 100,
      });

      // The resolved triple is what the data plane sends — no restart needed.
      const listener = fake.firstListener('agent/pre-step')!;
      await runPreStep(listener, { agent: { session: { id: 's1' } }, turn: 1, step: 1 }, { kind: 'enter', messages: [userMessage('pnpm 用什么?')] });
      const recall = callsTo(fixture.calls, '/v3/recall').find((call) => call.body.query !== 'warmup')!;
      expect(recall.headers['x-tdai-team-id']).toBe('team-key');
      expect(recall.headers['x-tdai-agent-id']).toBe('agt-key');
      expect(recall.headers['x-tdai-user-id']).toBe('usr-key');
      // The user key authenticates the user, not the core: it must not be
      // promoted to the Bearer token.
      expect(recall.headers.authorization).toBeUndefined();
    });

    it('asks through reflect when a bare property read would throw (task-117 e2e)', async () => {
      // Measured on the real host: this plugin declares `inject = ['systemPrompt']`,
      // so reading `ctx.userQuestions` as a property throws
      // `cannot get property "userQuestions" without inject` and the picker died
      // with source=skipped. The service is still reachable through
      // `reflect.get(name, false)`, which is the path this case pins.
      const fixture = installFetch({
        fail: metaRoutes({
          ...RESOLVED,
          '/v3/meta/agent/list': {
            items: [
              { agent_id: 'agt-main', team_id: 'team-key', name: 'Main' },
              { agent_id: 'agt-other', team_id: 'team-key', name: 'Other' },
            ],
            total: 2,
          },
        }),
      });
      // The asset_confirm card comes first (the config endpoint is not stubbed,
      // so the read fails and the plugin asks), then the agent question.
      const ask = vi.fn(async (request: any) => {
        if (request.questions[0]?.id === 'asset_confirm') {
          return { answers: [{ id: 'asset_confirm', selected: ['是，关联团队资产'] }] };
        }
        return { answers: [{ id: 'agent_select', selected: ['Other (gt-other)'] }] };
      });
      const fake = await startApp({ server: { teamId: '', agentId: '', userId: '', userKey: 'user-key-abc' } }, { userQuestions: { ask } });
      Object.defineProperty(fake.ctx, 'userQuestions', {
        configurable: true,
        get() { throw new Error('cannot get property "userQuestions" without inject'); },
      });

      const listener = fake.firstListener('agent/pre-step')!;
      await runPreStep(listener, { agent: { session: { id: 's-card' } }, turn: 1, step: 1 }, { kind: 'enter', messages: [userMessage('pnpm 用什么?')] });

      expect(ask).toHaveBeenCalledTimes(2);
      // The step that asked may still race the answer; the bound identity must be
      // what the NEXT step's data call sends.
      await runPreStep(listener, { agent: { session: { id: 's-card' } }, turn: 1, step: 2 }, { kind: 'enter', messages: [userMessage('pnpm 用什么?')] });
      const recalls = callsTo(fixture.calls, '/v3/recall').filter((call) => call.body.query !== 'warmup');
      expect(recalls.length).toBeGreaterThan(0);
      expect(recalls[recalls.length - 1].headers['x-tdai-agent-id']).toBe('agt-other');
    });

    it('gives the memory_recall tool the same session identity as the volatile block', async () => {
      // The tool call carries no session of its own. Measured in the task-117
      // e2e: the volatile block searched with the bound agent while
      // memory_recall searched with the configured one, so one turn read two
      // different memories. `sessionId` is the fix; this case pins it.
      const fixture = installFetch({
        fail: metaRoutes({
          ...RESOLVED,
          '/v3/meta/agent/list': {
            items: [
              { agent_id: 'agt-main', team_id: 'team-key', name: 'Main' },
              { agent_id: 'agt-other', team_id: 'team-key', name: 'Other' },
            ],
            total: 2,
          },
        }),
      });
      const registered: Array<{ name: string; execute: (args: any) => Promise<string> }> = [];
      const tools = { register: (definition: any) => { registered.push(definition); return () => {}; } };
      const ask = vi.fn(async (request: any) => {
        if (request.questions[0]?.id === 'asset_confirm') {
          return { answers: [{ id: 'asset_confirm', selected: ['是，关联团队资产'] }] };
        }
        return { answers: [{ id: 'agent_select', selected: ['Other (gt-other)'] }] };
      });
      const fake = await startApp(
        { server: { teamId: '', agentId: '', userId: '', userKey: 'user-key-abc' } },
        { userQuestions: { ask }, tools },
      );

      const listener = fake.firstListener('agent/pre-step')!;
      await runPreStep(listener, { agent: { session: { id: 's-tool' } }, turn: 1, step: 1 }, { kind: 'enter', messages: [userMessage('pnpm 用什么?')] });
      const recallTool = registered.find((definition) => definition.name === 'memory_recall')!;
      await recallTool.execute({ query: 'pnpm' });

      const searches = callsTo(fixture.calls, '/v3/atomic/search');
      expect(searches.length).toBeGreaterThan(0);
      expect(searches[searches.length - 1].headers['x-tdai-agent-id']).toBe('agt-other');
    });

    it('binds the per-user preset silently and sends ITS identity (no card)', async () => {
      const fixture = installFetch({
        sessionInit: {
          manual_select: '0',
          default_associate: '1',
          default_team_id: 'team-key',
          default_agent_id: 'agt-preset',
        },
        fail: metaRoutes({
          ...RESOLVED,
          // Two agents in the team: the mount cannot resolve one on its own, so
          // only the user-level preset can name agt-preset.
          '/v3/meta/agent/list': {
            items: [
              { agent_id: 'agt-key', team_id: 'team-key', name: 'Main' },
              { agent_id: 'agt-preset', team_id: 'team-key', name: 'Preset' },
            ],
            total: 2,
          },
        }),
      });
      const ask = vi.fn(async () => ({ answers: [] }));
      const fake = await startApp(
        { server: { teamId: '', agentId: '', userId: '', userKey: 'user-key-abc' } },
        { userQuestions: { ask } },
      );

      const listener = fake.firstListener('agent/pre-step')!;
      const decision = await runPreStep(
        listener,
        { agent: { session: { id: 's-preset' } }, turn: 1, step: 1 },
        { kind: 'enter', messages: [userMessage('pnpm 用什么?')] },
      );

      expect(ask).not.toHaveBeenCalled();
      expect(decision.messages).toHaveLength(2);
      const recalls = callsTo(fixture.calls, '/v3/recall').filter((call) => call.body.query !== 'warmup');
      expect(recalls[recalls.length - 1].headers['x-tdai-team-id']).toBe('team-key');
      expect(recalls[recalls.length - 1].headers['x-tdai-agent-id']).toBe('agt-preset');
    });

    it('injects NOTHING on a bypass user (no data calls at all)', async () => {
      const fixture = installFetch({
        sessionInit: { manual_select: '0', default_associate: '0' },
        fail: metaRoutes(RESOLVED),
      });
      const ask = vi.fn(async () => ({ answers: [] }));
      const fake = await startApp(
        { server: { teamId: '', agentId: '', userId: '', userKey: 'user-key-abc' } },
        { userQuestions: { ask } },
      );

      const listener = fake.firstListener('agent/pre-step')!;
      const decision = await runPreStep(
        listener,
        { agent: { session: { id: 's-bypass' } }, turn: 1, step: 1 },
        { kind: 'enter', messages: [userMessage('pnpm 用什么?')] },
      );

      expect(ask).not.toHaveBeenCalled();
      // The empty binding makes missingIdentity() report teamId, so the whole
      // data plane stays quiet instead of falling back to the configured team.
      expect(decision.messages).toHaveLength(1);
      expect(callsTo(fixture.calls, '/v3/recall').filter((call) => call.body.query !== 'warmup')).toHaveLength(0);
      expect(callsTo(fixture.calls, '/v3/atomic/search')).toHaveLength(0);
      // The config read itself is the one call bypass is ALLOWED to make.
      expect(callsTo(fixture.calls, '/v3/meta/config/user/get')).toHaveLength(1);
      // A deliberate no-association session must not look like a broken one.
      expect(fake.logs.filter((line) => line.startsWith('warn') && line.includes('/v3/recall'))).toHaveLength(0);
    });

    it('fails OPEN when the user config cannot be read (warmup runs, the card asks)', async () => {
      const fixture = installFetch({
        // The mount read decides whether background reads may run. A 5xx must NOT
        // be read as "opted out": losing the warmup costs a cold turn, so the
        // gate opens and the picker falls back to asking.
        fail: metaRoutes(RESOLVED, (path) =>
          path.endsWith('/v3/meta/config/user/get') ? new Response('boom', { status: 500 }) : undefined),
      });
      const ask = vi.fn(async () => ({ answers: [] }));
      const fake = await startApp(
        { server: { teamId: 'team-key', agentId: 'agt-key', userId: 'usr-key', userKey: 'user-key-abc' } },
        { userQuestions: { ask } },
      );
      await vi.waitFor(() => expect(callsTo(fixture.calls, '/v3/meta/config/user/get')).toHaveLength(1));
      // The warmup is team-scoped data, and it must still happen for this user.
      await vi.waitFor(() => expect(callsTo(fixture.calls, '/v3/core/read').length).toBeGreaterThan(0));

      const listener = fake.firstListener('agent/pre-step')!;
      await runPreStep(
        listener,
        { agent: { session: { id: 's-fail-open' } }, turn: 1, step: 1 },
        { kind: 'enter', messages: [userMessage('pnpm 用什么?')] },
      );
      expect(ask).toHaveBeenCalled();
      expect(ask.mock.calls[0][0].questions[0].id).toBe('asset_confirm');
    });

    it('keeps the background warmup quiet for a bypass user (no team read before the decision)', async () => {
      const fixture = installFetch({
        sessionInit: { manual_select: '0', default_associate: '0' },
        fail: metaRoutes(RESOLVED),
      });
      // A CONFIGURED triple is the dangerous case: without the gate the mount
      // head pack + the embedding prewarm would read team data seconds before
      // anyone asked the user -- exactly what default_associate=0 opted out of.
      const fake = await startApp({
        server: { teamId: 'team-cfg', agentId: 'agt-cfg', userId: 'usr-cfg', userKey: 'user-key-abc' },
      });
      fake.emit('agent/created', { agent: {} });
      // turn/start and the section render are the two paths that fired the leak
      // in e2e: both must be gated by the same allowFetch, not just the mount.
      fake.emit('session/event', { id: 's-bypass-warmup' }, { type: 'turn/start', data: {} });
      expect(fake.sectionText()).toBe('');
      await vi.waitFor(() => expect(callsTo(fixture.calls, '/v3/meta/config/user/get')).toHaveLength(1));
      await new Promise((resolve) => setTimeout(resolve, 80));

      expect(callsTo(fixture.calls, '/v3/core/read')).toHaveLength(0);
      expect(callsTo(fixture.calls, '/v3/scenario/ls')).toHaveLength(0);
      expect(callsTo(fixture.calls, '/v3/skill/listing')).toHaveLength(0);
      expect(callsTo(fixture.calls, '/v3/recall')).toHaveLength(0);
      expect(callsTo(fixture.calls, '/v3/atomic/search')).toHaveLength(0);
    });

    it('reads the user config once per session, reusing the mount read for the first', async () => {
      const fixture = installFetch({
        sessionInit: { manual_select: '1' },
        fail: metaRoutes(RESOLVED),
      });
      const fake = await startApp({
        server: { teamId: 'team-key', agentId: 'agt-key', userId: 'usr-key', userKey: 'user-key-abc' },
      });
      // Mount reads it for the warmup gate; session 1 consumes that same value
      // instead of paying for a second round-trip.
      await vi.waitFor(() => expect(callsTo(fixture.calls, '/v3/meta/config/user/get')).toHaveLength(1));
      const listener = fake.firstListener('agent/pre-step')!;
      await runPreStep(
        listener,
        { agent: { session: { id: 's-one' } }, turn: 1, step: 1 },
        { kind: 'enter', messages: [userMessage('第一句')] },
      );
      expect(callsTo(fixture.calls, '/v3/meta/config/user/get')).toHaveLength(1);

      // A NEW session reads it again: a config change must not be pinned for the
      // lifetime of the process.
      await runPreStep(
        listener,
        { agent: { session: { id: 's-two' } }, turn: 1, step: 1 },
        { kind: 'enter', messages: [userMessage('第二句')] },
      );
      expect(callsTo(fixture.calls, '/v3/meta/config/user/get')).toHaveLength(2);
    });

    it('waits for a credentials seam that the composition mounts after this plugin', async () => {
      const fixture = installFetch({ fail: metaRoutes(RESOLVED) });
      // The credentials entry is a SIBLING loader entry. Measured on a real
      // headless composition: at the moment this plugin's apply() ran the
      // service object was absent (ready printed keySource=none at +228ms)
      // while the very same refs resolved 500ms later.
      const services: Record<string, unknown> = {};
      const fake = createFakeContext({ services });
      applied.push(fake);
      const mounted = apply(fake.ctx, {
        server: {
          teamId: '',
          agentId: '',
          userId: '',
          apiKeyRef: 'TDAI_GATEWAY_APIKEY',
          userKeyRef: 'TDAI_USER_KEY',
        },
        writeback: { outboxPath: tempOutbox() },
      });
      setTimeout(() => {
        services.credentials = {
          async resolve(ref: string) {
            if (ref === 'TDAI_GATEWAY_APIKEY') return { value: 'core-key-from-seam', source: 'file' };
            if (ref === 'TDAI_USER_KEY') return { value: 'user-key-from-seam', source: 'file' };
            return undefined;
          },
        };
      }, 50);
      await mounted;

      const ready = fake.logs.find((line) => line.includes('agemem: ready'))!;
      expect(ready).toContain('identity=resolved(user_key)');
      expect(ready).toContain('userKeySource=credentials:TDAI_USER_KEY');
      expect(ready).toContain('keySource=credentials:TDAI_GATEWAY_APIKEY');
      expect(ready).toContain('health=ok');
      // Never a value, and the wait is announced instead of silently guessing.
      expect(ready).not.toContain('core-key-from-seam');
      expect(ready).not.toContain('user-key-from-seam');
      // The bounded wait SUCCEEDED: it never fell back to the environment path.
      expect(fake.logs.some((line) => line.includes('credentials seam is not mounted'))).toBe(false);

      // The seam values reach the wire: gateway key as Bearer, user key as header.
      await runPreStep(
        fake.firstListener('agent/pre-step')!,
        { agent: { session: { id: 's1' } }, turn: 1, step: 1 },
        { kind: 'enter', messages: [userMessage('pnpm 要几个?')] },
      );
      const recall = callsTo(fixture.calls, '/v3/recall').find((call) => call.body.query !== 'warmup')!;
      expect(recall.headers.authorization).toBe('Bearer core-key-from-seam');
      expect(recall.headers['x-tdai-team-id']).toBe('team-key');
      // The user key never rides the data plane; it authenticates the metadata reads.
      expect(callsTo(fixture.calls, '/v3/meta/team/list')[0].headers['x-tdai-user-key']).toBe('user-key-from-seam');
    });

    it('stays inert and warns once when the user key matches more than one team', async () => {
      const fixture = installFetch({
        fail: metaRoutes({
          ...RESOLVED,
          '/v3/meta/team/list': { items: [{ team_id: 'team-a' }, { team_id: 'team-b' }], total: 2 },
        }),
      });
      const fake = await startApp({ server: { teamId: '', agentId: '', userId: '', userKey: 'user-key-abc' } });

      const line = fake.logs.find((entry) => entry.includes('agemem: ready'))!;
      expect(line).toContain('identity=missing(teamId,agentId,userId)');
      const warnings = fake.logs.filter((entry) => entry.startsWith('warn') && entry.includes('server.userKey'));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('2 teams');
      expect(warnings[0]).toContain('scripts/agemem-identity.mjs');
      // Never guesses: no agent list, no data call, no injection.
      expect(callsTo(fixture.calls, '/v3/meta/agent/list')).toHaveLength(0);
      expect(callsTo(fixture.calls, '/v3/atomic/search')).toHaveLength(0);

      const decision = await runPreStep(
        fake.firstListener('agent/pre-step')!,
        { agent: { session: { id: 's1' } }, turn: 1, step: 1 },
        { kind: 'enter', messages: [userMessage('pnpm 用什么?')] },
      );
      expect(decision.messages).toHaveLength(1);
    });

    it('warns once and stays inert when the core rejects the user key', async () => {
      installFetch({ fail: metaRoutes({ '/v3/meta/auth/verify': { valid: false, user: null } }) });
      const fake = await startApp({ server: { teamId: '', agentId: '', userId: '', userKey: 'wrong-key' } });

      const warnings = fake.logs.filter((entry) => entry.startsWith('warn') && entry.includes('server.userKey'));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('not valid');
      expect(fake.logs.find((entry) => entry.includes('agemem: ready'))!).toContain('identity=missing(');
    });

    it('keeps the user key out of the ready line and reports only its source', async () => {
      installFetch();
      const fake = await startApp({ server: { teamId: '', userKey: 'user-key-abc' } });
      const line = fake.logs.find((entry) => entry.includes('agemem: ready'))!;
      expect(line).toContain('userKeySource=config');
      expect(line).not.toContain('user-key-abc');
    });

    it('re-resolves on every mount: nothing is persisted to the profile', async () => {
      const fixture = installFetch({ fail: metaRoutes(RESOLVED) });
      const config = { server: { teamId: '', agentId: '', userId: '', userKey: 'user-key-abc' } };
      vi.useFakeTimers();
      try {
        const first = await settleOnFakeClock(startApp(config));
        // A second process does the same three reads: the resolution lives in
        // memory only, so the patch file is never touched at runtime.
        const second = await settleOnFakeClock(startApp(config));

        // The wait is faked, not removed. A mount with no credentials/tools
        // sibling burns exactly SEAM_WAIT_MS + TOOLS_WAIT_MS = 1600ms
        // (src/index.ts:156 and :165); measured 1600 on both mounts. A mount
        // that stopped waiting, waited only once, or overran the budget fails
        // here bit-for-bit rather than silently getting faster.
        expect(first.virtualMs).toBe(1600);
        expect(second.virtualMs).toBe(1600);
        expect(callsTo(fixture.calls, '/v3/meta/auth/verify')).toHaveLength(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });


  it('serves persona plus the L2 scenario index through the section getter', async () => {
    installFetch();
    const fake = await startApp();
    await vi.waitFor(() => {
      const text = fake.sectionText();
      expect(text).toContain('# User Narrative Profile');
      expect(text).toContain('## 长期记忆 · 场景索引（L2）');
      // The segment renders the prefixed, dated, summarised line (task-103);
      // `- scene_blocks` is also the anchor scripts/verify-installed.mjs greps.
      expect(text).toContain('- scene_blocks/scenes/deploy.md — 部署流程');
      expect(text.indexOf('# User Narrative Profile')).toBeLessThan(text.indexOf('## 长期记忆'));
    });
    // The mount line reports the segment's own four-state label, not a
    // configured value dressed up as a result.
    const ready = fake.logs.find((line) => line.includes('agemem: ready')) ?? '';
    expect(ready).toMatch(/l2=(ok\(\d+,\d+\)|pending|empty|fail:)/);
  });

  it('renders the core\'s <available_skills> block into the head pack section', async () => {
    // parity requirement: the core already renders the model-ready listing
    // (/v3/skill/listing data.listing); re-assembling it here would drift.
    const listing = ['<available_skills>', '- ncc-ct-to-order-generation-chain v3', '- review-checklist v1', '</available_skills>'].join(LF);
    installFetch({
      fail: (path) => (path === '/v3/skill/listing'
        ? envelope({ listing, hits: [{ skill_id: 'skl-1', version: 3, name: 'ncc-ct-to-order-generation-chain' }], truncated: false })
        : undefined),
    });
    const fake = await startApp();
    await vi.waitFor(() => expect(fake.sectionText()).toContain('<available_skills>') );
    const text = fake.sectionText();
    expect(text).toContain('- ncc-ct-to-order-generation-chain v3');
    expect(text.trimEnd().endsWith('</available_skills>')).toBe(true);
    // The persona keeps the lead position: the listing is appended after it.
    expect(text.indexOf('# User Narrative Profile')).toBeLessThan(text.indexOf('<available_skills>'));
  });

  it('drops the skill segment to zero characters when the listing fails, keeping the persona', async () => {
    installFetch({ fail: (path) => (path === '/v3/skill/listing' ? new Response('boom', { status: 500 }) : undefined) });
    const fake = await startApp();
    await vi.waitFor(() => expect(fake.sectionText()).toContain('# User Narrative Profile'));
    expect(fake.sectionText()).not.toContain('<available_skills>');
    const composed = fake.rawLogs.find((entry) => String(entry.parts[0]).includes('head pack composed'));
    expect(composed).toBeDefined();
    const payload: any = composed!.parts[1];
    expect(payload.segments).toContain('skills=failed:0');
  });

  it('strips the persona scene block and serves the index from the L2 segment instead', async () => {
    // Shaped like the real /v3/core/read persona: narrative + 14 scene sections,
    // each carrying a long Summary body. Before task-103 this block was
    // compressed in place (~6.2k of a 10k persona) and duplicated the L2 index.
    const scenes = Array.from({ length: 14 }, (_, index) => [
      '### Path: scene_blocks/scene_' + String(index + 1).padStart(2, '0') + '.md',
      '**热度**: ' + (100 - index) + ' | **更新**: 2026-10-' + String(index + 1).padStart(2, '0'),
      'Summary: ' + '这一段的摘要很长，占掉大部分字符。'.repeat(6),
    ].join(LF));
    const persona = [
      '# User Narrative Profile',
      '',
      '## 身份',
      '- 用户偏好简洁回答。',
      '',
      '## 🗺️ Scene Navigation (Scene Index)',
      '',
      scenes.join(LF + LF),
    ].join(LF);

    const fixture = installFetch({ persona });
    const fake = await startApp();
    await vi.waitFor(() => expect(fake.sectionText()).toContain('## 长期记忆 · 场景索引（L2）'));

    const text = fake.sectionText();
    // The narrative survives; its trailing index block does not — the L2
    // segment is the only index now, so no path is listed twice.
    expect(text).toContain('用户偏好简洁回答。');
    expect(text).not.toContain('## 🗺️ Scene Navigation');
    expect(text).not.toContain('Summary:');
    // The persona's own 14-line block is gone entirely (its paths are not in
    // the /v3/scenario/ls fixture), so the L2 section is the only index.
    expect(text).not.toContain('scene_blocks/scene_01.md');
    expect(text).not.toContain('[agemem head pack truncated at');
    // The index comes from /v3/scenario/ls (two fixture scenes), not from the
    // persona body.
    const l2Lines = text.match(/^- scene_blocks\/\S+ — .+$/gm) ?? [];
    expect(l2Lines).toHaveLength(2);
    expect(callsTo(fixture.calls, '/v3/scenario/ls').length).toBeGreaterThan(0);
    // ...and the whole pack still fits the configured budget.
    expect(text.length).toBeLessThanOrEqual(20000);
    // KNOWN, TASK-104-OWNED: HeadPack's structure pass now runs over a pack that
    // has a scene heading but no heat/date lines in the persona shape it parses,
    // so it logs its one-shot warning once per process. The behaviour is
    // harmless (bare-clamp fallback), the log line is noise, and the dead
    // `fetchScenarios` path in src/head-pack.ts is what task-104 removes.
    expect(fake.logs.filter((line) => line.includes('no parseable scene index')).length).toBeLessThanOrEqual(1);
  });
  it('writes the scene index once when the persona already lists the path', () => {
    const persona = [
      '# User Narrative Profile',
      '',
      '## 🗺️ Scene Navigation (Scene Index)',
      '',
      '- scene_blocks/a.md（热度 3，更新 2026-10-01）',
    ].join(LF);
    const pack = composeHeadPack(persona, ['scene_blocks/a.md', 'scene_blocks/b.md'], {
      maxChars: 8000,
      includeScenarioIndex: true,
    });

    // The path the persona already lists (with heat and date) is not repeated as
    // a bare line: 334 chars / 6.8% of the measured head pack went to that.
    expect(pack.split('scene_blocks/a.md')).toHaveLength(2);
    expect(pack).toContain('- scene_blocks/b.md');
    // The `- scene_blocks` marker verify-installed.mjs keys on still exists in
    // both shapes: the persona line and the appended section.
    expect(pack).toContain('- scene_blocks');
    const naive = persona + LF + LF + '## 长期记忆 · 场景索引（L2）' + LF + '- scene_blocks/a.md' + LF + '- scene_blocks/b.md';
    expect(pack.length).toBeLessThan(naive.length);
  });

  it('appends a path the persona does not list, and a longer sibling is not a match', () => {
    const persona = '# User Narrative Profile' + LF + LF + '- scenes/deploy.md.bak（热度 1，更新 2026-10-01）';
    const pack = composeHeadPack(persona, ['scenes/deploy.md'], {
      maxChars: 8000,
      includeScenarioIndex: true,
    });

    // `scenes/deploy.md` is a prefix of the listed `scenes/deploy.md.bak`: a
    // substring test would have swallowed the real scene, so the boundary after
    // the path must be a non-path character.
    expect(pack).toContain('- scenes/deploy.md');
    expect(pack.split('scenes/deploy.md.bak')).toHaveLength(2);
  });

  it('sends the configured identity to the core', async () => {
    const fixture = installFetch();
    await startApp({ server: { teamId: 'team-custom' } });
    await vi.waitFor(() => expect(callsTo(fixture.calls, '/v3/core/read')).toHaveLength(1));
    const body = callsTo(fixture.calls, '/v3/core/read')[0].body;
    expect(body).toEqual({ team_id: 'team-custom', agent_id: 'agt-test', user_id: 'usr-test' });
    expect(callsTo(fixture.calls, '/v3/core/read')[0].headers['x-tdai-service-id']).toBe('default');
  });

  it('stays inert with the shipped empty identity (never writes into an unknown account)', async () => {
    const fixture = installFetch();
    const fake = await startApp({ server: { teamId: '', agentId: '', userId: '' } });
    // Section and listeners still register (fail-open), but nothing leaves the process.
    expect(fake.sections).toHaveLength(4); // P1-2: 口径 + head pack + identity + anchor
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fixture.calls).toHaveLength(0);
    expect(fake.sectionText()).toBe('');
  });

  it('fails open when the core is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const fake = await startApp();
    await expect(apply(fake.ctx, { enabled: false })).resolves.toBeUndefined();
    expect(fake.sectionText()).toBe('');
    expect(fake.sections).toHaveLength(4); // P1-2: 口径 + head pack + identity + anchor
  });

  it('registers nothing when disabled', async () => {
    const fixture = installFetch();
    const fake = await startApp({ enabled: false });
    expect(fake.sections).toHaveLength(0);
    expect(fake.listenerCount('agent/pre-step')).toBe(0);
    expect(fixture.calls).toHaveLength(0);
  });

  it('registers memory_recall when a tool service is mounted', async () => {
    installFetch();
    const register = vi.fn(() => () => {});
    const fake = await startApp({}, { tools: { register } });
    // Several modules register through this seam (recall + the read-only skill
    // tools); each one is its own register() call, so look the tool up by name.
    const names = register.mock.calls.map((call) => (call[0] as any).name);
    expect(names).toContain('memory_recall');
    const definition: any = register.mock.calls.find((call) => (call[0] as any).name === 'memory_recall')![0];
    expect(definition.name).toBe('memory_recall');
    // A whole JSON Schema object, not the old DSL field map: register() ships
    // `parameters` to the model untouched (see the header note in tools.ts).
    expect(definition.parameters).toMatchObject({ type: 'object', required: ['query'] });
    expect(definition.parameters.properties.query.type).toBe('string');
    expect(definition.output.schema).toEqual({ type: 'string' });
    expect(fake.listenerCount('agent/pre-step')).toBe(2);
  });

  it('waits for a tools service that mounts after apply (mount-timing)', async () => {
    installFetch();
    const register = vi.fn(() => () => {});
    // The service object is created by a sibling entry AFTER this plugin's
    // apply() runs on a real composition: one lookup at mount time found
    // nothing, took the "unavailable" branch and memory_recall never existed
    // for the whole process. Measured latency on the real host: ~500ms.
    const services: Record<string, unknown> = {};
    const started = startApp({}, services);
    setTimeout(() => { services.tools = { register }; }, 50);
    const fake = await started;
    expect(register.mock.calls.map((call) => (call[0] as any).name)).toContain('memory_recall');
    expect(fake.listenerCount('agent/pre-step')).toBe(2);
  });

  it('names the violated rule when the host rejects the tool definition', async () => {
    installFetch();
    const register = vi.fn(() => {
      const rejection: any = new Error('tool definition rejected');
      rejection.code = 'UNSUPPORTED_SCHEMA';
      rejection.name = 'JsonSchemaError';
      rejection.violations = ['parameters.limit.required must be true when present'];
      throw rejection;
    });
    const fake = await startApp({}, { tools: { register } });
    // Still loads, and the log carries the actual rule instead of a bare object.
    expect(fake.sections).toHaveLength(4); // P1-2: 口径 + head pack + identity + anchor
    const warning = fake.logs.find((line) => line.startsWith('warn') && line.includes('memory_recall registration failed'));
    expect(warning).toBeDefined();
    expect(warning).toContain('UNSUPPORTED_SCHEMA');
    expect(warning).toContain('parameters.limit.required must be true when present');
  });

  it('mirrors the log into a file only when debug is on', async () => {
    installFetch();
    const dir = mkdtempSync(path.join(tmpdir(), 'agemem-log-'));
    tempDirs.push(dir);
    const logFile = path.join(dir, 'agemem.log');
    const off = await startApp({ debug: false, debugLogFile: logFile });
    expect(off.logs.some((line) => line.includes('debug log mirror'))).toBe(false);
    let mirrored = '';
    try {
      mirrored = readFileSync(logFile, 'utf8');
    } catch {
      mirrored = '';
    }
    expect(mirrored).toBe('');
    const on = await startApp({ debug: true, debugLogFile: logFile });
    const text = readFileSync(logFile, 'utf8');
    expect(on.logs.join(String.fromCharCode(10))).toContain('debug log mirror');
    expect(text).toContain('agemem: debug log mirror');
    // The ready line is the one line an operator greps for; it must land in the
    // file too, since the GUI host has no readable stderr.
    expect(text).toContain('agemem: ready (endpoint=');
  });

  it('keeps loading when no tool service is mounted', async () => {
    installFetch();
    const fake = await startApp();
    expect(fake.sections).toHaveLength(4); // P1-2: 口径 + head pack + identity + anchor
  });

  it('warms the core once on agent/created without blocking the turn', async () => {
    const fixture = installFetch();
    const fake = await startApp();
    expect(callsTo(fixture.calls, '/v3/recall')).toHaveLength(0);

    fake.emit('agent/created', { id: 'a1' });
    await vi.waitFor(() => expect(callsTo(fixture.calls, '/v3/recall')).toHaveLength(1));
    // The warm-up must hit the expensive leg: /v3/recall runs the L1 embedding
    // search (cold ~5.0s), while atomic/search alone no longer warms it.
    const warmup = callsTo(fixture.calls, '/v3/recall')[0].body;
    expect(warmup.query).toBe('warmup');
    expect(warmup.maxResults).toBe(1);

    // One prewarm per process: a second agent must not pay it again.
    fake.emit('agent/created', { id: 'a2' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(callsTo(fixture.calls, '/v3/recall')).toHaveLength(1);
  });

  it('分支会话静默继承父会话的人设卡与身份：零新增取卡、字节相同', async () => {
    const fixture = installFetch({ card: { version: 7, hash: 'h7', text: 'NAME:审墨|VOICE:短句。' } });
    const fake = await startApp();
    const parent = { id: 'session-parent', session: { id: 'session-parent' } };
    fake.emit('agent/created', { agent: parent });
    await vi.waitFor(() => expect(callsTo(fixture.calls, '/v3/soul/card').length).toBe(1));

    const identitySection = fake.sections.find((candidate) => candidate.name === 'tdb-agemem:persona-identity')!;
    const parentText = (identitySection.text as (c?: unknown) => string)({ agent: parent });
    expect(parentText).toContain('审墨');

    const child = { id: 'session-child', session: { id: 'session-child', header: { parentSession: 'session-parent' } } };
    fake.emit('agent/created', { agent: child });
    await new Promise((resolve) => setTimeout(resolve, 80));

    // 一次都不再取：分支复制父会话那份冻结字节。
    expect(callsTo(fixture.calls, '/v3/soul/card').length).toBe(1);
    const childText = (identitySection.text as (c?: unknown) => string)({ agent: child });
    expect(childText).toBe(parentText);
  });

  it('P2-C：取卡带会话键（Core 据此按在场者过滤），且不猜 participants', async () => {
    const fixture = installFetch({ card: { version: 3, hash: 'h3', text: 'NAME:审墨|VOICE:短句。' } });
    const fake = await startApp();
    const agent = { id: 'session-p2c', session: { id: 'session-p2c' } };
    fake.emit('agent/created', { agent });
    await vi.waitFor(() => expect(callsTo(fixture.calls, '/v3/soul/card').length).toBe(1));
    const call = callsTo(fixture.calls, '/v3/soul/card')[0];
    // 会话键必须原样送到 Core：按人过滤的唯一入口。
    expect(call.url).toContain('session=session-p2c');
    // 插件不传 participants：传展示名会被 Core 丢弃，传空串等于「只剩全局行」。
    expect(call.url).not.toContain('participants=');
  });

  it('父会话没有卡时，分支按父身份补一次字节，仍不弹窗', async () => {
    const fixture = installFetch({ card: null });
    const fake = await startApp();
    const parent = { id: 'session-p2', session: { id: 'session-p2' } };
    fake.emit('agent/created', { agent: parent });
    await vi.waitFor(() => expect(callsTo(fixture.calls, '/v3/soul/card').length).toBe(1));

    const child = { id: 'session-c2', session: { id: 'session-c2', header: { parentSession: 'session-p2' } } };
    fake.emit('agent/created', { agent: child });
    await vi.waitFor(() => expect(callsTo(fixture.calls, '/v3/soul/card').length).toBe(2));
    // 没有任何用户提问往返（弹窗会打到 userQuestions 服务；这里没注入该服务）。
    expect(fake.listenerCount('agent/created')).toBeGreaterThan(0);
  });
  it('resolves the API key through the credentials ref, not from config', async () => {
    const fixture = installFetch();
    const resolve = vi.fn(async () => ({ value: 'secret-from-store' }));
    await startApp({}, { credentials: { resolve } });
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledWith('TDAI_GATEWAY_APIKEY'));
    await vi.waitFor(() => {
      const call = callsTo(fixture.calls, '/v3/core/read')[0];
      expect(call?.headers.authorization).toBe('Bearer secret-from-store');
    });
  });

  it('lets an inline api key win over the credentials ref', async () => {
    const fixture = installFetch();
    const resolve = vi.fn(async () => ({ value: 'ref-key' }));
    await startApp({ server: { apiKey: 'inline-key' } }, { credentials: { resolve } });
    await vi.waitFor(() => expect(callsTo(fixture.calls, '/v3/core/read')).toHaveLength(1));
    const call = callsTo(fixture.calls, '/v3/core/read')[0];
    expect(call.headers.authorization).toBe('Bearer inline-key');
    // A configured gateway key must not even consult the seam, let alone lose
    // to it. The user-key ref is a different ref and is still resolved (it rides
    // its own header), so assert on the gateway ref only.
    expect(resolve).not.toHaveBeenCalledWith('TDAI_GATEWAY_APIKEY');
  });

  it('warns once and stays fail-open when the core rejects the key', async () => {
    const fixture = installFetch({ fail: () => new Response('unauthorized', { status: 401 }) });
    const outboxPath = tempOutbox();
    const fake = await startApp({ writeback: { outboxPath } });

    const listener = fake.firstListener('agent/pre-step');
    if (!listener) throw new Error('pre-step listener not installed');
    const claimed = [userMessage('pnpm 用什么?')];
    const decision = await runPreStep(listener, { agent: { session: { id: 's1' } }, turn: 1, step: 1 }, { kind: 'enter', messages: claimed });

    fake.emit('session/event', { id: 's1' }, { type: 'user/message', data: { turn: 1, message: userMessage('pnpm 用什么?', 'u1') } });
    fake.emit('session/event', { id: 's1' }, {
      type: 'assistant/message',
      data: { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: '用 pnpm。' }] } },
    });
    fake.emit('agent/turn-stopping', { turn: 1, agent: { session: { id: 's1' } } });

    await vi.waitFor(() => expect(callsTo(fixture.calls, '/v3/conversation/add')).toHaveLength(1));
    // Fail-open: no injection, no section text.
    expect(decision.messages).toHaveLength(1);
    expect(fake.sectionText()).toBe('');
    // One warn per failure class, not per request.
    const authWarnings = fake.logs.filter((line) => line.startsWith('warn') && line.includes('server.apiKey'));
    expect(authWarnings).toHaveLength(1);
    expect(authWarnings[0]).toContain('HTTP 401');
    expect(authWarnings[0]).toContain('TDAI_GATEWAY_APIKEY');
    // 401/403 is a configuration bug: neither pipeline may burn 8 × 30s of
    // backoff on it, so both are dead-lettered on the first answer.
    const l0Warnings = fake.logs.filter((line) => line.startsWith('warn')
      && line.includes('/v3/conversation/add')
      && line.includes('not retried on an HTTP response'));
    expect(l0Warnings).toHaveLength(1);
    expect(l0Warnings[0]).toContain('HTTP 401');
    const skillWarnings = fake.logs.filter((line) => line.startsWith('warn')
      && line.includes('/v3/skill/conversation/add')
      && line.includes('not retried on an HTTP response'));
    expect(skillWarnings).toHaveLength(1);
    expect(skillWarnings[0]).toContain('HTTP 401');
    // The dead-letter moves are reported once, without the key or the text.
    const deadWarnings = fake.logs.filter((line) => line.startsWith('warn') && line.includes('dead letter'));
    expect(deadWarnings).toHaveLength(1);
    expect(deadWarnings[0]).toContain('class=auth');
    expect(deadWarnings[0]).not.toContain('s1:turn:1');
    // The only other warning is the missing tools service (this fake context has none).
    const other = fake.logs.filter((line) => line.startsWith('warn') && line.includes('tools service unavailable'));
    expect(other).toHaveLength(1);
    // One warn per failure class, never per request: auth, recall, L0, skill,
    // dead, tools — plus the persona-card read (channel A), which is its own
    // class since task-11 (a 401 there is still reported once, never per retry).
    expect(fake.logs.filter((line) => line.startsWith('warn'))).toHaveLength(7);

    // Nothing is left queued for retry: both rows were answered with 401.
    const entries = readFileSync(outboxPath, 'utf8').trim().split(String.fromCharCode(10)).filter((line) => line !== '');
    expect(entries).toHaveLength(0);

    // Both siblings are parked in the dead letter file, structured and free of
    // conversation content, each keeping its own reason class and endpoint.
    const deadPath = outboxPath.replace(/\.jsonl$/, '.dead.jsonl');
    const dead = readFileSync(deadPath, 'utf8').trim().split(String.fromCharCode(10)).filter((line) => line !== '');
    expect(dead).toHaveLength(2);
    const deadL0 = JSON.parse(dead[0]);
    expect(deadL0.payload.kind).toBe('l0');
    expect(deadL0.reason.reasonClass).toBe('auth');
    expect(deadL0.reason.status).toBe(401);
    expect(deadL0.reason.endpoint).toBe('/v3/conversation/add');
    const deadSkill = JSON.parse(dead[1]);
    expect(deadSkill.payload.kind).toBe('skill');
    expect(deadSkill.reason.reasonClass).toBe('auth');
    expect(deadSkill.reason.status).toBe(401);
    expect(deadSkill.reason.endpoint).toBe('/v3/skill/conversation/add');
  });

  it('opens the recall circuit permanently on a 422 and reports it once', async () => {
    // Live probe: /v3/recall answers 422 "missing team_id, agent_id, user_id"
    // when the isolation triple is not in the HEADERS. That is a configuration
    // state (like a 401), not a transient hiccup: retrying it every turn would
    // burn the volatile budget forever and silently hide the misconfiguration.
    const fixture = installFetch({
      fail: (endpoint: string) => (endpoint.endsWith('/v3/recall')
        ? new Response('{"code":422,"message":"/v3 requires strict isolation: missing team_id, agent_id, user_id"}', { status: 422 })
        : undefined),
    });
    const fake = await startApp();
    const listener = fake.firstListener('agent/pre-step');
    if (!listener) throw new Error('pre-step listener not installed');

    const first = await runPreStep(listener, { agent: { session: { id: 's1' } }, turn: 1, step: 1 }, { kind: 'enter', messages: [userMessage('pnpm 用什么?')] });
    // A second session: the near-duplicate text guard is per session, and this
    // test is about the circuit, not about dedupe.
    const second = await runPreStep(listener, { agent: { session: { id: 's2' } }, turn: 1, step: 1 }, { kind: 'enter', messages: [userMessage('另一句')] });

    // Fail-open: both turns still get the atomic/search fallback block.
    expect(first.messages).toHaveLength(2);
    expect(second.messages).toHaveLength(2);
    expect(String((second as any).messages[1].content[0].text)).toContain('【agemem');
    expect(fake.logs.some((line) => line.includes('circuit open'))).toBe(true);
    // Exactly ONE recall attempt: the circuit is open for the rest of the process.
    expect(callsTo(fixture.calls, '/v3/recall')).toHaveLength(1);
    expect(callsTo(fixture.calls, '/v3/atomic/search').length).toBeGreaterThanOrEqual(2);

    const warned = fake.logs.filter((line) => line.startsWith('warn') && line.includes('/v3/recall') && line.includes('422'));
    expect(warned).toHaveLength(1);
    // The operator gets the endpoint, the status and the server's own wording.
    expect(warned[0]).toContain('/v3/recall');
    expect(warned[0]).toContain('x-tdai-team-id');
    expect(warned[0]).toContain('restart after fixing');
  });

  it('dead-letters a 4xx L0 write on the first answer instead of retrying it', async () => {
    const fixture = installFetch({
      fail: (endpoint: string) => (endpoint.endsWith('/v3/conversation/add')
        ? new Response('{"code":400,"message":"bad payload"}', { status: 400 })
        : undefined),
    });
    const outboxPath = tempOutbox();
    const fake = await startApp({ writeback: { outboxPath, skillFeed: false, maxAttempts: 8, retryMs: 100 } });

    fake.emit('session/event', { id: 's1' }, { type: 'user/message', data: { turn: 1, message: userMessage('q', 'u1') } });
    fake.emit('session/event', { id: 's1' }, { type: 'assistant/message', data: { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'a' }] } } });
    fake.emit('agent/turn-stopping', { turn: 1, agent: { session: { id: 's1' } } });

    await vi.waitFor(() => expect(readDead(outboxPath)).toHaveLength(1), { timeout: 3000 });
    // A answered-but-rejected request stays rejected: only one send, not eight.
    expect(callsTo(fixture.calls, '/v3/conversation/add')).toHaveLength(1);
    const dead = readDead(outboxPath)[0];
    expect(dead.payload.kind).toBe('l0');
    expect(dead.reason.reasonClass).toBe('l0-http');
    expect(dead.reason.status).toBe(400);
    expect(fake.logs.filter((line) => line.startsWith('warn') && line.includes('not retried on an HTTP response'))).toHaveLength(1);
  });

  it('retries a transport reset exactly once, then dead-letters it', async () => {
    let seen = 0;
    const fixture = installFetch({
      fail: (endpoint: string) => {
        if (!endpoint.endsWith('/v3/conversation/add')) return undefined;
        seen += 1;
        throw new Error('fetch failed: ECONNRESET');
      },
    });
    const outboxPath = tempOutbox();
    vi.useFakeTimers();
    try {
      const mounted = await settleOnFakeClock(startApp({ writeback: { outboxPath, skillFeed: false, maxAttempts: 8, retryMs: 100 } }));
      const fake = mounted.value;

      fake.emit('session/event', { id: 's1' }, { type: 'user/message', data: { turn: 1, message: userMessage('q', 'u1') } });
      fake.emit('session/event', { id: 's1' }, { type: 'assistant/message', data: { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'a' }] } } });
      fake.emit('agent/turn-stopping', { turn: 1, agent: { session: { id: 's1' } } });

      // The first attempt rides the turn path; the retry waits on the outbox
      // timer, so nothing is dead-lettered while that timer is still pending.
      await vi.advanceTimersByTimeAsync(0);
      expect(seen).toBe(1);
      expect(readDead(outboxPath)).toHaveLength(0);

      // One full retry interval (retryMs) is what it takes — and it takes it.
      // src/outbox.ts:359 floors the retry timer at 1000ms (\\`Math.max(1000, retryMs)\\`)
      // regardless of the configured 100ms, so the row must still be pending
      // after 900ms of virtual time — the wait is asserted, not just skipped.
      await vi.advanceTimersByTimeAsync(1100);
      expect(seen).toBe(1);
      expect(readDead(outboxPath)).toHaveLength(0);

      // ...and it lands on the first outbox tick at/after entry.nextAt. That is
      // +1200ms here: the retry floor is 1000ms (src/outbox.ts:359) and the
      // interval, armed at mount, ticks at 800 + 1200. A hang or a dropped
      // entry now fails on an exact millisecond instead of a 4000ms wall-clock
      // waitFor that would happily burn four seconds and then pass.
      await vi.advanceTimersByTimeAsync(100);
      expect(seen).toBe(2);
      expect(readDead(outboxPath)).toHaveLength(1);

      const dead = readDead(outboxPath)[0];
      expect(dead.reason.reasonClass).toBe('transport-reset');
      expect(dead.reason.status).toBeUndefined();
      expect(dead.reason.attempt).toBe(2);

      // Dead means dead: ten more intervals add no send and no second row.
      await vi.advanceTimersByTimeAsync(1000);
      expect(seen).toBe(2);
      expect(readDead(outboxPath)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats HTTP 200 with a non-zero business code as a rejection', async () => {
    // The skill route validates and answers 200 + code 40001; judging success by
    // the status line alone turned a real rejection into a one-line debug log.
    const fixture = installFetch({
      fail: (endpoint: string) => (endpoint.endsWith('/v3/conversation/add')
        ? envelope({}, 40001, 'messages[0].timestamp must be ISO')
        : undefined),
    });
    const outboxPath = tempOutbox();
    const fake = await startApp({ writeback: { outboxPath, skillFeed: false } });

    fake.emit('session/event', { id: 's1' }, { type: 'user/message', data: { turn: 1, message: userMessage('q', 'u1') } });
    fake.emit('session/event', { id: 's1' }, { type: 'assistant/message', data: { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'a' }] } } });
    fake.emit('agent/turn-stopping', { turn: 1, agent: { session: { id: 's1' } } });

    await vi.waitFor(() => expect(readDead(outboxPath)).toHaveLength(1), { timeout: 3000 });
    expect(callsTo(fixture.calls, '/v3/conversation/add')).toHaveLength(1);
    const dead = readDead(outboxPath)[0];
    expect(dead.reason.reasonClass).toBe('business-rejected');
    const warned = fake.logs.filter((line) => line.startsWith('warn') && line.includes('40001'));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('/v3/conversation/add');
  });

  it('writes both pipelines on one turn: ISO for L0, epoch ms for skill', async () => {
    const fixture = installFetch();
    const fake = await startApp();
    fake.emit('session/event', { id: 's1' }, { type: 'user/message', data: { turn: 1, timestamp: '2026-10-31T10:00:00.000Z', message: userMessage('问句', 'u1') } });
    fake.emit('session/event', { id: 's1' }, {
      type: 'assistant/message',
      data: { turn: 1, timestamp: '2026-10-31T10:00:05.000Z', message: { role: 'assistant', content: [{ type: 'text', text: '答句' }] } },
    });
    fake.emit('agent/turn-stopping', { turn: 1, agent: { session: { id: 's1' } } });

    await vi.waitFor(() => expect(callsTo(fixture.calls, '/v3/conversation/add')).toHaveLength(1));
    await vi.waitFor(() => expect(callsTo(fixture.calls, '/v3/skill/conversation/add')).toHaveLength(1));

    const l0 = callsTo(fixture.calls, '/v3/conversation/add')[0].body;
    for (const message of l0.messages) expect(message.timestamp).toMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T/);

    const skill = callsTo(fixture.calls, '/v3/skill/conversation/add')[0].body;
    expect(skill.session_id).toBe('s1');
    expect(skill.messages.map((message: any) => message.content)).toEqual(['问句', '答句']);
    expect(skill.messages.map((message: any) => typeof message.timestamp)).toEqual(['number', 'number']);
    expect(skill.messages[0].timestamp).toBe(Date.parse('2026-10-31T10:00:00.000Z'));
  });

  it('does not feed the skill buffer from an errored turn', async () => {
    const fixture = installFetch();
    const fake = await startApp();
    fake.emit('session/event', { id: 's1' }, { type: 'assistant/message', data: { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: '半截' }] } } });
    fake.emit('session/event', { id: 's1' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'error' } } });

    await vi.waitFor(() => expect(callsTo(fixture.calls, '/v3/conversation/add')).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 25));
    // L0 records the failed turn for the record; L2 must stay clean.
    expect(callsTo(fixture.calls, '/v3/skill/conversation/add')).toHaveLength(0);
  });

  it('sends only L0 when skillFeed is off', async () => {
    const fixture = installFetch();
    const outboxPath = tempOutbox();
    const fake = await startApp({ writeback: { outboxPath, skillFeed: false } });
    fake.emit('session/event', { id: 's1' }, { type: 'assistant/message', data: { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: '答句' }] } } });
    fake.emit('agent/turn-stopping', { turn: 1, agent: { session: { id: 's1' } } });

    await vi.waitFor(() => expect(callsTo(fixture.calls, '/v3/conversation/add')).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(callsTo(fixture.calls, '/v3/skill/conversation/add')).toHaveLength(0);
  });

  it('refetches the head pack on the real compaction events only', async () => {
    const fixture = installFetch();
    const fake = await startApp();
    await vi.waitFor(() => expect(fake.sectionText()).toContain('# User Narrative Profile'));
    const before = callsTo(fixture.calls, '/v3/core/read').length;

    // The pre-fix spelling has zero hits in app.asar: watching it was dead code,
    // so it must stay a no-op here (guards against a silent regression).
    fake.emit('session/event', { id: 's1' }, { type: 'session/compacted' });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(callsTo(fixture.calls, '/v3/core/read').length).toBe(before);

    // compaction/start clears during compaction (prompt assembly already uses the new pack).
    fake.emit('compaction/start', { id: 's1' });
    await vi.waitFor(() => expect(callsTo(fixture.calls, '/v3/core/read').length).toBe(before + 1));

    // compaction/end clears again for the post-compaction assembly.
    fake.emit('compaction/end', { id: 's1' });
    await vi.waitFor(() => expect(callsTo(fixture.calls, '/v3/core/read').length).toBe(before + 2));
  });

  it('appends one volatile block built from the atomic search hits', async () => {
    installFetch();
    const fake = await startApp();
    const listener = fake.firstListener('agent/pre-step');
    if (!listener) throw new Error('pre-step listener not installed');
    const claimed = [userMessage('pnpm 用什么?')];
    const decision = await runPreStep(listener, { agent: { session: { id: 's1' } }, turn: 1, step: 1 }, { kind: 'enter', messages: claimed });

    expect(decision.messages).toHaveLength(2);
    expect(decision.messages[0]).toBe(claimed[0]);
    const text = decision.messages[1].content[0].text;
    expect(text).toContain('【agemem 记忆提示】');
    expect(text).toContain(ATOMIC_ITEMS[0].content);
    expect(decision.messages[1].source.kind).toBe(VOLATILE_SOURCE_KIND);
  });
  /**
   * 2026-11-07 task-19：插件侧旧的 soul 兜底全链退役。召回块
   * 只剩记忆段——旧 core 的 soul 片断（若还出现在 /v3/recall 的 block 里）一律
   * 丢弃，人格只从插件的人格卡 section 进提示词。
   */
  it('volatile 块只有记忆段：不出现任何旧 soul 片断，预算仍是 1500', async () => {
    installFetch();
    const fake = await startApp();
    const listener = fake.firstListener('agent/pre-step');
    if (!listener) throw new Error('pre-step listener not installed');
    const decision = await runPreStep(
      listener,
      { agent: { session: { id: 's1' } }, turn: 1, step: 1 },
      { kind: 'enter', messages: [userMessage('pnpm 用什么?')] },
    );
    const text = decision.messages[1].content[0].text;
    expect(text.startsWith(VOLATILE_HEADER)).toBe(true);
    expect(text).not.toContain('<soul');
    expect(text).toContain(ATOMIC_ITEMS[0].content);
    expect(text.length).toBeLessThanOrEqual(1500);
    const payload = fake.rawLogs
      .filter((entry) => entry.level === 'debug' && entry.parts[0] === 'agemem: volatile block ready')
      .map((entry) => entry.parts[1] as Record<string, unknown>)
      .pop();
    expect(payload).toBeDefined();
    expect(payload!.soulChars).toBeUndefined();
    expect(payload!.soulVersion).toBeUndefined();
  });

  /**
   * task-11：通道 A（插件人格卡 section）在位时，volatile 里的旧 soul 支路必须
   * 关闭——同一份人格不能既进稳定前缀又进每轮消息（双注入 = 双倍 token，且两处
   * 口径可能不同）。判据 3/4 的字节约束也钉在这里。
   */
  describe('人格卡接管后 volatile 不再重复注入人格（task-11）', () => {
    const CARD = {
      version: 9,
      hash: 'cardhash-9',
      text: '### 名称' + LF + '何晨' + LF + LF + '### 风格' + LF + '- 先结论，后证据。',
    };

    function sectionOf(fake: FakeContext) {
      return fake.sections.find((candidate) => candidate.name === PERSONA_IDENTITY_SECTION_NAME);
    }

    function anchorSectionOf(fake: FakeContext) {
      return fake.sections.find((candidate) => candidate.name === PERSONA_ANCHOR_SECTION_NAME);
    }

    /** 宿主给 section getter 的 context：agent.id === session.id 由宿主强制。 */
    const agentOf = (id: string) => ({ id, session: { id } });

    function cardText(fake: FakeContext, sessionId = 's1'): string {
      const section = sectionOf(fake);
      if (!section) throw new Error('persona identity section not registered');
      const getter = section.text as (context?: unknown) => string;
      return getter({ agent: agentOf(sessionId) });
    }

    /** 末尾锚段（P1-2）：旧 Core 的 fixture 没有 anchor，应为空串。 */
    function anchorText(fake: FakeContext, sessionId = 's1'): string {
      const section = anchorSectionOf(fake);
      if (!section) throw new Error('persona anchor section not registered');
      const getter = section.text as (context?: unknown) => string;
      return getter({ agent: agentOf(sessionId) });
    }

    /**
     * task-32：卡不再在挂载时取，而是在「会话第一次绑定 agent」那一刻取
     * （sessionIdentity.ensureBound → onBound → personaCard.bind）。这里用一次
     * pre-step 触发绑定，返回这次 pre-step 的 decision 供断言。
     */
    async function bindCard(fake: FakeContext, sessionId = 's1', turn = 1) {
      const listener = fake.firstListener('agent/pre-step');
      if (!listener) throw new Error('pre-step listener not installed');
      const decision = await runPreStep(
        listener,
        { agent: agentOf(sessionId), turn, step: 1 },
        { kind: 'enter', messages: [userMessage('pnpm 用什么?')] },
      );
      await vi.waitFor(() => expect(cardText(fake, sessionId)).toContain('何晨'));
      return decision;
    }

    it('卡非空时：两个 section（identity order 1 / anchor 尾部 10302），volatile 里没有任何 <soul- 段', async () => {
      installFetch({ card: CARD });
      const fake = await startApp();
      // P1-2：身份段固定前置 1（紧跟 harness:identity −1000 与 persona-prefix 0，早于 WORKING_DIRECTORY 100；
      // 110 是宿主的 SANDBOX_POLICY，撞号会与沙箱策略同级）。
      const section = sectionOf(fake);
      expect(section).toBeDefined();
      expect(section!.order).toBe(1);
      expect(section!.interpolate).toBe(false);
      expect(typeof section!.text).toBe('function');
      // 末尾锚沿用尾部 order（base 10200 + orderOffset 0 + 2 = 10302）。
      const anchor = anchorSectionOf(fake);
      expect(anchor).toBeDefined();
      expect(anchor!.order).toBe(10302);
      expect(anchor!.interpolate).toBe(false);
      // 拆分后旧名单不再注册：不会既注入整卡 section、又注入两段。
      expect(fake.sections.some((candidate) => candidate.name === 'tdb-agemem:persona-card')).toBe(false);
      // 绑定之前：没有会话上下文就没有卡（不预热、不兜底）。
      expect(cardText(fake, 's-not-bound')).toBe('');
      expect(anchorText(fake, 's-not-bound')).toBe('');

      const decision = await bindCard(fake);
      expect(cardText(fake)).toBe(CARD.text);
      // 旧 Core 的卡只有 text：身份段退化成整卡，末尾锚为空串（不注入占位）。
      expect(anchorText(fake)).toBe('');

      const text = decision.messages[1].content[0].text;
      // 人格只走卡 section；volatile 块里不允许再出现人格片断。
      expect(text).not.toContain('<soul');
      expect(text).toContain('【agemem 记忆提示】');
      expect(text).toContain('偏好 pnpm workspace');
    });

    it('把实际注入量回报给 Core：card 元数据 + volatile 真实字节数，均无正文', async () => {
      const fixture = installFetch({ card: CARD });
      const fake = await startApp();
      const listener = fake.firstListener('agent/pre-step');
      if (!listener) throw new Error('pre-step listener not installed');

      // 第一次 pre-step 就是绑定时机：卡在这时取到并回报。
      const first = await runPreStep(
        listener,
        { agent: agentOf('s1'), turn: 1, step: 1 },
        { kind: 'enter', messages: [userMessage('pnpm 用什么?')] },
      );
      const injected = first.messages[1].content[0].text as string;

      // 通道 A：卡真进了前缀才报，且只报 version/hash/chars。
      await vi.waitFor(() => {
        const cardCalls = callsTo(fixture.calls, '/v3/soul/injection').filter(
          (call) => (call.body as any)?.card !== undefined,
        );
        expect(cardCalls).toHaveLength(1);
        const body = cardCalls[0].body as any;
        // A3：回报的 hash 是卡正文 SHA-256（64 hex），不再是 Core 的旧快照 hash。
        expect(body.card).toEqual({ version: CARD.version, hash: sha256(CARD.text), chars: CARD.text.length });
        expect(body.card.hash).toMatch(/^[0-9a-f]{64}$/);
        expect(JSON.stringify(body)).not.toContain('何晨');
        // 回归：回报必须带**本会话**绑定的身份三元组。缺 sessionId 时会退回挂载三元组
        // （桌面端常为空），Core 直接 422 且错误被 fail-open 吞掉，注入记账静默丢失。
        expect(cardCalls[0].headers['x-tdai-agent-id']).toBeDefined();
      });
      expect(cardText(fake)).toBe(CARD.text);

      // 通道 B：chars 必须等于真实 append 的字节数（clamped），不是召回量。
      await vi.waitFor(() => {
        const volatileCalls = callsTo(fixture.calls, '/v3/soul/injection').filter(
          (call) => (call.body as any)?.volatile !== undefined,
        );
        expect(volatileCalls).toHaveLength(1);
        const body = volatileCalls[0].body as any;
        expect(body.volatile).toMatchObject({ chars: injected.length, skipped: false });
        expect(body.sessionKey).toBe('s1');
        expect(body.turn).toBe(1);
        expect(JSON.stringify(body)).not.toContain('偏好 pnpm workspace');
      });

      // 同文本的第二轮被近 3 轮去重跳过：必须报 skipped:true + chars:0。
      const second = await runPreStep(
        listener,
        { agent: agentOf('s1'), turn: 2, step: 1 },
        { kind: 'enter', messages: [userMessage('pnpm 用什么?')] },
      );
      expect(second.messages).toHaveLength(1);
      await vi.waitFor(() => {
        const volatileCalls = callsTo(fixture.calls, '/v3/soul/injection').filter(
          (call) => (call.body as any)?.volatile !== undefined,
        );
        expect(volatileCalls).toHaveLength(2);
        expect((volatileCalls[1].body as any).volatile).toMatchObject({ chars: 0, skipped: true });
      });
    });

    it('逐轮段裁到 400 字符并追加在块尾，记忆仍在前', async () => {
      const longMood = '心境'.repeat(320); // 640 字符，必然被裁
      installFetch({ card: CARD, turn: { text: longMood, openLoops: ['还要取证'] } });
      const fake = await startApp();
      const decision = await bindCard(fake);
      const text = decision.messages[1].content[0].text;
      expect(text).toContain('【agemem 记忆提示】');
      // 通道 B 在块尾：恰好 PERSONA_TURN_MAX_CHARS 个字符，不切在中间。
      expect(text.endsWith('心境'.repeat(PERSONA_TURN_MAX_CHARS / 2))).toBe(true);
      expect(text.includes('心境'.repeat(PERSONA_TURN_MAX_CHARS / 2 + 1))).toBe(false);
      expect(text).not.toContain('<soul-');
    });

    it('取卡 401：fail-open（section 空、回合照常），warn 留 http_status + 401', async () => {
      installFetch({
        fail: (path) => (path.endsWith('/v3/soul/card') ? new Response('', { status: 401 }) : undefined),
      });
      const fake = await startApp();
      const listener = fake.firstListener('agent/pre-step');
      if (!listener) throw new Error('pre-step listener not installed');
      const decision = await runPreStep(
        listener,
        { agent: agentOf('s1'), turn: 1, step: 1 },
        { kind: 'enter', messages: [userMessage('pnpm 用什么?')] },
      );
      await vi.waitFor(() => {
        const warn = fake.rawLogs
          .filter((entry) => entry.level === 'warn' && String(entry.parts[0]).includes('persona card bind failed'))
          .pop();
        expect(warn?.parts[1]).toMatchObject({ reason: 'http_status', status: 401 });
      });
      // 该会话没有卡：section 空，但回合照常拿到记忆。
      expect(cardText(fake)).toBe('');
      expect(decision.messages[1].content[0].text).toContain('偏好 pnpm workspace');
    });

    it('取卡超时：fail-open，warn 留 reason=timeout', async () => {
      const fixture = coreFixture();
      vi.stubGlobal('fetch', vi.fn((input: any, init?: any) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith('/v3/soul/card')) return new Promise<Response>(() => {});
        return fixture.fetchImpl(input, init);
      }));
      const fake = await startApp({ server: { requestTimeoutMs: 100 } });
      const listener = fake.firstListener('agent/pre-step');
      if (!listener) throw new Error('pre-step listener not installed');
      await runPreStep(
        listener,
        { agent: agentOf('s1'), turn: 1, step: 1 },
        { kind: 'enter', messages: [userMessage('pnpm 用什么?')] },
      );
      await vi.waitFor(() => {
        const warn = fake.rawLogs
          .filter((entry) => entry.level === 'warn' && String(entry.parts[0]).includes('persona card bind failed'))
          .pop();
        expect(warn?.parts[1]).toMatchObject({ reason: 'timeout' });
      });
      expect(cardText(fake)).toBe('');
    });
  });


  it('serves the pre-step block from the prefetched recall cache (no second request)', async () => {
    const fixture = installFetch();
    const fake = await startApp();
    const listener = fake.firstListener('agent/pre-step');
    if (!listener) throw new Error('pre-step listener not installed');

    // The prefetch usually finishes before the step claims the message; the cache
    // is what turns that into a free block (the embedding is 97% of the cost).
    const claimed = [userMessage('pnpm 用什么?', 'u1')];
    fake.emit('session/event', { id: 's1' }, { type: 'user/message', data: { turn: 1, message: claimed[0] } });
    await vi.waitFor(() => {
      expect(callsTo(fixture.calls, '/v3/recall')).toHaveLength(1);
    });

    const decision = await runPreStep(listener, { agent: { session: { id: 's1' } }, turn: 1, step: 1 }, { kind: 'enter', messages: claimed });
    expect(callsTo(fixture.calls, '/v3/recall')).toHaveLength(1);
    expect(decision.messages).toHaveLength(2);
    expect(decision.messages[1].content[0].text).toContain('【agemem 记忆提示】');
    expect(fake.logs.some((line) => line.includes('volatile block served from cache'))).toBe(true);
  });

  it('shares ONE recall request between the user-message prefetch and the pre-step await', async () => {
    const fixture = installFetch();
    const fake = await startApp();
    const listener = fake.firstListener('agent/pre-step');
    if (!listener) throw new Error('pre-step listener not installed');

    // The host persists the user message before the step claims it — that is the
    // prefetch window. The pre-step must join that request, not issue a second.
    const claimed = [userMessage('pnpm 用什么?', 'u1')];
    fake.emit('session/event', { id: 's1' }, { type: 'user/message', data: { turn: 1, message: claimed[0] } });
    const decision = await runPreStep(listener, { agent: { session: { id: 's1' } }, turn: 1, step: 1 }, { kind: 'enter', messages: claimed });

    expect(callsTo(fixture.calls, '/v3/recall')).toHaveLength(1);
    expect(decision.messages).toHaveLength(2);
    expect(decision.messages[1].content[0].text).toContain('【agemem 记忆提示】');
  });

  it('cancels its own slow recall at the budget and falls back to atomic/search', async () => {
    const calls: string[] = [];
    // A fetch that only settles when we abort: this is what AbortController is
    // for — without it the request would keep running in the background.
    vi.stubGlobal('fetch', vi.fn((input: any, init: any = {}) => {
      const path = new URL(String(input)).pathname;
      calls.push(path);
      if (path.endsWith('/v3/recall')) {
        return new Promise((_resolve, reject) => {
          const signal: AbortSignal | undefined = init.signal;
          signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
          });
        });
      }
      if (path.endsWith('/v3/atomic/search')) return Promise.resolve(envelope({ items: ATOMIC_ITEMS }));
      if (path.endsWith('/v3/core/read')) return Promise.resolve(envelope({ content: PERSONA }));
      if (path.endsWith('/v3/scenario/ls')) return Promise.resolve(envelope({ entries: SCENARIO_ENTRIES }));
      return Promise.resolve(envelope({}));
    }));
    const fake = await startApp({ volatile: { recallTimeoutMs: 100, timeoutMs: 3000 } });
    const listener = fake.firstListener('agent/pre-step');
    if (!listener) throw new Error('pre-step listener not installed');

    const decision = await runPreStep(listener, { agent: { session: { id: 's1' } }, turn: 1, step: 1 }, { kind: 'enter', messages: [userMessage('pnpm 用什么?')] });

    expect(calls).toContain('/v3/recall');
    // The fallback still feeds the block, and the diagnosis names OUR cancel.
    expect(decision.messages).toHaveLength(2);
    expect(decision.messages[1].content[0].text).toContain(ATOMIC_ITEMS[0].content);
    const warn = fake.logs.find((line) => line.includes('/v3/recall failed'));
    expect(warn).toBeDefined();
    expect(warn).toContain('cancelled locally');
    expect(calls.filter((path) => path.endsWith('/v3/atomic/search'))).toHaveLength(1);
  });

  it('degrades to a fresh fetch when the prefetch key does not match the step', async () => {
    const fixture = installFetch();
    const fake = await startApp();
    const listener = fake.firstListener('agent/pre-step');
    if (!listener) throw new Error('pre-step listener not installed');

    // No turn number on either side: the key is the user text, so a different
    // text must miss (never reuse another question's block).
    fake.emit('session/event', { id: 's1' }, { type: 'user/message', data: { message: userMessage('asked A', 'u1') } });
    await runPreStep(listener, { agent: { session: { id: 's1' } }, step: 1 }, { kind: 'enter', messages: [userMessage('asked B', 'u2')] });

    expect(callsTo(fixture.calls, '/v3/recall')).toHaveLength(2);
  });

  it('writes a completed turn back as [user, assistant]', async () => {
    const fixture = installFetch();
    const fake = await startApp();
    fake.emit('session/event', { id: 's1' }, { type: 'user/message', data: { turn: 1, message: userMessage('问句', 'u1') } });
    fake.emit('session/event', { id: 's1' }, {
      type: 'assistant/message',
      data: { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: '答句' }] }, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
    });
    fake.emit('agent/turn-stopping', { turn: 1, agent: { session: { id: 's1' } } });

    await vi.waitFor(() => expect(callsTo(fixture.calls, '/v3/conversation/add')).toHaveLength(1));
    const body = callsTo(fixture.calls, '/v3/conversation/add')[0].body;
    expect(body.session_id).toBe('s1');
    expect(body.messages.map((message: any) => message.role)).toEqual(['user', 'assistant']);
    expect(body.messages.map((message: any) => message.content)).toEqual(['问句', '答句']);
    for (const message of body.messages) expect(message.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('never writes its own injected block back as user text', async () => {
    const fixture = installFetch();
    const fake = await startApp();
    fake.emit('session/event', { id: 's1' }, {
      type: 'user/message',
      data: {
        turn: 1,
        message: { id: 'blk', role: 'user', source: { kind: VOLATILE_SOURCE_KIND }, content: [{ type: 'text', text: '记忆块' }] },
      },
    });
    fake.emit('session/event', { id: 's1' }, {
      type: 'assistant/message',
      data: { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: '答句' }] } },
    });
    fake.emit('agent/turn-stopping', { turn: 1, agent: { session: { id: 's1' } } });

    await vi.waitFor(() => expect(callsTo(fixture.calls, '/v3/conversation/add')).toHaveLength(1));
    const body = callsTo(fixture.calls, '/v3/conversation/add')[0].body;
    expect(body.messages.map((message: any) => message.role)).toEqual(['assistant']);
  });

  it('never re-sends a skill row that a previous process already dead-lettered', async () => {
    const fixture = installFetch({
      fail: (endpoint: string) => (endpoint.endsWith('/conversation/add')
        ? new Response('unauthorized', { status: 401 })
        : undefined),
    });
    const outboxPath = tempOutbox();
    const turnText = (id: string, text: string) => {
      return { type: 'user/message', data: { turn: 1, message: userMessage(text, id) } };
    };

    const first = await startApp({ writeback: { outboxPath } });
    first.emit('session/event', { id: 's1' }, turnText('u1', 'q'));
    first.emit('session/event', { id: 's1' }, {
      type: 'assistant/message',
      data: { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'a' }] } },
    });
    first.emit('agent/turn-stopping', { turn: 1, agent: { session: { id: 's1' } } });
    await vi.waitFor(() => expect(callsTo(fixture.calls, '/v3/skill/conversation/add')).toHaveLength(1));
    const deadPath = outboxPath.replace(/\.jsonl$/, '.dead.jsonl');
    await vi.waitFor(() => expect(readFileSync(deadPath, 'utf8')).toContain('"kind":"skill"'));

    // A restarted process finalizes the same turn again (crash at turn end).
    const second = await startApp({ writeback: { outboxPath } });
    second.emit('session/event', { id: 's1' }, turnText('u2', 'q2'));
    second.emit('session/event', { id: 's1' }, {
      type: 'assistant/message',
      data: { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'a2' }] } },
    });
    second.emit('agent/turn-stopping', { turn: 1, agent: { session: { id: 's1' } } });
    await new Promise((resolve) => setTimeout(resolve, 60));

    // The dead key is not re-queued: one skill request total, no doubled L2 buffer.
    expect(callsTo(fixture.calls, '/v3/skill/conversation/add')).toHaveLength(1);
    const skillDead = readFileSync(deadPath, 'utf8')
      .split(String.fromCharCode(10))
      .filter((line) => line.includes('"kind":"skill"'));
    expect(skillDead).toHaveLength(1);
  });

  it('dead-letters an L0 write with a structured, text-free reason', async () => {
    const fixture = installFetch({ fail: () => new Response('boom', { status: 500 }) });
    const outboxPath = tempOutbox();
    const fake = await startApp({ writeback: { outboxPath, maxAttempts: 1 } });

    fake.emit('session/event', { id: 's1' }, { type: 'user/message', data: { turn: 1, message: userMessage('secret question', 'u1') } });
    fake.emit('session/event', { id: 's1' }, {
      type: 'assistant/message',
      data: { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'secret answer' }] } },
    });
    fake.emit('agent/turn-stopping', { turn: 1, agent: { session: { id: 's1' } } });
    await vi.waitFor(() => expect(callsTo(fixture.calls, '/v3/conversation/add')).toHaveLength(1));

    const deadPath = outboxPath.replace(/\.jsonl$/, '.dead.jsonl');
    const dead = await vi.waitFor(() => {
      const raw = readFileSync(deadPath, 'utf8').trim();
      expect(raw).not.toBe('');
      return JSON.parse(raw.split(String.fromCharCode(10))[0]);
    });
    expect(dead.payload.kind).toBe('l0');
    expect(dead.reason).toMatchObject({
      reasonClass: 'l0-http',
      endpoint: '/v3/conversation/add',
      status: 500,
      attempt: 1,
    });
    // The dead-letter record is ops data, not a second copy of the conversation.
    expect(JSON.stringify(dead.reason)).not.toContain('secret question');
    expect(JSON.stringify(dead.reason)).not.toContain('secret answer');
    expect(JSON.stringify(dead.reason)).not.toContain('s1');
  });

  it('stops timers and listeners on dispose', async () => {
    installFetch();
    const fake = await startApp();
    expect(fake.listenerCount('dispose')).toBe(1);
    fake.emit('dispose');
    expect(fake.sections).toHaveLength(0);
    expect(fake.listenerCount('agent/pre-step')).toBe(0);
    expect(fake.listenerCount('agent/turn-stopping')).toBe(0);
  });
});

describe('composeHeadPack', () => {
  it('puts the persona first and the scene index after it', () => {
    const text = composeHeadPack(PERSONA, ['a.md', 'b.md'], { maxChars: 4000, includeScenarioIndex: true });
    expect(text.startsWith('# User Narrative Profile')).toBe(true);
    expect(text).toContain('## 长期记忆 · 场景索引（L2）');
    expect(text).toContain('- a.md');
  });

  it('reserves room for the scene index before truncating a long persona', () => {
    const longPersona = 'P'.repeat(500);
    const text = composeHeadPack(longPersona, ['a.md'], { maxChars: 120, includeScenarioIndex: true });
    expect(text.length).toBeLessThanOrEqual(120);
    expect(text).toContain('- a.md');
    expect(text).toContain('truncated');
  });

  it('omits the scene index when disabled or empty, and caps the entry count', () => {
    expect(composeHeadPack('persona', ['a.md'], { maxChars: 4000, includeScenarioIndex: false })).toBe('persona');
    expect(composeHeadPack(PERSONA, [], { maxChars: 4000, includeScenarioIndex: true })).toBe(PERSONA.trim());
    expect(composeHeadPack(undefined, [], { maxChars: 4000 })).toBe('');
    // Ceiling is hardcoded at HEAD_PACK_MAX_SCENARIO_ENTRIES = 20 (the old config
    // knob was never passed by the only caller, so 20 was always the live value).
    const many = Array.from({ length: 25 }, (_, i) => `s${i}.md`);
    const capped = composeHeadPack(undefined, many, { maxChars: 4000, includeScenarioIndex: true });
    expect(capped).toContain('- s19.md');
    expect(capped).not.toContain('- s20.md');
  });


  it('returns an empty section for a zero budget', () => {
    expect(composeHeadPack(PERSONA, ['a.md'], { maxChars: 0, includeScenarioIndex: true })).toBe('');
  });
});

describe('unbound session diagnostics', () => {
  // Measured 2026-11-01 01:52:21 on a mount whose identity comes from the user
  // key: the old single line said "using the configured triple" when there was
  // no triple at all, and the call actually carried no isolation headers.
  it('says which fallback the call really used', () => {
    expect(unboundIdentityMessage(true)).toContain('using the configured triple');
    expect(unboundIdentityMessage(false)).toContain('no configured triple');
    expect(unboundIdentityMessage(false)).toContain('no isolation identity');
  });
});


/**
 * P1-B W3：turn 收口 → L0 写回成功 → 逐条投递工具事件（fire-and-forget）。
 * 两条纪律在这里被钉住：事件必须带齐分类/证据/去重键；事件面失败绝不影响
 * turn 本身与对话正文的写回。
 */
describe('soul tool events (P1-B W3)', () => {
  it('L0 写回之后按 tool/test/commit/rollback 投递事件，带证据与去重键', async () => {
    const fixture = installFetch();
    const fake = await startApp({ writeback: { outboxPath: tempOutbox() } });

    fake.emit('session/event', { id: 's1' }, { type: 'user/message', data: { turn: 1, message: userMessage('跑一下测试', 'u1') } });
    fake.emit('session/event', { id: 's1' }, {
      type: 'tool/call',
      data: { turn: 1, step: 1, callId: 'c1', name: 'ops_bash', arguments: { command: 'npx vitest run' } },
    });
    fake.emit('session/event', { id: 's1' }, {
      type: 'tool/result',
      data: { turn: 1, step: 1, message: toolMessage('Tests  46 passed (46)') },
    });
    fake.emit('session/event', { id: 's1' }, {
      type: 'assistant/message',
      data: { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: '全绿。' }] } },
    });
    fake.emit('agent/turn-stopping', { turn: 1, agent: { session: { id: 's1' } } });

    await vi.waitFor(() => expect(callsTo(fixture.calls, '/v3/conversation/add')).toHaveLength(1));
    await vi.waitFor(() => expect(callsTo(fixture.calls, '/v3/soul/event')).toHaveLength(1));

    // 顺序：正文先落地，工具事件后到（「我跑过」不该早于「我说过」）。
    const addIndex = fixture.calls.findIndex((call) => call.path.endsWith('/v3/conversation/add'));
    const eventIndex = fixture.calls.findIndex((call) => call.path.endsWith('/v3/soul/event'));
    expect(eventIndex).toBeGreaterThan(addIndex);

    const body = callsTo(fixture.calls, '/v3/soul/event')[0].body as Record<string, any>;
    expect(body.source_kind).toBe('test');
    expect(body.dedupe_key).toBe('dsh:s1:c1');
    expect(body.session_id).toBe('s1');
    expect(body.summary).toBe('test: ops_bash npx vitest run');
    expect(body.epistemic).toBe('observed');
    expect(body.confidence).toBe(0.9);
    expect(body.evidence).toEqual([{ role: 'tool', quote: 'Tests  46 passed (46)', record_id: 'c1' }]);
    expect(body.action).toMatchObject({ tool: 'ops_bash', tool_call_id: 'c1', result_status: 'success' });
    // 头：租户三元组只走 header，body 里不带（Core 从 header 取，缺一 422）。
    const headers = callsTo(fixture.calls, '/v3/soul/event')[0].headers;
    expect(headers['x-tdai-team-id']).toBe('team-test');
    expect(headers['x-tdai-agent-id']).toBe('agt-test');
    expect(headers['x-tdai-user-id']).toBe('usr-test');
    expect(Object.keys(body)).not.toContain('team_id');
  });

  it('事件被拒只 warn 一次，turn 与 L0 写回照常完成（不重投、不进 Outbox）', async () => {
    const fixture = installFetch({
      fail: (path) => (path.endsWith('/v3/soul/event') ? new Response('boom', { status: 500 }) : undefined),
    });
    const outboxPath = tempOutbox();
    const fake = await startApp({ writeback: { outboxPath } });

    fake.emit('session/event', { id: 's1' }, { type: 'user/message', data: { turn: 1, message: userMessage('跑一下测试', 'u1') } });
    fake.emit('session/event', { id: 's1' }, {
      type: 'tool/call',
      data: { turn: 1, step: 1, callId: 'c1', name: 'ops_bash', arguments: { command: 'npx vitest run' } },
    });
    fake.emit('session/event', { id: 's1' }, {
      type: 'tool/result',
      data: { turn: 1, step: 1, message: toolMessage('Tests 46 passed (46)') },
    });
    fake.emit('session/event', { id: 's1' }, {
      type: 'assistant/message',
      data: { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: '全绿。' }] } },
    });
    fake.emit('agent/turn-stopping', { turn: 1, agent: { session: { id: 's1' } } });

    await vi.waitFor(() => expect(callsTo(fixture.calls, '/v3/soul/event')).toHaveLength(1));
    // 正文照样写回：事件是观测面，不是写回的前置条件。
    expect(callsTo(fixture.calls, '/v3/conversation/add')).toHaveLength(1);
    // 不重投（只有那次失败的投递），也不留下待重试的行。
    expect(callsTo(fixture.calls, '/v3/soul/event')).toHaveLength(1);
    const entries = readFileSync(outboxPath, 'utf8').trim().split(LF).filter((line) => line !== '');
    expect(entries).toHaveLength(0);
    // 失败类别只报一次，且指向事件路由。
    const eventWarnings = fake.logs.filter((line) => line.startsWith('warn') && line.includes('/v3/soul/event'));
    expect(eventWarnings).toHaveLength(1);
    expect(eventWarnings[0]).toContain('HTTP 500');
    // 不留事件正文：warn 行里没有工具输出。
    expect(eventWarnings[0]).not.toContain('46 passed');
  });
});
/**
 * P7 输出侧（shadow）：L0 写回成功 → 把这一轮助手输出送 POST /v3/soul/gate。
 * 三条纪律在这里被钉住：一回合只发一次；失败只 warn 一次、不重投、不进 Outbox；
 * 判定结果不回灌模型、日志里不落正文。
 */
describe('soul output gate (P7 shadow)', () => {
  /** 驱动一个成功回合：用户消息 → 工具调用/回执 → 助手正文 → 收口。 */
  function driveTurn(fake: FakeContext): void {
    fake.emit('session/event', { id: 's1' }, { type: 'user/message', data: { turn: 1, message: userMessage('跑一下测试', 'u1') } });
    fake.emit('session/event', { id: 's1' }, {
      type: 'tool/call',
      data: { turn: 1, step: 1, callId: 'c1', name: 'ops_bash', arguments: { command: 'npx vitest run' } },
    });
    fake.emit('session/event', { id: 's1' }, {
      type: 'tool/result',
      data: { turn: 1, step: 1, message: toolMessage('Tests  46 passed (46)') },
    });
    fake.emit('session/event', { id: 's1' }, {
      type: 'assistant/message',
      data: { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: '全绿。' }] } },
    });
    fake.emit('agent/turn-stopping', { turn: 1, agent: { session: { id: 's1' } } });
  }

  it('成功回合发且只发一次，带 text/stage/会话标识，且在正文落地之后', async () => {
    const fixture = installFetch();
    const outboxPath = tempOutbox();
    const fake = await startApp({ writeback: { outboxPath } });

    driveTurn(fake);

    await vi.waitFor(() => expect(callsTo(fixture.calls, '/v3/soul/gate')).toHaveLength(1));
    const gate = callsTo(fixture.calls, '/v3/soul/gate')[0];
    expect(gate.method).toBe('POST');
    // body：Core 只读 text/stage/eventId（soul-gate-endpoint.ts:218/:231/:243）。
    expect(gate.body).toMatchObject({ text: '全绿。', stage: 'output', sessionId: 's1' });
    expect(Object.keys(gate.body)).not.toContain('team_id');
    // 会话标识：body 一份 + x-tdai-session-id（规范会话头）一份。
    expect(gate.headers['x-tdai-session-id']).toBe('s1');
    // 形状先跑一次：gate 是 shadow 观测面，不能因为它让别的调用变少。
    expect(callsTo(fixture.calls, '/v3/soul/gate').length).toBe(1);
    // 身份仍走三元组头（Core 缺一 422）。
    expect(gate.headers['x-tdai-team-id']).toBe('team-test');
    expect(gate.headers['x-tdai-agent-id']).toBe('agt-test');
    expect(gate.headers['x-tdai-user-id']).toBe('usr-test');

    // 顺序：正文先落地，判定后到（「我说过什么」不该晚于「我判了什么」）。
    const addIndex = fixture.calls.findIndex((call) => call.path.endsWith('/v3/conversation/add'));
    const gateIndex = fixture.calls.findIndex((call) => call.path.endsWith('/v3/soul/gate'));
    expect(gateIndex).toBeGreaterThan(addIndex);

    // 不进 Outbox：gate 失败不该留下可重投的行，也不该把正文写进死信文件。
    expect(readFileSync(outboxPath, 'utf8').trim().split(LF).filter((line) => line !== '')).toHaveLength(0);
    // 判定结果不回灌：写回正文里没有任何 gate 字段，日志里不带助手正文。
    expect(JSON.stringify(callsTo(fixture.calls, '/v3/conversation/add')[0].body)).not.toContain('wouldDecision');
    expect(fake.logs.filter((line) => line.includes('soul gate') && line.includes('全绿'))).toHaveLength(0);
  });

  it('同一轮重复收口只判一次（不重投）', async () => {
    const fixture = installFetch();
    const fake = await startApp({ writeback: { outboxPath: tempOutbox() } });

    driveTurn(fake);
    await vi.waitFor(() => expect(callsTo(fixture.calls, '/v3/soul/gate')).toHaveLength(1));

    // 宿主重复发收口（重连/重放）：不允许多记一条判定。
    fake.emit('agent/turn-stopping', { turn: 1, agent: { session: { id: 's1' } } });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(callsTo(fixture.calls, '/v3/soul/gate')).toHaveLength(1);
    expect(callsTo(fixture.calls, '/v3/conversation/add')).toHaveLength(1);
  });

  it('判定失败只 warn 一次：turn 与 L0 写回照常，不重投、不进 Outbox、日志不落正文', async () => {
    const fixture = installFetch({
      fail: (path) => (path.endsWith('/v3/soul/gate') ? new Response('boom', { status: 500 }) : undefined),
    });
    const outboxPath = tempOutbox();
    const fake = await startApp({ writeback: { outboxPath } });

    driveTurn(fake);

    await vi.waitFor(() =>
      expect(fake.logs.filter((line) => line.startsWith('warn') && line.includes('/v3/soul/gate'))).toHaveLength(1),
    );
    // 只发一次：失败不重投。
    expect(callsTo(fixture.calls, '/v3/soul/gate')).toHaveLength(1);
    // L0 写回不受影响（gate 在它之后、且与之无关）。
    expect(callsTo(fixture.calls, '/v3/conversation/add')).toHaveLength(1);
    const entries = readFileSync(outboxPath, 'utf8').trim().split(LF).filter((line) => line !== '');
    expect(entries).toHaveLength(0);

    const gateWarnings = fake.logs.filter((line) => line.startsWith('warn') && line.includes('/v3/soul/gate'));
    expect(gateWarnings[0]).toContain('HTTP 500');
    // 不落正文：warn 行里没有这一轮的助手输出。
    expect(gateWarnings[0]).not.toContain('全绿');
    expect(fake.logs.filter((line) => line.includes('全绿'))).toHaveLength(0);
  });
});
describe('persona card bind target', () => {
  // 2026-11-08 02:14 现场：切换人设时先绑空三元组（候选/弹窗没成），旧实现把它
  // 当成「不关联」清卡，02:14:15.990 清 → 02:14:23.491 才绑上，中间那次拼提示
  // 词没有卡。三种结果必须分开。
  it('binds the picked agent', () => {
    expect(personaBindTarget({ teamId: 't1', userId: 'u1', agentId: 'a1' }))
      .toBe('t1/u1/a1');
  });

  it('clears only on an explicit "do not associate"', () => {
    expect(personaBindTarget({ teamId: '', associate: false })).toBeNull();
    expect(personaBindTarget({ teamId: '', agentId: '', userId: '', associate: false })).toBeNull();
  });

  it('keeps the current card when a binding attempt did not succeed', () => {
    // 空三元组、但没有「不关联」的意思：候选接口超时 / 弹窗被打断 / 无退回三元组。
    expect(personaBindTarget({ teamId: '' })).toBeUndefined();
    expect(personaBindTarget({ teamId: '', userId: '', agentId: '', associate: true })).toBeUndefined();
  });
});
