import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_QUESTION_ID,
  ASSET_CONFIRM_NO,
  ASSET_CONFIRM_QUESTION_ID,
  ASSET_CONFIRM_YES,
  installSessionIdentity,
  isSkipAnswer,
  SessionIdentityStore,
  SKIP_LABEL,
  TASK_NO_TASK_LABEL,
  TASK_QUESTION_ID,
  TEAM_QUESTION_ID,
  type SessionIdentityDeps,
} from '../src/session-identity.js';
import { createFakeContext, runPreStep } from './helpers/fake-ctx.js';

const tempDirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempStatePath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'agemem-identity-'));
  tempDirs.push(dir);
  return path.join(dir, 'session-identity.json');
}

const BASE = { serviceId: 'default', teamId: 'team-cfg', agentId: 'agt-cfg', userId: 'usr-cfg' };

interface HarnessOptions {
  teams?: Array<{ teamId: string; name?: string }>;
  agents?: Array<{ agentId: string; name?: string }>;
  answers?: (request: any) => any;
  /** What the asset_confirm card answers; default true = 是. */
  assetConfirm?: boolean;
  /** Override the asset_confirm answer (used to gate/throw/timeout it). */
  answersAssetConfirm?: (request: any) => any;
  askTimeoutMs?: number;
  askAtSessionStart?: boolean;
  followUserSessionInit?: boolean;
  /** Work items (Task) offered by the task card; default none. */
  tasks?: Array<{ taskId: string; title?: string }>;
  /** Ask the task card after team/agent; default true (matches DEFAULT_CONFIG). */
  askForTask?: boolean;
  /** What the per-user session_init read returns; default null = unreadable. */
  sessionInit?: Record<string, string> | null;
  getUserSessionInit?: SessionIdentityDeps['getUserSessionInit'];
  resolveUserKey?: () => Promise<string | undefined>;
  getQuestions?: () => any;
  statePath?: string;
  candidates?: SessionIdentityDeps['candidates'];
}

function harness(options: HarnessOptions = {}) {
  const fake = createFakeContext();
  const store = new SessionIdentityStore({ statePath: options.statePath });
  const asks: any[] = [];
  const ask = vi.fn(async (request: any) => {
    asks.push(request);
    // The proxy's asset_confirm question always comes first on the ask path;
    // answering it here keeps every test focused on the card it cares about.
    if (request.questions[0]?.id === ASSET_CONFIRM_QUESTION_ID) {
      if (options.answersAssetConfirm !== undefined) return options.answersAssetConfirm(request);
      const yes = options.assetConfirm ?? true;
      return {
        answers: [{ id: ASSET_CONFIRM_QUESTION_ID, selected: [yes ? ASSET_CONFIRM_YES : ASSET_CONFIRM_NO] }],
      };
    }
    if (options.answers !== undefined) return options.answers(request);
    return { answers: [] };
  });
  const teams = options.teams ?? [{ teamId: 'team-a', name: '北方团队' }];
  const agents = options.agents ?? [{ agentId: 'agt-a', name: '采购助手' }];
  const tasks = options.tasks ?? [];
  const readInit = vi.fn(options.getUserSessionInit
    ?? (async () => (options.sessionInit === undefined ? null : options.sessionInit)));
  const deps: SessionIdentityDeps = {
    settings: {
      askAtSessionStart: options.askAtSessionStart ?? true,
      followUserSessionInit: options.followUserSessionInit ?? true,
      askTimeoutMs: options.askTimeoutMs ?? 60000,
      rememberSession: true,
      skipDefault: false,
      askForTask: options.askForTask ?? true,
      statePath: options.statePath ?? '',
    },
    base: BASE,
    resolveUserKey: options.resolveUserKey ?? (async () => 'user-key-1'),
    candidates: options.candidates ?? (async () => ({ kind: 'ok', userId: 'usr-a', teams, agents, tasks })),
    getUserSessionInit: readInit,
    store,
    getQuestions: options.getQuestions ?? (() => ({ ask })),
    timeoutMs: 500,
    log: fake.ctx.logger,
  };
  const installed = installSessionIdentity(fake.ctx, deps);
  const agent = { session: { id: 'sess-1' } };
  const step = async (sessionId = 'sess-1', signal?: unknown) => {
    const listener = fake.firstListener('agent/pre-step')!;
    return await runPreStep(
      listener,
      { agent: { session: { id: sessionId } }, turn: 1, step: 1, ...(signal === undefined ? {} : { signal }) },
      { kind: 'enter', messages: [] },
    );
  };
  const askIds = (): string[] => asks.map((request) => String(request.questions[0]?.id));
  const countAsks = (id: string): number => askIds().filter((entry) => entry === id).length;
  return { fake, store, ask, asks, askIds, countAsks, readInit, deps, installed, step, agent, logs: fake.logs };
}

/** The four keys a preset profile carries (spec §5 / user-session-init-preset). */
function preset(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    manual_select: '0',
    default_associate: '1',
    default_team_id: 'team-a',
    default_agent_id: 'agt-a',
    ...overrides,
  };
}

describe('session identity store', () => {
  it('round-trips a binding through the state file', () => {
    const statePath = tempStatePath();
    const first = new SessionIdentityStore({ statePath });
    first.set('sess-1', { teamId: 'team-a', agentId: 'agt-a', userId: 'usr-a', source: 'picked', at: 1 });

    const second = new SessionIdentityStore({ statePath });
    expect(second.get('sess-1')).toMatchObject({ teamId: 'team-a', agentId: 'agt-a', source: 'picked' });
    expect(second.hasFileState).toBe(true);
    // No key material in the file: the user key never leaves the process.
    const raw = readFileSync(statePath, 'utf8');
    expect(raw).not.toContain('user-key-1');
    expect(raw).toContain('"version":1');
  });

  it('evicts the OLDEST binding past 200 sessions (a revisit just re-asks)', () => {
    const store = new SessionIdentityStore({});
    for (let index = 0; index < 200; index += 1) {
      store.set('s' + index, { teamId: 't', agentId: 'a', userId: 'u', source: 'picked', at: index });
    }
    store.set('s200', { teamId: 't', agentId: 'a', userId: 'u', source: 'picked', at: 200 });

    expect(store.size).toBe(200);
    // The oldest one is gone; the survivor set is contiguous.
    expect(store.get('s0')).toBeUndefined();
    expect(store.get('s1')?.teamId).toBe('t');
    expect(store.get('s200')).toBeDefined();
  });

  it('survives a corrupt state file and empty session ids', () => {
    const statePath = tempStatePath();
    const store = new SessionIdentityStore({ statePath });
    store.set('', { teamId: 'x', agentId: 'y', userId: 'z', source: 'picked', at: 0 });
    expect(store.size).toBe(0);
    expect(store.get(undefined)).toBeUndefined();
    expect(() => new SessionIdentityStore({ statePath: path.join(statePath, 'missing-dir', 'x.json') })).not.toThrow();
  });
});

describe('isSkipAnswer', () => {
  it('recognises the proxy skip label and free-text skip phrases', () => {
    expect(isSkipAnswer(SKIP_LABEL)).toBe(true);
    expect(isSkipAnswer('跳过')).toBe(true);
    expect(isSkipAnswer('本次跳过')).toBe(true);
    expect(isSkipAnswer('skip this')).toBe(true);
    expect(isSkipAnswer('北方团队 (12345678)')).toBe(false);
    expect(isSkipAnswer('')).toBe(false);
  });
});

describe('installSessionIdentity', () => {
  it('asks team then agent and binds the picked pair', async () => {
    const twoTeams = [
      { teamId: 'team-a', name: '北方团队' },
      { teamId: 'team-b', name: '南方团队' },
    ];
    let scope: string | undefined;
    const h = harness({
      teams: twoTeams,
      agents: [{ agentId: 'agt-x', name: '采购助手' }],
      candidates: async (input) => {
        if (input.teamId === undefined) return { kind: 'ok', userId: 'usr-a', teams: twoTeams };
        scope = input.teamId;
        return { kind: 'ok', userId: 'usr-a', teams: twoTeams, agents: [{ agentId: 'agt-x', name: '采购助手' }] };
      },
      answers: async (request) => ({
        answers: request.questions.map((question: any) => ({
          id: question.id,
          // Pick the SECOND option: index 0 is the first team, 1 the second.
          selected: [question.options[1].label],
        })),
      }),
    });

    await h.step();

    // Two cards: the proxy's asset_confirm first, then the team question.
    expect(h.ask).toHaveBeenCalledTimes(2);
    expect(h.askIds()).toEqual([ASSET_CONFIRM_QUESTION_ID, TEAM_QUESTION_ID]);
    expect(h.asks[1].questions[0].question).toContain('请选择本次会话所属的 Team:');
    expect(h.asks[1].questions[0].options.at(-1).label).toBe(SKIP_LABEL);
    expect(h.asks[1].questions[0].multiSelect).toBe(false);
    expect(scope).toBe('team-b');
    expect(h.store.get('sess-1')).toMatchObject({ teamId: 'team-b', agentId: 'agt-x', userId: 'usr-a', source: 'picked' });
  });

  it('asks only the agent question when the team is unambiguous and two agents exist', async () => {
    const h = harness({
      teams: [{ teamId: 'team-a', name: '北方团队' }],
      agents: [
        { agentId: 'agt-a', name: '采购助手' },
        { agentId: 'agt-b', name: '库存助手' },
      ],
      answers: async (request) => ({
        answers: [{ id: request.questions[0].id, selected: [request.questions[0].options[1].label] }],
      }),
    });

    await h.step();

    // asset_confirm + agent only: the team is unambiguous, so it never asks it.
    expect(h.ask).toHaveBeenCalledTimes(2);
    expect(h.askIds()).toEqual([ASSET_CONFIRM_QUESTION_ID, AGENT_QUESTION_ID]);
    expect(h.asks[1].questions[0].question).toContain('请选择「北方团队」下要使用的 Agent:');
    expect(h.store.get('sess-1')).toMatchObject({ teamId: 'team-a', agentId: 'agt-b', source: 'picked' });
  });

  // The proxy's THIRD stage (task_select): after team + agent, an OPTIONAL work
  // item. A real task becomes taskId; the virtual "no task" option is always
  // first and binds nothing -- it must not undo the team/agent answer.
  it('asks the task question after team+agent and binds the picked work item', async () => {
    const statePath = tempStatePath();
    const h = harness({
      statePath,
      tasks: [
        { taskId: 'task-12345678', title: '燕京 2305 客开' },
        { taskId: 'task-87654321', title: 'DSH 记忆插件' },
      ],
      answers: async (request) => ({
        answers: [{ id: request.questions[0].id, selected: [request.questions[0].options[1].label] }],
      }),
    });

    await h.step();

    expect(h.askIds()).toEqual([ASSET_CONFIRM_QUESTION_ID, TASK_QUESTION_ID]);
    expect(h.asks[1].questions[0].question).toContain('关联哪个工作项（Task）');
    expect(h.asks[1].questions[0].options[0].label).toBe(TASK_NO_TASK_LABEL);
    expect(h.asks[1].questions[0].options[1].label).toBe('燕京 2305 客开 (12345678)');
    expect(h.store.get('sess-1')).toMatchObject({
      teamId: 'team-a',
      agentId: 'agt-a',
      taskId: 'task-12345678',
      source: 'picked',
    });
    // The pick survives a restart: the state file carries it too.
    expect(new SessionIdentityStore({ statePath }).get('sess-1')?.taskId).toBe('task-12345678');
  });

  it('binds team+agent but no task when the user picks 本次不关联任务', async () => {
    const h = harness({
      tasks: [{ taskId: 'task-12345678', title: '燕京 2305 客开' }],
      answers: async (request) => ({
        answers: [{ id: request.questions[0].id, selected: [request.questions[0].options[0].label] }],
      }),
    });

    await h.step();

    expect(h.askIds()).toEqual([ASSET_CONFIRM_QUESTION_ID, TASK_QUESTION_ID]);
    const binding = h.store.get('sess-1');
    // The association still happened: only the optional task axis stays empty,
    // and it is ABSENT rather than '', so headers() sends no task header.
    expect(binding).toMatchObject({ teamId: 'team-a', agentId: 'agt-a', source: 'picked' });
    expect(binding?.taskId).toBeUndefined();
  });

  it('never asks the task question with askForTask=false or with no task candidates', async () => {
    const off = harness({ tasks: [{ taskId: 'task-12345678' }], askForTask: false });
    await off.step();
    expect(off.askIds()).toEqual([ASSET_CONFIRM_QUESTION_ID]);
    expect(off.store.get('sess-1')?.taskId).toBeUndefined();

    const none = harness({ tasks: [] });
    await none.step();
    expect(none.askIds()).toEqual([ASSET_CONFIRM_QUESTION_ID]);
    expect(none.store.get('sess-1')?.taskId).toBeUndefined();
  });

  // THE RED CASE for this change: the card is NOT a function of candidate
  // count. One team and one agent still get asked when the user's session_init
  // says ask -- the old implementation silently bound them (source 'userkey'),
  // which is the bug this task exists to fix.
  it('still asks with ONE team and ONE agent when the user config says ask', async () => {
    const h = harness({ sessionInit: { manual_select: '1' } });

    await h.step();

    expect(h.ask).toHaveBeenCalledTimes(1);
    expect(h.askIds()).toEqual([ASSET_CONFIRM_QUESTION_ID]);
    expect(h.asks[0].questions[0].question).toContain('请确认本次对话是否要关联团队资产？');
    expect(h.store.get('sess-1')).toMatchObject({ teamId: 'team-a', agentId: 'agt-a', source: 'picked' });
    expect(h.installed.status()).toBe('bound(picked)');
  });

  it('binds the user preset silently (preset, no card at all)', async () => {
    const h = harness({ sessionInit: preset() });

    await h.step();

    expect(h.ask).not.toHaveBeenCalled();
    expect(h.store.get('sess-1')).toMatchObject({
      teamId: 'team-a',
      agentId: 'agt-a',
      userId: 'usr-a',
      source: 'user-preset',
    });
    expect(h.installed.status()).toBe('bound(user-preset)');
  });

  it('uses the team\'s single agent when the preset carries no agent id', async () => {
    const h = harness({
      sessionInit: preset({ default_agent_id: '' }),
      agents: [{ agentId: 'agt-only', name: '唯一助手' }],
    });

    await h.step();

    expect(h.ask).not.toHaveBeenCalled();
    expect(h.store.get('sess-1')).toMatchObject({ teamId: 'team-a', agentId: 'agt-only', source: 'user-preset' });
  });

  it('warns once and falls back to the card when the preset team is not the user\'s', async () => {
    const h = harness({ sessionInit: preset({ default_team_id: 'team-someone-else' }) });

    await h.step();

    expect(h.askIds()[0]).toBe(ASSET_CONFIRM_QUESTION_ID);
    expect(h.store.get('sess-1')?.source).toBe('picked');
    const warns = h.logs.filter((line) => line.startsWith('warn'));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('session_init');
  });

  it('falls back to the card when the preset agent is not in the team (or ambiguous)', async () => {
    const staleAgent = harness({ sessionInit: preset({ default_agent_id: 'agt-gone' }) });
    await staleAgent.step();
    expect(staleAgent.askIds()[0]).toBe(ASSET_CONFIRM_QUESTION_ID);
    expect(staleAgent.store.get('sess-1')?.source).not.toBe('user-preset');

    // No agent id + TWO agents in the team is equally ambiguous, so the card
    // takes over (the first option is picked here just to finish the flow).
    const ambiguous = harness({
      sessionInit: preset({ default_agent_id: '' }),
      agents: [
        { agentId: 'agt-a', name: '采购助手' },
        { agentId: 'agt-b', name: '库存助手' },
      ],
      answers: async (request) => ({
        answers: [{ id: request.questions[0].id, selected: [request.questions[0].options[0].label] }],
      }),
    });
    await ambiguous.step();
    expect(ambiguous.askIds()).toEqual([ASSET_CONFIRM_QUESTION_ID, AGENT_QUESTION_ID]);
    expect(ambiguous.store.get('sess-1')?.source).toBe('picked');
  });

  it('associates NOTHING on default_associate=0 (bypass: no card, empty triple)', async () => {
    const h = harness({ sessionInit: preset({ default_associate: '0' }) });

    await h.step();

    expect(h.ask).not.toHaveBeenCalled();
    // The empty triple is the point: memory-client.missingIdentity() then
    // reports 'teamId' and every data call is skipped instead of falling back
    // to the CONFIGURED team's pool.
    expect(h.store.get('sess-1')).toMatchObject({ teamId: '', agentId: '', userId: '', source: 'user-bypass' });
    expect(h.installed.status()).toBe('bound(user-bypass)');
  });

  it('associates nothing when the user answers 否 (skipped, empty triple)', async () => {
    const h = harness({ assetConfirm: false });

    await h.step();
    await h.step();

    expect(h.ask).toHaveBeenCalledTimes(1);
    expect(h.store.get('sess-1')).toMatchObject({ teamId: '', agentId: '', userId: '', source: 'skipped' });
    expect(h.store.get('sess-1')?.reason).toContain('不关联');
    expect(h.installed.status()).toBe('bound(skipped)');
  });

  it('reads the user config ONCE per session (and not at all when the card is off)', async () => {
    const h = harness({ sessionInit: preset() });
    await h.step();
    await h.step();
    await h.step('sess-1');
    expect(h.readInit).toHaveBeenCalledTimes(1);

    const off = harness({ askAtSessionStart: false, sessionInit: preset() });
    await off.step();
    expect(off.readInit).not.toHaveBeenCalled();
    expect(off.ask).not.toHaveBeenCalled();
  });

  it('does not ask twice for one session (the card lands once, not per step)', async () => {
    const h = harness({
      teams: [
        { teamId: 'team-a', name: 'A' },
        { teamId: 'team-b', name: 'B' },
      ],
      answers: async () => ({ answers: [{ id: TEAM_QUESTION_ID, selected: [SKIP_LABEL] }] }),
    });

    await h.step();
    await h.step();
    await h.step('sess-1');

    expect(h.ask).toHaveBeenCalledTimes(2);
    expect(h.countAsks(ASSET_CONFIRM_QUESTION_ID)).toBe(1);
    expect(h.store.get('sess-1')?.source).toBe('skipped');
    // A skipped session still has a binding: it must not pop again next turn.
    expect(h.store.get('sess-1')?.reason).toContain('skip');
  });

  it('treats a free-text skip as a skip (the input box is a valid answer)', async () => {
    const h = harness({
      teams: [
        { teamId: 'team-a', name: 'A' },
        { teamId: 'team-b', name: 'B' },
      ],
      answers: async () => ({ answers: [{ id: TEAM_QUESTION_ID, selected: [], custom: '跳过' }] }),
    });

    await h.step();

    expect(h.store.get('sess-1')?.source).toBe('skipped');
  });

  it('asks once for two concurrent pre-steps of the same session (hard requirement C)', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = harness({
      teams: [
        { teamId: 'team-a', name: 'A' },
        { teamId: 'team-b', name: 'B' },
      ],
      answers: async () => {
        await gate;
        return { answers: [{ id: TEAM_QUESTION_ID, selected: [SKIP_LABEL] }] };
      },
    });

    const first = h.step();
    const second = h.step();
    await vi.waitFor(() => { expect(h.ask).toHaveBeenCalled(); });
    release?.();
    await Promise.all([first, second]);

    expect(h.ask).toHaveBeenCalledTimes(2);
    expect(h.store.get('sess-1')?.source).toBe('skipped');
    // Concurrency must not multiply the metadata round-trip either: the same
    // inFlight de-dupe that makes one card also makes one config read.
    expect(h.readInit).toHaveBeenCalledTimes(1);
  });

  it('skips silently for a delegated caller (no human answerer, no warn)', async () => {
    const delegated = Object.assign(new Error('an owned child has no human answerer and would block forever'), {
      code: 'DELEGATED_CALLER',
    });
    const h = harness({
      teams: [
        { teamId: 'team-a', name: 'A' },
        { teamId: 'team-b', name: 'B' },
      ],
      answers: async () => { throw delegated; },
    });

    await expect(h.step()).resolves.toBeDefined();

    expect(h.store.get('sess-1')?.source).toBe('skipped');
    expect(h.store.get('sess-1')?.reason).toContain('delegated');
    expect(h.logs.filter((line) => line.startsWith('warn'))).toHaveLength(0);
  });

  it('warns once and carries on when the host has no question service', async () => {
    const h = harness({
      teams: [
        { teamId: 'team-a', name: 'A' },
        { teamId: 'team-b', name: 'B' },
      ],
      getQuestions: () => undefined,
    });

    await h.step();
    await h.step('sess-2');

    const warns = h.logs.filter((line) => line.startsWith('warn'));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('userQuestions');
    expect(h.store.get('sess-1')?.source).toBe('skipped');
  });

  it('stays inert (and silent) when no user key is available', async () => {
    const h = harness({ resolveUserKey: async () => undefined });

    await h.step();

    expect(h.ask).not.toHaveBeenCalled();
    expect(h.store.get('sess-1')).toBeUndefined();
    expect(h.installed.status()).toBe('inert(no-key)');
  });

  it('times out the card and records a skip instead of parking the turn', async () => {
    vi.useFakeTimers();
    const h = harness({
      askTimeoutMs: 1000,
      teams: [
        { teamId: 'team-a', name: 'A' },
        { teamId: 'team-b', name: 'B' },
      ],
      answers: async (request) => new Promise((_resolve, reject) => {
        request.signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      }),
    });

    const pending = h.step();
    await vi.advanceTimersByTimeAsync(1000);
    await pending;

    expect(h.store.get('sess-1')?.source).toBe('skipped');
    expect(h.store.get('sess-1')?.reason).toContain('abort');
  });

  it('does nothing at all when askAtSessionStart is false', async () => {
    const h = harness({ askAtSessionStart: false });

    await h.step();

    expect(h.ask).not.toHaveBeenCalled();
    expect(h.store.size).toBe(0);
    expect(h.installed.status()).toBe('off(config)');
  });

  it('records a skip when the metadata routes fail, so it is not retried every turn', async () => {
    const h = harness({ candidates: async () => ({ kind: 'failed', reason: 'core said 503' }) });

    await h.step();

    expect(h.store.get('sess-1')).toMatchObject({ source: 'skipped', reason: 'candidates failed: core said 503' });
  });

  it('still reports the session id when the card is off (one identity per turn)', async () => {
    const seen: string[] = [];
    const fake = createFakeContext();
    const store = new SessionIdentityStore({});
    const ask = vi.fn(async () => ({ answers: [] }));
    installSessionIdentity(fake.ctx, {
      settings: { askAtSessionStart: false, followUserSessionInit: true, askTimeoutMs: 1000, rememberSession: true, skipDefault: false, statePath: '' },
      base: BASE,
      resolveUserKey: async () => 'user-key-1',
      candidates: async () => ({ kind: 'ok', userId: 'usr-a', teams: [{ teamId: 'team-a' }] }),
      store,
      getQuestions: () => ({ ask }),
      timeoutMs: 500,
      onSessionSeen: (sessionId) => seen.push(sessionId),
    });

    await runPreStep(
      fake.firstListener('agent/pre-step')!,
      { agent: { session: { id: 'sess-off' } }, turn: 1 },
      { kind: 'enter', messages: [] },
    );

    expect(seen).toEqual(['sess-off']);
    expect(ask).not.toHaveBeenCalled();
    expect(store.size).toBe(0);
  });

  it('reports an already-bound session before short-circuiting', async () => {
    const seen: string[] = [];
    const fake = createFakeContext();
    const store = new SessionIdentityStore({});
    store.set('sess-bound', { teamId: 'team-a', agentId: 'agt-a', userId: 'usr-a', source: 'picked', at: 1 });
    const ask = vi.fn(async () => ({ answers: [] }));
    installSessionIdentity(fake.ctx, {
      settings: { askAtSessionStart: true, followUserSessionInit: true, askTimeoutMs: 1000, rememberSession: true, skipDefault: false, statePath: '' },
      base: BASE,
      resolveUserKey: async () => 'user-key-1',
      candidates: async () => ({ kind: 'ok', userId: 'usr-a', teams: [{ teamId: 'team-a' }] }),
      store,
      getQuestions: () => ({ ask }),
      timeoutMs: 500,
      onSessionSeen: (sessionId) => seen.push(sessionId),
    });

    await runPreStep(
      fake.firstListener('agent/pre-step')!,
      { agent: { session: { id: 'sess-bound' } }, turn: 1 },
      { kind: 'enter', messages: [] },
    );

    expect(seen).toEqual(['sess-bound']);
    expect(ask).not.toHaveBeenCalled();
  });
  it('puts the skip option first when skipDefault is on', async () => {
    const fake = createFakeContext();
    const store = new SessionIdentityStore({});
    const asks: any[] = [];
    const ask = vi.fn(async (request: any) => {
      asks.push(request);
      // asset_confirm first (answer 是), then the team question (answer skip).
      if (request.questions[0]?.id === ASSET_CONFIRM_QUESTION_ID) {
        return { answers: [{ id: ASSET_CONFIRM_QUESTION_ID, selected: [ASSET_CONFIRM_YES] }] };
      }
      return { answers: [{ id: TEAM_QUESTION_ID, selected: [SKIP_LABEL] }] };
    });
    installSessionIdentity(fake.ctx, {
      settings: {
        askAtSessionStart: true,
        followUserSessionInit: true,
        askTimeoutMs: 1000,
        rememberSession: false,
        skipDefault: true,
        statePath: '',
      },
      base: BASE,
      resolveUserKey: async () => 'user-key-1',
      candidates: async () => ({
        kind: 'ok',
        userId: 'usr-a',
        teams: [
          { teamId: 'team-a', name: 'A' },
          { teamId: 'team-b', name: 'B' },
        ],
      }),
      store,
      getQuestions: () => ({ ask }),
      timeoutMs: 500,
    });
    await runPreStep(
      fake.firstListener('agent/pre-step')!,
      { agent: { session: { id: 'sess-9' } }, turn: 1 },
      { kind: 'enter', messages: [] },
    );
    const teamQuestion = asks.find((request) => request.questions[0]?.id === TEAM_QUESTION_ID);
    expect(teamQuestion).toBeDefined();
    expect(teamQuestion.questions[0].options[0].label).toBe(SKIP_LABEL);
  });
});
