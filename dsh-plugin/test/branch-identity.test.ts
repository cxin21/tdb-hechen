import { describe, expect, it } from 'vitest';
import {
  appendBranchIdentity,
  BRANCH_RECORD_TYPE,
  inheritedPrefixOf,
  readBranchParentId,
  readBranchParentRecord,
  setPluginRecordIo,
  type PluginRecordIo,
} from '../src/branch-identity.js';

const NOW = 1_700_000_000_000;

/**
 * Fake session: `prefix` is what a fork copied in (events [0, inheritedEventCount)),
 * `own` is what this session wrote itself.
 */
function fakeSession(prefix: unknown[], own: unknown[] = []) {
  const log = [...prefix, ...own];
  return {
    inheritedEventCount: prefix.length,
    log,
    snapshotEvents(from = 0, to = log.length) {
      return log.slice(from, to);
    },
    ownEvents() {
      return log.slice(prefix.length);
    },
  };
}

/** A host stand-in: records are plain objects carrying `ignorable`, like the real ones. */
function fakeIo(): PluginRecordIo & { appended: Array<{ type: string; data: any }> } {
  const appended: Array<{ type: string; data: any }> = [];
  return {
    appended,
    append(_session, type, data) {
      appended.push({ type, data });
    },
    read(event) {
      const record = event as { type?: unknown; data?: unknown; ignorable?: unknown } | null;
      if (record === null || typeof record !== 'object') return undefined;
      if (record.ignorable !== true || typeof record.type !== 'string') return undefined;
      return { type: record.type, data: record.data };
    },
  };
}

function record(data: Record<string, unknown>, type: string = BRANCH_RECORD_TYPE): unknown {
  return { type, seq: 1, time: NOW, data, ignorable: true };
}

const PAYLOAD = {
  sessionId: 'session-parent',
  teamId: 'team-a',
  agentId: 'agt-a',
  userId: 'usr-a',
  agentLabel: '青禾 (a)',
  version: 1 as const,
  at: NOW,
};

describe('branch identity record（B11：分支靠父会话自己写的记录认父）', () => {
  it('从继承前缀里读出父会话 id —— 外键直指，不做前缀比对', async () => {
    const io = fakeIo();
    setPluginRecordIo(io);
    try {
      const child = fakeSession([record({ ...PAYLOAD, teamId: 'team-x' }), record({ ...PAYLOAD })]);
      expect(inheritedPrefixOf({ session: child })).toHaveLength(2);
      expect(await readBranchParentId({ session: child })).toBe('session-parent');
    } finally {
      setPluginRecordIo(null);
    }
  });

  it('取前缀里最靠后的一条（父会话换过人，就应该继承最后一次）', async () => {
    const io = fakeIo();
    setPluginRecordIo(io);
    try {
      const child = fakeSession([
        record({ ...PAYLOAD, sessionId: 'session-old', agentId: 'agt-old' }),
        record({ ...PAYLOAD, sessionId: 'session-new', agentId: 'agt-new' }),
      ]);
      expect(await readBranchParentId({ session: child })).toBe('session-new');
      expect((await readBranchParentRecord({ session: child }))?.agentId).toBe('agt-new');
    } finally {
      setPluginRecordIo(null);
    }
  });

  it('不是分支（没有 inheritedEventCount）时读不到，也不报错', async () => {
    const io = fakeIo();
    setPluginRecordIo(io);
    try {
      expect(await readBranchParentId({ session: { log: [] } })).toBeUndefined();
      expect(await readBranchParentId({})).toBeUndefined();
      expect(await readBranchParentId(undefined)).toBeUndefined();
    } finally {
      setPluginRecordIo(null);
    }
  });

  it('父会话在分支时还没绑身份（前缀里没有记录）→ 退回重新解析', async () => {
    const io = fakeIo();
    setPluginRecordIo(io);
    try {
      const child = fakeSession([{ type: 'session/end-seed', data: { inherited: true } }]);
      expect(await readBranchParentId({ session: child })).toBeUndefined();
      expect(await readBranchParentRecord({ session: child })).toBeUndefined();
    } finally {
      setPluginRecordIo(null);
    }
  });

  it('只认自己这一版：别的 plugin record、坏字段、旧 version 都不算', async () => {
    const io = fakeIo();
    setPluginRecordIo(io);
    try {
      const child = fakeSession([
        record({ ...PAYLOAD }, 'plugin:other/thing'),
        record({ ...PAYLOAD, version: 2 }),
        record({ ...PAYLOAD, sessionId: '' }),
        record({ ...PAYLOAD, teamId: 7 }),
        record({ ...PAYLOAD, sessionId: 'session-real' }),
      ]);
      expect(await readBranchParentId({ session: child })).toBe('session-real');
    } finally {
      setPluginRecordIo(null);
    }
  });

  it('宿主解析不到 dsh-session 时整条链 fail-open（读 undefined，写 unavailable）', async () => {
    setPluginRecordIo(undefined);
    try {
      const child = fakeSession([record({ ...PAYLOAD })]);
      expect(await readBranchParentId({ session: child })).toBeUndefined();
      expect(await appendBranchIdentity(child, PAYLOAD)).toBe('unavailable');
    } finally {
      setPluginRecordIo(null);
    }
  });

  it('身份没变就不重复追加（幂等门，避免每条 pre-step 撑大 log）', async () => {
    const io = fakeIo();
    setPluginRecordIo(io);
    try {
      const session = fakeSession([], [record({ ...PAYLOAD, sessionId: 'session-self' })]);
      expect(await appendBranchIdentity(session, { ...PAYLOAD, sessionId: 'session-self' })).toBe('unchanged');
      expect(io.appended).toHaveLength(0);
    } finally {
      setPluginRecordIo(null);
    }
  });

  it('身份变了就追加一条，data 里带 version 与父 id', async () => {
    const io = fakeIo();
    setPluginRecordIo(io);
    try {
      const session = fakeSession([], [record({ ...PAYLOAD, sessionId: 'session-self', agentId: 'agt-old' })]);
      const outcome = await appendBranchIdentity(session, { ...PAYLOAD, sessionId: 'session-self' });
      expect(outcome).toBe('written');
      expect(io.appended).toHaveLength(1);
      expect(io.appended[0]?.type).toBe(BRANCH_RECORD_TYPE);
      expect(io.appended[0]?.data).toMatchObject({ sessionId: 'session-self', agentId: 'agt-a', version: 1 });
    } finally {
      setPluginRecordIo(null);
    }
  });

  it('写记录失败只是丢掉下游继承，绝不抛进这一轮', async () => {
    const failing: PluginRecordIo = {
      append() {
        throw new Error('session is closed');
      },
      read() {
        return undefined;
      },
    };
    setPluginRecordIo(failing);
    try {
      expect(await appendBranchIdentity(fakeSession([]), PAYLOAD)).toBe('unavailable');
    } finally {
      setPluginRecordIo(null);
    }
  });

  it('空会话（没有 session 对象）写不进去也读不出来，不抛', async () => {
    const io = fakeIo();
    setPluginRecordIo(io);
    try {
      expect(await appendBranchIdentity(undefined, PAYLOAD)).toBe('unavailable');
      expect(await appendBranchIdentity({}, PAYLOAD)).toBe('unavailable');
      expect(await readBranchParentRecord(undefined)).toBeUndefined();
    } finally {
      setPluginRecordIo(null);
    }
  });
});
