import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { agentKey } from './ids.js';
import type { MemoryIdentity } from './memory-client.js';
import type { AgememContext, LoggerLike, PreStepDecision } from './types.js';
import { resolveUserSessionInitDecision, type UserInitDecision } from './user-session-init.js';

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
  | 'picked'
  | 'skipped'
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
    submit(sessionId, { teamId: '', agentId: '', userId: '', source, reason, at: now() });
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
    const first = await deps.candidates({ userKey, timeoutMs: deps.timeoutMs });
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
        submit(sessionId, {
          teamId: preset.teamId,
          agentId: preset.agentId,
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
      bindNothing(sessionId, 'skipped', confirmed.reason);
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

    // The proxy's THIRD stage (form.ts:252-274): Task / work item. This is an
    // OPTIONAL scope axis, so every path below degrades to "no task" -- it must
    // never sink an association the user already answered for team + agent.
    let taskId: string | undefined;
    if (settings.askForTask) {
      if (tasks.length === 0 && team.teamId !== '') {
        const scoped = await deps.candidates({ userKey, teamId: team.teamId, timeoutMs: deps.timeoutMs });
        if (scoped.kind === 'ok') tasks = scoped.tasks ?? [];
      }
      if (tasks.length > 0) {
        // The proxy unshifted a virtual "default task" and treated it as "no
        // task for this session"; the same option is first here, always, so
        // ignoring the card can never silently attach a work item.
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
        if (asked.kind === 'answers') {
          const pickedTask = resolveChoice(asked.answers, TASK_QUESTION_ID, choices);
          // '' is the explicit "no task" option; a skip answer means the same.
          if (pickedTask.kind === 'picked' && pickedTask.id !== '') taskId = pickedTask.id;
        }
      }
    }

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

  const ensureBound = async (agent: unknown, signal?: unknown): Promise<void> => {
    const sessionId = agentKey(agent as any);
    // Record BEFORE both early returns: with the card switched off (or the
    // session already bound) nothing below runs, and the process-wide
    // latestSessionId would stay undefined -- tools and segments would then
    // keep using the configured identity while recall/writeback used the
    // bound one, i.e. two identities inside one turn.
    deps.onSessionSeen?.(sessionId);
    if (!settings.askAtSessionStart) return;
    if (deps.store.get(sessionId) !== undefined) return;
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
    },
  };
}
