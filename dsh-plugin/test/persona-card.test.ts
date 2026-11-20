import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

import {
  PERSONA_ANCHOR_SECTION_NAME,
  PERSONA_CARD_SECTION_NAME,
  PERSONA_IDENTITY_ORDER,
  PERSONA_IDENTITY_SECTION_NAME,
  PERSONA_TURN_MAX_CHARS,
  createPersonaCard,
  type PersonaCardFailure,
  type PersonaCardHandle,
  type PersonaCardRead,
  type PersonaCardSession,
  type PersonaCardSnapshot,
} from '../src/persona-card.js';
import type { InjectionLog, InjectionLogEvent } from '../src/injection-log.js';
import { createFakeContext } from './helpers/fake-ctx.js';

/**
 * task-32：人格卡按会话持有、绑定即取卡、无缓存、无「最近会话」兜底。
 *
 * 用户原话：`User said (m06421): 「改吧，还有就是每次选择agent绑定后应该是覆盖卡，一个会话不一定只有一个卡」`
 * 与 `User said (m06442): 「绑定取卡时都调接口读，不要有缓存」`；追加约束
 * `User said (m06501): 「也有可能多个会话同时用一个人设，各种场景都需要考虑」`。
 *
 * 会话键的宿主依据（lead 从 `D:/DSH/resources/app.asar` 解出）：
 * `@deepseek-ai/dsh-agent/lib/types/index.js:242-245` 的 `AgentRegistry.enter()`
 * 里 `agent.id !== agent.session.id` 直接 throw，且 section getter 拿到的是
 * `{ agent, scope: agent, signal }`，所以 `agent.id === sessionId`。
 */

/** 宿主给 section getter 的 context，形状与 assembleContextFor 一致。 */
const SESSION = (id: string) => ({ agent: { id, session: { id } }, scope: undefined, signal: undefined });

function snapshot(text: string, version = 1): PersonaCardSnapshot {
  return { version, hash: `h${String(version)}`, textHash: 'x'.repeat(64), text, chars: text.length, dirty: false };
}

/** 新 Core 形态：整卡 + 两段（P1-2）。 */
function segmented(
  identityText: string,
  anchorText: string,
  text = `整卡标题\n${identityText}\n${anchorText}`,
  version = 1,
): PersonaCardSnapshot {
  return { ...snapshot(text, version), identity: { text: identityText }, anchor: { text: anchorText } };
}

/** 与插件/Core 同算法，用来断言 section-read 的 hash 就是该段的 sha256。 */
function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 尾部 section 的 order（installSection 的第二个参数）。 */
const ANCHOR_ORDER = 10303;

function memoryLog(events: InjectionLogEvent[]): InjectionLog {
  return {
    path: '(test)',
    record: (event: InjectionLogEvent) => { events.push(event); },
    failed: () => false,
  };
}

interface Harness {
  handle: PersonaCardHandle;
  events: InjectionLogEvent[];
  calls: Array<string | undefined>;
  fake: ReturnType<typeof createFakeContext>;
  /** 旧兼容：identity 段在旧 Core 下就是整卡，早期用例都按它写。 */
  getter: (context?: unknown) => string;
  identity: (context?: unknown) => string;
  anchor: (context?: unknown) => string;
}

function sectionTextOf(fake: ReturnType<typeof createFakeContext>, name: string): (context?: unknown) => string {
  const section = fake.sections.find((entry) => entry.name === name);
  if (section === undefined) throw new Error(`section ${name} not installed`);
  return section.text as (context?: unknown) => string;
}

function harness(read: (sessionId?: string) => Promise<PersonaCardRead>, extra: {
  resolveSession?: (context: unknown) => PersonaCardSession | undefined;
  timeoutMs?: number;
  log?: { debug?: (...args: unknown[]) => void; info?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void };
} = {}): Harness {
  const events: InjectionLogEvent[] = [];
  const calls: Array<string | undefined> = [];
  const fake = createFakeContext();
  const handle = createPersonaCard({
    enabled: true,
    fetchCard: async (sessionId?: string) => {
      calls.push(sessionId);
      return read(sessionId);
    },
    fetchTurn: async () => ({ text: '', openLoops: [] }),
    timeoutMs: extra.timeoutMs ?? 50,
    injectionLog: memoryLog(events),
    log: extra.log,
    resolveSession: extra.resolveSession ?? ((context: unknown) => {
      const id = (context as { agent?: { id?: string } } | undefined)?.agent?.id ?? '';
      if (id === '') return undefined;
      return { sessionId: id, source: 'context-agent', field: 'agent.id' };
    }),
  });
  handle.installSection(fake.ctx, ANCHOR_ORDER);
  const identity = sectionTextOf(fake, PERSONA_IDENTITY_SECTION_NAME);
  const anchor = sectionTextOf(fake, PERSONA_ANCHOR_SECTION_NAME);
  return { handle, events, calls, fake, getter: identity, identity, anchor };
}

describe('人格卡 · 按会话绑定（task-32）', () => {
  it('① 单会话单 agent：bind 后该会话拿到该卡', async () => {
    const h = harness(async () => snapshot('卡A'));
    await h.handle.bind('s1', 'team/user/agentA');
    expect(h.getter(SESSION('s1'))).toBe('卡A');
    expect(h.calls).toEqual(['s1']);
  });

  it('② 单会话切 agent：第二次 bind 覆盖，旧卡不再出现', async () => {
    let text = '卡A';
    const h = harness(async () => snapshot(text));
    await h.handle.bind('s1', 'team/user/agentA');
    expect(h.getter(SESSION('s1'))).toBe('卡A');
    text = '卡B';
    await h.handle.bind('s1', 'team/user/agentB');
    expect(h.getter(SESSION('s1'))).toBe('卡B');
    expect(h.calls).toEqual(['s1', 's1']);
    // 同一会话两次覆盖各记一行 card-bound，identity 可区分。
    const bounds = h.events.filter((e) => e.event === 'card-bound');
    expect(bounds.map((e) => e.identity)).toEqual(['team/user/agentA', 'team/user/agentB']);
  });

  it('③ 两会话同 agent：各自取卡，两份独立副本', async () => {
    const h = harness(async () => snapshot('同一个人设'));
    await h.handle.bind('a1', 'team/user/agentA');
    await h.handle.bind('a2', 'team/user/agentA');
    expect(h.getter(SESSION('a1'))).toBe('同一个人设');
    expect(h.getter(SESSION('a2'))).toBe('同一个人设');
    expect(h.calls).toEqual(['a1', 'a2']);
    expect(h.handle.boundSessions()).toBe(2);
    expect(h.handle.snapshot('a1')).not.toBe(h.handle.snapshot('a2'));
    // 覆盖其中一个不改变另一个。
    await h.handle.bind('a1', 'team/user/agentB');
    expect(h.getter(SESSION('a2'))).toBe('同一个人设');
  });

  it('④ 两会话不同 agent：各自只返回自己的卡，互不串', async () => {
    const h = harness(async (sessionId) => snapshot(sessionId === 'a1' ? '审墨' : '别的人设'));
    await h.handle.bind('a1', 'team/user/审墨');
    await h.handle.bind('a2', 'team/user/别的');
    expect(h.getter(SESSION('a1'))).toBe('审墨');
    expect(h.getter(SESSION('a2'))).toBe('别的人设');
  });

  it('⑤ 两会话同 agent，其一 rebind 到别的 agent：只有它变', async () => {
    let a1Text = '原卡';
    const h = harness(async (sessionId) => snapshot(sessionId === 'a1' ? a1Text : '原卡'));
    await h.handle.bind('a1', 'team/user/agentA');
    await h.handle.bind('a2', 'team/user/agentA');
    expect(h.getter(SESSION('a2'))).toBe('原卡');
    a1Text = '换后';
    await h.handle.bind('a1', 'team/user/agentB');
    expect(h.getter(SESSION('a1'))).toBe('换后');
    expect(h.getter(SESSION('a2'))).toBe('原卡');
  });

  it('⑥b 卡 TTL：超过 PERSONA_REFRESH_MS 才重取，失败保留旧卡（A4 Round7）', async () => {
    let text = '旧卡';
    let fail = false;
    const h = harness(async () => {
      if (fail) throw new Error('boom');
      return snapshot(text, 2);
    });
    await h.handle.bind('s1', 'team/user/agentA');
    expect(h.calls).toEqual(['s1']);
    // 未到期：不取卡，返回 false。
    expect(await h.handle.refreshIfStale('s1', 6 * 60 * 60 * 1000, Date.now())).toBe(false);
    expect(h.calls).toEqual(['s1']);
    // 到期：重取一次，段文本换成新卡。
    text = '新卡';
    expect(await h.handle.refreshIfStale('s1', 1000, Date.now() + 5000)).toBe(true);
    expect(h.calls).toEqual(['s1', 's1']);
    expect(h.getter(SESSION('s1'))).toBe('新卡');
    // 取卡失败：返回 false，旧卡继续服务（fail-open 不回退成空段）。
    fail = true;
    expect(await h.handle.refreshIfStale('s1', 1000, Date.now() + 10_000)).toBe(false);
    expect(h.getter(SESSION('s1'))).toBe('新卡');
  });
  it('⑥ 会话恢复（进程内无绑定）：不读缓存，仍调 fetchCard 并覆盖', async () => {
    const h = harness(async () => snapshot('从 Core 现取'));
    expect(h.handle.boundSessions()).toBe(0);
    await h.handle.bind('restored', 'team/user/agentA');
    expect(h.calls).toEqual(['restored']);
    expect(h.getter(SESSION('restored'))).toBe('从 Core 现取');
    // 再绑一次也不走缓存：每次都打接口。
    await h.handle.bind('restored', 'team/user/agentA');
    expect(h.calls).toEqual(['restored', 'restored']);
  });

  it('⑦ bind 失败且该会话无旧卡：section 返回空串，不借别人的卡', async () => {
    const h = harness(async (sessionId) => {
      if (sessionId === 'a2') return { reason: 'timeout' } satisfies PersonaCardFailure;
      return snapshot('别的会话的卡');
    });
    await h.handle.bind('a1', 'team/user/agentA');
    await h.handle.bind('a2', 'team/user/agentA');
    expect(h.getter(SESSION('a2'))).toBe('');
    expect(h.getter(SESSION('a1'))).toBe('别的会话的卡');
    const failed = h.events.filter((e) => e.event === 'card-bound-failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ sessionId: 'a2', reason: 'timeout', chars: 0, identity: 'team/user/agentA' });
    expect(failed[0].keptVersion).toBeUndefined();
  });

  it('⑧ bind 失败但有旧卡：保留旧卡，记 card-bound-failed + keptVersion', async () => {
    let broken = false;
    const h = harness(async () => (broken
      ? { reason: 'http_status', status: 503 } satisfies PersonaCardFailure
      : snapshot('旧卡', 3)));
    await h.handle.bind('a1', 'team/user/agentA');
    broken = true;
    await h.handle.bind('a1', 'team/user/agentB');
    expect(h.getter(SESSION('a1'))).toBe('旧卡');
    const failed = h.events.filter((e) => e.event === 'card-bound-failed');
    expect(failed).toHaveLength(1);
    // identity 是「这次尝试绑定的身份」，keptVersion 是「实际保留的那份」——两者不同才是失败留因的意义。
    expect(failed[0]).toMatchObject({ sessionId: 'a1', reason: 'http_status', keptVersion: 3, identity: 'team/user/agentB' });
    expect(h.handle.boundSessions()).toBe(1);
  });

  it('⑨「本次不关联」绑定：只清该会话的卡，记 card-cleared 而不是零字节 card-bound', async () => {
    const h = harness(async () => snapshot('卡A'));
    await h.handle.bind('a1', 'team/user/agentA');
    await h.handle.bind('a2', 'team/user/agentA');
    await h.handle.bind('a1', undefined);
    expect(h.getter(SESSION('a1'))).toBe('');
    expect(h.getter(SESSION('a2'))).toBe('卡A');
    // Round26：用户主动「不关联」是决定，不是取卡失败——旧实现记 card-bound chars 0，
    // 于是 stats 的 cardBoundEmpty 把主动退出算成注入故障。
    const cleared = h.events.filter((e) => e.event === 'card-cleared');
    expect(cleared.map((e) => e.sessionId)).toEqual(['a1']);
    expect(cleared[0]).toMatchObject({ chars: 0, reason: 'unassociated' });
    expect(h.events.filter((e) => e.event === 'card-bound' && e.chars === 0)).toHaveLength(0);
  });

  it('⑨c 清卡归因：用户拒绝与被清空身份分开记（r26d-a1）', async () => {
    const h = harness(async () => snapshot('卡A'));
    await h.handle.bind('declined1', undefined, 'declined');
    await h.handle.bind('unconf1', undefined, 'unconfigured');
    // 旧实现把 null（用户选否）与 undefined（没装配身份）塌成同一个事件，
    // 面板于是把「配置缺口」说成「用户主动不关联」。
    const cleared = h.events.filter((e) => e.event === 'card-cleared');
    expect(cleared.map((e) => [e.sessionId, e.reason, e.source])).toEqual([
      ['declined1', 'unassociated', 'declined'],
      ['unconf1', 'unconfigured', 'unconfigured'],
    ]);
  });

  it('⑨d 刷新路径不再凭空造清卡记录（r26e-a5；有牙的只有第 ① 条）', async () => {
    const h = harness(async () => snapshot('卡A'));
    // 生产 08:16:13Z 那一条没有 source 的 card-cleared 就是这条路径造出来的：
    // refresh 只传 identity、不传归因，alreadyUnbound 为假时落一行「不知道为什么」。
    // ① 有牙：没卡也没身份的会话被 refresh 时，什么都不该发生。删掉 refresh 里的早退
    //    （persona-card.ts 的 knownIdentity/cards 判空）这条立刻红——round26 复核实测
    //    旧写法在这里产出 ["card-cleared","never-bound","unassociated",null]。
    await h.handle.refresh('never-bound');
    expect(h.events.filter((e) => e.event === 'card-cleared')).toHaveLength(0);
    // ② 观测性断言（不是保护）：已按用户拒绝清卡的会话再 refresh，不会多出事件——
    //    这条在删掉早退后仍然绿（alreadyUnbound 为真），只用来固定「清卡是一次性的」。
    await h.handle.bind('declined2', undefined, 'declined');
    await h.handle.refresh('declined2');
    expect(h.events.filter((e) => e.event === 'card-cleared').map((e) => [e.sessionId, e.reason, e.source]))
      .toEqual([['declined2', 'unassociated', 'declined']]);
    // ③ 观测性断言：身份回来后旧归因不残留，再清一次由调用方重新给原因。
    await h.handle.bind('declined2', 'team/user/agentX');
    await h.handle.bind('declined2', undefined, 'unconfigured');
    expect(h.events.filter((e) => e.event === 'card-cleared' && e.sessionId === 'declined2').map((e) => [e.reason, e.source]))
      .toEqual([['unassociated', 'declined'], ['unconfigured', 'unconfigured']]);
  });

  it('⑨b 不关联会话被反复绑定：只记一行 card-cleared（旧实现每 pre-step 刷一行）', async () => {
    const h = harness(async () => snapshot('卡A'));
    // 没有卡的会话每个 pre-step 都会再 bind 一次；这里模拟 50 步。
    for (let i = 0; i < 50; i += 1) await h.handle.bind('a1', undefined);
    const cleared = h.events.filter((e) => e.event === 'card-cleared');
    expect(cleared).toHaveLength(1);
    expect(h.events.filter((e) => e.event === 'card-bound')).toHaveLength(0);
  });

  it('⑩ 并发 assemble：两个会话交替取文本，中途 rebind 不影响另一会话', async () => {
    const h = harness(async (sessionId) => snapshot(sessionId === 'a1' ? '会话一的卡' : '会话二的卡'));
    await h.handle.bind('a1', 'team/user/agentA');
    await h.handle.bind('a2', 'team/user/agentB');
    const even: string[] = [];
    const odd: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      even.push(h.getter(SESSION('a1')));
      if (i === 4) await h.handle.bind('a1', 'team/user/agentA');
      odd.push(h.getter(SESSION('a2')));
    }
    expect(even).toEqual(new Array(10).fill('会话一的卡'));
    expect(odd).toEqual(new Array(10).fill('会话二的卡'));
  });

  it('§ 没有会话键：section 返回空串，记 sidSource=none，无「最近绑定」兜底', async () => {
    const h = harness(async () => snapshot('卡A'));
    await h.handle.bind('a1', 'team/user/agentA');
    expect(h.getter()).toBe('');
    expect(h.getter({})).toBe('');
    expect(h.getter({ agent: {} })).toBe('');
    // 末尾锚段同样不兜底（两段各判各的会话键）。
    expect(h.anchor()).toBe('');
    // 空 context 不会退回去用已绑定的会话。
    expect(h.getter(SESSION('a1'))).toBe('卡A');
    const none = h.events.filter((e) => e.event === 'section-read' && e.sidSource === 'none');
    // 两段各记一行（section 区分），所以一共两条、各 chars 0。
    expect(none.map((e) => e.section)).toEqual(['identity', 'anchor']);
    expect(none.map((e) => e.chars)).toEqual([0, 0]);
  });

  it('§ 宿主换 API（无 agent.id）只 warn 一次，不刷屏', async () => {
    const warn = vi.fn();
    const h = harness(async () => snapshot('卡A'), { log: { debug: () => {}, info: () => {}, warn } });
    h.getter({});
    h.getter({});
    h.getter({ agent: {} });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('got no session id from the host context');
  });

  it('§ section-read 带 sessionId + identity + section + sidSource=context-agent', async () => {
    const h = harness(async () => snapshot('卡A'));
    await h.handle.bind('a1', 'team/user/agentA');
    expect(h.getter(SESSION('a1'))).toBe('卡A');
    const read = h.events.find((e) => e.event === 'section-read');
    expect(read).toMatchObject({
      event: 'section-read',
      section: 'identity',
      sessionId: 'a1',
      identity: 'team/user/agentA',
      version: 1,
      chars: 2,
      hash: sha256('卡A'),
      sidSource: 'context-agent',
      sidField: 'agent.id',
    });
  });

  it('§ fetchCard 真抛错：fail-open，归 http_status，日志不带错误本体', async () => {
    const warn = vi.fn();
    const fake = createFakeContext();
    const handle = createPersonaCard({
      enabled: true,
      fetchCard: async () => { throw new Error('boom token=secret'); },
      fetchTurn: async () => ({ text: '', openLoops: [] }),
      timeoutMs: 50,
      resolveSession: () => ({ sessionId: 'a1', source: 'context-agent', field: 'agent.id' }),
      log: { debug: () => {}, info: () => {}, warn },
    });
    handle.installSection(fake.ctx, 10303);
    await handle.bind('a1', 'team/user/agentA');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('persona card bind failed'),
      expect.objectContaining({ reason: 'http_status' }),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
    expect(handle.currentFor('a1')).toBe('');
  });

  it('§ 同会话并发 bind 折成一次取卡', async () => {
    let release: ((value: PersonaCardRead) => void) | undefined;
    const h = harness(() => new Promise<PersonaCardRead>((resolve) => { release = resolve; }));
    const first = h.handle.bind('a1', 'team/user/agentA');
    const second = h.handle.bind('a1', 'team/user/agentA');
    await Promise.resolve();
    expect(h.calls).toEqual(['a1']);
    release?.(snapshot('卡A'));
    await Promise.all([first, second]);
    expect(h.getter(SESSION('a1'))).toBe('卡A');
  });

  it('§ 通道 B：裁到 400 字符', async () => {
    const fake = createFakeContext();
    const long = '心境'.repeat(320);
    const handle = createPersonaCard({
      enabled: true,
      fetchCard: async () => snapshot('卡A'),
      fetchTurn: async () => ({ text: long, openLoops: ['还要取证'] }),
      timeoutMs: 50,
    });
    handle.installSection(fake.ctx, 10303);
    const text = await handle.turnText('a1');
    expect(PERSONA_TURN_MAX_CHARS).toBe(400);
    expect(text).toHaveLength(400);
    expect(text).toBe(long.slice(0, 400));
  });

  it('§6：turn 文本为空时状态仍返回（text 与 state 解耦）', async () => {
    const fake = createFakeContext();
    const handle = createPersonaCard({
      enabled: true,
      fetchCard: async () => snapshot('卡A'),
      fetchTurn: async () => ({ text: '', openLoops: [], state: { dynamicText: '现在：接线' } } as any),
      timeoutMs: 50,
    });
    handle.installSection(fake.ctx, 10303);
    const block = await handle.turnBlock('a1');
    expect(block.text).toBe('');
    expect(block.state?.dynamicText).toBe('现在：接线');
  });
});

/**
 * P1-2：人格卡由「一个 section（整卡）」改成「两段两个 section」。
 *
 * - 身份段 `tdb-agemem:persona-identity`：固定 order 1（紧跟 harness:identity 与 persona-prefix）；
 * - 末尾锚 `tdb-agemem:persona-anchor`：沿用调用方的尾部 order（历史之后）。
 */
const IDENTITY_TEXT = '## 读法\n先读再答\n## 使命\n把事做完';
const ANCHOR_TEXT = '## 底色\n克制\n## 未完的事\n把测试补齐';

describe('人格卡 · 两段注入（P1-2）', () => {
  it('① 旧 Core（响应只有 text）→ identity 返回整卡，anchor 返回空串', async () => {
    const h = harness(async () => snapshot('整卡正文'));
    await h.handle.bind('a1', 'team/user/agentA');
    expect(h.identity(SESSION('a1'))).toBe('整卡正文');
    expect(h.anchor(SESSION('a1'))).toBe('');
    const reads = h.events.filter((e) => e.event === 'section-read' && e.sessionId === 'a1');
    expect(reads.map((e) => e.section)).toEqual(['identity', 'anchor']);
    // 整卡进 identity 时 hash 就是整卡的 sha256（= Core textHash 同算法）。
    expect(reads[0]).toMatchObject({ section: 'identity', chars: 4, hash: sha256('整卡正文') });
    // 空段只留痕，不注入空 section 的占位。
    expect(reads[1]).toMatchObject({ section: 'anchor', chars: 0, reason: 'empty-segment' });
  });

  it('② 新 Core → 两段各进各的 section，互不含对方的块标题', async () => {
    const h = harness(async () => segmented(IDENTITY_TEXT, ANCHOR_TEXT));
    await h.handle.bind('a1', 'team/user/agentA');
    expect(h.identity(SESSION('a1'))).toBe(IDENTITY_TEXT);
    expect(h.anchor(SESSION('a1'))).toBe(ANCHOR_TEXT);
    // 交叉检查：身份段里没有锚的块标题，锚里没有身份的。
    expect(h.identity(SESSION('a1'))).not.toContain('未完的事');
    expect(h.identity(SESSION('a1'))).not.toContain('底色');
    expect(h.anchor(SESSION('a1'))).not.toContain('使命');
    expect(h.anchor(SESSION('a1'))).not.toContain('读法');
    // 整卡的中段块不进提示词：两段拼起来也不含整卡标题。
    expect(h.identity(SESSION('a1')) + h.anchor(SESSION('a1'))).not.toContain('整卡标题');
    const reads = h.events.filter((e) => e.event === 'section-read' && e.sessionId === 'a1');
    expect(reads.map((e) => e.section)).toEqual(['identity', 'anchor']);
    expect(reads[0]).toMatchObject({ hash: sha256(IDENTITY_TEXT), chars: IDENTITY_TEXT.length });
    expect(reads[1]).toMatchObject({ hash: sha256(ANCHOR_TEXT), chars: ANCHOR_TEXT.length });
    // 两段 hash 必须不同：同一条日志里能靠 hash 区分是哪段。
    expect(reads[0].hash).not.toBe(reads[1].hash);
  });

  it('③ 两段都空 → 该会话无卡：getter 空串，section-read 两段各记 chars:0', async () => {
    const h = harness(async () => segmented('', '', ''));
    await h.handle.bind('a1', 'team/user/agentA');
    expect(h.handle.boundSessions()).toBe(0);
    expect(h.identity(SESSION('a1'))).toBe('');
    expect(h.anchor(SESSION('a1'))).toBe('');
    const reads = h.events.filter((e) => e.event === 'section-read' && e.sessionId === 'a1');
    expect(reads.map((e) => e.section)).toEqual(['identity', 'anchor']);
    expect(reads.map((e) => e.chars)).toEqual([0, 0]);
    expect(reads.every((e) => e.reason === 'no-card')).toBe(true);
  });

  it('③b identity 空但 anchor 非空 → 只注入 anchor，不注入空 identity 占位', async () => {
    const h = harness(async () => segmented('', ANCHOR_TEXT));
    await h.handle.bind('a1', 'team/user/agentA');
    expect(h.identity(SESSION('a1'))).toBe('');
    expect(h.anchor(SESSION('a1'))).toBe(ANCHOR_TEXT);
    const reads = h.events.filter((e) => e.event === 'section-read' && e.sessionId === 'a1');
    expect(reads[0]).toMatchObject({ section: 'identity', chars: 0, reason: 'empty-segment' });
    expect(reads[1]).toMatchObject({ section: 'anchor', chars: ANCHOR_TEXT.length });
    expect(reads[1]?.reason).toBeUndefined();
  });

  it('④ 两段各记一行；5 分钟心跳去重按「会话+段」分记，互不挤掉', async () => {
    const h = harness(async () => segmented('身份段', '锚段'));
    await h.handle.bind('a1', 'team/user/agentA');
    // 宿主每 step 取一次：两段交替取两轮，只该留两行（每段一行）。
    h.identity(SESSION('a1'));
    h.anchor(SESSION('a1'));
    h.identity(SESSION('a1'));
    h.anchor(SESSION('a1'));
    const a1 = h.events.filter((e) => e.event === 'section-read' && e.sessionId === 'a1');
    expect(a1.map((e) => e.section)).toEqual(['identity', 'anchor']);
    expect(a1.map((e) => e.chars)).toEqual([3, 2]);
    expect(a1.map((e) => e.hash)).toEqual([sha256('身份段'), sha256('锚段')]);
    // 无卡会话的 miss 也按段各记一行——否则「只看到 identity 没看到 anchor」会被误读成注入。
    h.identity(SESSION('a2'));
    h.anchor(SESSION('a2'));
    const a2 = h.events.filter((e) => e.event === 'section-read' && e.sessionId === 'a2');
    expect(a2.map((e) => e.section)).toEqual(['identity', 'anchor']);
  });

  it('⑤ identity section 的 order 固定 130，anchor 沿用调用方的尾部 order', async () => {
    const h = harness(async () => snapshot('卡A'));
    const byName = (name: string) => h.fake.sections.find((entry) => entry.name === name);
    expect(byName(PERSONA_IDENTITY_SECTION_NAME)).toMatchObject({ order: 1, interpolate: false });
    expect(byName(PERSONA_ANCHOR_SECTION_NAME)).toMatchObject({ order: ANCHOR_ORDER, interpolate: false });
    expect(PERSONA_IDENTITY_ORDER).toBe(1);
    // 旧名单不再注册：不会既注入整卡 section、又注入两段。
    expect(h.fake.sections.map((entry) => entry.name)).toEqual([
      PERSONA_IDENTITY_SECTION_NAME,
      PERSONA_ANCHOR_SECTION_NAME,
    ]);
    expect(h.fake.sections.some((entry) => entry.name === PERSONA_CARD_SECTION_NAME)).toBe(false);
  });

  it('⑤b installSection 返回组合 disposer：一次摘掉两个 section', async () => {
    const fake = createFakeContext();
    const handle = createPersonaCard({
      enabled: true,
      fetchCard: async () => snapshot('卡A'),
      fetchTurn: async () => ({ text: '', openLoops: [] }),
      timeoutMs: 50,
    });
    const dispose = handle.installSection(fake.ctx, ANCHOR_ORDER);
    expect(fake.sections.map((entry) => entry.name)).toEqual([
      PERSONA_IDENTITY_SECTION_NAME,
      PERSONA_ANCHOR_SECTION_NAME,
    ]);
    dispose();
    expect(fake.sections).toHaveLength(0);
  });

  it('⑥b 取卡失败时把 failReason 回报 Core（A4：stats 才看得到取卡失败）', async () => {
    const reports: Array<{ failReason?: string; failStatus?: number; sessionId?: string }> = [];
    const handle = createPersonaCard({
      enabled: true,
      fetchCard: async () => ({ reason: 'http_status', status: 503 }),
      fetchTurn: async () => ({ text: '', openLoops: [] }),
      timeoutMs: 50,
      reportInjection: (payload) => { reports.push(payload); },
    });
    const outcome = await handle.bind('a1', 'team/user/agentA');
    expect(outcome.ok).toBe(false);
    // 只带原因与会话键，不带卡正文；Core 侧据此写一行 phase=card 的失败行。
    expect(reports).toEqual([{ failReason: 'http_status', failStatus: 503, sessionId: 'a1' }]);
  });

  it('⑥ 回报 chars = 两段实际注入量之和，hash 仍是整卡 hash，且带上会话键', async () => {
    const reports: Array<{ card: { version: number; hash: string; chars: number }; sessionId?: string }> = [];
    const handle = createPersonaCard({
      enabled: true,
      fetchCard: async () => segmented('身份段', '锚段'),
      fetchTurn: async () => ({ text: '', openLoops: [] }),
      timeoutMs: 50,
      reportInjection: (payload) => { reports.push(payload); },
    });
    await handle.bind('a1', 'team/user/agentA');
    // 会话键必须一起报：Core 的 /v3/soul/injection 只从请求头取身份三元组，
    // 少了它就会退回挂载三元组（桌面端为空），整条记账被 422 静默吞掉。
    expect(reports).toEqual([{ card: { version: 1, hash: 'x'.repeat(64), chars: 3 + 2 }, sessionId: 'a1' }]);
  });

  it('⑥c 段注册失败不冒充注入：报 section_install_failed，chars 只算注册成功的段（A4 Round10）', async () => {
    const reports: Array<{ card?: { chars: number }; failReason?: string; sessionId?: string }> = [];
    const events: InjectionLogEvent[] = [];
    const fake = createFakeContext();
    const real = fake.ctx.systemPrompt.section.bind(fake.ctx.systemPrompt);
    fake.ctx.systemPrompt.section = ((options: Parameters<typeof real>[0]) => {
      if (options.name === PERSONA_IDENTITY_SECTION_NAME) throw new Error('host refused');
      return real(options);
    }) as typeof fake.ctx.systemPrompt.section;
    const handle = createPersonaCard({
      enabled: true,
      fetchCard: async () => segmented('身份段', '锚段'),
      fetchTurn: async () => ({ text: '', openLoops: [] }),
      timeoutMs: 50,
      injectionLog: memoryLog(events),
      reportInjection: (payload) => { reports.push(payload); },
    });
    handle.installSection(fake.ctx, ANCHOR_ORDER);
    await handle.bind('a1', 'team/user/agentA');
    // 本地日志：一行独立的注册失败证据。
    expect(events.some((e) => e.event === 'section-install-failed' && e.section === 'identity')).toBe(true);
    // 回报 Core：仍报卡（锚段确实进了），但 chars 只算锚段——不再是 3+2；
    // 另有一条段注册失败的 failReason（installSection 时上报，无会话键）。
    expect(reports).toContainEqual({ card: { version: 1, hash: 'x'.repeat(64), chars: 2 }, sessionId: 'a1' });
    expect(reports).toContainEqual({ failReason: 'section_install_failed' });
    const bound = events.find((e) => e.event === 'card-bound');
    expect(bound?.chars).toBe(2);
  });

  it('⑥d 两段都注册失败：不报 card，改报 failReason（否则 stats 会把「没注入」记成「注入成功」）', async () => {
    const reports: Array<{ card?: unknown; failReason?: string; sessionId?: string }> = [];
    const events: InjectionLogEvent[] = [];
    const fake = createFakeContext();
    fake.ctx.systemPrompt.section = (() => { throw new Error('host refused'); }) as typeof fake.ctx.systemPrompt.section;
    const handle = createPersonaCard({
      enabled: true,
      fetchCard: async () => segmented('身份段', '锚段'),
      fetchTurn: async () => ({ text: '', openLoops: [] }),
      timeoutMs: 50,
      injectionLog: memoryLog(events),
      reportInjection: (payload) => { reports.push(payload); },
    });
    handle.installSection(fake.ctx, ANCHOR_ORDER);
    await handle.bind('a1', 'team/user/agentA');
    expect(reports).toEqual([
      { failReason: 'section_install_failed' },
      { failReason: 'section_install_failed', sessionId: 'a1' },
    ]);
    expect(events.find((e) => e.event === 'card-bound')?.chars).toBe(0);
  });

  it('⑥e 空卡/空段：零字节绑定不再记成 card-bound，改报 failReason=empty（A4 Round13）', async () => {
    // 生产 3543 条 card-bound 里 3343 条 chars=0：Core 回空串时旧实现仍上报「绑定成功」，
    // stats 的 cardBound 因此把「什么都没进提示词」算成注入成功。
    const reports: Array<{ card?: unknown; failReason?: string; sessionId?: string }> = [];
    const events: InjectionLogEvent[] = [];
    const fake = createFakeContext();
    const handle = createPersonaCard({
      enabled: true,
      fetchCard: async () => segmented('', '', ''),
      fetchTurn: async () => ({ text: '', openLoops: [] }),
      timeoutMs: 50,
      injectionLog: memoryLog(events),
      reportInjection: (payload) => { reports.push(payload); },
    });
    handle.installSection(fake.ctx, ANCHOR_ORDER);
    await handle.bind('a1', 'team/user/agentA');
    expect(reports).toEqual([{ failReason: 'empty', sessionId: 'a1' }]);
    expect(events.some((e) => e.event === 'card-empty')).toBe(true);
    expect(events.some((e) => e.event === 'card-bound')).toBe(false);
  });
});
/**
 * 绑定结果契约（m08038 的冷启动重试依赖它）。
 *
 * 生产证据：宿主重启后插件 `apply 01:59:55`、Core healthy 约 `02:00:2x`，
 * 对恢复中的会话 `card-bound-failed reason:"parse"` → 首次 assemble
 * `section-read reason=no-card`（`persona-injection.jsonl` 02:00:41.902）。
 * 修法不是让 getter 兜底，而是让调用方**能判**「这是上游没准备好，还是这个
 * agent 真没卡」，从而在首次 assemble 之前把这段时间等掉。所以 bind 必须回话。
 */
describe('人格卡 · 分支继承（同一段对话一个人设）', () => {
  it('父会话有卡时：子会话拿到逐字节相同的卡，且不再取一次', async () => {
    const h = harness(async () => snapshot('审墨的卡正文'));
    await h.handle.bind('parent', 'team/user/agtA');
    const before = h.calls.length;
    expect(h.handle.inheritFrom('parent', 'child')).toBe(true);
    expect(h.getter(SESSION('child'))).toBe('审墨的卡正文');
    expect(h.calls.length).toBe(before); // 零网络：没有第二次 fetchCard
    const inherited = h.events.filter((e) => e.event === 'card-inherited');
    expect(inherited).toHaveLength(1);
    expect(inherited[0]?.parentSessionId).toBe('parent');
    expect(inherited[0]?.chars).toBe(h.handle.currentFor('parent').length);
  });

  it('父会话没有卡时返回 false，调用方据此回落到「按父身份重取」', async () => {
    const h = harness(async () => snapshot('x'));
    expect(h.handle.inheritFrom('parent', 'child')).toBe(false);
    expect(h.getter(SESSION('child'))).toBe('');
    expect(h.events.filter((e) => e.event === 'card-inherited')).toHaveLength(0);
  });

  it('父子同一个会话键 / 空键：不复制，避免自指与空键污染', async () => {
    const h = harness(async () => snapshot('卡'));
    await h.handle.bind('s1', 'team/user/agtA');
    expect(h.handle.inheritFrom('s1', 's1')).toBe(false);
    expect(h.handle.inheritFrom('', 's1')).toBe(false);
    expect(h.handle.inheritFrom('s1', '')).toBe(false);
    expect(h.handle.boundSessions()).toBe(1);
  });

  it('分支继承之后再 bind 新卡：覆盖只影响子会话，父会话不变', async () => {
    let text = '审墨';
    const h = harness(async () => snapshot(text));
    await h.handle.bind('parent', 'team/user/agtA');
    h.handle.inheritFrom('parent', 'child');
    text = '小满';
    await h.handle.bind('child', 'team/user/agtB');
    expect(h.handle.currentFor('child')).toBe('小满');
    expect(h.handle.currentFor('parent')).toBe('审墨');
  });
});
describe('人格卡 · 绑定结果（重试的判据来源）', () => {
  it('上游失败回 ok:false + reason，且不覆盖该会话已有的卡', async () => {
    let failing = false;
    const h = harness(async () => (failing ? { reason: 'http_status', status: 503 } : snapshot('卡A')));
    expect(await h.handle.bind('s1', 'team/user/agentA')).toEqual({ ok: true });
    expect(h.getter(SESSION('s1'))).toBe('卡A');

    failing = true;
    expect(await h.handle.bind('s1', 'team/user/agentA')).toEqual({ ok: false, reason: 'http_status' });
    // 失败保留上一份：宁可让这个会话继续用旧卡，也不能把它清成无卡。
    expect(h.getter(SESSION('s1'))).toBe('卡A');
    expect(h.events.filter((e) => e.event === 'card-bound-failed')).toHaveLength(1);
  });

  it('这个 agent 本来没卡（empty）算成功，调用方不该重试', async () => {
    const h = harness(async () => undefined);
    expect(await h.handle.bind('s1', 'team/user/agentA')).toEqual({ ok: true });
    expect(h.getter(SESSION('s1'))).toBe('');
    // A4 Round13：空卡不再写 card-bound（那会把「什么都没注入」记成成功），改记 card-empty。
    expect(h.events.filter((e) => e.event === 'card-empty')).toHaveLength(1);
    expect(h.events.filter((e) => e.event === 'card-bound')).toHaveLength(0);
  });

  it('绑定到「不关联」也算成功（清卡不是故障）', async () => {
    const h = harness(async () => snapshot('卡A'));
    await h.handle.bind('s1', 'team/user/agentA');
    expect(await h.handle.bind('s1', undefined)).toEqual({ ok: true });
    expect(h.getter(SESSION('s1'))).toBe('');
  });

  it('A4（Round5）：usageProbe 用 4-gram 覆盖测「注入的人格原文有没有出现在回复里」', async () => {
    const h = harness(async () => segmented('身份：我宁可慢一点，也不交付没验证过的东西。\n说话直接，先给结论。', '底色：遇到分歧先核对证据。'));
    await h.handle.bind('s1', 'team/user/agentA');
    const hit = h.handle.usageProbe('s1', '先给结论：我宁可慢一点，也不交付没验证过的东西。遇到分歧先核对证据。');
    expect(hit.totalLines).toBeGreaterThan(0);
    expect(hit.matchedLines).toBeGreaterThan(0);
    expect(hit.overlapPct).toBeGreaterThan(0);
    const miss = h.handle.usageProbe('s1', '今天上海有雨，记得带伞。');
    expect(miss.matchedLines).toBe(0);
    expect(miss.overlapPct).toBe(0);
    // 没有卡的会话：不编造写照。
    expect(h.handle.usageProbe('unknown', '我宁可慢一点，也不交付没验证过的东西。')).toEqual({ matchedLines: 0, totalLines: 0, overlapPct: 0 });
  });
});
