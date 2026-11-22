import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { agentKey } from './ids.js';
import type { MemoryIdentity } from './memory-client.js';
import type { AgememContext, LoggerLike, PreStepDecision } from './types.js';
import { resolveUserSessionInitDecision, type UserInitDecision } from './user-session-init.js';

/** 会话开始时候选拉取的一次重试间隔：只用来跨过宿主机/核心的瞬时不可达。 */
const CANDIDATES_RETRY_DELAY_MS = 700;

/**
 * 自愈探针的超时（R33-8）：会话启动时用 4s（不能拖慢第一屏），但自愈发生在会话
 * 已经跑起来之后，Core 可能正在冷启动尾部或跑 backfill，4s 会把「慢」记成
 * 「transport failure」并再压 2 分钟。自愈给 10s，仍然有界。
 */
const HEAL_PROBE_TIMEOUT_MS = 10_000;

/**
 * P0-2：陈旧「跳过」的重试门槛。
 *
 * 2026-11-19 现场：Core 重启窗口里那一次 candidates 拉取以
 * 'transport failure: fetch failed' 收尾，会话就被永久记成 skipped —— 之后
 * 每个 tick 读到这条记录就直接返回，176 个分支又都 inherited 了它的空三元组，
 * 于是整棵树永远取不到卡（段读一律 no-card，注入无法对账）。
 *
 * 为什么是 2 分钟：观测到的 Core 重启窗口是 10–60s，2 分钟足以跨过它；而同一个
 * turn 的多个 pre-step 相隔只有毫秒到秒级，年龄门槛保证「本轮刚失败」不会在同一
 * 轮里被反复重试。重试失败只推 at，等于每个会话最多每 2 分钟一次探测（单次
 * 开销最多一次 candidates 往返 + 0.7s 退避）。at=0（旧文件/损坏值）视为足够旧。
 */
export const SKIP_RETRY_MIN_AGE_MS = 2 * 60 * 1000;

/**
 * How long an unresolved session waits before retrying "candidates failed" on a
 * later pre-step. The old behaviour froze the failure forever, so a 3-second
 * core restart cost the whole conversation (and every fork of it) its identity:
 * the chip kept saying 「未关联」 while the account DID have a preset.
 */
export const UNRESOLVED_RETRY_MIN_AGE_MS = 30 * 1000;

/** pick() 写失败原因时加的前缀：reason 形如 'candidates failed: transport failure: fetch failed'。 */
const CANDIDATES_FAILED_PREFIX = 'candidates failed: ';

/**
 * 这条 reason 是不是一次「候选拉取失败」——不论传输层还是 Core 拒绝。
 * 两者都是**窗口性**的（网络抖动 / Core 在重启），Core 回来后重解就该成功；
 * 与「没有团队」「有歧义且没用 chip」这种**确定性**结论必须区别对待：后者重解
 * 一百次也是同一个结论，只会白打网络。
 */
export function isCandidatesFailure(reason: string | undefined): boolean {
  return typeof reason === 'string' && reason.startsWith(CANDIDATES_FAILED_PREFIX);
}

/**
 * 这条 reason 是不是「候选拉取的传输层失败」——只有这两类才值得自愈重试。
 * 4xx/5xx（'core said 503' 之类）是 Core 真在拒绝，重试只是多打一次网络。
 */
export function isCandidatesTransportSkip(reason: string | undefined): boolean {
  if (typeof reason !== 'string' || reason === '') return false;
  const detail = reason.startsWith(CANDIDATES_FAILED_PREFIX)
    ? reason.slice(CANDIDATES_FAILED_PREFIX.length)
    : reason;
  return detail.startsWith('transport failure') || detail.startsWith('timed out');
}

/** 记录是否旧到可以再试一次（口径见 SKIP_RETRY_MIN_AGE_MS）。 */
export function isStaleForRetry(
  binding: { at?: number },
  now: number,
  minAgeMs: number = SKIP_RETRY_MIN_AGE_MS,
): boolean {
  const at = typeof binding.at === 'number' && Number.isFinite(binding.at) ? binding.at : 0;
  return now - at >= minAgeMs;
}

/** 分支绑定 reason 里的父会话 id（'branch of <sessionId>'）；不是分支绑定则 undefined。 */
export function branchParentOf(reason: string | undefined): string | undefined {
  if (typeof reason !== 'string') return undefined;
  const match = /^branch of ([^\s]+)$/.exec(reason.trim());
  return match === null ? undefined : match[1];
}

/** 空三元组 = 什么身份都没绑上（inherited 分支从失败父会话复制出来的那种）。 */
export function isEmptyTriple(binding: { teamId: string; agentId: string; userId: string }): boolean {
  return binding.teamId === '' && binding.agentId === '' && binding.userId === '';
}

/**
 * An empty triple that NOBODY chose: the account's candidates were unreachable
 * (or ambiguous and the chip was never used), so the record means "not resolved
 * yet", not "the user said 本次不关联". Only an explicit decline carries
 * associate:false, and that one must keep reading as a decision.
 */
export function isUnresolvedBinding(binding: { source: string; associate?: boolean } & {
  teamId: string; agentId: string; userId: string;
}): boolean {
  if (binding.associate === false) return false;
  if (!isEmptyTriple(binding)) return false;
  return binding.source === 'skipped' || binding.source === 'delegated' || binding.source === 'inherited';
}

/**
 * An empty triple the SYSTEM wrote on the user's behalf, not one the user chose:
 * the account was ambiguous and the chip was never touched (rule ⑤ -> 「本次不关联」),
 * or a branch inherits a parent that had nothing to inherit.
 *
 * It reads like a decline -- writes skip, nothing lands in a guessed team -- but
 * it must NOT freeze the session. Measured pain (2026-11-22 10:02, session
 * 386626c4): the first turn stamped committedAt on this row, the chip turned into
 * a read-only 「未关联」 label, and the user lost every way to say who this
 * conversation belongs to -- for a decision nobody had made.
 *
 * Freezing is about SPLITTING data (turn 1 in agent A, turn 10 in agent B). A row
 * with no triple has written nothing, so a later real choice cannot split
 * anything: it only starts writing.
 */
export function isProvisionalDecline(binding: { source: string; associate?: boolean } & {
  teamId: string; agentId: string; userId: string;
}): boolean {
  if (binding.associate !== false) return false;
  if (!isEmptyTriple(binding)) return false;
  return binding.source === 'skipped' || binding.source === 'inherited';
}

/**
 * Session identity: one silent resolution per session, decided in the COMPOSER.
 *
 * The remembered flow is the proxy's: a conversation reads and writes inside one
 * Team (and one Agent inside it). The first port of that idea -- a userQuestions
 * card popped by 'agent/pre-step' -- turned out to be the wrong seam for this
 * host. The host refuses to swap an agent's tools after a turn has run, so a
 * question that can only be answered while a turn is open arrives too late by
 * construction; and answering it used to wipe the workspace of the session that
 * was being started.
 *
 * So the choice moved to where the host itself keeps a per-conversation choice:
 * the composer tool row, next to the model picker. A chip there opens one panel
 * (Team / Agent / Task) and STAGES a choice; the first turn of that session
 * turns the staging into the binding. From then on the chip is a read-only
 * label -- the same rule the host applies to its own agent preset.
 *
 * Where a binding comes from, in order:
 *
 *  0. Written ONCE and never again (I1/I2): the first submit stamps
 *     committedAt, and from then on the row is read-only -- the chip renders as
 *     a label, choose refuses, and every heal short-circuits. A conversation
 *     whose identity could still move would write turn 1 into one agent library
 *     and turn 10 into another.
 *
 *  1. The chip: whatever the user staged before the first turn. An explicit
 *     click in THIS session outranks the account default below -- otherwise the
 *     panel 本次不关联 could never be reached once a preset agent exists,
 *     which is exactly the case the panel fixes that button for.
 *  2. A preset in the user's per-user `session_init` config (the proxy's
 *     manual_select=0 path): bind silently. Its default_agent_id is shown in the
 *     panel but is never selectable -- the user asked for exactly that.
 *  3. Nothing to ask: one team and one agent (or the configured triple).
 *  4. "本次不关联": the explicit empty triple -- the panel's own button, a
 *     session_init bypass, or an ambiguous account whose chip was never touched.
 *
 * Four rules, each the result of a measured host behaviour:
 *
 *  - NEVER block a turn. Resolution is bounded by the metadata budget; every
 *    failure (no key, no candidates, transport error) resolves instead of
 *    rejecting, and the turn continues.
 *  - NEVER resolve twice. A binding is written for the session (memory +
 *    optional state file) before the handler returns, and concurrent pre-steps
 *    of the same session await the SAME in-flight promise.
 *  - NEVER ask a machine. A headless composition has no user key: it takes the
 *    silent path with no warn. There is no question service in this file.
 *  - NEVER resolve in a branch. A fork shares its parent's history, so it
 *    inherits its parent's identity; a new persona means a new session.
 */

/** Where a session's identity came from; also the store's audit field. */
export type IdentitySource =
  | 'userkey'
  /** Bound silently from the user's session_init preset. */
  | 'user-preset'
  /** session_init says default_associate=0: associate nothing. */
  | 'user-bypass'
  /**
   * 用户按了 chip 面板的「本次不关联」。与 user-bypass 的区别只在归因：一个是
   * 账号配置，一个是本次会话的当场决定；两者都写空三元组、都不注入。
   */
  | 'user-declined'
  /** Resolved with no interaction: one team/agent, or the configured triple. */
  | 'auto'
  /** Chosen by the user in the composer chip, committed on the first turn. */
  | 'chip'
  /**
   * Legacy：会话开始弹窗路径写下的值。新代码不再产生它，但旧状态文件里还有，
   * previouslyChosenTriple 仍把它当成「用户亲手选过」。
   */
  | 'picked'
  /** 分支（fork/压缩）从父会话继承的身份：同一段对话，同一套三元组。 */
  | 'inherited'
  | 'skipped'
  /**
   * P0-2：这条会话曾被传输层失败记成 skipped，之后一次陈旧重试把 candidates
   * 拉回来了并静默绑上。与 'picked' 分开只为一件事：审计能看出「没弹过窗、是
   * 自愈补上的」，而不是把一次恢复说成用户的选择。
   */
  | 'recovered'
  | 'delegated';

/** The panel's virtual "default task": no task scope, never "skip everything". */
export const NO_TASK_LABEL = '本次不关联任务';

export interface SessionBinding {
  teamId: string;
  agentId: string;
  userId: string;
  /**
   * Optional work item (Task). Empty = "this session is not associated with a
   * task"; it narrows nothing. Only ever set from the task card.
   */
  taskId?: string;
  source: IdentitySource;
  /** Why it was skipped/resolved; free text, never a secret. */
  reason?: string;
  /**
   * 明确的「本次不关联」。只有它允许清掉该会话已注入的人格卡。
   *
   * 缺省（undefined）= 有意向关联、但这次没绑成（候选接口超时、弹窗被打断、
   * 没有可退回的三元组）。此时必须**保留**已有卡：把它当成「不关联」会在切换
   * 人设的那一轮造成无卡窗口（2026-11-08 02:14 现场：先清卡、9 秒后才绑上）。
   */
  associate?: boolean;
  /**
   * P2-C：这个会话绑定的**自然人**（Core 的 `person_key`，`p_` 前缀）。
   *
   * 只来自 Core 的回答，不在插件里推导：绑卡时 `/v3/soul/card` 若按人过滤且
   * 过滤结果恰好是一个人，`persons` 就带一个 key，这里照抄；0 个或多于 1 个
   * 都留空（多人同场时归到谁身上都是猜 —— 与 Core 侧 human 行的裁决同一口径）。
   */
  personKey?: string;
  /**
   * P0-2 观测面：最近一次自愈探测（healSkipped / healBranch）的时间与**这一次**的
   * 失败原因。原来的 reason 是建记录时那一次失败，被刻意保留（重试失败不该改写历史
   * 结论），于是线上永远看不到「现在到底为什么还不行」。成功绑定后随新记录一起消失。
   */
  lastHealAt?: number;
  lastHealProbe?: string;
  /** Epoch ms. */
  at: number;
  /**
   * When this identity became FINAL (I1). Present = frozen: `ensureBound` writes
   * nothing more for the session and the heals are short-circuited, so the agent
   * that answered turn 1 is the agent that answers turn 10. Absent only on
   * records written by an older build, which still get one P0-2 heal.
   */
  committedAt?: number;
  /**
   * Epoch ms the row was written BEFORE the conversation ran a turn.
   *
   * A row created at `agent/created` is a PRE-ANSWER: it freezes the identity
   * that turn 1 will use, but the user has not said anything yet. Two such rows
   * must still be their choice, because the question they answer ("which agent
   * does this conversation belong to") is exactly the one the composer chip
   * asks -- and answering it by pressing 发送 is not an answer:
   *   - 「有默认 agent 时仍允许本次不关联」(rule ②): the preset freezes at
   *     creation, so without this the panel入口 would never open (2026-11-22
   *     11:56 现场 session-7ce40b5d: chip was a bare StaticText the moment the
   *     conversation existed, and 本次不关联 was unreachable);
   *   - D4: the chip shows 「待生效」 until the first POST has an identity, so
   *     the first turn's writeback must be HELD, not sent under the preset the
   *     user was about to change (2026-11-22 12:04 现场).
   * Cleared by the first `agent/pre-step` (see confirmPendingRow): from then on
   * the row is frozen like any other committed one.
   */
  unconfirmedAt?: number;
  /**
   * I3: the display label captured WHEN the binding was made ("青禾 (8k22f496)").
   *
   * The chip is a read-only label after the first turn, so it needs the name for
   * as long as the conversation lives -- but the name only comes back from a
   * candidates read, and that read can be slow or down for the rest of the
   * session. Measured 2026-11-22 11:34 (session dceb0a9e): core timed out on one
   * describe call and the chip fell back to rendering the raw id
   * 「TDB 记忆 · agt-3i8k22f496」-- true, ugly, and unfixable from the client
   * because the store never kept the name.
   */
  agentLabel?: string;
}


export interface TeamChoice {
  teamId: string;
  name?: string;
}

export interface AgentChoice {
  agentId: string;
  name?: string;
  description?: string;
}

/** One work item as the task card needs it (metadata task/list, status=running). */
export interface TaskChoice {
  taskId: string;
  title?: string;
}

/** What the metadata routes produced (see identity.ts listCandidates). */
export type CandidatesResult =
  | { kind: 'ok'; userId: string; teams: TeamChoice[]; agents?: AgentChoice[]; tasks?: TaskChoice[] }
  | { kind: 'failed'; reason: string };

export interface SessionIdentitySettings {
  /**
   * Master switch: false = never resolve, never fetch candidates; the configured
   * three ids are used as-is. For headless compositions that want zero network.
   */
  enabled: boolean;
  /**
   * Honour the per-user `session_init` config (manual_select / default_associate
   * / default_team_id / default_agent_id), like the proxy.
   *
   * true（缺省）：preset 静默绑定 / bypass 不关联；false：跳过读配置，一律走
   * chip 与无歧义兜底。
   */
  followUserSessionInit: boolean;
  /** 绑定写状态文件：重启后同 session 不再解析。false = 只记内存。 */
  rememberSession: boolean;
  /** '' -> 由 outbox 目录推导；否则就是这个 JSON 状态文件的绝对路径。 */
  statePath: string;
}


/** Bounded state file: one entry per live session, evicted oldest first. */
const MAX_STORED_SESSIONS = 200;

/**
 * Memory + optional JSON file of session bindings.
 *
 * Reads are synchronous on purpose: identityFor(sessionId) runs inside
 * headers(), which cannot await. Writes are atomic (tmp + rename) and never
 * throw -- a full disk must not take a turn down with it.
 */
export class SessionIdentityStore {
  private readonly sessions = new Map<string, SessionBinding>();
  private readonly loaded: boolean;

  constructor(private readonly options: {
    statePath?: string;
    log?: LoggerLike;
    now?: () => number;
  } = {}) {
    this.loaded = this.load();
  }

  get(sessionId: string | undefined): SessionBinding | undefined {
    if (typeof sessionId !== 'string' || sessionId === '') return undefined;
    return this.sessions.get(sessionId);
  }

  set(sessionId: string, binding: SessionBinding): void {
    if (sessionId === '') return;
    this.sessions.set(sessionId, binding);
    this.evict();
    this.persist();
  }

  /** Test/ops seam: how many sessions are remembered. */
  get size(): number {
    return this.sessions.size;
  }

  /**
   * Every remembered binding (P0-2 收口：歧义兜底要看得到「本机历史上用户选过什么」)。
   * Returns the live objects; callers must not mutate them.
   */
  values(): SessionBinding[] {
    return [...this.sessions.values()];
  }

  private evict(): void {
    if (this.sessions.size <= MAX_STORED_SESSIONS) return;
    const ordered = [...this.sessions.entries()].sort((a, b) => a[1].at - b[1].at);
    for (let index = 0; index < ordered.length - MAX_STORED_SESSIONS; index += 1) {
      this.sessions.delete(ordered[index][0]);
    }
  }

  private load(): boolean {
    const path = this.options.statePath;
    if (path === undefined || path === '') return false;
    try {
      const raw = readFileSync(path, 'utf8');
      const parsed = JSON.parse(raw) as { sessions?: Record<string, SessionBinding> };
      const entries = parsed?.sessions;
      if (entries === null || typeof entries !== 'object') return false;
      for (const [sessionId, binding] of Object.entries(entries)) {
        if (binding === null || typeof binding !== 'object') continue;
        if (typeof binding.teamId !== 'string' || typeof binding.agentId !== 'string') continue;
        if (typeof binding.userId !== 'string') continue;
        this.sessions.set(sessionId, {
          teamId: binding.teamId,
          agentId: binding.agentId,
          userId: binding.userId,
          // Optional scope: an old state file simply has no taskId.
          ...(typeof binding.taskId === 'string' && binding.taskId !== '' ? { taskId: binding.taskId } : {}),
          source: binding.source ?? 'picked',
          reason: typeof binding.reason === 'string' ? binding.reason : undefined,
          ...(typeof (binding as { lastHealAt?: unknown }).lastHealAt === 'number' ? { lastHealAt: binding.lastHealAt } : {}),
          ...(typeof (binding as { lastHealProbe?: unknown }).lastHealProbe === 'string' ? { lastHealProbe: binding.lastHealProbe } : {}),
          at: typeof binding.at === 'number' && Number.isFinite(binding.at) ? binding.at : 0,
          // I1 must survive a restart. Without this the freeze flag is lost on
          // every process start, and a bound conversation quietly becomes
          // editable again -- the exact hole that lets turn 10 land in a
          // different agent's library than turn 1.
          // Same reason as committedAt: an offered-but-unconfirmed row must still
          // be editable after a restart, otherwise a process restart silently
          // turns the preset into a decision the user never made.
          ...(typeof (binding as { unconfirmedAt?: unknown }).unconfirmedAt === 'number'
            && Number.isFinite(binding.unconfirmedAt)
            ? { unconfirmedAt: binding.unconfirmedAt }
            : {}),
          ...(typeof (binding as { committedAt?: unknown }).committedAt === 'number'
            && Number.isFinite(binding.committedAt) ? { committedAt: binding.committedAt } : {}),
          ...(typeof (binding as { agentLabel?: unknown }).agentLabel === 'string'
            && (binding as { agentLabel: string }).agentLabel.trim() !== ''
            ? { agentLabel: (binding as { agentLabel: string }).agentLabel } : {}),
        });
      }
      return true;
    } catch {
      // Missing/corrupt state is not an error: it only costs one card.
      return false;
    }
  }

  private persist(): void {
    const path = this.options.statePath;
    if (path === undefined || path === '') return;
    try {
      const sessions: Record<string, SessionBinding> = {};
      for (const [sessionId, binding] of this.sessions) sessions[sessionId] = binding;
      const payload = JSON.stringify({ version: 1, sessions });
      mkdirSync(dirname(path), { recursive: true });
      const temporary = path + '.tmp-' + String(process.pid);
      writeFileSync(temporary, payload, 'utf8');
      renameSync(temporary, path);
    } catch (error) {
      this.options.log?.debug?.('agemem: session identity state not written', error);
    }
  }

  /** Only used by tests to assert the file round-trip. */
  get hasFileState(): boolean {
    return this.loaded;
  }
}

export interface SessionIdentityDeps {
  settings: SessionIdentitySettings;
  /** The three ids to fall back on (config, or the mount-time userKey resolution). */
  base: MemoryIdentity;
  /** The account's user key: undefined = headless (no candidates, no chip). */
  resolveUserKey: () => Promise<string | undefined>;
  /** Teams, and (given one team) its agents and tasks. Never throws. */
  candidates: (input: { userKey: string; teamId?: string; timeoutMs?: number }) => Promise<CandidatesResult>;
  /** Per-user `session_init` config reader; absent = always the chip path. */
  getUserSessionInit?: (input: { userKey: string; userId: string; timeoutMs?: number }) => Promise<Record<string, string> | null>;
  store: SessionIdentityStore;
  /** Per metadata-call budget. */
  timeoutMs: number;
  log?: LoggerLike;
  /** Called once per pre-step with the session this step belongs to. */
  onSessionSeen?: (sessionId: string) => void;
  /** Called when a session gets bound, so a frozen head pack can refetch. */
  onBound?: (sessionId: string, binding: SessionBinding) => void;
  /**
   * B11：这个会话是不是从别的会话分支出来的，父会话 id 是谁。
   *
   * 宿主 UI 的「在新对话中分支」**不写** `header.parentSession`（2026-11-22 实测
   * projcache 零命中），所以父关系由插件自己记进父会话 log 的 plugin record，
   * 由 index.ts 在 `agent/created` 解析后同步填进这张表。返回 undefined 就是
   * 「不是分支，或还没解析出来」—— 两者都退回按新会话解析。
   */
  knownBranchParent?: (agent: unknown) => string | undefined;
  now?: () => number;
}

/**
 * One committed choice: the triple plus the optional task scope.
 *
 * `associate === false` 是面板的「本次不关联」：空三元组会让
 * memory-client.missingIdentity() 对每次调用都报 'teamId'，于是 volatile、
 * head-pack、recall、writeback 全部跳过，而不是悄悄读写「配置的」那个 team 池。
 */
export interface IdentityChoice {
  teamId: string;
  agentId: string;
  taskId?: string;
  associate?: boolean;
}

/** One row of the chip's panel: the id is never shown, only the label is. */
export interface ComposerOption {
  id: string;
  label: string;
  detail?: string;
  /** Present only for the preset agent: rendered, never selectable. */
  locked?: boolean;
}

/** Everything the composer chip needs to paint its panel (one round trip). */
export interface ComposerState {
  /** 'inert' = no user key; 'failed' = candidates unreachable. */
  status: 'ok' | 'inert' | 'failed';
  reason?: string;
  /** Present once the session is bound: from then on the chip is read-only. */
  bound?: SessionBinding;
  /** The staged (not yet committed) choice, if the user already pressed 确定. */
  staged?: IdentityChoice;
  /**
   * True when the session already has a record but that record is an empty
   * triple nobody chose (a candidates failure, or "ambiguous and the chip was
   * never used"). The chip stays editable in that state: showing 「未关联」 for
   * a user who HAS a preset was a lie, and it locked the correction out.
   */
  unresolved?: boolean;
  /**
   * A committed row that is still a PRE-ANSWER: `unconfirmedAt` is set, i.e.
   * the identity was picked at creation and not one turn has run under it. The
   * chip stays clickable in that state (rule ②, see SessionBinding.unconfirmedAt)
   * and marks itself 「待生效」 so nobody mistakes it for an applied setting.
   */
  editable?: boolean;
  /** The team whose agents/tasks are listed below ('' = account has several). */
  teamId: string;
  teams: ComposerOption[];
  agents: ComposerOption[];
  tasks: ComposerOption[];
}

export interface SessionIdentity {
  /** The ready line's field: on(chip) | off(config) | inert(no key) ... */
  status(): string;
  /** Idempotent, bounded, never throws; the volatile block calls it too. */
  ensureBound(agent: unknown, signal?: unknown): Promise<void>;
  /** The composer chip asks for this session's candidate lists (read-only). */
  /**
   * What a writeback queued for this session should do RIGHT NOW (I4):
   *
   *  - 'send'     -- it has an identity, send it.
   *  - 'skip'     -- the user declined (associate:false). No identity is coming,
   *                  so the write would never succeed; drop it silently.
   *  - 'defer'    -- no binding at all: the session simply has not been resolved
   *                  yet. Hold the write and flush it the moment onBound fires.
   *
   * The distinction is the whole point of D4: before this, 'defer' and 'skip'
   * were both reported as 'identity missing', so a conversation that started while
   * the core was down lost every turn to the dead-letter file.
   */
  writebackPolicy(sessionId: string): 'send' | 'skip' | 'defer';
  describe(sessionId: string, teamId?: string): Promise<ComposerState>;
  /**
   * The composer chip committed a choice (staged until the first turn runs).
   * Returns false when the session is already committed: the chip is a label at
   * that point, and a refused click that answers 200 while changing nothing is
   * the worst kind of silent failure.
   */
  choose(sessionId: string, choice: IdentityChoice): boolean;
  dispose(): void;
}

/**
 * What a panel row shows: the human name, then the last 8 chars of the id.
 *
 * The full id is noise in a dropdown, but the tail is what disambiguates two
 * same-named teams or agents, so it is kept in parentheses.
 */
export function labelOf(name: string | undefined, id: string): string {
  const base = (name ?? '').trim();
  if (base === '') return id;
  return base + ' (' + id.slice(-8) + ')';
}

/**
 * Round26（r26e-a1）：清卡归因。declined=用户明确选了「本次不关联」；
 * unconfigured=会话没有可用身份（配置缺口，不是用户的决定）。
 */
export type CardClearedSource = 'declined' | 'unconfigured';

/**
 * 从会话绑定推出「为什么这张卡被清掉」。
 *
 * 旧实现里「没有绑定」与「绑定被清空」都落到同一句 reason=unassociated，面板于是把
 * 配置缺口说成用户的决定（r26e-a1 判据1 FAIL）。这里把判据收在一处，三个调用点共用。
 */
export function cardClearedSource(bound: { associate?: boolean } | undefined): CardClearedSource {
  return bound !== undefined && bound.associate === false ? 'declined' : 'unconfigured';
}
/**
 * Install the silent resolver. The listener is prepended so it runs before the
 * volatile block and before every other consumer of the identity reads it.
 */
export function installSessionIdentity(ctx: AgememContext, deps: SessionIdentityDeps): SessionIdentity {
  const settings = deps.settings;
  const now = deps.now ?? Date.now;
  /** sessionId -> the ask that is already running (hard requirement C). */
  const inFlight = new Map<string, Promise<void>>();
  /** sessionId -> the P0-2 self-heal already running (one candidates probe per session). */
  const healInFlight = new Map<string, Promise<void>>();
  /** sessionId -> the composer chip's committed-but-not-yet-bound choice. */
  const staged = new Map<string, IdentityChoice>();
  /**
   * sessionId -> earliest time a transient failure may be retried (D3/I4).
   *
   * A transport failure writes NOTHING to the store: a persisted row that says
   * skipped is indistinguishable from a decision, survives restarts, and (before
   * this) locked the whole session -- and every branch of it -- out of its
   * identity for good after a 3-second core hiccup. Absence of a row is the
   * honest representation of "not resolved yet"; this map only stops the same
   * turn from re-probing per step.
   */
  const retryAfter = new Map<string, number>();
  /**
   * agentId -> display label, learned from any candidates read. `submit` copies
   * the label into the row (I3) so a later describe() can still name the agent
   * after core stops answering; without this the chip degrades to a raw id.
   */
  const agentLabels = new Map<string, string>();
  const rememberAgentLabels = (agents: AgentChoice[] | undefined): void => {
    if (agents === undefined) return;
    for (const agent of agents) agentLabels.set(agent.agentId, labelOf(agent.name, agent.agentId));
  };
  let warnedPresetMismatch = false;
  let statusLabel = settings.enabled ? 'on(chip)' : 'off(config)';

  const debug = (...args: unknown[]): void => deps.log?.debug?.(...args);

  const bindingFor = (source: IdentitySource, reason: string | undefined): SessionBinding => ({
    teamId: deps.base.teamId,
    agentId: deps.base.agentId,
    userId: deps.base.userId,
    source,
    reason,
    at: now(),
  });

  /** The ONE place a binding is written: store, status line, head-pack refresh. */
  const submit = (sessionId: string, binding: SessionBinding, unconfirmed = false): void => {
    // I1: every write through this door is FINAL. `committedAt` is the flag the
    // rest of the file reads. Measured pain: a 30s self-heal window used to swap
    // the identity of a conversation that had already written turns under the
    // old one, because "not resolved" and "resolved" looked the same in the
    // store.
    // I3: freeze the display label with the binding. A read-only chip must be
    // able to say 「青禾 (8k22f496)」without a candidates round trip.
    const knownLabel = binding.agentId === '' ? undefined : agentLabels.get(binding.agentId);
    const row: SessionBinding = {
      ...binding,
      ...(binding.agentLabel === undefined && knownLabel !== undefined ? { agentLabel: knownLabel } : {}),
      committedAt: binding.committedAt ?? now(),
      ...(unconfirmed ? { unconfirmedAt: now() } : {}),
    };
    deps.store.set(sessionId, row);
    retryAfter.delete(sessionId);
    statusLabel = 'bound(' + binding.source + ')';
    debug('agemem: session identity bound', {
      sessionId,
      source: binding.source,
      team: binding.teamId,
      agent: binding.agentId,
      task: binding.taskId,
      reason: binding.reason,
    });
    try {
      deps.onBound?.(sessionId, row);
    } catch {
      // A refresh callback must never break the turn it was called from.
    }
  };

  /**
   * Turn 1 is about to run: whatever the creation-time rows said, this session
   * now writes under its identity, so the window for changing it closes.
   *
   * Called on EVERY pre-step (idempotent, two store reads at most): the row is
   * at most one step old, so "the turn that is about to speak" is the right
   * moment. The chip's own click (choose) is the only way in before this, and
   * the freeze afterwards is exactly I1.
   */
  const confirmPendingRow = (sessionId: string): void => {
    const row = deps.store.get(sessionId);
    if (row === undefined || row.unconfirmedAt === undefined) return;
    const { unconfirmedAt: offeredAt, ...confirmed } = row;
    deps.store.set(sessionId, confirmed);
    // A held write was waiting for exactly this: the identity is now real, so
    // the deferred hold can be released on the same step.
    retryAfter.delete(sessionId);
    debug('agemem: session identity confirmed by its first turn', {
      sessionId,
      source: row.source,
      openForMs: now() - offeredAt,
    });
  };

  /** Fall back to the configured triple (no card answer, or a failure). */
  const bindSkipped = (sessionId: string, reason: string, source: IdentitySource = 'skipped'): void => {
    submit(sessionId, bindingFor(source, reason));
  };

  /**
   * A failure that says NOTHING about the identity (core unreachable, candidates
   * timed out). Writes no row: the session stays unresolved, the chip stays
   * editable, and the next turn past the backoff resolves it for real. This is
   * the D3/I4 split -- "we could not ask" must never be stored as "the user said
   * no", because a stored no is permanent.
   */
  const noteUnresolved = (sessionId: string, reason: string): void => {
    retryAfter.set(sessionId, now() + UNRESOLVED_RETRY_MIN_AGE_MS);
    statusLabel = 'unresolved(' + reason + ')';
    debug('agemem: session identity left unresolved', { sessionId, reason });
  };

  /**
   * Associate NOTHING: an explicitly empty triple.
   *
   * This is not the same as bindSkipped(): the empty triple makes
   * memory-client.missingIdentity() report 'teamId' for every call, so the
   * volatile block, the head-pack segments, recall and writeback all skip
   * instead of quietly reading/writing the *configured* team's pool. That is
   * exactly what "本次不关联" and `default_associate=0` mean.
   */
  const bindNothing = (sessionId: string, source: IdentitySource, reason: string): void => {
    const row = { teamId: '', agentId: '', userId: '', source, reason, associate: false, at: now() };
    // Who did the declining decides whether it is final:
    //  - the user (chip 本次不关联 / session_init default_associate=0) -> frozen;
    //  - the SYSTEM on an ambiguous account (rule ⑤) or a branch -> provisional,
    //    no committedAt, so the chip stays editable and a later pick can commit
    //    (see isProvisionalDecline for why that cannot split an identity).
    if (source === 'user-declined' || source === 'user-bypass') {
      submit(sessionId, row);
      return;
    }
    deps.store.set(sessionId, row);
    retryAfter.delete(sessionId);
    statusLabel = 'provisional(' + source + ')';
    debug('agemem: session identity declined on behalf of the user (not final)', { sessionId, source, reason });
  };
  /**
   * The user-level session_init decision, read ONCE per session (the binding is
   * written by the caller, and ensureBound short-circuits on it).
   *
   * Every failure mode -- no reader wired, throw, timeout, 401 -- degrades to
   * ask, which is the pre-change behaviour: a core that cannot answer must not
   * change how the session starts.
   */
  const readDecision = async (userKey: string, userId: string): Promise<UserInitDecision> => {
    if (!settings.followUserSessionInit) return { kind: 'ask' };
    const read = deps.getUserSessionInit;
    if (read === undefined) return { kind: 'ask' };
    try {
      const config = await read({ userKey, userId, timeoutMs: deps.timeoutMs });
      const decision = resolveUserSessionInitDecision(config);
      debug('agemem: user session_init decision', { kind: decision.kind, team: decision.kind === 'preset' ? decision.teamId : undefined });
      return decision;
    } catch (error) {
      debug('agemem: user session_init config unreadable; asking', error);
      return { kind: 'ask' };
    }
  };

  const warnPresetMismatch = (detail: string): void => {
    if (warnedPresetMismatch) return;
    warnedPresetMismatch = true;
    deps.log?.warn?.(
      'agemem: the user session_init preset does not match this account (' + detail + '); '
      + 'falling back to the composer chip',
    );
  };

  /**
   * Validate the preset against the account's REAL teams/agents before binding:
   * a stale default_team_id would otherwise address someone else's pool, which
   * is worse than no preset at all. The proxy validated the same way
   * (resolvePresetIdentity) and fell through to the form on a mismatch; here it
   * falls through to the chip / auto path.
   */
  const resolvePreset = async (
    decision: Extract<UserInitDecision, { kind: 'preset' }>,
    first: Extract<CandidatesResult, { kind: 'ok' }>,
    userKey: string,
  ): Promise<{ teamId: string; agentId: string } | undefined> => {
    const team = first.teams.find((entry) => entry.teamId === decision.teamId);
    if (team === undefined) {
      warnPresetMismatch('default_team_id ' + decision.teamId + ' is not one of this user\'s teams');
      return undefined;
    }
    let agents = first.agents ?? [];
    const wanted = decision.agentId;
    const present = wanted !== undefined && agents.some((entry) => entry.agentId === wanted);
    // Only pay for the scoped list when the answer is not already in hand.
    if (!present && (wanted !== undefined || agents.length !== 1)) {
      const scoped = await deps.candidates({ userKey, teamId: team.teamId, timeoutMs: deps.timeoutMs });
      agents = scoped.kind === 'ok' ? scoped.agents ?? [] : [];
    }
    if (wanted !== undefined) {
      const found = agents.find((entry) => entry.agentId === wanted);
      if (found === undefined) {
        warnPresetMismatch('default_agent_id ' + wanted + ' is not among the agents of ' + team.teamId);
        return undefined;
      }
      return { teamId: team.teamId, agentId: found.agentId };
    }
    // No agent configured: only the team's single agent is unambiguous.
    if (agents.length !== 1) {
      warnPresetMismatch('no default_agent_id and ' + String(agents.length) + ' agents in ' + team.teamId);
      return undefined;
    }
    return { teamId: team.teamId, agentId: agents[0].agentId };
  };
  /**
   * Candidates, with ONE bounded retry for a transient transport failure.
   *
   * Measured 2026-11-19: a session whose first candidates call landed inside a Core
   * restart window got 'transport failure: fetch failed' and was recorded as
   * skipped for good -- and every branch session inherited the empty triple, so the
   * whole tree ran with no card and logged section-read reason 'no-card'. A retry
   * is still bounded (one extra call, ~0.7s) and only fires for transport/timeout,
   * so a real 4xx/5xx still records the skip exactly as before.
   */
  const candidatesWithOneRetry = async (input: { userKey: string; teamId?: string; timeoutMs?: number }): Promise<CandidatesResult> => {
    const firstAttempt = await deps.candidates(input);
    if (firstAttempt.kind === 'ok') return firstAttempt;
    const transient = firstAttempt.reason.startsWith('transport failure') || firstAttempt.reason.startsWith('timed out');
    if (!transient) return firstAttempt;
    await new Promise<void>((resolve) => { setTimeout(resolve, CANDIDATES_RETRY_DELAY_MS); });
    const secondAttempt = await deps.candidates(input);
    debug('agemem: identity candidates retried after a transient failure', firstAttempt.reason, secondAttempt.kind);
    return secondAttempt;
  };

  /**
   * P0-2：把 candidates 的成功结果收成一个**无歧义**的三元组；有歧义就返回
   * undefined（保持 skipped，等用户下一次真的开会话）。
   *
   * 歧义的判据与 pick() 里的折叠一致：多于一个 team 只有 base 配置指向其中一个
   * 时才不用问人；多于一个 agent 只有 base 配置指向其中一个时同理。这里绝不能
   * 弹窗 —— 会话已经在跑了。
   */
  const unambiguousTriple = async (
    first: Extract<CandidatesResult, { kind: 'ok' }>,
    userKey: string,
  ): Promise<{ teamId: string; agentId: string; userId: string } | undefined> => {
    if (first.teams.length === 0) return undefined;
    let teamId: string;
    if (first.teams.length === 1) {
      teamId = first.teams[0].teamId;
    } else {
      const configured = first.teams.find((entry) => entry.teamId === deps.base.teamId);
      if (configured === undefined) return undefined;
      teamId = configured.teamId;
    }
    // The unscoped payload only carries agents when the team is unambiguous; for a
    // multi-team account they must be fetched for the chosen team.
    let agents = first.teams.length === 1 ? first.agents ?? [] : [];
    if (agents.length === 0) {
      const scoped = await candidatesWithOneRetry({ userKey, teamId, timeoutMs: deps.timeoutMs });
      if (scoped.kind !== 'ok') return undefined;
      agents = scoped.agents ?? [];
    }
    if (agents.length === 1) return { teamId, agentId: agents[0].agentId, userId: first.userId };
    const configuredAgent = agents.find((entry) => entry.agentId === deps.base.agentId);
    if (configuredAgent === undefined) return undefined;
    return { teamId, agentId: configuredAgent.agentId, userId: first.userId };
  };

  /**
   * P0-2 收口：歧义时的兜底 —— 用**本机历史上用户亲手选过**的三元组。
   *
   * 只在 unambiguousTriple 给不出答案、而本机同 user 恰好只有一个 picked/recovered
   * 三元组时使用：那是用户在这台机器上已经做过的决定，不是替他猜。选过两个以上
   * （不同会话要不同 agent）就继续 stays skipped —— 合并它们才是真的编造。
   */
  const previouslyChosenTriple = (
    userId: string,
  ): { teamId: string; agentId: string; userId: string } | undefined => {
    const seen = new Map<string, { teamId: string; agentId: string; userId: string }>();
    for (const binding of deps.store.values()) {
      if (binding.userId !== userId) continue;
      // D2（用户 2026-11-22 拍板）：只认 chip。'picked' 是旧弹窗留下的，'recovered'
      // 是自愈推导出来的 —— 两者都不是「这台机器上用户亲手做过的选择」。把它们
      // 当默认的后果实测过：用户清空 session_init 的默认 agent 之后，下一个新会话
      // 仍被历史记录自动绑回同一个 agent（现场 2026-11-22 source:'auto'）。
      if (binding.source !== 'chip') continue;
      seen.set(`${binding.teamId}|${binding.agentId}`, {
        teamId: binding.teamId,
        agentId: binding.agentId,
        userId: binding.userId,
      });
    }
    if (seen.size !== 1) return undefined;
    return [...seen.values()][0];
  };

  /**
   * P0-2：把一个「因传输层失败被永久跳过」的会话重新绑上。
   *
   * 只走 candidates（复用 candidatesWithOneRetry 的那一次重试），不弹窗：会话已经
   * 开始了，这时再弹卡是打扰；而且第一次失败时用户的 session_init 决策
   * （preset/ask/bypass）根本没读到，重走 pick() 会把一次恢复变成一张新卡。
   *
   * 失败或有歧义都只推 at、保持 skipped —— 否则同一个会话的每个 tick 都会重打一
   * 轮网络，回到这条缺陷要解决的「每 tick 都打网络」的另一面。
   */
  const healSkipped = async (sessionId: string, existing: SessionBinding): Promise<void> => {
    const userKey = await deps.resolveUserKey();
    // Headless composition: no key to list teams with, so no probe at all.
    if (userKey === undefined) return;
    const first = await candidatesWithOneRetry({ userKey, timeoutMs: HEAL_PROBE_TIMEOUT_MS });
    const resolved = first.kind === 'ok'
      ? (await unambiguousTriple(first, userKey)) ?? previouslyChosenTriple(first.userId)
      : undefined;
    if (resolved === undefined) {
      const probe = first.kind === 'ok' ? 'candidates are ambiguous' : first.reason;
      deps.store.set(sessionId, { ...existing, at: now(), lastHealAt: now(), lastHealProbe: probe });
      debug('agemem: identity skip not healed yet', probe);
      return;
    }
    // reason 不带：绑定态就该没有失败原因。
    submit(sessionId, { ...resolved, source: 'recovered', at: now() });
  };

  /**
   * 空三元组分支的父会话自己就卡在传输层失败里（父可能再也不被调用，没人会去自愈它）。
   * 这时分支用**自己的** userKey 探一次，成功就记 recovered；失败只推 at、保持原 source/reason，
   * 不把「继承来的空身份」改写成别的语义。
   */
  const healBranch = async (sessionId: string, existing: SessionBinding): Promise<void> => {
    const userKey = await deps.resolveUserKey();
    if (userKey === undefined) return;
    const first = await candidatesWithOneRetry({ userKey, timeoutMs: HEAL_PROBE_TIMEOUT_MS });
    const resolved = first.kind === 'ok'
      ? (await unambiguousTriple(first, userKey)) ?? previouslyChosenTriple(first.userId)
      : undefined;
    if (resolved === undefined) {
      const probe = first.kind === 'ok' ? 'candidates are ambiguous' : first.reason;
      deps.store.set(sessionId, { ...existing, at: now(), lastHealAt: now(), lastHealProbe: probe });
      debug('agemem: inherited branch not healed yet', probe);
      return;
    }
    submit(sessionId, { ...resolved, source: 'recovered', at: now() });
  };

  /**
   * 已有记录的两条自愈路径（P0-2）。两条都不弹窗、也都不问人。
   */
  const reconcileExisting = async (sessionId: string, existing: SessionBinding): Promise<void> => {
    // (1) 传输层失败留下的 skipped：记录够旧就再试一次 candidates。
    if (existing.source === 'skipped' && isCandidatesTransportSkip(existing.reason)) {
      if (!isStaleForRetry(existing, now())) return;
      const running = healInFlight.get(sessionId);
      if (running !== undefined) {
        // Same session, another step of the same turn: one probe, not one per step.
        await running;
        return;
      }
      const started = (async () => {
        try {
          await healSkipped(sessionId, existing);
        } catch (error) {
          // A probe must never reject a step; push at so the next tick is quiet.
          debug('agemem: identity skip heal failed', error);
          deps.store.set(sessionId, { ...existing, at: now() });
        } finally {
          healInFlight.delete(sessionId);
        }
      })();
      healInFlight.set(sessionId, started);
      await started;
      return;
    }
    // (2) 空三元组的 inherited 分支：父会话现在绑上了，就继承父三元组。
    //
    // 绝不为分支单独发网络请求：分支在 fork 时就已经决定「不问人」，它自己的
    // candidates 拉取在父会话的历史里已有自述的前提下只会多一次网络。
    if (existing.source === 'inherited' && isEmptyTriple(existing)) {
      const parentSid = branchParentOf(existing.reason);
      if (parentSid === undefined) return;
      const parent = deps.store.get(parentSid);
      // 父会话的 skipped 不是绑定：抄它的三元组只会在审计里把「没身份」写成
      // 「继承来的身份」。父仍未绑定 -> 原样返回，等父会话自己先自愈。
      if (parent === undefined) return;
      // 父被传输层失败卡住时分支没有可抄的身份；这里补一次探针（同一套陈旧门/歧义门）。
      if (parent.source === 'skipped' && isEmptyTriple(parent)) {
        if (!isCandidatesTransportSkip(parent.reason) || !isStaleForRetry(existing, now())) return;
        const pending = healInFlight.get(sessionId);
        if (pending !== undefined) {
          await pending;
          return;
        }
        const work = (async () => {
          try {
            await healBranch(sessionId, existing);
          } catch (error) {
            debug('agemem: inherited branch heal failed', error);
            deps.store.set(sessionId, { ...existing, at: now() });
          } finally {
            healInFlight.delete(sessionId);
          }
        })();
        healInFlight.set(sessionId, work);
        await work;
        return;
      }
      // 父自己没身份、又不是「被传输层卡住」：没有可抄的，也没有该替它发的探针。
      if (parent.source === 'skipped' || isEmptyTriple(parent)) return;
      submit(sessionId, {
        teamId: parent.teamId,
        agentId: parent.agentId,
        userId: parent.userId,
        // 同一段对话，同一套作用域：任务轴跟着父会话走。
        ...(parent.taskId !== undefined ? { taskId: parent.taskId } : {}),
        // 保持语义：这条身份是继承来的，不是本会话弹窗选的。
        source: 'inherited',
        reason: existing.reason,
        at: now(),
      });
    }
  };
  /**
   * One silent resolution per session -- the replacement for the old card.
   *
   * The order is documented at the top of this file: staged chip > session_init
   * preset/bypass > unambiguous account > empty triple. Everything here is
   * bounded by deps.timeoutMs and returns rather than throws.
   */
  const resolveSilently = async (sessionId: string): Promise<void> => {
    const userKey = await deps.resolveUserKey();
    if (userKey === undefined) {
      // Headless composition: credentials are disabled, so there is no key to
      // list teams with. Inert, and no bind (a later run may have one).
      debug('agemem: session identity skipped, no user key (inert)');
      statusLabel = 'inert(no-key)';
      return;
    }
    const first = await candidatesWithOneRetry({ userKey, timeoutMs: deps.timeoutMs });
    if (first.kind !== 'ok') {
      // D3: a failed READ is not a decision. Nothing is written, the chip keeps
      // saying 「未关联 · 点此设置」, and the next turn past the backoff retries.
      noteUnresolved(sessionId, 'candidates failed: ' + first.reason);
      return;
    }
    rememberAgentLabels(first.agents);

    // 1) The composer chip wins when it was used: an explicit click in THIS
    //    session is a stronger statement than an account-level default, and it
    //    is the only way to overrule a preset (including "本次不关联", which
    //    must stay reachable even when a default agent is fixed in the panel).
    const chosen = staged.get(sessionId);
    if (chosen !== undefined) {
      staged.delete(sessionId);
      if (chosen.associate === false) {
        bindNothing(sessionId, 'user-declined', 'the user chose 本次不关联 in the composer chip');
        return;
      }
      submit(sessionId, {
        teamId: chosen.teamId,
        agentId: chosen.agentId,
        // Absent (not empty) when no task was picked: absence means "no task".
        ...(chosen.taskId !== undefined && chosen.taskId !== '' ? { taskId: chosen.taskId } : {}),
        userId: first.userId,
        source: 'chip',
        at: now(),
      });
      return;
    }

    // 2) The per-user session_init config: an account-level decision made
    //    once, so it must not need the chip every session. Only reached when
    //    the user did NOT pick anything here.
    const decision = await readDecision(userKey, first.userId);
    if (decision.kind === 'bypass') {
      bindNothing(sessionId, 'user-bypass', 'user session_init: default_associate=0 (bypass)');
      return;
    }
    if (decision.kind === 'preset') {
      const preset = await resolvePreset(decision, first, userKey);
      if (preset !== undefined) {
        submit(sessionId, {
          teamId: preset.teamId,
          agentId: preset.agentId,
          // The VERIFIED user id, not server.userId.
          userId: first.userId,
          source: 'user-preset',
          reason: 'user session_init: preset',
          at: now(),
        }, true);
        return;
      }
      // Mismatch already warned once; fall through to the auto path.
    }

    if (first.teams.length === 0) {
      // Deterministic: this account owns no team, so no retry will change it.
      // Still a decision about the session, so it is written as one.
      bindNothing(sessionId, 'skipped', 'the user belongs to no team');
      return;
    }

    // 3) Nothing to ask: one team + one agent, or the configured triple.
    const auto = (await unambiguousTriple(first, userKey)) ?? previouslyChosenTriple(first.userId);
    if (auto !== undefined) {
      submit(sessionId, { ...auto, source: 'auto', at: now() }, true);
      return;
    }

    // 4) Ambiguous account and the chip was never used: the rule is
    //    「本次不关联」, never "silently pick the configured team".
    bindNothing(
      sessionId,
      'skipped',
      'no preset, ambiguous candidates, and the composer chip was not used',
    );
  };

  /**
   * The composer chip's data source (read-only: it never binds anything).
   *
   * The preset agent comes back as `locked` so the panel can render it as text
   * instead of a radio -- "show the default agent's name and id, not selectable".
   * That lock lifts as soon as the user has staged something: the chip outranks
   * the account default (see resolveSilently), so freezing the panel on the very
   * agent the user just overruled would strand them.
   */
  const describe = async (sessionId: string, teamId?: string): Promise<ComposerState> => {
    const state: ComposerState = { status: 'ok', teamId: '', teams: [], agents: [], tasks: [] };
    const bound = deps.store.get(sessionId);
    if (bound !== undefined) {
      // I3 backfill: an older row (or one written before this build) has no
      // label; if a candidates read ever taught us this agent's name, answer
      // with it rather than letting the chip paint a bare id.
      const cachedLabel = bound.agentId === '' ? undefined : agentLabels.get(bound.agentId);
      state.bound = bound.agentLabel === undefined && cachedLabel !== undefined
        ? { ...bound, agentLabel: cachedLabel }
        : bound;
      // An empty triple nobody chose is "not resolved yet", not 「未关联」: the
      // chip must stay editable so the user can fix it, and the panel must be
      // able to say why. Only associate:false is a real decline. (Only legacy
      // rows can be in this shape -- new failures write no row at all.)
      if (isUnresolvedBinding(bound) || isProvisionalDecline(bound)) state.unresolved = true;
      // A pre-answer (written at creation, no turn yet) is open to change: see
      // SessionBinding.unconfirmedAt. The chip renders it as 「待生效」 and keeps
      // the panel reachable -- that is what makes rule ② true when the account
      // has a default agent.
      if (bound.unconfirmedAt !== undefined) state.editable = true;
    } else if (retryAfter.has(sessionId)) {
      // D3/I4: the last resolution failed transiently and deliberately wrote
      // nothing, so the row's ABSENCE is the unresolved state. Read it here or
      // the chip would look freshly unset and never explain itself.
      state.unresolved = true;
    }
    const stagedChoice = staged.get(sessionId);
    if (stagedChoice !== undefined) state.staged = stagedChoice;
    const userKey = await deps.resolveUserKey();
    if (userKey === undefined) {
      state.status = 'inert';
      state.reason = 'no user key in this composition';
      return state;
    }
    const first = await candidatesWithOneRetry({ userKey, timeoutMs: deps.timeoutMs });
    if (first.kind !== 'ok') {
      state.status = 'failed';
      state.reason = first.reason;
      return state;
    }
    rememberAgentLabels(first.agents);
    const decision = await readDecision(userKey, first.userId);
    const preset = decision.kind === 'preset' ? await resolvePreset(decision, first, userKey) : undefined;
    const presetAgentId = decision.kind === 'preset' ? decision.agentId : undefined;
    // Which team's agents to list: the query -> staged -> preset -> bound ->
    // the account's only team. '' means "the account has several, choose first".
    // Staged ranks ABOVE preset for the same reason resolveSilently does: the
    // panel must reopen on the team the user just picked, not snap back to the
    // account default the moment they look at it.
    const wantedTeam = ((): string => {
      if (teamId !== undefined && teamId !== '') return teamId;
      if (stagedChoice !== undefined && stagedChoice.teamId !== '') return stagedChoice.teamId;
      if (preset !== undefined) return preset.teamId;
      if (bound !== undefined && bound.teamId !== '') return bound.teamId;
      return first.teams.length === 1 ? first.teams[0].teamId : '';
    })();
    state.teamId = wantedTeam;
    for (const team of first.teams) {
      state.teams.push({ id: team.teamId, label: labelOf(team.name, team.teamId) });
    }
    let agents: AgentChoice[] = first.agents ?? [];
    let tasks: TaskChoice[] = first.tasks ?? [];
    if (wantedTeam !== '' && wantedTeam !== first.teams[0]?.teamId) {
      // Scoped read: agents/tasks belong to ONE team, so a team change needs a
      // second round trip (the whole point of describe() being per-team).
      const scoped = await deps.candidates({ userKey, teamId: wantedTeam, timeoutMs: deps.timeoutMs });
      if (scoped.kind === 'ok') {
        agents = scoped.agents ?? [];
        tasks = scoped.tasks ?? [];
        rememberAgentLabels(agents);
      }
    } else if (wantedTeam === '' ) {
      // Several teams: list no agents until one is chosen (asking now would
      // show an agent that does not exist in the team the user finally picks).
      agents = [];
      tasks = [];
    }
    for (const agent of agents) {
      const option: ComposerOption = { id: agent.agentId, label: labelOf(agent.name, agent.agentId) };
      if (agent.description !== undefined && agent.description.trim() !== '') {
        option.detail = agent.description.trim();
      }
      // Locked = the account default, shown as text. But only while the user has
      // NOT staged anything: the chip outranks the preset, so a user who picked
      // an agent (or 「本次不关联」) must see the panel they can still change,
      // not one frozen on the account default they just overruled.
      if (presetAgentId !== undefined && agent.agentId === presetAgentId && stagedChoice === undefined) {
        option.locked = true;
      }
      state.agents.push(option);
    }
    for (const task of tasks) {
      state.tasks.push({ id: task.taskId, label: labelOf(task.title, task.taskId) });
    }
    return state;
  };

  /**
   * The chip's commit. It only STAGES: the binding is written by the first
   * turn's pre-step, which is what makes "choose before the session starts,
   * read-only afterwards" true rather than cosmetic.
   */
  const choose = (sessionId: string, choice: IdentityChoice): boolean => {
    if (sessionId === '') return false;
    // Already RESOLVED: the chip is a label at that point, and a late write
    // would swap the identity of a conversation that has already run a turn.
    // An unresolved record is the opposite case -- it is the record this click
    // exists to correct, so it must not block the write.
    const existing = deps.store.get(sessionId);
    if (existing !== undefined && existing.committedAt !== undefined && existing.unconfirmedAt === undefined) {
      debug('agemem: composer chip refused, session identity is committed', { sessionId });
      return false;
    }
    staged.set(sessionId, choice);
    // The user just answered the question the backoff was waiting on: resolve on
    // the next pre-step instead of making them sit out the window.
    retryAfter.delete(sessionId);
    debug('agemem: composer chip staged a session identity', {
      sessionId,
      team: choice.teamId,
      agent: choice.agentId,
      task: choice.taskId,
      associate: choice.associate,
    });
    return true;
  };

  /**
   * 分支会话的父键（fork/压缩产生）。规则：**分支静默继承，绝不在分支里弹窗**。
   *
   * 理由（2026-11-08 现场 session-d8e40819）：分支共享父会话历史，历史里已有
   * 「我是 X」这类自述；即使换一张卡也压不住，只会多一次「组装早于取卡」的竞态。
   * 身份属于「这条对话」，所以父会话绑什么，分支就用什么；想换人设请新开会话。
   */
  const parentSessionOf = (agent: unknown): string | undefined => {
    const session = (agent as { session?: { header?: { parentSession?: unknown } } } | undefined)?.session;
    const parent = session?.header?.parentSession;
    if (typeof parent === 'string' && parent !== '') return parent;
    // UI 分支不带 header.parentSession（见已知事实），父 id 只能来自 plugin record。
    return deps.knownBranchParent?.(agent);
  };
  const ensureBound = async (agent: unknown, signal?: unknown): Promise<void> => {
    const sessionId = agentKey(agent as any);
    // Record BEFORE both early returns: with resolution switched off (or the
    // session already bound) nothing below runs, and the process-wide
    // latestSessionId would stay undefined -- tools and segments would then
    // keep using the configured identity while recall/writeback used the
    // bound one, i.e. two identities inside one turn.
    deps.onSessionSeen?.(sessionId);
    if (!settings.enabled) return;
    const openRow = deps.store.get(sessionId);
    // The chip's staged pick and the pre-answer are answers to the SAME question
    // ("which agent does this conversation belong to"), so the click wins and the
    // prompt is not burned: confirm only when there is nothing staged.
    if (openRow !== undefined && staged.has(sessionId)) {
      await resolveSilently(sessionId);
      return;
    }
    // Turn 1 is about to speak: from here the row is frozen (I1).
    confirmPendingRow(sessionId);
    const existing = deps.store.get(sessionId);
    if (existing !== undefined) {
      // I1: a committed row is FROZEN. Nothing below this line may write for the
      // session -- not the chip, not the P0-2 heals. Measured pain: a heal window
      // swapped the identity of a conversation that had already written turns,
      // so turn 1 landed in agent A's library and turn 10 in agent B's.
      if (existing.committedAt !== undefined) return;
      // 用户刚在 chip 里点过「确定」（这个会话还是旧版本写的、没有 committedAt）：
      // 那一刻的答案高于旧记录，也高于自愈探针，否则探针会把用户刚选的 agent
      // 覆盖成「无歧义推导」的那一个。
      if (staged.has(sessionId)) {
        await resolveSilently(sessionId);
        return;
      }
      if (isProvisionalDecline(existing)) {
        // B11：分支的开放空行不是「系统替用户拒绝」，它只是在等父会话先绑身份。
        // 父会话一绑上，这一支就把它补成父三元组（不发网络）；父还没绑就什么都不做。
        if (existing.source === 'inherited' && branchParentOf(existing.reason) !== undefined) {
          await reconcileExisting(sessionId, existing);
          return;
        }
        // The system declined on the user's behalf (ambiguous account, rule ⑤).
        // Re-deriving it every turn would just rewrite the same row; the panel is
        // where this gets answered, and a pick there must commit.
        if (!staged.has(sessionId)) return;
        await resolveSilently(sessionId);
        return;
      }
      // Legacy record (no committedAt): one last heal, then the submit inside it
      // stamps committedAt and the session freezes like everything else.
      await reconcileExisting(sessionId, existing);
      return;
    }
    // No row yet. A previous attempt failed transiently and wrote NOTHING (see
    // noteUnresolved): honour its backoff so a dead core is not re-probed on every
    // step of every turn, but DO retry once the window passes -- that retry is
    // what makes "core came back" heal the session by itself.
    if (!staged.has(sessionId)) {
      const retry = retryAfter.get(sessionId);
      if (retry !== undefined) {
        if (now() < retry) return;
        retryAfter.delete(sessionId);
      }
    }
    // 走到这里说明父会话本身没绑成 —— 仍不问人，把无身份暴露给调用方：空三元组
    // 让缺身份在 memory-client 那里显形，而不是退回 config 的团队池。
    const branchParent = parentSessionOf(agent);
    if (branchParent !== undefined) {
      // 父会话已经绑好：立刻抄，不留窗口（分支绝不自己发网络请求）。
      const parent = deps.store.get(branchParent);
      if (parent !== undefined && parent.teamId !== '') {
        submit(sessionId, {
          teamId: parent.teamId,
          agentId: parent.agentId,
          userId: parent.userId,
          ...(parent.taskId === undefined || parent.taskId === '' ? {} : { taskId: parent.taskId }),
          ...(parent.agentLabel === undefined ? {} : { agentLabel: parent.agentLabel }),
          source: 'inherited',
          reason: 'branch of ' + branchParent,
          at: now(),
          committedAt: parent.committedAt ?? now(),
        });
        return;
      }
      // 父会话还没绑上：留一条**开放**的空行（无 committedAt）。空三元组让缺身份在
      // memory-client 那里显形，而 reason 里的父 id 让 reconcileExisting 在父绑上后
      // 把三元组直接补回来 —— 不必让分支自己发一次网络请求。
      bindNothing(sessionId, 'inherited', 'branch of ' + branchParent);
      return;
    }
    const running = inFlight.get(sessionId);
    if (running !== undefined) {
      // Second (third, ...) step of the same turn: never a second card.
      await running;
      return;
    }
    const started = (async () => {
      try {
        await resolveSilently(sessionId);
      } catch (error) {
        // resolveSilently() is written not to throw; this is the belt.
        debug('agemem: session identity resolution failed', error);
        bindSkipped(sessionId, 'unexpected resolution failure');
      } finally {
        inFlight.delete(sessionId);
      }
    })();
    inFlight.set(sessionId, started);
    await started;
  };
  const off = ctx.on(
    'agent/pre-step',
    async (payload: { agent?: unknown; signal?: unknown }, next: () => Promise<PreStepDecision>) => {
      const decision = await next();
      try {
        if (!decision || decision.kind === 'reject') return decision;
        // Always call: even with the card off this reports the session id to
        // the rest of the plugin (see onSessionSeen above).
        await ensureBound(payload?.agent, payload?.signal);
      } catch {
        // Fail open: a card must never reject a step.
      }
      return decision;
    },
    { prepend: true },
  );
  return {
    status: () => statusLabel,
    ensureBound: async (agent: unknown, signal?: unknown) => {
      try {
        await ensureBound(agent, signal);
      } catch {
        // never propagate
      }
    },
    writebackPolicy: (sessionId: string) => {
      const bound = deps.store.get(sessionId);
      if (bound === undefined) {
        // No row means resolution has not produced an answer for this session. If
        // a transient failure is on its backoff clock, the answer is genuinely
        // coming: hold the write. Otherwise the configured triple is the identity
        // memory-client will use (either resolution is switched off, or this
        // session simply has not run a pre-step yet), and nothing is pending.
        return retryAfter.has(sessionId) ? 'defer' : 'send';
      }
      // A provisional decline (rule ⑤: ambiguous account, chip unused) is the
      // SYSTEM's guess, not the user's decision: the chip is still editable and
      // a later pick must be able to write back the turns spoken under it. So it
      // defers. Only the two sources that are genuinely the user's word skip.
      if (isProvisionalDecline(bound)) return 'defer';
      // A pre-answer is not an identity yet (D4): the first turn's write would
      // land under a preset the user is still allowed to overrule, so hold it
      // until the row is confirmed (or replaced) by that same turn's pre-step.
      if (bound.unconfirmedAt !== undefined) return 'defer';
      if (bound.associate === false) return 'skip';
      if (bound.teamId === '') return 'defer';
      return 'send';
    },
    describe,
    choose,
    dispose: () => {
      off();
      inFlight.clear();
      healInFlight.clear();
      staged.clear();
      retryAfter.clear();
    },
  };
}
