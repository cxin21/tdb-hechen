import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  branchParentOf,
  cardClearedSource,
  installSessionIdentity,
  isCandidatesFailure,
  isCandidatesTransportSkip,
  isStaleForRetry,
  isProvisionalDecline,
  isUnresolvedBinding,
  SessionIdentityStore,
  NO_TASK_LABEL,
  SKIP_RETRY_MIN_AGE_MS,
  UNRESOLVED_RETRY_MIN_AGE_MS,
  type SessionIdentityDeps,
} from '../src/session-identity.js';
import { createFakeContext, runPreStep } from './helpers/fake-ctx.js';

describe('cardClearedSource（r26e-a1：清卡归因只在一处判）', () => {
  it('associate=false 才是用户的决定', () => {
    expect(cardClearedSource({ associate: false })).toBe('declined');
  });
  it('有绑定但三元组为空 = 配置缺口，不是用户拒绝', () => {
    expect(cardClearedSource({ associate: true })).toBe('unconfigured');
    expect(cardClearedSource({})).toBe('unconfigured');
  });
  it('根本没有绑定 = 配置缺口（旧实现记成「用户不关联」）', () => {
    expect(cardClearedSource(undefined)).toBe('unconfigured');
  });
});

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
  agents?: Array<{ agentId: string; name?: string; description?: string }>;
  tasks?: Array<{ taskId: string; title?: string }>;
  /** What the per-user session_init read returns; default null = unreadable. */
  sessionInit?: Record<string, string> | null;
  getUserSessionInit?: SessionIdentityDeps['getUserSessionInit'];
  resolveUserKey?: () => Promise<string | undefined>;
  statePath?: string;
  candidates?: SessionIdentityDeps['candidates'];
  /** Fixed clock (P0-2 tests drive the skip-retry threshold deterministically). */
  now?: () => number;
  /** The chip transport switch (identity.enabled). */
  enabled?: boolean;
  followUserSessionInit?: boolean;
  /** B11: 宿主 UI 分支不写 header.parentSession，父 id 由插件从 plugin record 解析后同步给出。 */
  knownBranchParent?: (agent: unknown) => string | undefined;
}

/**
 * v4（task-117 / m08428）：**没有 userQuestions 桩了**。解析全程静默，唯一的
 * 人类输入是 composer 里那个 chip，它通过 choose() 只 stage，不 bind。
 */
function harness(options: HarnessOptions = {}) {
  const fake = createFakeContext();
  const store = new SessionIdentityStore({ statePath: options.statePath });
  const seen: string[] = [];
  const bound: string[] = [];
  const teams = options.teams ?? [{ teamId: 'team-a', name: '北方团队' }];
  const agents = options.agents ?? [{ agentId: 'agt-a', name: '采购助手' }];
  const tasks = options.tasks ?? [];
  const readInit = vi.fn(options.getUserSessionInit
    ?? (async () => (options.sessionInit === undefined ? null : options.sessionInit)));
  const deps: SessionIdentityDeps = {
    settings: {
      enabled: options.enabled ?? true,
      followUserSessionInit: options.followUserSessionInit ?? true,
      rememberSession: true,
      statePath: options.statePath ?? '',
    },
    base: BASE,
    resolveUserKey: options.resolveUserKey ?? (async () => 'user-key-1'),
    candidates: options.candidates ?? (async () => ({ kind: 'ok', userId: 'usr-a', teams, agents, tasks })),
    getUserSessionInit: readInit,
    store,
    timeoutMs: 500,
    log: fake.ctx.logger,
    onSessionSeen: (sessionId) => { seen.push(sessionId); },
    onBound: (_sessionId, binding) => { bound.push(binding.source); },
    now: options.now,
    ...(options.knownBranchParent === undefined ? {} : { knownBranchParent: options.knownBranchParent }),
  };
  const installed = installSessionIdentity(fake.ctx, deps);
  const step = async (sessionId = 'sess-1', signal?: unknown) => {
    const listener = fake.firstListener('agent/pre-step')!;
    return await runPreStep(
      listener,
      { agent: { session: { id: sessionId } }, turn: 1, step: 1, ...(signal === undefined ? {} : { signal }) },
      { kind: 'enter', messages: [] },
    );
  };
  const warnings = (): string[] => fake.logs.filter((line) => line.startsWith('warn'));
  const debugLines = (): string[] => fake.logs.filter((line) => line.startsWith('debug'));
  return { fake, store, readInit, deps, installed, step, seen, bound, warnings, debugLines, logs: fake.logs };
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
    first.set('sess-1', {
      teamId: 'team-a',
      agentId: 'agt-a',
      userId: 'usr-a',
      source: 'chip',
      at: 1,
      committedAt: 1,
    });

    const second = new SessionIdentityStore({ statePath });
    expect(second.get('sess-1')).toMatchObject({ teamId: 'team-a', agentId: 'agt-a', source: 'chip' });
    // I1 must survive a process restart: the freeze flag is what stops a restored
    // conversation from being re-resolved into a different agent's library.
    expect(second.get('sess-1')?.committedAt).toBe(1);
  });

  it('keeps a legacy row without committedAt unfrozen (so it still gets its one heal)', () => {
    const statePath = tempStatePath();
    const first = new SessionIdentityStore({ statePath });
    first.set('sess-legacy', { teamId: 'team-a', agentId: 'agt-a', userId: 'usr-a', source: 'picked', at: 1 });

    const second = new SessionIdentityStore({ statePath });
    expect(second.get('sess-legacy')).toBeDefined();
    expect(second.get('sess-legacy')?.committedAt).toBeUndefined();
    expect(second.hasFileState).toBe(true);
    // No key material in the file: the user key never leaves the process.
    const raw = readFileSync(statePath, 'utf8');
    expect(raw).not.toContain('user-key-1');
    expect(raw).toContain('"version":1');
  });

  it('evicts the OLDEST binding past 200 sessions (a revisit just re-resolves)', () => {
    const store = new SessionIdentityStore({});
    for (let index = 0; index < 200; index += 1) {
      store.set('s' + index, { teamId: 't', agentId: 'a', userId: 'u', source: 'chip', at: index });
    }
    store.set('s200', { teamId: 't', agentId: 'a', userId: 'u', source: 'chip', at: 200 });

    expect(store.size).toBe(200);
    // The oldest one is gone; the survivor set is contiguous.
    expect(store.get('s0')).toBeUndefined();
    expect(store.get('s1')?.teamId).toBe('t');
    expect(store.get('s200')).toBeDefined();
  });

  it('survives a corrupt state file and empty session ids', () => {
    const statePath = tempStatePath();
    const store = new SessionIdentityStore({ statePath });
    store.set('', { teamId: 'x', agentId: 'y', userId: 'z', source: 'chip', at: 0 });
    expect(store.size).toBe(0);
    expect(store.get(undefined)).toBeUndefined();
    expect(() => new SessionIdentityStore({ statePath: path.join(statePath, 'missing-dir', 'x.json') })).not.toThrow();
  });
});

describe('installSessionIdentity — 静默解析（v4：没有弹窗）', () => {
  it('单 team 单 agent 且无 preset：静默 auto 绑定，全程不问人', async () => {
    const h = harness();

    await h.step();

    expect(h.store.get('sess-1')).toMatchObject({
      teamId: 'team-a', agentId: 'agt-a', userId: 'usr-a', source: 'auto',
    });
    expect(h.installed.status()).toBe('bound(auto)');
    expect(h.seen).toEqual(['sess-1']);
  });

  it('多 team 且用户没点 chip：按「本次不关联」写空三元组，绝不猜配置的 team', async () => {
    const h = harness({
      teams: [{ teamId: 'team-a', name: '北方团队' }, { teamId: 'team-b', name: '南方团队' }],
    });

    await h.step();

    expect(h.store.get('sess-1')).toMatchObject({
      teamId: '', agentId: '', userId: '', source: 'skipped', associate: false,
    });
    expect(h.store.get('sess-1')?.reason).toContain('the composer chip was not used');
  });

  it('preset 静默绑定，并且压过多 team 的歧义', async () => {
    const h = harness({
      teams: [{ teamId: 'team-a', name: '北方团队' }, { teamId: 'team-b', name: '南方团队' }],
      sessionInit: preset(),
    });

    await h.step();

    expect(h.store.get('sess-1')).toMatchObject({
      teamId: 'team-a', agentId: 'agt-a', userId: 'usr-a', source: 'user-preset',
    });
    expect(h.readInit).toHaveBeenCalledTimes(1);
  });

  it('preset 的 team 不是这个人的：warn 一次，回落到静默解析', async () => {
    const h = harness({
      teams: [{ teamId: 'team-b', name: '南方团队' }],
      sessionInit: preset(),
    });

    await h.step();
    expect(h.warnings()).toHaveLength(1);
    expect(h.warnings()[0]).toContain('default_team_id team-a');
    expect(h.store.get('sess-1')).toMatchObject({ teamId: 'team-b', agentId: 'agt-a', source: 'auto' });

    // The warn is once per install, not once per session.
    await h.step('sess-2');
    expect(h.warnings()).toHaveLength(1);
  });

  it('preset 的 agent 不在 team 里：warn 一次，回落到静默解析', async () => {
    const h = harness({
      agents: [{ agentId: 'agt-a', name: '采购助手' }, { agentId: 'agt-b', name: '库存助手' }],
      sessionInit: preset({ default_agent_id: 'agt-missing' }),
    });

    await h.step();

    expect(h.warnings()).toHaveLength(1);
    expect(h.warnings()[0]).toContain('default_agent_id agt-missing');
    // Two agents and no matching configured id -> the rule is 本次不关联.
    expect(h.store.get('sess-1')).toMatchObject({ teamId: '', agentId: '', source: 'skipped' });
  });

  it('preset 没带 agent id 且 team 只有一个 agent：绑它', async () => {
    const h = harness({ sessionInit: preset({ default_agent_id: '' }) });

    await h.step();

    expect(h.store.get('sess-1')).toMatchObject({ agentId: 'agt-a', source: 'user-preset' });
  });

  it('default_associate=0（bypass）：空三元组，一个数据面调用都不发', async () => {
    const h = harness({ sessionInit: { manual_select: '0', default_associate: '0' } });

    await h.step();

    expect(h.store.get('sess-1')).toMatchObject({
      teamId: '', agentId: '', userId: '', source: 'user-bypass', associate: false,
    });
    // Bypass is decided AFTER candidates (the user's teams must be verified),
    // but before anything is bound: the config read is the only extra call.
    expect(h.readInit).toHaveBeenCalledTimes(1);
  });

  it('同一个会话只读一次 session_init（绑定写入后短路）', async () => {
    const h = harness();

    await h.step();
    await h.step();
    await h.step();

    expect(h.readInit).toHaveBeenCalledTimes(1);
  });

  it('一个 turn 的两个并发 pre-step 只解析一次', async () => {
    let calls = 0;
    const h = harness({
      candidates: async () => {
        calls += 1;
        await new Promise((resolve) => { setTimeout(resolve, 5); });
        return { kind: 'ok', userId: 'usr-a', teams: [{ teamId: 'team-a' }], agents: [{ agentId: 'agt-a' }] };
      },
    });

    await Promise.all([h.step(), h.step()]);

    expect(calls).toBe(1);
    expect(h.store.get('sess-1')).toMatchObject({ teamId: 'team-a', source: 'auto' });
  });

  it('开关关闭（identity.enabled=false）：不解析，但仍上报 session id', async () => {
    let calls = 0;
    const h = harness({
      enabled: false,
      candidates: async () => {
        calls += 1;
        return { kind: 'ok', userId: 'usr-a', teams: [{ teamId: 'team-a' }], agents: [{ agentId: 'agt-a' }] };
      },
    });

    await h.step();

    expect(calls).toBe(0);
    expect(h.store.get('sess-1')).toBeUndefined();
    expect(h.installed.status()).toBe('off(config)');
    // One identity per turn: the rest of the plugin still learns the session id.
    expect(h.seen).toEqual(['sess-1']);
  });

  it('没有 user key：inert，不绑定也不打网络', async () => {
    let calls = 0;
    const h = harness({
      resolveUserKey: async () => undefined,
      candidates: async () => {
        calls += 1;
        return { kind: 'ok', userId: 'usr-a', teams: [], agents: [] };
      },
    });

    await h.step();

    expect(calls).toBe(0);
    expect(h.store.get('sess-1')).toBeUndefined();
    expect(h.installed.status()).toBe('inert(no-key)');
  });

  it('候选拉取失败：不写任何记录（未解析 ≠ 用户拒绝），只在内存里挂退避', async () => {
    const h = harness({ candidates: async () => ({ kind: 'failed', reason: 'core said 503' }) });

    await h.step();

    // D3/I4: a failed READ is not a decision. Writing a skipped row here made the
    // session permanently unidentifiable -- a 3s core blip froze the whole session
    // and every branch of it, and the row outlived restarts.
    expect(h.store.get('sess-1')).toBeUndefined();
    expect(h.installed.status()).toContain('unresolved(');
    expect(h.installed.status()).toContain('candidates failed: core said 503');
    // The absence is visible to the chip, so it keeps offering the picker.
    const state = await h.installed.describe('sess-1');
    expect(state.unresolved).toBe(true);
    expect(state.bound).toBeUndefined();
    // Writebacks are held, not dead-lettered, while the answer is in flight.
    expect(h.installed.writebackPolicy('sess-1')).toBe('defer');
  });

  it('一次瞬时传输失败会重试一次（只有传输层/超时才重试）', async () => {
    let calls = 0;
    const h = harness({
      candidates: async () => {
        calls += 1;
        return calls === 1
          ? { kind: 'failed', reason: 'transport failure: fetch failed' }
          : { kind: 'ok', userId: 'usr-a', teams: [{ teamId: 'team-a' }], agents: [{ agentId: 'agt-a' }] };
      },
    });

    await h.step();

    expect(calls).toBe(2);
    expect(h.store.get('sess-1')).toMatchObject({ teamId: 'team-a', source: 'auto' });
  });

  it('分支会话没有记录：继承语义的空三元组，且不为分支单独打网络', async () => {
    let calls = 0;
    const h = harness({
      candidates: async () => {
        calls += 1;
        return { kind: 'ok', userId: 'usr-a', teams: [{ teamId: 'team-a' }], agents: [{ agentId: 'agt-a' }] };
      },
    });

    const childAgent = { session: { id: 'child-1', header: { parentSession: 'parent-1' } } };
    await h.installed.ensureBound(childAgent);

    expect(calls).toBe(0);
    // 分支没有自己的记录：先落一条开放的空行（associate:false + 无 committedAt），
    // reason 里写着父会话 id —— 父会话稍后绑上时，reconcileExisting 靠它把三元组
    // 补进来，不需要分支自己发一次网络请求。
    expect(h.store.get('child-1')).toMatchObject({
      teamId: '', agentId: '', userId: '', source: 'inherited', associate: false,
    });
    expect(h.store.get('child-1')?.reason).toBe('branch of parent-1');
    expect(h.store.get('child-1')?.committedAt).toBeUndefined();
  });

  it('歧义但本机只有一个历史选择：auto 复用它（不是替用户猜）', async () => {
    const h = harness({
      teams: [{ teamId: 'team-a' }, { teamId: 'team-b' }],
      agents: [{ agentId: 'agt-a' }, { agentId: 'agt-b' }],
    });
    h.store.set('sess-old', {
      teamId: 'team-b', agentId: 'agt-b', userId: 'usr-a', source: 'chip', at: 1,
    });

    await h.step();

    expect(h.store.get('sess-1')).toMatchObject({
      teamId: 'team-b', agentId: 'agt-b', userId: 'usr-a', source: 'auto',
    });
  });
});

describe('installSessionIdentity — composer chip', () => {
  it('chip 的选择在首轮落绑定（含 task 轴），之后只读', async () => {
    const h = harness({
      teams: [{ teamId: 'team-a', name: '北方团队' }, { teamId: 'team-b', name: '南方团队' }],
    });

    h.installed.choose('sess-1', { teamId: 'team-b', agentId: 'agt-a', taskId: 'task-1' });
    await h.step();

    expect(h.store.get('sess-1')).toMatchObject({
      teamId: 'team-b', agentId: 'agt-a', taskId: 'task-1', userId: 'usr-a', source: 'chip',
    });
    expect(h.bound).toEqual(['chip']);

    // 进会话后不可改：已绑定写不回，chip 退化成标签。
    h.installed.choose('sess-1', { teamId: 'team-a', agentId: 'agt-a' });
    await h.step();
    expect(h.store.get('sess-1')).toMatchObject({ teamId: 'team-b', source: 'chip' });
  });

  it('chip 选「本次不关联」：user-declined 的空三元组', async () => {
    const h = harness();

    h.installed.choose('sess-1', { teamId: '', agentId: '', associate: false });
    await h.step();

    expect(h.store.get('sess-1')).toMatchObject({
      teamId: '', agentId: '', userId: '', source: 'user-declined', associate: false,
    });
  });

  // 顺序缺陷（Round43 复核发现）：preset 先于 chip 判定时，账号一旦配了
  // default_agent_id，面板里「本次不关联」就永远走不到 —— 而「有默认 agent 时
  // 仍允许显式不关联」正是那个面板存在的理由。chip 是本会话的当场决定，压过
  // 账号级缺省。
  it('chip 显式选的 team/agent 压过 session_init preset', async () => {
    const h = harness({
      teams: [{ teamId: 'team-a', name: '北方团队' }, { teamId: 'team-b', name: '南方团队' }],
      sessionInit: preset(),
    });

    h.installed.choose('sess-1', { teamId: 'team-b', agentId: 'agt-b' });
    await h.step();

    expect(h.store.get('sess-1')).toMatchObject({
      teamId: 'team-b', agentId: 'agt-b', userId: 'usr-a', source: 'chip',
    });
    // preset 根本没被读：这一轮不需要它，读它就是白花一次 HTTP。
    expect(h.readInit).toHaveBeenCalledTimes(0);
  });

  it('有 preset 默认 agent 时，chip 的「本次不关联」仍然生效', async () => {
    const h = harness({ sessionInit: preset() });

    h.installed.choose('sess-1', { teamId: '', agentId: '', associate: false });
    await h.step();

    expect(h.store.get('sess-1')).toMatchObject({
      teamId: '', agentId: '', userId: '', source: 'user-declined', associate: false,
    });
  });

  it('B2：有默认 agent 时点「本次不关联」，之后每轮都不被 preset 顶回来', async () => {
    // 2026-11-22 现场（用户 m09526 的同型抱怨的反面）：拒绝必须比缺省硬。
    // 只断言第一轮不够 —— preset 是每轮都读得到的，会被顺手写回去的正是
    // 「某一轮 ensureBound 又跑了一次 resolveSilently」。
    const clock = 1_800_000_000_000;
    const h = harness({ sessionInit: preset(), now: () => clock });

    h.installed.choose('sess-1', { teamId: '', agentId: '', associate: false });
    await h.step();
    expect(h.store.get('sess-1')).toMatchObject({
      teamId: '', agentId: '', userId: '', source: 'user-declined', associate: false,
    });
    expect(h.store.get('sess-1')?.committedAt).toBe(clock);

    await h.step();
    await h.step();

    expect(h.store.get('sess-1')).toMatchObject({ teamId: '', agentId: '', source: 'user-declined' });
    // 拒绝过的会话既不排队也不重放：这是用户的话，不是待办。
    expect(h.installed.writebackPolicy('sess-1')).toBe('skip');
  });

  it('已绑定的会话再 choose：忽略（首写为准）', async () => {
    const h = harness();
    h.store.set('sess-1', {
      teamId: 'team-a', agentId: 'agt-a', userId: 'usr-a', source: 'user-preset', at: 1, committedAt: 1,
    });

    h.installed.choose('sess-1', { teamId: 'team-b', agentId: 'agt-b' });
    await h.step();

    expect(h.store.get('sess-1')).toMatchObject({ teamId: 'team-a', agentId: 'agt-a', source: 'user-preset' });
    expect(h.bound).toEqual([]);
  });

  it('空 sessionId 的 choose：忽略，后续会话仍走静默解析', async () => {
    const h = harness();

    h.installed.choose('', { teamId: 'team-b', agentId: 'agt-b' });
    await h.step();

    expect(h.store.get('sess-1')).toMatchObject({ teamId: 'team-a', source: 'auto' });
  });
});

describe('installSessionIdentity — describe（面板数据，只读）', () => {
  it('没有 user key：inert，面板不画候选', async () => {
    const h = harness({ resolveUserKey: async () => undefined });

    const state = await h.installed.describe('sess-1');

    expect(state.status).toBe('inert');
    expect(state.teams).toEqual([]);
    expect(state.agents).toEqual([]);
  });

  it('候选不可达：failed + reason（面板据此禁用确定按钮）', async () => {
    const h = harness({ candidates: async () => ({ kind: 'failed', reason: 'core said 503' }) });

    const state = await h.installed.describe('sess-1');

    expect(state.status).toBe('failed');
    expect(state.reason).toBe('core said 503');
  });

  it('preset 指定的 agent 标 locked（名称与 id 只显示不可选），其它 agent 可选', async () => {
    const h = harness({
      teams: [{ teamId: 'team-a', name: '北方团队' }, { teamId: 'team-b', name: '南方团队' }],
      agents: [
        { agentId: 'agt-a', name: '采购助手' },
        { agentId: 'agt-b', name: '库存助手', description: '盯库存' },
      ],
      sessionInit: preset({ default_agent_id: 'agt-b' }),
    });

    const state = await h.installed.describe('sess-1');

    expect(state.status).toBe('ok');
    expect(state.teamId).toBe('team-a');
    expect(state.teams.map((option) => option.id)).toEqual(['team-a', 'team-b']);
    const locked = state.agents.filter((option) => option.locked === true);
    expect(locked.map((option) => option.id)).toEqual(['agt-b']);
    expect(locked[0].label).toContain('库存助手');
    expect(state.agents.filter((option) => option.locked !== true).map((option) => option.id)).toEqual(['agt-a']);
    expect(state.agents.find((option) => option.id === 'agt-b')?.detail).toBe('盯库存');
  });

  it('chip 已 stage：面板跟着 staged 走，preset 默认 agent 不再锁死（用户已当场推翻账号缺省）', async () => {
    const h = harness({
      teams: [{ teamId: 'team-a', name: '北方团队' }, { teamId: 'team-b', name: '南方团队' }],
      agents: [
        { agentId: 'agt-a', name: '采购助手' },
        { agentId: 'agt-b', name: '库存助手' },
      ],
      sessionInit: preset({ default_agent_id: 'agt-b' }),
    });
    h.installed.choose('sess-1', { teamId: 'team-b', agentId: 'agt-a' });

    const state = await h.installed.describe('sess-1');

    expect(state.teamId).toBe('team-b');
    expect(state.staged).toMatchObject({ teamId: 'team-b', agentId: 'agt-a' });
    // 锁死只表达「账号缺省」，用户已经选了就不再锁——否则面板会把人困在
    // 他刚刚推翻的那个 agent 上。
    expect(state.agents.filter((option) => option.locked === true)).toEqual([]);
  });

  it('多 team 未指定 teamId：先不列 agent；指定后按那个 team 取 agents/tasks', async () => {
    const teams = [{ teamId: 'team-a', name: '北方团队' }, { teamId: 'team-b', name: '南方团队' }];
    const h = harness({
      teams,
      candidates: async (input) => (input.teamId === undefined
        ? { kind: 'ok', userId: 'usr-a', teams }
        : {
          kind: 'ok',
          userId: 'usr-a',
          teams,
          agents: [{ agentId: 'agt-b', name: '库存助手' }],
          tasks: [{ taskId: 'task-9', title: '补货' }],
        }),
    });

    const unscoped = await h.installed.describe('sess-1');
    expect(unscoped.teamId).toBe('');
    expect(unscoped.teams).toHaveLength(2);
    expect(unscoped.agents).toEqual([]);
    expect(unscoped.tasks).toEqual([]);

    const scoped = await h.installed.describe('sess-1', 'team-b');
    expect(scoped.teamId).toBe('team-b');
    expect(scoped.agents.map((option) => option.id)).toEqual(['agt-b']);
    expect(scoped.tasks.map((option) => option.id)).toEqual(['task-9']);
  });

  it('任务列表里「本次不关联任务」由面板自己加，describe 只给真实候选', async () => {
    const h = harness({ tasks: [{ taskId: 'task-1', title: '补货' }] });

    const state = await h.installed.describe('sess-1');

    expect(state.tasks.map((option) => option.id)).toEqual(['task-1']);
    expect(state.tasks.some((option) => option.label === NO_TASK_LABEL)).toBe(false);
  });

  it('已绑定的会话把绑定带回来（chip 退化为只读标签）', async () => {
    const h = harness();
    h.store.set('sess-1', {
      teamId: 'team-a', agentId: 'agt-a', userId: 'usr-a', source: 'chip', at: 5,
    });

    const state = await h.installed.describe('sess-1');

    expect(state.bound).toMatchObject({ teamId: 'team-a', agentId: 'agt-a', source: 'chip' });
  });

  it('chip staged 但还没跑首轮：describe 把 staged 带回来', async () => {
    const h = harness();
    h.installed.choose('sess-1', { teamId: 'team-a', agentId: 'agt-a', taskId: 'task-1' });

    const state = await h.installed.describe('sess-1');

    expect(state.bound).toBeUndefined();
    expect(state.staged).toMatchObject({ teamId: 'team-a', agentId: 'agt-a', taskId: 'task-1' });
  });
});

describe('unresolved 绑定：空三元组不等于「用户选了本次不关联」', () => {
  const NOW = 1_800_000_000_000;
  const TRANSPORT_SKIP = 'candidates failed: transport failure: fetch failed';

  it('isUnresolvedBinding：只有「没绑上且不是用户拒绝」才算未解析', () => {
    expect(isUnresolvedBinding({
      teamId: '', agentId: '', userId: '', source: 'skipped', reason: TRANSPORT_SKIP,
    })).toBe(true);
    expect(isUnresolvedBinding({ teamId: '', agentId: '', userId: '', source: 'delegated' })).toBe(true);
    expect(isUnresolvedBinding({ teamId: '', agentId: '', userId: '', source: 'inherited' })).toBe(true);
    // A real decline: the user said 本次不关联, so it stays a decision.
    expect(isUnresolvedBinding({
      teamId: '', agentId: '', userId: '', source: 'user-declined', associate: false,
    })).toBe(false);
    // A real binding is never "unresolved", whatever the source.
    expect(isUnresolvedBinding({ teamId: 't', agentId: 'a', userId: 'u', source: 'skipped' })).toBe(false);
    expect(isUnresolvedBinding({ teamId: '', agentId: '', userId: '', source: 'auto' })).toBe(false);
  });

  it('describe 把未解析的空三元组标出来（chip 据此保持可编辑）', async () => {
    const h = harness();
    h.store.set('sess-1', {
      teamId: '', agentId: '', userId: '', source: 'skipped', reason: TRANSPORT_SKIP, at: NOW,
    });

    const state = await h.installed.describe('sess-1');

    expect(state.unresolved).toBe(true);
    expect(state.bound).toMatchObject({ source: 'skipped' });
  });

  it('describe 不把「本次不关联」标成未解析（那是用户的选择）', async () => {
    const h = harness();
    h.store.set('sess-1', {
      teamId: '', agentId: '', userId: '', source: 'user-declined', associate: false, at: NOW,
    });

    const state = await h.installed.describe('sess-1');

    expect(state.unresolved).toBeUndefined();
  });

  it('choose 能覆盖未解析的记录（这正是它存在的理由），但不覆盖已绑定的', () => {
    const h = harness();
    h.store.set('sess-1', {
      teamId: '', agentId: '', userId: '', source: 'skipped', reason: TRANSPORT_SKIP, at: NOW,
    });
    h.installed.choose('sess-1', { teamId: 'team-a', agentId: 'agt-a' });

    // Still only staged: the first turn's pre-step writes it.
    expect(h.store.get('sess-1')).toMatchObject({ source: 'skipped', teamId: '' });

    h.store.set('sess-2', { teamId: 'team-b', agentId: 'agt-b', userId: 'usr-a', source: 'chip', at: NOW });
    h.installed.choose('sess-2', { teamId: 'team-a', agentId: 'agt-a' });

    const state = h.store.get('sess-2');
    expect(state).toMatchObject({ teamId: 'team-b', agentId: 'agt-b', source: 'chip' });
  });

  it('一次候选失败不写记录；退避窗口过后下一轮按 preset 解析（用户配了默认就该生效）', async () => {
    let clock = NOW;
    let calls = 0;
    const h = harness({
      now: () => clock,
      sessionInit: preset(),
      candidates: async () => {
        calls += 1;
        // Two failures: the first attempt plus candidatesWithOneRetry's one retry.
        return calls <= 2
          ? { kind: 'failed', reason: 'transport failure: fetch failed' }
          : { kind: 'ok', userId: 'usr-a', teams: [{ teamId: 'team-a' }], agents: [{ agentId: 'agt-a' }] };
      },
    });

    await h.step();
    // Transport failed: nothing written, so the session is unresolved, not declined.
    expect(calls).toBe(2);
    expect(h.store.get('sess-1')).toBeUndefined();

    // Inside the window: silent, no second probe.
    clock = NOW + UNRESOLVED_RETRY_MIN_AGE_MS - 1;
    await h.step();
    expect(calls).toBe(2);
    expect(h.store.get('sess-1')).toBeUndefined();

    // Past the window the answer is retried, and preset is what the account decided.
    clock = NOW + UNRESOLVED_RETRY_MIN_AGE_MS;
    await h.step();

    expect(calls).toBe(3);
    expect(h.store.get('sess-1')).toMatchObject({
      teamId: 'team-a', agentId: 'agt-a', userId: 'usr-a', source: 'user-preset',
    });
    expect(h.store.get('sess-1')?.reason).toBe('user session_init: preset');
  });

  it('退避窗口内的未解析记录不重打网络（同一轮的多步只解一次）', async () => {
    let calls = 0;
    const h = harness({
      now: () => NOW,
      sessionInit: preset(),
      candidates: async () => {
        calls += 1;
        return { kind: 'ok', userId: 'usr-a', teams: [{ teamId: 'team-a' }], agents: [{ agentId: 'agt-a' }] };
      },
    });
    h.store.set('sess-1', {
      teamId: '', agentId: '', userId: '', source: 'skipped', reason: TRANSPORT_SKIP, at: NOW,
    });

    await h.step();

    expect(calls).toBe(0);
    expect(h.store.get('sess-1')).toMatchObject({ source: 'skipped', teamId: '' });
  });

  it('确定性结论（没有团队 / 有歧义没用 chip）不重打网络，只重试「候选失败」', async () => {
    expect(isCandidatesFailure(TRANSPORT_SKIP)).toBe(true);
    expect(isCandidatesFailure('candidates failed: core said 503')).toBe(true);
    expect(isCandidatesFailure('the user belongs to no team')).toBe(false);
    expect(isCandidatesFailure('no preset, ambiguous candidates, and the composer chip was not used')).toBe(false);

    let calls = 0;
    const h = harness({
      now: () => NOW,
      sessionInit: preset(),
      candidates: async () => {
        calls += 1;
        return { kind: 'ok', userId: 'usr-a', teams: [{ teamId: 'team-a' }], agents: [{ agentId: 'agt-a' }] };
      },
    });
    h.store.set('sess-1', {
      teamId: '', agentId: '', userId: '', source: 'skipped',
      reason: 'no preset, ambiguous candidates, and the composer chip was not used',
      at: NOW - UNRESOLVED_RETRY_MIN_AGE_MS,
    });

    await h.step();

    // 一次网络都不打：确定性的「没身份」不该每 30 秒重问一遍。
    expect(calls).toBe(0);
    expect(h.store.get('sess-1')).toMatchObject({ source: 'skipped', teamId: '' });
  });

  it('系统代答的「本次不关联」（歧义没用 chip）不冻结会话：chip 仍可编辑', async () => {
    const h = harness({
      teams: [{ teamId: 'team-a', name: '北方团队' }, { teamId: 'team-b', name: '南方团队' }],
    });

    await h.step();

    const row = h.store.get('sess-1');
    // Rule ⑤ still writes the empty triple (nothing lands in a guessed team)...
    expect(row).toMatchObject({ teamId: '', agentId: '', source: 'skipped', associate: false });
    // ...but committedAt stays unset: nobody chose this, so it must not freeze.
    // Measured pain 2026-11-22 10:02: the first turn stamped committedAt here and
    // the chip became a read-only 「未关联」 label with no way to answer.
    expect(row?.committedAt).toBeUndefined();
    expect(h.installed.status()).toBe('provisional(skipped)');
    expect(isProvisionalDecline(row!)).toBe(true);

    const state = await h.installed.describe('sess-1');
    expect(state.unresolved).toBe(true);
    // Not the user's word, so the turns spoken under the guess are HELD, not
    // skipped: if the user picks an agent later, those turns still have a home.
    expect(h.installed.writebackPolicy('sess-1')).toBe('defer');
  });

  it('绑定写入时把 agent 的显示名一起冻结（I3：之后 core 不答也能画出名字）', async () => {
    let up = true;
    const h = harness({
      agents: [{ agentId: 'agt-a', name: '青禾' }],
      candidates: async () => (up
        ? { kind: 'ok', userId: 'usr-a', teams: [{ teamId: 'team-a' }], agents: [{ agentId: 'agt-a', name: '青禾' }] }
        : { kind: 'error', reason: 'timed out after 4000ms' }),
    });

    await h.step();
    expect(h.store.get('sess-1')?.agentLabel).toBe('青禾 (agt-a)');

    // Core goes down. The row must still be able to name the agent -- measured
    // 2026-11-22 11:34: the chip painted 「TDB 记忆 · agt-3i8k22f496」for exactly
    // this case, because the label only ever existed in the candidates payload.
    up = false;
    const state = await h.installed.describe('sess-1');
    expect(state.status).toBe('failed');
    expect(state.bound?.agentLabel).toBe('青禾 (agt-a)');
  });

  it('reload 之后描述仍带得出 label（store round-trip 保留 agentLabel）', async () => {
    const statePath = tempStatePath();
    const first = harness({ statePath, agents: [{ agentId: 'agt-a', name: '青禾' }] });
    await first.step();
    expect(first.store.get('sess-1')?.agentLabel).toBeDefined();

    const second = new SessionIdentityStore({ statePath });
    expect(second.get('sess-1')?.agentLabel).toBe(first.store.get('sess-1')?.agentLabel);
  });

  it('系统代答之后用户在 chip 里选人：覆盖代答并冻结', async () => {
    const h = harness({
      now: () => NOW,
      teams: [{ teamId: 'team-a', name: '北方团队' }, { teamId: 'team-b', name: '南方团队' }],
    });
    await h.step();
    expect(h.store.get('sess-1')?.committedAt).toBeUndefined();

    h.installed.choose('sess-1', { teamId: 'team-b', agentId: 'agt-b' });
    await h.step();

    expect(h.store.get('sess-1')).toMatchObject({ teamId: 'team-b', agentId: 'agt-b', source: 'chip' });
    expect(h.store.get('sess-1')?.committedAt).toBe(NOW);
    // And now it is frozen: a second pick cannot move it, and the caller is TOLD
    // (a refused click that answered 200 would leave the chip saying 「待生效」).
    expect(h.installed.choose('sess-1', { teamId: 'team-a', agentId: 'agt-a' })).toBe(false);
    await h.step();
    expect(h.store.get('sess-1')).toMatchObject({ teamId: 'team-b', agentId: 'agt-b', source: 'chip' });
  });

  it('用户亲手点的「本次不关联」是终局：committed，且 chip 不再允许改', async () => {
    const h = harness({
      now: () => NOW,
      teams: [{ teamId: 'team-a', name: '北方团队' }, { teamId: 'team-b', name: '南方团队' }],
    });

    h.installed.choose('sess-1', { teamId: '', agentId: '', associate: false });
    await h.step();

    const row = h.store.get('sess-1');
    expect(row).toMatchObject({ teamId: '', agentId: '', source: 'user-declined', associate: false });
    expect(row?.committedAt).toBe(NOW);
    expect(isProvisionalDecline(row!)).toBe(false);
    // The user's own words: no queue, no writeback, nothing to replay.
    expect(h.installed.writebackPolicy('sess-1')).toBe('skip');

    // A late pick is refused (the session may already have written turns).
    expect(h.installed.choose('sess-1', { teamId: 'team-a', agentId: 'agt-a' })).toBe(false);
    await h.step();
    expect(h.store.get('sess-1')).toMatchObject({ source: 'user-declined', teamId: '' });
  });

  it('系统代答的行不会被每轮重算改写（不再打网络）', async () => {
    let calls = 0;
    const h = harness({
      now: () => NOW,
      teams: [{ teamId: 'team-a', name: '北方团队' }, { teamId: 'team-b', name: '南方团队' }],
      candidates: async () => {
        calls += 1;
        return {
          kind: 'ok', userId: 'usr-a',
          teams: [{ teamId: 'team-a' }, { teamId: 'team-b' }], agents: [{ agentId: 'agt-a' }],
        };
      },
    });

    await h.step();
    const strikes = calls;
    await h.step();
    await h.step();

    // The first turn resolved (2 attempts at most); later turns just read the row.
    expect(calls).toBe(strikes);
    expect(h.store.get('sess-1')).toMatchObject({ source: 'skipped', teamId: '' });
  });

  it('用户显式「本次不关联」之后不会被退避重试翻案', async () => {
    let calls = 0;
    const h = harness({
      now: () => NOW,
      sessionInit: preset(),
      candidates: async () => {
        calls += 1;
        return { kind: 'ok', userId: 'usr-a', teams: [{ teamId: 'team-a' }], agents: [{ agentId: 'agt-a' }] };
      },
    });
    h.store.set('sess-1', {
      teamId: '', agentId: '', userId: '', source: 'user-declined', associate: false,
      at: NOW - UNRESOLVED_RETRY_MIN_AGE_MS,
    });

    await h.step();

    expect(calls).toBe(0);
    expect(h.store.get('sess-1')).toMatchObject({ source: 'user-declined', associate: false, teamId: '' });
  });
});

describe('P0-2 self-heal: transport skip + empty inherited branch', () => {
  const NOW = 1_800_000_000_000;
  const TEN_MIN_AGO = NOW - 10 * 60 * 1000;
  const TRANSPORT_SKIP = 'candidates failed: transport failure: fetch failed';

  it('isCandidatesTransportSkip 只认传输层前缀（含 candidates failed: 包装）', () => {
    expect(isCandidatesTransportSkip(TRANSPORT_SKIP)).toBe(true);
    expect(isCandidatesTransportSkip('candidates failed: timed out after 500ms')).toBe(true);
    expect(isCandidatesTransportSkip('transport failure: fetch failed')).toBe(true);
    // A rejected 4xx/5xx is Core refusing, not a transient window: no retry.
    expect(isCandidatesTransportSkip('candidates failed: core said 503')).toBe(false);
    expect(isCandidatesTransportSkip('candidates failed: the user belongs to no team')).toBe(false);
    expect(isCandidatesTransportSkip(undefined)).toBe(false);
    expect(isCandidatesTransportSkip('')).toBe(false);
  });

  it('isStaleForRetry 以 SKIP_RETRY_MIN_AGE_MS 为门槛，at=0 视为足够旧', () => {
    expect(isStaleForRetry({ at: NOW - SKIP_RETRY_MIN_AGE_MS }, NOW)).toBe(true);
    expect(isStaleForRetry({ at: NOW - SKIP_RETRY_MIN_AGE_MS + 1 }, NOW)).toBe(false);
    expect(isStaleForRetry({ at: NOW }, NOW)).toBe(false);
    expect(isStaleForRetry({}, NOW)).toBe(true);
  });

  it('branchParentOf 只从 branch of 里取父会话 id', () => {
    expect(branchParentOf('branch of parent-1')).toBe('parent-1');
    expect(branchParentOf(TRANSPORT_SKIP)).toBeUndefined();
    expect(branchParentOf(undefined)).toBeUndefined();
  });

  it('a STALE transport skip is healed by one candidates probe (no card)', async () => {
    let calls = 0;
    const h = harness({
      now: () => NOW,
      candidates: async () => {
        calls += 1;
        return { kind: 'ok', userId: 'usr-a', teams: [{ teamId: 'team-a' }], agents: [{ agentId: 'agt-a' }] };
      },
    });
    h.store.set('sess-1', {
      teamId: '', agentId: '', userId: '', source: 'skipped', reason: TRANSPORT_SKIP, at: TEN_MIN_AGO,
    });

    await h.step();

    expect(calls).toBe(1);
    // Never a card this late in the session: the heal is candidates-only.
    const healed = h.store.get('sess-1');
    expect(healed).toMatchObject({ teamId: 'team-a', agentId: 'agt-a', userId: 'usr-a', source: 'recovered', at: NOW });
    // The failure reason is gone: a bound record must not claim it failed.
    expect(healed?.reason).toBeUndefined();
  });

  it('a FRESH transport skip is not retried (one turn, ms-apart steps)', async () => {
    let calls = 0;
    const h = harness({
      now: () => NOW,
      candidates: async () => {
        calls += 1;
        return { kind: 'ok', userId: 'usr-a', teams: [{ teamId: 'team-a' }], agents: [{ agentId: 'agt-a' }] };
      },
    });
    h.store.set('sess-1', {
      teamId: '', agentId: '', userId: '', source: 'skipped', reason: TRANSPORT_SKIP, at: NOW,
    });

    await h.step();

    expect(calls).toBe(0);
    expect(h.store.get('sess-1')).toMatchObject({ source: 'skipped', reason: TRANSPORT_SKIP, at: NOW });
  });

  it('an AMBIGUOUS candidates result does NOT resurrect a legacy picked triple (D2: only a chip choice counts)', async () => {
    const h = harness({
      now: () => NOW,
      // Two teams, neither matching BASE.teamId -> unambiguousTriple gives up.
      candidates: async () => ({
        kind: 'ok',
        userId: 'usr-a',
        teams: [{ teamId: 'team-a' }, { teamId: 'team-b' }],
        agents: [{ agentId: 'agt-a' }, { agentId: 'agt-b' }],
      }),
    });
    // What the user actually chose on this machine, long before the skip.
    h.store.set('sess-picked', {
      teamId: 'team-b', agentId: 'agt-b', userId: 'usr-a', source: 'picked', at: NOW - 1000,
    });
    h.store.set('sess-1', {
      teamId: '', agentId: '', userId: '', source: 'skipped', reason: TRANSPORT_SKIP, at: TEN_MIN_AGO,
    });

    await h.step();

    // Ambiguity is a real answer: keep the skip and record why, do not guess.
    // A 'picked' row predates the chip; treating it as a standing default is
    // exactly what resurrected a default the user had already cleared.
    expect(h.store.get('sess-1')).toMatchObject({
      teamId: '', agentId: '', userId: '', source: 'skipped', lastHealProbe: 'candidates are ambiguous',
    });
  });

  it('an AMBIGUOUS candidates result still honours a triple the user chose in the chip', async () => {
    const h = harness({
      now: () => NOW,
      candidates: async () => ({
        kind: 'ok',
        userId: 'usr-a',
        teams: [{ teamId: 'team-a' }, { teamId: 'team-b' }],
        agents: [{ agentId: 'agt-a' }, { agentId: 'agt-b' }],
      }),
    });
    h.store.set('sess-chosen', {
      teamId: 'team-b', agentId: 'agt-b', userId: 'usr-a', source: 'chip', at: NOW - 1000,
    });
    h.store.set('sess-1', {
      teamId: '', agentId: '', userId: '', source: 'skipped', reason: TRANSPORT_SKIP, at: TEN_MIN_AGO,
    });

    await h.step();

    // A click in the composer is the user's own decision, not a heuristic.
    expect(h.store.get('sess-1')).toMatchObject({
      teamId: 'team-b', agentId: 'agt-b', userId: 'usr-a', source: 'recovered', at: NOW,
    });
  });

  it('two DIFFERENT picked triples keep the skip and record the ambiguity', async () => {
    const h = harness({
      now: () => NOW,
      candidates: async () => ({
        kind: 'ok',
        userId: 'usr-a',
        teams: [{ teamId: 'team-a' }, { teamId: 'team-b' }],
        agents: [{ agentId: 'agt-a' }, { agentId: 'agt-b' }],
      }),
    });
    h.store.set('sess-picked-1', {
      teamId: 'team-a', agentId: 'agt-a', userId: 'usr-a', source: 'picked', at: NOW - 2000,
    });
    h.store.set('sess-picked-2', {
      teamId: 'team-b', agentId: 'agt-b', userId: 'usr-a', source: 'picked', at: NOW - 1000,
    });
    h.store.set('sess-1', {
      teamId: '', agentId: '', userId: '', source: 'skipped', reason: TRANSPORT_SKIP, at: TEN_MIN_AGO,
    });

    await h.step();

    // Two real user decisions cannot be merged by the plugin.
    expect(h.store.get('sess-1')).toMatchObject({
      source: 'skipped', lastHealProbe: 'candidates are ambiguous',
    });
  });

  it('a FAILED retry keeps skipped and only pushes at (no network on every tick)', async () => {
    let calls = 0;
    const h = harness({
      now: () => NOW,
      candidates: async () => {
        calls += 1;
        return { kind: 'failed', reason: 'core said 503' };
      },
    });
    h.store.set('sess-1', {
      teamId: '', agentId: '', userId: '', source: 'skipped', reason: TRANSPORT_SKIP, at: TEN_MIN_AGO,
    });

    await h.step();

    // 'core said 503' is not transport: exactly one probe, no candidatesWithOneRetry retry.
    expect(calls).toBe(1);
    expect(h.store.get('sess-1')).toMatchObject({ source: 'skipped', reason: TRANSPORT_SKIP, at: NOW });

    // The very next step of the same turn is silent: at is no longer stale.
    await h.step();
    expect(calls).toBe(1);
  });

  it('ambiguous candidates (several teams, base not among them) stay skipped instead of guessing', async () => {
    const h = harness({
      now: () => NOW,
      teams: [{ teamId: 'team-a' }, { teamId: 'team-b' }],
    });
    h.store.set('sess-1', {
      teamId: '', agentId: '', userId: '', source: 'skipped', reason: TRANSPORT_SKIP, at: TEN_MIN_AGO,
    });

    await h.step();

    expect(h.store.get('sess-1')).toMatchObject({
      teamId: '', agentId: '', userId: '', source: 'skipped', at: NOW,
    });
  });

  it('an empty inherited branch copies the BOUND parent triple without any network call', async () => {
    let calls = 0;
    const h = harness({
      now: () => NOW,
      candidates: async () => {
        calls += 1;
        return { kind: 'ok', userId: 'usr-a', teams: [{ teamId: 'team-a' }], agents: [{ agentId: 'agt-a' }] };
      },
    });
    h.store.set('parent-1', {
      teamId: 'team-a', agentId: 'agt-a', userId: 'usr-a', taskId: 'task-1', source: 'chip', at: TEN_MIN_AGO,
    });
    h.store.set('sess-1', {
      teamId: '', agentId: '', userId: '', source: 'inherited', reason: 'branch of parent-1', at: TEN_MIN_AGO,
    });

    await h.step();

    // No card, no candidates: a branch never gets its own network request.
    expect(calls).toBe(0);
    expect(h.store.get('sess-1')).toMatchObject({
      teamId: 'team-a',
      agentId: 'agt-a',
      userId: 'usr-a',
      taskId: 'task-1',
      source: 'inherited',
      reason: 'branch of parent-1',
      at: NOW,
    });
  });

  it('an empty inherited branch whose parent is stuck on a transport skip probes once and recovers', async () => {
    let calls = 0;
    const h = harness({
      now: () => NOW,
      candidates: async () => {
        calls += 1;
        return { kind: 'ok', userId: 'usr-a', teams: [{ teamId: 'team-a' }], agents: [{ agentId: 'agt-a' }] };
      },
    });
    h.store.set('parent-1', {
      teamId: '', agentId: '', userId: '', source: 'skipped', reason: TRANSPORT_SKIP, at: TEN_MIN_AGO,
    });
    const child = {
      teamId: '', agentId: '', userId: '', source: 'inherited' as const, reason: 'branch of parent-1', at: TEN_MIN_AGO,
    };
    h.store.set('sess-1', child);

    await h.step();

    // 父会话被传输层失败卡住时没人会去自愈它（父可能再也不被调用），所以分支自己探一次；
    // 探到就是 recovered（不是 inherited —— 这条身份不是从父抄来的）。
    expect(calls).toBe(1);
    expect(h.store.get('sess-1')).toMatchObject({
      teamId: 'team-a', agentId: 'agt-a', userId: 'usr-a', source: 'recovered', at: NOW,
    });
  });

  it('an inherited record that already has a triple is left alone', async () => {
    const h = harness({ now: () => NOW });
    h.store.set('parent-1', {
      teamId: 'team-a', agentId: 'agt-a', userId: 'usr-a', source: 'chip', at: TEN_MIN_AGO,
    });
    const child = {
      teamId: 'team-x', agentId: 'agt-x', userId: 'usr-x', source: 'inherited' as const, reason: 'branch of parent-1', at: TEN_MIN_AGO,
    };
    h.store.set('sess-1', child);

    await h.step();

    expect(h.store.get('sess-1')).toEqual(child);
  });
});

describe('B11 分支继承：父 id 来自 plugin record，而不是 header.parentSession', () => {
  const NOW = 1_800_000_000_000;

  it('knownBranchParent 给出父会话 → 直接抄父三元组，不发 candidates', async () => {
    let calls = 0;
    const h = harness({
      now: () => NOW,
      knownBranchParent: (agent) => ((agent as { session?: { id?: string } })?.session?.id === 'sess-child' ? 'parent-1' : undefined),
      candidates: async () => {
        calls += 1;
        return { kind: 'ok', userId: 'usr-a', teams: [{ teamId: 'team-a' }], agents: [{ agentId: 'agt-a' }] };
      },
    });
    h.store.set('parent-1', {
      teamId: 'team-a', agentId: 'agt-a', userId: 'usr-a', taskId: 'task-1',
      source: 'chip', at: NOW - 1000, committedAt: NOW - 1000,
    });

    const listener = h.fake.firstListener('agent/pre-step')!;
    await runPreStep(
      listener,
      { agent: { session: { id: 'sess-child' } }, turn: 1, step: 1 },
      { kind: 'enter', messages: [] },
    );

    // 分支永远不自己发网络请求（P0-2 的原判据，这里对 plugin-record 路径同样成立）。
    expect(calls).toBe(0);
    expect(h.store.get('sess-child')).toMatchObject({
      teamId: 'team-a',
      agentId: 'agt-a',
      userId: 'usr-a',
      taskId: 'task-1',
      source: 'inherited',
      reason: 'branch of parent-1',
    });
  });

  it('父会话还没绑成时分支落空三元组（可见的无身份），也不去问人', async () => {
    let calls = 0;
    const h = harness({
      now: () => NOW,
      knownBranchParent: () => 'parent-1',
      candidates: async () => {
        calls += 1;
        return { kind: 'ok', userId: 'usr-a', teams: [{ teamId: 'team-a' }], agents: [{ agentId: 'agt-a' }] };
      },
    });

    await h.step('sess-child');

    expect(calls).toBe(0);
    const row = h.store.get('sess-child');
    expect(row).toMatchObject({ teamId: '', agentId: '', userId: '', source: 'inherited', reason: 'branch of parent-1' });
    // 父会话稍后绑上时，reconcileExisting 靠这个 reason 把三元组补回来。
    expect(branchParentOf(row?.reason)).toBe('parent-1');
  });

  it('父会话稍后才绑上：分支的开放空行被补成父三元组（不发网络）', async () => {
    let calls = 0;
    const h = harness({
      now: () => NOW,
      knownBranchParent: () => 'parent-1',
      candidates: async () => {
        calls += 1;
        return { kind: 'ok', userId: 'usr-x', teams: [{ teamId: 'team-x' }], agents: [{ agentId: 'agt-x' }] };
      },
    });

    // 第一轮：父会话还没有行 -> 分支落开放空行。
    await h.step('sess-child');
    expect(h.store.get('sess-child')?.committedAt).toBeUndefined();

    // 父会话（同一个进程里，另一个 UI 会话）这时才在 chip 里选定身份。
    h.store.set('parent-1', {
      teamId: 'team-a', agentId: 'agt-a', userId: 'usr-a', taskId: 'task-1',
      source: 'chip', at: NOW, committedAt: NOW,
    });

    // 第二轮：分支一眼不发网络，直接把父三元组抄进来并冻结。
    await h.step('sess-child');

    expect(calls).toBe(0);
    expect(h.store.get('sess-child')).toMatchObject({
      teamId: 'team-a', agentId: 'agt-a', userId: 'usr-a', taskId: 'task-1',
      source: 'inherited', reason: 'branch of parent-1',
    });
    expect(h.store.get('sess-child')?.committedAt).toBe(NOW);
  });

  it('不是分支（knownBranchParent 返回 undefined）时照常解析 —— 不会把普通会话误判成分支', async () => {
    const h = harness({ now: () => NOW, knownBranchParent: () => undefined });

    await h.step('sess-1');

    expect(h.store.get('sess-1')).toMatchObject({ teamId: 'team-a', agentId: 'agt-a', source: 'auto' });
  });
});

describe('创建期预答（unconfirmedAt）：默认 agent 不再是不可撤销的判决', () => {
  const NOW = 1_800_000_000_000;

  it('creation-time preset row stays editable and defers the first writeback', async () => {
    const h = harness({ now: () => NOW, sessionInit: preset() });
    // 这正是 agent/created 写下的行：committedAt 已置位，但一轮都还没跑。
    h.store.set('sess-1', {
      teamId: 'team-a', agentId: 'agt-a', userId: 'usr-a',
      source: 'user-preset', reason: 'user session_init: preset', at: NOW, committedAt: NOW,
      unconfirmedAt: NOW,
    });

    const state = await h.installed.describe('sess-1');
    expect(state.editable).toBe(true);
    expect(state.bound?.unconfirmedAt).toBe(NOW);
    // D4：第一轮还没发出身份，绝不能先发出去。
    expect(h.installed.writebackPolicy('sess-1')).toBe('defer');
  });

  it('the chip can overrule a creation-time preset, and that pick wins the first turn', async () => {
    const h = harness({
      now: () => NOW,
      sessionInit: preset(),
      agents: [{ agentId: 'agt-a', name: '采购助手' }, { agentId: 'agt-b', name: '青禾' }],
    });
    h.store.set('sess-1', {
      teamId: 'team-a', agentId: 'agt-a', userId: 'usr-a',
      source: 'user-preset', reason: 'user session_init: preset', at: NOW, committedAt: NOW,
      unconfirmedAt: NOW,
    });

    expect(h.installed.choose('sess-1', { teamId: 'team-a', agentId: 'agt-b' })).toBe(true);
    await h.step();

    expect(h.store.get('sess-1')).toMatchObject({
      agentId: 'agt-b', source: 'chip', committedAt: NOW,
    });
    expect(h.store.get('sess-1')?.unconfirmedAt).toBeUndefined();
    expect(h.installed.writebackPolicy('sess-1')).toBe('send');
  });

  it('a pre-answer nobody changed is confirmed (and frozen) by the first turn', async () => {
    const h = harness({ now: () => NOW, sessionInit: preset() });
    h.store.set('sess-1', {
      teamId: 'team-a', agentId: 'agt-a', userId: 'usr-a',
      source: 'user-preset', reason: 'user session_init: preset', at: NOW, committedAt: NOW,
      unconfirmedAt: NOW,
    });

    await h.step();

    expect(h.store.get('sess-1')).toMatchObject({ agentId: 'agt-a', source: 'user-preset', committedAt: NOW });
    expect(h.store.get('sess-1')?.unconfirmedAt).toBeUndefined();
    expect(h.installed.writebackPolicy('sess-1')).toBe('send');
    // 冻结之后 chip 的点击必须被拒（I1）。
    expect(h.installed.choose('sess-1', { teamId: 'team-a', agentId: 'agt-b' })).toBe(false);
  });

  it('a creation-time auto row is a pre-answer too, not a decision', async () => {
    const h = harness({ now: () => NOW, teams: [{ teamId: 'team-a' }], agents: [{ agentId: 'agt-a' }] });
    h.store.set('sess-1', {
      teamId: '', agentId: '', userId: '', source: 'skipped', associate: false,
      at: NOW, committedAt: NOW, unconfirmedAt: NOW,
    });

    const state = await h.installed.describe('sess-1');
    expect(state.editable).toBe(true);
    expect(h.installed.writebackPolicy('sess-1')).toBe('defer');
  });

  it('unconfirmedAt survives a restart (otherwise a process start becomes a decision)', async () => {
    const statePath = tempStatePath();
    const first = new SessionIdentityStore({ statePath });
    first.set('sess-1', {
      teamId: 'team-a', agentId: 'agt-a', userId: 'usr-a',
      source: 'user-preset', at: NOW, committedAt: NOW, unconfirmedAt: NOW,
    });
    const second = new SessionIdentityStore({ statePath });
    expect(second.get('sess-1')?.unconfirmedAt).toBe(NOW);
    expect(second.get('sess-1')?.committedAt).toBe(NOW);
  });

  it('a confirmed row is NOT editable even though its source is a preset', async () => {
    const h = harness({ now: () => NOW, sessionInit: preset() });
    h.store.set('sess-1', {
      teamId: 'team-a', agentId: 'agt-a', userId: 'usr-a',
      source: 'user-preset', reason: 'user session_init: preset', at: NOW, committedAt: NOW,
    });

    const state = await h.installed.describe('sess-1');
    expect(state.editable).toBeUndefined();
    expect(h.installed.writebackPolicy('sess-1')).toBe('send');
    expect(h.installed.choose('sess-1', { teamId: 'team-a', agentId: 'agt-b' })).toBe(false);
  });
});

