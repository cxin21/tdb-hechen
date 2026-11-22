/**
 * 分支会话的身份继承（B11）：父亲是谁，用 **plugin record** 记在父会话自己的 log 里。
 *
 * 为什么不用 `session.header.parentSession`：UI 的「在新对话中分支」走
 * `@deepseek-ai/dsh-api-session-controller` 的 `commands.fork`，它在
 * `ctx.agents.create({ meta: { cwd, isSeeded, agentPreset } })` 里**没有**带
 * `parentSession`（实测 2026-11-22：子会话 header 里该字段不存在，projcache 里
 * grep parentSession / fork / branch 零命中）。`parentSession` 唯一的写入点是
 * `SessionStore.fork`，而 UI 那条路自己造 seed 调 agents.create，绕过了它。
 *
 * 为什么事后补 header 补不上（三条硬约束，都读实）：
 *   1. `dsh-session` 构造时 `this.header = restoredHeader ?? snapshotSessionHeader(...)`
 *      —— 深拷贝快照，改调用方对象无效；
 *   2. `dsh-agent-loop.createAgent` 先 `createStoredSession` 落盘、后
 *      `setupAndPublish` 发 `agent/created` —— 插件看到 header 时已持久化；
 *   3. `dsh-agent.create(options)` 转发 `target.createAgent`，options 里根本没有父 id。
 *
 * 所以改用宿主自己承诺的机制：`appendPluginRecord` 写的记录是 `ignorable:true`
 * 的 log 事件，`buildForkSeed` 按引用复制源会话的前缀（`events.slice(0, boundary+1)`），
 * 文档原文「fork and resume carry it with the rest of the log」。子会话因此能在
 * 自己的 `inheritedEventCount` 之前的**冻结前缀**里读到父会话写下的身份记录，
 * 里面的 `sessionId` 就是父会话 id —— 外键直指，没有前缀哈希比对的歧义。
 *
 * 边界（都是往「退化」而不是「错绑」的方向走）：
 *   - 父会话还没绑身份就分支了：前缀里没有记录 -> 读不到 -> 调用方退回原路径；
 *   - 宿主格式迁移对插件记录是 best-effort：丢了同样只是退回去重新解析；
 *   - 记录只在身份真的变化时追加，不会每条 pre-step 都膨胀 log；
 *   - `@deepseek-ai/dsh-session` 解析不到（宿主换了打包方式）时整条链 fail-open：
 *     继承退化成「按新会话解析」，不会抛进 turn。
 */

/** 记录类型：`plugin:` + 斜杠分段的小写标识（宿主 `isPluginRecordType` 的语法）。 */
export const BRANCH_RECORD_TYPE = 'plugin:tdb-agemem/identity';

/** 记录里带的身份快照（只放读回时要用的字段，不放语气/人设正文）。 */
export interface BranchRecordPayload {
  /** 父会话 id —— 读回时用它反查 store。 */
  sessionId: string;
  teamId: string;
  agentId: string;
  userId: string;
  taskId?: string;
  agentLabel?: string;
  /** 记录格式版本：将来加字段时靠它判能不能读。 */
  version: 1;
  at: number;
}

/** 宿主 `@deepseek-ai/dsh-session` 上用到的那两个函数（按结构声明，不 import 类型）。 */
export interface PluginRecordIo {
  append(session: unknown, type: string, data: unknown): unknown;
  read(event: unknown): { type: string; data: unknown } | undefined;
}

const SESSION_MODULE = '@deepseek-ai/dsh-session';

let override: PluginRecordIo | null | undefined;
let loading: Promise<PluginRecordIo | undefined> | undefined;

/**
 * 宿主进程内解析 `@deepseek-ai/dsh-session`（实测 2026-11-22 12:37 成功：
 * `import.meta.resolve` 落在 `app.asar/dsh/node_modules/...`）。
 *
 * 用非字面量的 specifier 调 `import()`：TypeScript 因此不会去解析这个包
 * （插件没有也不能有它做 dependency —— 它由宿主提供），运行时才由宿主解析。
 */
async function loadPluginRecordIo(): Promise<PluginRecordIo | undefined> {
  if (override !== undefined) return override ?? undefined;
  if (loading !== undefined) return loading;
  loading = (async () => {
    try {
      const specifier: string = SESSION_MODULE;
      const mod = (await import(specifier)) as {
        appendPluginRecord?: (session: unknown, type: string, data: unknown) => unknown;
        pluginRecordOf?: (event: unknown) => { type: string; data: unknown } | undefined;
      };
      const append = mod.appendPluginRecord;
      const read = mod.pluginRecordOf;
      if (typeof append !== 'function' || typeof read !== 'function') return undefined;
      return {
        append: (session, type, data) => append(session, type, data),
        read: (event) => read(event),
      } satisfies PluginRecordIo;
    } catch {
      // 解析不到就是没有这条能力：继承退回按新会话解析（fail-open）。
      return undefined;
    }
  })();
  return loading;
}

/** 测试注入点：传 `undefined` 关掉（模拟宿主解析失败），传 `null` 恢复真实加载。 */
export function setPluginRecordIo(io: PluginRecordIo | undefined): void {
  override = io ?? null;
  loading = undefined;
}

interface SessionLike {
  log?: unknown;
  inheritedEventCount?: unknown;
  snapshotEvents?: (fromSeq?: number, toSeqExclusive?: number) => unknown;
  ownEvents?: () => unknown;
}

function sessionOf(agent: unknown): SessionLike | undefined {
  const session = (agent as { session?: unknown } | undefined)?.session;
  return session === null || typeof session !== 'object' ? undefined : (session as SessionLike);
}

function eventsBetween(session: SessionLike, from: number, to: number): unknown[] | undefined {
  if (typeof session.snapshotEvents === 'function') {
    const slice = session.snapshotEvents(from, to);
    return Array.isArray(slice) ? slice : undefined;
  }
  return Array.isArray(session.log) ? session.log.slice(from, to) : undefined;
}

/** 子会话从父会话继承来的那一段 log（`[0, inheritedEventCount)`）；不是分支就是空。 */
export function inheritedPrefixOf(agent: unknown): unknown[] {
  const session = sessionOf(agent);
  if (session === undefined) return [];
  const inherited = session.inheritedEventCount;
  if (typeof inherited !== 'number' || !Number.isInteger(inherited) || inherited <= 0) return [];
  return eventsBetween(session, 0, inherited) ?? [];
}

function payloadOf(record: { type: string; data: unknown } | undefined): BranchRecordPayload | undefined {
  if (record === undefined || record.type !== BRANCH_RECORD_TYPE) return undefined;
  const data = record.data as Partial<BranchRecordPayload> | null | undefined;
  if (data === null || typeof data !== 'object') return undefined;
  // 只认自己写的那一版：将来改了字段语义就换 version，宁可读不到也不要读错。
  if (data.version !== 1) return undefined;
  if (typeof data.sessionId !== 'string' || data.sessionId === '') return undefined;
  if (typeof data.teamId !== 'string' || typeof data.agentId !== 'string' || typeof data.userId !== 'string') {
    return undefined;
  }
  return {
    sessionId: data.sessionId,
    teamId: data.teamId,
    agentId: data.agentId,
    userId: data.userId,
    ...(typeof data.taskId === 'string' ? { taskId: data.taskId } : {}),
    ...(typeof data.agentLabel === 'string' ? { agentLabel: data.agentLabel } : {}),
    version: 1,
    at: typeof data.at === 'number' ? data.at : 0,
  };
}

/**
 * 从子会话的继承前缀里读父会话 id（**倒序**扫，最靠后的那条是最近的父身份）。
 *
 * 读不到就返回 undefined —— 这不是错误：父会话在分支时还没绑身份，或者宿主
 * 的格式迁移丢掉了这条记录，都属于「退回去重新解析」的正常情况。
 */
export async function readBranchParentId(agent: unknown): Promise<string | undefined> {
  const prefix = inheritedPrefixOf(agent);
  if (prefix.length === 0) return undefined;
  const io = await loadPluginRecordIo();
  if (io === undefined) return undefined;
  for (let index = prefix.length - 1; index >= 0; index -= 1) {
    const payload = payloadOf(io.read(prefix[index]));
    if (payload !== undefined) return payload.sessionId;
  }
  return undefined;
}

/** 从继承前缀里读父会话的完整身份快照（父会话已不在 store 里时的兜底）。 */
export async function readBranchParentRecord(agent: unknown): Promise<BranchRecordPayload | undefined> {
  const prefix = inheritedPrefixOf(agent);
  if (prefix.length === 0) return undefined;
  const io = await loadPluginRecordIo();
  if (io === undefined) return undefined;
  for (let index = prefix.length - 1; index >= 0; index -= 1) {
    const payload = payloadOf(io.read(prefix[index]));
    if (payload !== undefined) return payload;
  }
  return undefined;
}

function ownEventsOf(session: SessionLike): unknown[] | undefined {
  if (typeof session.ownEvents === 'function') {
    const own = session.ownEvents();
    if (Array.isArray(own)) return own;
  }
  const inherited = typeof session.inheritedEventCount === 'number' ? session.inheritedEventCount : 0;
  return Array.isArray(session.log) ? session.log.slice(inherited) : undefined;
}

/**
 * 把会话现在的身份写进它自己的 log（只在这个会话自己的事件里倒着找上一条）。
 *
 * 幂等：三元组 / 任务 / 显示名都没变就不写 —— 每条 pre-step 都追加会白白把 log
 * 撑大，而这条记录的唯一用途就是「将来有人从这里分支时读得到」。
 *
 * 返回 'written' | 'unchanged' | 'unavailable'（都是结论，不是异常）。
 */
export async function appendBranchIdentity(
  session: unknown,
  payload: BranchRecordPayload,
): Promise<'written' | 'unchanged' | 'unavailable'> {
  const like = session as SessionLike | undefined;
  if (like === null || typeof like !== 'object') return 'unavailable';
  const io = await loadPluginRecordIo();
  if (io === undefined || typeof io.append !== 'function') return 'unavailable';
  const own = ownEventsOf(like);
  if (own === undefined) return 'unavailable';
  for (let index = own.length - 1; index >= 0; index -= 1) {
    const previous = payloadOf(io.read(own[index]));
    if (previous === undefined) continue;
    const same =
      previous.sessionId === payload.sessionId &&
      previous.teamId === payload.teamId &&
      previous.agentId === payload.agentId &&
      previous.userId === payload.userId &&
      (previous.taskId ?? '') === (payload.taskId ?? '') &&
      (previous.agentLabel ?? '') === (payload.agentLabel ?? '');
    if (same) return 'unchanged';
    break;
  }
  try {
    io.append(like, BRANCH_RECORD_TYPE, { ...payload, version: 1 });
    return 'written';
  } catch {
    // 记录写不进去只是丢了下游的分支继承，绝不能影响这一轮。
    return 'unavailable';
  }
}
