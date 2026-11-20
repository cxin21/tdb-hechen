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

/** pick() 写失败原因时加的前缀：reason 形如 'candidates failed: transport failure: fetch failed'。 */
const CANDIDATES_FAILED_PREFIX = 'candidates failed: ';

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
 * Session-start identity picker (task-117 v3).
 *
 * The remembered flow is the proxy's, not ours: at the START of a session the
 * user is asked which Team (and which Agent inside it) this conversation should
 * read and write. The old attempt -- a loopback HTTP API that the Settings page
 * called -- was the wrong seam: the host has a first-class way to ask a human
 * questions inside a live session, and it is ctx.userQuestions.ask.
 *
 * Why this file exists at all:
 *
 *  1. The plugin resolves ONE identity at mount from server.userKey. That is
 *     right for a single-tenant profile and wrong for the proxy's UX, where the
 *     user may belong to several teams and picks per session.
 *  2. 'agent/pre-step' is the only seam that runs while a human is watching and
 *     a turn is open, so it is where the card is shown. The host renders it in
 *     the conversation; the answer arrives as
 *     answers: [{ id: 'team_select', selected: ['<label>'] }].
 *
 * WHERE the answer comes from is the proxy's business, not ours: before the
 * first card of a session the plugin reads the SAME per-user `session_init`
 * config the proxy reads (memory-client.getUserSessionInit, decision table in
 * ./user-session-init.ts). preset -> bind silently, bypass -> associate nothing,
 * ask -> show the card. The card is therefore NOT a function of how many
 * candidates exist: one team and one agent still get asked when the user's
 * config says ask (a live profile once relied on the opposite and was wrong).
 * Only AFTER "yes" may the fold happen: one team needs no team question, one
 * agent needs no agent question.
 *
 * Four rules, each the result of a measured host behaviour:
 *
 *  - NEVER block a turn. The ask is raced against askTimeoutMs; every failure
 *    (no service, abort, timeout, no candidates) resolves instead of rejecting,
 *    and the turn continues on the configured triple.
 *  - NEVER pop twice. A binding is written for the session (memory + optional
 *    state file) before the handler returns, and concurrent pre-steps of the
 *    same session await the SAME in-flight promise -- a first turn with tool
 *    calls runs pre-step several times, and that used to be several cards.
 *  - NEVER pop at a machine. An owned child agent has no human answerer (the
 *    host throws DELEGATED_CALLER, "would block forever"), and a headless
 *    composition has no credentials store, so no user key: both take the silent
 *    path, with no warn (a sub-agent hits it every turn).
 */

/** Question ids are fixed: the proxy's form uses the same three. */
export const TEAM_QUESTION_ID = 'team_select';
export const AGENT_QUESTION_ID = 'agent_select';
/** The proxy's THIRD stage (form.ts:252-274): which work item this session is for. */
export const TASK_QUESTION_ID = 'task_select';
/**
 * The proxy's virtual "default task" (form.ts:254-259), unshifted ahead of the
 * real tasks. Selecting it means NO task scope -- it must never be read as
 * "skip the whole association", because team/agent were already answered.
 */
export const TASK_NO_TASK_LABEL = '本次不关联任务';

/** Verbatim from MemoryProxy/src/session/dsh/form.ts (SKIP_LABEL / SKIP_HINT). */
export const SKIP_LABEL = '本次不关联(跳过注入,直接放行)';
export const SKIP_HINT = '（如选择"跳过"选项，本次 session init 将跳过，不注入任何团队资产）';

/**
 * The proxy's asset_confirm question, verbatim (form.ts:115-117): it is asked
 * BEFORE team/agent whenever the user's config says ask, and only its "yes"
 * unlocks the candidate list.
 */
export const ASSET_CONFIRM_QUESTION_ID = 'asset_confirm';
export const ASSET_CONFIRM_YES = '是，关联团队资产';
export const ASSET_CONFIRM_NO = '否，本次不关联';
export const ASSET_CONFIRM_TITLE = '会话初始化 — 是否关联团队资产';

/** Where a session's identity came from; also the store's audit field. */
export type IdentitySource =
  | 'userkey'
  /** Bound silently from the user's session_init preset (no card). */
  | 'user-preset'
  /** The user's session_init says default_associate=0: associate nothing. */
  | 'user-bypass'
  /**
   * 用户在会话开始的那张卡上选了「否，本次不关联」。与 user-bypass 的区别只在归因：
   * 一个是配置，一个是本次会话的当场决定；两者都写空三元组、都不注入。
   */
  | 'user-declined'
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
}

/** One card option. id is NOT sent to the host -- it is our label -> id map. */
export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionSpec {
  id: string;
  header?: string;
  question: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

export interface QuestionAnswer {
  id?: string;
  selected?: string[];
  custom?: string;
}

/** The host service, structurally (verified against dsh-user-questions). */
export interface UserQuestionsLike {
  ask(request: {
    agent?: unknown;
    questions: QuestionSpec[];
    signal?: AbortSignal;
  }): Promise<{ answers?: QuestionAnswer[] } | undefined>;
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
  /** Master switch: false = never read the user config, never show a card. */
  askAtSessionStart: boolean;
  /** Honour the per-user session_init config (preset/bypass/ask), like the proxy. */
  followUserSessionInit: boolean;
  askTimeoutMs: number;
  rememberSession: boolean;
  skipDefault: boolean;
  /** Ask the task (work item) question after team/agent; false = never send x-tdai-task-id. */
  askForTask: boolean;
  /** '' -> no file (memory only); otherwise the JSON state path. */
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
  /** The configured triple (the fallback when a session is unbound). */
  base: MemoryIdentity;
  /** The user key, resolved lazily (credentials ref or env; may be absent). */
  resolveUserKey: () => Promise<string | undefined>;
  /** verify -> teams -> agents, optionally scoped to one team. */
  candidates: (input: { userKey: string; teamId?: string; timeoutMs?: number }) => Promise<CandidatesResult>;
  /**
   * The user's `session_init` config (`{ param_name: effective_value }`), or
   * null when it cannot be read. Optional: a composition/tests that omit it
   * behave exactly like a read failure, i.e. ask.
   */
  getUserSessionInit?: (input: { userKey: string; userId: string; timeoutMs?: number }) => Promise<Record<string, string> | null>;
  store: SessionIdentityStore;
  /** The host's question service, looked up per call (it is a sibling entry). */
  getQuestions: () => UserQuestionsLike | undefined;
  /** Per metadata-call budget. */
  timeoutMs: number;
  log?: LoggerLike;
  /** Called once per pre-step with the session this step belongs to. */
  onSessionSeen?: (sessionId: string) => void;
  /** Called when a session gets bound, so a frozen head pack can refetch. */
  onBound?: (sessionId: string, binding: SessionBinding) => void;
  now?: () => number;
}

export interface SessionIdentity {
  /** The ready line's field: on | off(config) | inert(no key) ... */
  status(): string;
  /** Idempotent, bounded, never throws; the volatile block calls it too. */
  ensureBound(agent: unknown, signal?: unknown): Promise<void>;
  dispose(): void;
}

/** A label -> id pair: the host only ever echoes the label back. */
interface Choice {
  label: string;
  id: string;
}

function labelOf(name: string | undefined, id: string): string {
  const base = name !== undefined && name.trim() !== '' ? name.trim() : id;
  return base + ' (' + id.slice(-8) + ')';
}

/**
 * Skip detection: the selected label, a free-text answer, or a synonym.
 *
 * CJK phrases match ANYWHERE in the box ('本次跳过' is what a human types),
 * while the ASCII 'skip' keeps a word boundary so 'skipper' stays a name.
 */
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

export function isSkipAnswer(text: string): boolean {
  const value = text.trim();
  if (value === '') return false;
  if (value === SKIP_LABEL) return true;
  if (/(跳过|不关联|不注入)/.test(value)) return true;
  return /(^|[^a-z])skip([^a-z]|$)/i.test(value);
}

function skipped(reason: string): { kind: 'skipped'; reason: string } {
  return { kind: 'skipped', reason };
}

/** Resolve one answered question to the chosen id (or skip). */
function resolveChoice(
  answers: QuestionAnswer[] | undefined,
  questionId: string,
  choices: Choice[],
): { kind: 'picked'; id: string } | { kind: 'skipped'; reason: string } {
  if (!Array.isArray(answers)) return skipped('no answer');
  const answer = answers.find((entry) => entry !== undefined && entry !== null && entry.id === questionId);
  if (answer === undefined) return skipped('answer for ' + questionId + ' missing');
  const labels = Array.isArray(answer.selected) ? answer.selected.filter((item) => typeof item === 'string') : [];
  const custom = typeof answer.custom === 'string' ? answer.custom : '';
  if (labels.length === 0 && custom.trim() === '') return skipped('empty answer');
  for (const label of labels) {
    if (isSkipAnswer(label)) return skipped('user chose to skip');
  }
  if (isSkipAnswer(custom)) return skipped('user typed a skip phrase');
  const wanted = (labels[0] ?? custom).trim();
  const exact = choices.find((choice) => choice.label === wanted);
  if (exact !== undefined) return { kind: 'picked', id: exact.id };
  const contains = choices.find((choice) => wanted !== '' && (choice.label.includes(wanted) || wanted.includes(choice.label)));
  if (contains !== undefined) return { kind: 'picked', id: contains.id };
  // Last resort: the user pasted the id (or its last 8 characters).
  const byId = choices.find((choice) => wanted !== '' && (choice.id === wanted || choice.id.endsWith(wanted)));
  if (byId !== undefined) return { kind: 'picked', id: byId.id };
  return skipped('answer did not match any option');
}

/**
 * Install the session-start card. The listener is prepended so it runs before
 * the volatile block and before every other consumer of the identity reads it.
 */
export function installSessionIdentity(ctx: AgememContext, deps: SessionIdentityDeps): SessionIdentity {
  const settings = deps.settings;
  const now = deps.now ?? Date.now;
  /** sessionId -> the ask that is already running (hard requirement C). */
  const inFlight = new Map<string, Promise<void>>();
  /** sessionId -> the P0-2 self-heal already running (one candidates probe per session). */
  const healInFlight = new Map<string, Promise<void>>();
  let warnedDelegated = false;
  let warnedNoService = false;
  let warnedPresetMismatch = false;
  let statusLabel = settings.askAtSessionStart ? 'on' : 'off(config)';

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
  const submit = (sessionId: string, binding: SessionBinding): void => {
    deps.store.set(sessionId, binding);
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
      deps.onBound?.(sessionId, binding);
    } catch {
      // A refresh callback must never break the turn it was called from.
    }
  };

  /** Fall back to the configured triple (no card answer, or a failure). */
  const bindSkipped = (sessionId: string, reason: string, source: IdentitySource = 'skipped'): void => {
    submit(sessionId, bindingFor(source, reason));
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
    submit(sessionId, { teamId: '', agentId: '', userId: '', source, reason, associate: false, at: now() });
  };

  const ask = async (
    questions: QuestionSpec[],
    agent: unknown,
    signal: unknown,
  ): Promise<{ kind: 'answers'; answers: QuestionAnswer[] | undefined } | { kind: 'skipped'; reason: string }> => {
    const service = deps.getQuestions();
    if (service === undefined) {
      if (!warnedNoService) {
        warnedNoService = true;
        deps.log?.warn?.(
          'agemem: the host has no userQuestions service in this composition; '
          + 'the session-start Team picker is unavailable, using the configured identity',
        );
      }
      return skipped('no userQuestions service');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, settings.askTimeoutMs));
    const unref = (timer as unknown as { unref?: () => void }).unref;
    if (typeof unref === 'function') unref.call(timer);
    const upstream = signal as {
      aborted?: boolean;
      addEventListener?: (name: string, listener: () => void) => void;
      removeEventListener?: (name: string, listener: () => void) => void;
    } | undefined;
    const onAbort = (): void => controller.abort();
    if (upstream?.aborted === true) controller.abort();
    upstream?.addEventListener?.('abort', onAbort);
    try {
      const reply = await service.ask({ agent, questions, signal: controller.signal });
      return { kind: 'answers', answers: Array.isArray(reply?.answers) ? reply.answers : undefined };
    } catch (error) {
      const record = error as { code?: unknown; name?: unknown; message?: unknown } | undefined;
      const text = [record?.code, record?.name, record?.message]
        .filter((part) => part !== undefined && part !== null)
        .map(String)
        .join(' ');
      // An owned child has no human answerer: the host refuses the ask outright.
      // Silent by design -- a sub-agent would otherwise warn on every turn.
      if (/DELEGATED_CALLER|no human answerer/i.test(text)) {
        if (!warnedDelegated) {
          warnedDelegated = true;
          debug('agemem: session identity picker skipped, the caller is a delegated agent');
        }
        return skipped('delegated caller');
      }
      debug('agemem: session identity question failed', text);
      return skipped('ask failed' + (text === '' ? '' : ': ' + text));
    } finally {
      clearTimeout(timer);
      upstream?.removeEventListener?.('abort', onAbort);
    }
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
      + 'falling back to the session-start card',
    );
  };

  /**
   * Validate the preset against the account's REAL teams/agents before binding:
   * a stale default_team_id would otherwise address someone else's pool, which
   * is worse than one extra card. The proxy validates the same way
   * (resolvePresetIdentity) and falls through to the form on a mismatch.
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
   * The proxy's asset_confirm question (form.ts:192-201), asked unconditionally
   * on the ask path -- the candidate count never decides it.
   */
  const askAssetConfirm = async (
    agent: unknown,
    signal: unknown,
  ): Promise<{ kind: 'yes' } | { kind: 'no'; reason: string } | { kind: 'failed'; reason: string }> => {
    const asked = await ask([{
      id: ASSET_CONFIRM_QUESTION_ID,
      header: '关联资产',
      // No SKIP_HINT here: this card has no "跳过" OPTION (only the host's skip
      // button), and the two options below already state the consequence. The
      // proxy's hint is kept on the team/agent questions, where it is accurate.
      question: '请确认本次对话是否要关联团队资产？',
      options: [
        { label: ASSET_CONFIRM_YES, description: '选择 Team / Agent / Task，注入团队上下文' },
        { label: ASSET_CONFIRM_NO, description: '本次不注入任何内容，直接放行' },
      ],
      multiSelect: false,
    }], agent, signal);
    if (asked.kind !== 'answers') return { kind: 'failed', reason: asked.reason };
    const answers = asked.answers;
    const answer = Array.isArray(answers)
      ? answers.find((entry) => entry !== undefined && entry !== null && entry.id === ASSET_CONFIRM_QUESTION_ID)
      : undefined;
    const labels = Array.isArray(answer?.selected) ? answer.selected.filter((entry) => typeof entry === 'string') : [];
    const custom = typeof answer?.custom === 'string' ? answer.custom : '';
    const wanted = (labels[0] ?? custom).trim();
    // No usable answer is a FAILURE, not a "no": it falls back to the configured
    // triple like a timeout does, instead of silently dropping team context.
    if (wanted === '') return { kind: 'failed', reason: 'empty answer' };
    if (wanted === ASSET_CONFIRM_YES) return { kind: 'yes' };
    if (wanted === ASSET_CONFIRM_NO) return { kind: 'no', reason: 'user chose 否，本次不关联' };
    if (/^(是|y|yes|关联|associate)/i.test(wanted)) return { kind: 'yes' };
    if (isSkipAnswer(wanted)) return { kind: 'no', reason: 'user chose not to associate' };
    // Anything unrecognised must NOT bind a team the user never confirmed.
    return { kind: 'no', reason: 'answer did not match an option' };
  };

  /**
   * The proxy's THIRD stage (form.ts:252-274): Task / work item.
   *
   * An OPTIONAL scope axis, so every failure mode below degrades to "no task":
   * it must never sink an association the user already answered for team + agent.
   * Shared by the ask path AND the preset path -- a preset fixes team/agent but
   * the work item is per session, so it still gets this one card when the team
   * actually has running work items (and stays silent when it has none).
   */
  const resolveTask = async (
    team: { teamId: string; name?: string },
    known: TaskChoice[],
    userKey: string,
    agent: unknown,
    signal: unknown,
  ): Promise<string | undefined> => {
    if (!settings.askForTask) return undefined;
    let tasks = known;
    if (tasks.length === 0 && team.teamId !== '') {
      const scoped = await deps.candidates({ userKey, teamId: team.teamId, timeoutMs: deps.timeoutMs });
      if (scoped.kind === 'ok') tasks = scoped.tasks ?? [];
    }
    if (tasks.length === 0) return undefined;
    // The proxy unshifted a virtual "default task" and treated it as "no task
    // for this session"; the same option is first here, always, so ignoring the
    // card can never silently attach a work item.
    const choices: Choice[] = [
      { label: TASK_NO_TASK_LABEL, id: '' },
      ...tasks.map((entry) => ({ label: labelOf(entry.title, entry.taskId), id: entry.taskId })),
    ];
    const asked = await ask([{
      id: TASK_QUESTION_ID,
      header: 'TDB 记忆',
      question: '「' + (team.name ?? team.teamId) + '」下本次会话关联哪个工作项（Task）？选「' + TASK_NO_TASK_LABEL + '」= 不按任务收窄: ' + SKIP_HINT,
      options: choices.map((choice) => ({ label: choice.label })),
      multiSelect: false,
    }], agent, signal);
    if (asked.kind !== 'answers') return undefined;
    const pickedTask = resolveChoice(asked.answers, TASK_QUESTION_ID, choices);
    // '' is the explicit "no task" option; a skip answer means the same.
    return pickedTask.kind === 'picked' && pickedTask.id !== '' ? pickedTask.id : undefined;
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
    const resolved = first.kind === 'ok' ? await unambiguousTriple(first, userKey) : undefined;
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
    const resolved = first.kind === 'ok' ? await unambiguousTriple(first, userKey) : undefined;
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

  const pick = async (sessionId: string, agent: unknown, signal: unknown): Promise<void> => {
    const labelChoices = (entries: Array<{ id: string; name?: string }>): Choice[] =>
      entries.map((entry) => ({ label: labelOf(entry.name, entry.id), id: entry.id }));
    const skipOption: Choice = { label: SKIP_LABEL, id: '' };
    const ordered = (choices: Choice[]): Choice[] => (settings.skipDefault ? [skipOption, ...choices] : [...choices, skipOption]);

    const userKey = await deps.resolveUserKey();
    if (userKey === undefined) {
      // Headless composition: credentials are disabled, so there is no key to
      // list teams with. Inert, no card, and no bind (a later run may have one).
      debug('agemem: session identity picker skipped, no user key (inert)');
      statusLabel = 'inert(no-key)';
      return;
    }
    const first = await candidatesWithOneRetry({ userKey, timeoutMs: deps.timeoutMs });
    if (first.kind !== 'ok') {
      bindSkipped(sessionId, 'candidates failed: ' + first.reason);
      return;
    }

    // 1) The USER-LEVEL session_init config decides whether a card appears at
    //    all -- never the candidate count (MemoryProxy init.ts:943-990).
    const decision = await readDecision(userKey, first.userId);
    if (decision.kind === 'bypass') {
      // default_associate=0: associate nothing, show nothing.
      bindNothing(sessionId, 'user-bypass', 'user session_init: default_associate=0 (bypass)');
      return;
    }
    if (decision.kind === 'preset') {
      const preset = await resolvePreset(decision, first, userKey);
      if (preset !== undefined) {
        // Preset fixes team + agent for the account, so those stay silent. The
        // work item is NOT account-level -- it changes per session -- so it
        // still gets its one optional card, and only when the team actually has
        // running work items (an empty list has nothing worth asking).
        const presetTask = await resolveTask({ teamId: preset.teamId }, first.tasks ?? [], userKey, agent, signal);
        submit(sessionId, {
          teamId: preset.teamId,
          agentId: preset.agentId,
          // Absent (not empty) when nothing was picked: absence means "no task".
          ...(presetTask !== undefined ? { taskId: presetTask } : {}),
          // The VERIFIED user id, not server.userId.
          userId: first.userId,
          source: 'user-preset',
          reason: 'user session_init: preset',
          at: now(),
        });
        return;
      }
      // Mismatch already warned once; behave exactly like ask from here on.
    }
    if (first.teams.length === 0) {
      bindSkipped(sessionId, 'the user belongs to no team');
      return;
    }

    // 2) ask: the asset_confirm question comes FIRST, unconditionally. Only its
    //    "yes" unlocks the folding below (init.ts:1026-1046, 1110-1157).
    const confirmed = await askAssetConfirm(agent, signal);
    if (confirmed.kind === 'failed') {
      bindSkipped(sessionId, confirmed.reason);
      return;
    }
    if (confirmed.kind === 'no') {
      // 这是用户的明确决定（「否，本次不关联」），不是「没绑成」——归因必须能分开，
      // 否则审计里 skipped 既表示超时/失败、又表示用户主动退出。
      bindNothing(sessionId, 'user-declined', confirmed.reason);
      return;
    }

    let team: TeamChoice;
    let agents = first.agents ?? [];
    // Tasks travel with the SAME scoped candidate call (metadata task/list):
    // first.tasks is populated whenever listCandidates knew the team.
    let tasks = first.tasks ?? [];
    if (first.teams.length === 1) {
      team = first.teams[0];
    } else {
      const choices = labelChoices(first.teams.map((entry) => ({ id: entry.teamId, name: entry.name })));
      const asked = await ask([{
        id: TEAM_QUESTION_ID,
        header: 'TDB 记忆',
        question: '请选择本次会话所属的 Team: ' + SKIP_HINT,
        options: ordered(choices).map((choice) => ({ label: choice.label })),
        multiSelect: false,
      }], agent, signal);
      if (asked.kind !== 'answers') {
        bindSkipped(sessionId, asked.reason);
        return;
      }
      const picked = resolveChoice(asked.answers, TEAM_QUESTION_ID, choices);
      if (picked.kind !== 'picked') {
        bindSkipped(sessionId, picked.reason);
        return;
      }
      team = first.teams.find((entry) => entry.teamId === picked.id) ?? { teamId: picked.id };
      const scoped = await deps.candidates({ userKey, teamId: team.teamId, timeoutMs: deps.timeoutMs });
      agents = scoped.kind === 'ok' ? scoped.agents ?? [] : [];
      tasks = scoped.kind === 'ok' ? scoped.tasks ?? [] : tasks;
    }

    if (agents.length === 0) {
      const scoped = await deps.candidates({ userKey, teamId: team.teamId, timeoutMs: deps.timeoutMs });
      agents = scoped.kind === 'ok' ? scoped.agents ?? [] : [];
      if (scoped.kind === 'ok' && (scoped.tasks ?? []).length > 0) tasks = scoped.tasks ?? [];
    }
    if (agents.length === 0) {
      bindSkipped(sessionId, 'this user owns no agent in the picked team');
      return;
    }

    let agentId: string;
    if (agents.length === 1) {
      agentId = agents[0].agentId;
    } else {
      const choices = labelChoices(agents.map((entry) => ({ id: entry.agentId, name: entry.name })));
      const asked = await ask([{
        id: AGENT_QUESTION_ID,
        header: 'TDB 记忆',
        question: '请选择「' + (team.name ?? team.teamId) + '」下要使用的 Agent: ' + SKIP_HINT,
        options: ordered(choices).map((choice) => ({ label: choice.label })),
        multiSelect: false,
      }], agent, signal);
      if (asked.kind !== 'answers') {
        bindSkipped(sessionId, asked.reason);
        return;
      }
      const picked = resolveChoice(asked.answers, AGENT_QUESTION_ID, choices);
      if (picked.kind !== 'picked') {
        bindSkipped(sessionId, picked.reason);
        return;
      }
      agentId = picked.id;
    }

    // The proxy's THIRD stage (form.ts:252-274): Task / work item -- optional,
    // so every failure degrades to "no task" and never sinks team + agent.
    const taskId = await resolveTask(team, tasks, userKey, agent, signal);

    submit(sessionId, {
      teamId: team.teamId,
      agentId,
      // Absent (not empty) when nothing was picked: the client only sends the
      // header for a real task, and absence means "no task scope".
      ...(taskId !== undefined ? { taskId } : {}),
      // The VERIFIED user id, not server.userId: the whole point of the picker
      // is that the config triple may be empty or stale.
      userId: first.userId,
      // Always 'picked': the user answered the card. The legacy 'userkey' value
      // is only read back from an old state file.
      source: 'picked',
      at: now(),
    });
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
    return typeof parent === 'string' && parent !== '' ? parent : undefined;
  };

  const ensureBound = async (agent: unknown, signal?: unknown): Promise<void> => {
    const sessionId = agentKey(agent as any);
    // Record BEFORE both early returns: with the card switched off (or the
    // session already bound) nothing below runs, and the process-wide
    // latestSessionId would stay undefined -- tools and segments would then
    // keep using the configured identity while recall/writeback used the
    // bound one, i.e. two identities inside one turn.
    deps.onSessionSeen?.(sessionId);
    if (!settings.askAtSessionStart) return;
    const existing = deps.store.get(sessionId);
    if (existing !== undefined) {
      // 分支/恢复的会话：父会话绑什么就用什么（绑定已在 agent/created 或上一次
      // pre-step 写进 store），不再问人、也不重复取卡。P0-2 的两条自愈路径在
      // reconcileExisting 里，它们同样不弹窗。
      await reconcileExisting(sessionId, existing);
      return;
    }
    // 走到这里说明父会话本身没绑成 —— 仍不问人，记一条 skipped 并把无身份暴露给调用方。
    if (parentSessionOf(agent) !== undefined) {
      bindSkipped(sessionId, 'branch inherits parent identity (no picker in a branch)');
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
        await pick(sessionId, agent, signal);
      } catch (error) {
        // pick() is written not to throw; this is the belt.
        debug('agemem: session identity picker failed', error);
        bindSkipped(sessionId, 'unexpected picker failure');
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
    dispose: () => {
      off();
      inFlight.clear();
      healInFlight.clear();
    },
  };
}
