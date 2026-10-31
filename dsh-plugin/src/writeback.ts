import { sessionKey, turnId } from './ids.js';
// Shared with MemoryCore's injection-guard.ts: one list, two consumers.
import { AGEMEM_MESSAGE_ID_PREFIX, INJECTED_KIND, looksLikeInjectedBlock } from './injection-markers.js';
import { CORE_MAX_MESSAGE_CHARS, truncateForCore } from './wire-limits.js';
import type { SkillConversationRole, SkillConversationMessage } from './memory-client.js';
import type { AgememContext, AgentLike, HostMessage, LoggerLike, SessionEventLike, SessionLike } from './types.js';
import type { Outbox } from './outbox.js';

/**
 * 回合回写：把「用户原文 + assistant 文本 + 工具调用」按真实顺序收集，回合关闭时交给 outbox。
 *
 * 为什么必须带 user 半边：真实写面 `POST /v3/conversation/add` 只收 messages 数组，
 * 只写 assistant 会让 L0 丢掉提问，检索时无法把答案锚回问题。
 *
 * 宿主已验证行为（docs/ops/dsh-plugin-probe-report.md）：
 * - 真实用户消息是 `session/event` 的 `user/message`，消息 `source.kind === 'user'`。
 * - 本插件注入块（`plugin:tdb-agemem-dsh`）同样落盘为 `user/message`，必须排除，
 *   否则记忆库会把注入的记忆提示当成用户原话自我强化。
 * - `assistant/message` 带 `{ turn, step, message, usage }`，usage 是 token 记账唯一真源。
 * - `agent/turn-stopping` 只在成功路径触发；错误/中断只能靠 `turn/end{reason}` 兜底。
 *
 * 投递永远异步：finalize 只做内存 → 本地 outbox 的入队，然后踢一次 flush，
 * 绝不 await 网络（回合路径上不允许任何网络等待）。
 */

export interface WritebackMessage {
  role: 'user' | 'assistant';
  /** 单个拼接字符串（v3 契约：content 不能是数组）。 */
  content: string;
  /** ISO 8601 字符串（v3 契约：timestamp 不是 ISO 会整批 400）。 */
  timestamp: string;
}

export interface WritebackToolCall {
  name?: string;
  callId?: string;
  arguments?: unknown;
  result?: string;
}

export interface TurnUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

/**
 * 本插件实际投递的形状。memory-client 的 `TurnEndPayload` 仍有
 * assistantText/toolCalls/usage 三个字段（兼容），但**没有 messages**：
 * v3 端点由队友在改，收口时以这份形状为准（冲突点已在回报里标注）。
 */
export interface TurnWritebackPayload {
  /** Discriminant: `l0` feeds /v3/conversation/add, `skill` feeds the L2 pipeline. */
  kind: 'l0';
  turnId: string;
  sessionId: string;
  workspaceId: string;
  turn: number;
  status: 'completed' | 'error';
  messages: WritebackMessage[];
  assistantText: string;
  toolCalls: WritebackToolCall[];
  usage?: TurnUsage;
  endedAt: string;
}

/**
 * The L2 (skill) variant of one turn. Same turn, different pipeline and a
 * different wire shape: epoch-ms timestamps and optional tool pairs.
 * It rides the SAME outbox under a distinct key (`<turnId>:skill`), so a
 * retried skill write can never replay the L0 write and vice versa.
 */
export interface SkillWritebackPayload {
  kind: 'skill';
  turnId: string;
  sessionId: string;
  turn: number;
  status: 'completed' | 'error';
  messages: SkillConversationMessage[];
  endedAt: string;
}

export interface WritebackDeps {
  outbox: Outbox;
  workspaceId: string;
  /**
   * Per-message cap. Defaults to the core's schema limit (8192): a longer block
   * makes /v3/conversation/add reject the WHOLE batch with a 400, so the turn
   * would be retried eight times and then dead-lettered — losing both the
   * question and the answer instead of one clipped sentence.
   */
  maxMessageChars?: number;
  /** Whole-turn cap for the aggregated assistantText field (not a wire field). */
  maxChars?: number;
  /**
   * Feed the L2 skill pipeline too (plugin config: writeback.skillFeed).
   * Default false here — the plugin passes its config explicitly; a bare
   * installWriteback() in a test should not emit a second payload by surprise.
   */
  skillFeed?: boolean;
  log?: LoggerLike;
}

interface TurnRecord {
  messages: WritebackMessage[];
  messageIds: Set<string>;
  toolCalls: WritebackToolCall[];
  lastCallIndex: number;
  usage?: TurnUsage;
  /** How many messages had to be clipped at the wire limit (debug counter). */
  truncated: number;
}

interface PendingUser {
  message: HostMessage;
  timestamp: string;
}

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    const text = (block as { text?: unknown })?.text;
    if (typeof text === 'string') parts.push(text);
  }
  return parts.join('\n');
}

/** Visible answer text only: `text`/`output_text` parts, never reasoning. */
const VISIBLE_PART_TYPES = new Set(['text', 'output_text']);

/**
 * Assistant messages arrive as a parts array, e.g.
 *   [{ type: 'reasoning', text: 'The user asks: …' }, { type: 'text', text: '用 pnpm。' }]
 * Writing the raw content pulled the CoT into L0 (e2e: a 1613-char row whose
 * real answer was the last ~180 chars), so retrieval then treats the model's
 * thinking as memory. Keep visible text only; an untyped text part is accepted
 * (some providers omit `type`), everything else is dropped.
 */
export function visibleTextOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const record = block as { type?: unknown; text?: unknown };
    if (typeof record.text !== 'string' || record.text === '') continue;
    if (typeof record.type === 'string' && !VISIBLE_PART_TYPES.has(record.type)) continue;
    parts.push(record.text);
  }
  return parts.join('\n');
}

/** Coerce any host-provided time into an ISO string; never emit a non-ISO value. */
function isoOf(value: unknown, fallback: () => string): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return fallback();
}

function usageOf(value: unknown): TurnUsage | undefined {
  let raw: any = value;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  if (!raw || typeof raw !== 'object') return undefined;
  return {
    inputTokens: typeof raw.inputTokens === 'number' ? raw.inputTokens : undefined,
    outputTokens: typeof raw.outputTokens === 'number' ? raw.outputTokens : undefined,
    totalTokens: typeof raw.totalTokens === 'number' ? raw.totalTokens : undefined,
  };
}

/**
 * Injection fingerprints, ordered by how much they can be trusted.
 *
 * 1. IDENTITY (authoritative): our own blocks declare `source.kind`
 *    `plugin:…` and carry an id of the form `agemem-volatile-<n>`
 *    (`src/volatile.ts` volatileMessageId). Either signal alone identifies
 *    the block; a host path that rewrites the source still keeps the id, and
 *    one that re-ids the message still keeps the kind.
 * 2. TEXT (fallback ONLY, and only when the source cannot decide): an injected
 *    block OPENS with one of our headers — normalised line prefix, within the
 *    first 3 non-empty lines or covering >=30% of the text (same rule as core,
 *    src/injection-markers.ts:detectInjectedBlock). A user quoting a header
 *    mid-message/mid-body is therefore kept (task-79: the old substring test
 *    dropped real questions that merely mentioned 【agemem 记忆提示】).
 *
 * The old shape used the text test as a broad second gate (`includes`), which
 * silently discarded real user messages; and the `kind !== 'user'` check that
 * followed it was unreachable for the same messages.
 */
/** Our injected messages are all `agemem-volatile-<n>` (src/volatile.ts). */


/** The declared source kind, when the host carried one at all. */
function sourceKindOf(message: HostMessage): string | undefined {
  const kind = message.source?.kind;
  return typeof kind === 'string' && kind !== '' ? kind : undefined;
}

/**
 * Identity gate: our own injection, independent of any text heuristics.
 * Non-throwing and allocation-free — this runs on every persisted message.
 */
function isOurInjection(message: HostMessage, sourceKind: string | undefined): boolean {
  if (sourceKind !== undefined && (sourceKind === INJECTED_KIND || sourceKind.startsWith('plugin:'))) return true;
  const id = message.id;
  return typeof id === 'string' && id.startsWith(AGEMEM_MESSAGE_ID_PREFIX);
}

/**
 * Text gate for messages whose source the host stripped. The rule itself lives
 * in src/injection-markers.ts (task-91): normalise line starts, then accept a
 * marker hit within the first 3 non-empty lines or when the matched segment is
 * >=30% of the non-whitespace chars. That is the same predicate core applies on
 * the way in, so "first line only" misses (indented / CRLF / ZWSP-prefixed
 * blocks) no longer slip through here and self-poison L0.
 */

/** ISO → epoch ms; the skill schema wants a number and rejects ISO strings. */
function epochOf(iso: string): number | undefined {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toolArgumentsText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

/**
 * Project one completed turn onto the skill wire shape.
 *
 * Ordering caveat: the record keeps text messages and tool calls in separate
 * lists, so tool pairs are appended after the text rather than interleaved at
 * their exact position. The extractor still sees the pair, and interleaving
 * would require per-message turn cursors that this host build does not expose.
 * A pair missing either half is dropped rather than guessed.
 */
function buildSkillMessages(
  messages: WritebackMessage[],
  toolCalls: WritebackToolCall[],
): SkillConversationMessage[] {
  const out: SkillConversationMessage[] = [];
  for (const message of messages) {
    const role: SkillConversationRole = message.role;
    const timestamp = epochOf(message.timestamp);
    out.push(timestamp === undefined
      ? { role, content: message.content }
      : { role, content: message.content, timestamp });
  }
  for (const call of toolCalls) {
    const toolName = typeof call.name === 'string' && call.name.trim() !== '' ? call.name.trim() : undefined;
    const callId = typeof call.callId === 'string' && call.callId.trim() !== '' ? call.callId.trim() : undefined;
    if (toolName === undefined || callId === undefined) continue;
    const content = toolArgumentsText(call.arguments);
    out.push({
      role: 'tool_call',
      content: content === '' ? toolName : content,
      tool_name: toolName,
      tool_call_id: callId,
    });
    const result = typeof call.result === 'string' ? call.result.trim() : '';
    if (result !== '') {
      out.push({ role: 'tool_result', content: result, tool_name: toolName, tool_call_id: callId });
    }
  }
  return out;
}

/**
 * Map a host turn/end `reason` onto the outbox status.
 *
 * Only {kind:'completed'} counts as a clean turn. Everything else —
 * interrupted/aborted/blocked/error, and a turn-end with no reason at all —
 * is a partial exchange: it still belongs in L0 (the question reached the
 * model and the answer may be half-written), but it must NOT feed the L2
 * skill pipeline, where an unanswered question would be distilled into a
 * fake lesson.
 */
export function turnEndStatus(reason: unknown): 'completed' | 'error' {
  const kind = (reason as { kind?: unknown } | undefined)?.kind;
  return kind === 'completed' ? 'completed' : 'error';
}

export function installWriteback(ctx: AgememContext, deps: WritebackDeps): () => void {
  const records = new Map<string, TurnRecord>();
  const finalized = new Set<string>();
  const maxRecords = 64;
  const maxChars = typeof deps.maxChars === 'number' && Number.isFinite(deps.maxChars)
    ? Math.max(0, deps.maxChars)
    : 20000;
  const configuredMessageChars = deps.maxMessageChars;
  const maxMessageChars = typeof configuredMessageChars === 'number' && Number.isFinite(configuredMessageChars)
    ? Math.min(CORE_MAX_MESSAGE_CHARS, Math.max(1, Math.floor(configuredMessageChars)))
    : CORE_MAX_MESSAGE_CHARS;

  /** 最近一个已知 turn：`user/message` 的事件体里通常不带 turn，只能靠 turn/start 等事件定位。 */
  const currentTurn = new Map<string, unknown>();
  /** turn 未知时先暂存用户原文，等 turn 确定后按原顺序补到该回合头部。 */
  const pendingUsers = new Map<string, PendingUser[]>();
  const maxPending = 16;

  const keyOf = (id: string, turn: unknown): string => turnId(id, turn);

  /**
   * Session id carried by the dispatch subject. dsh-agent/lib/types/dispatch.js
   * fuses the agent into every agent/* payload (`fused = (payload) => ({
   * ...payload, agent })`), but this is still an explicit lookup with NO
   * fallback: agentKey(undefined) keys the record as `anon-N` (src/ids.ts),
   * which can never match the `session.id` keys the session/event tracker
   * writes — a silent data loss that looks exactly like "writeback never ran".
   * No key is better than a wrong key: the turn/end fallback always carries
   * both the session and the turn.
   */
  const agentSessionId = (agent: AgentLike | undefined | null): string | undefined => {
    const id = agent?.session?.id;
    return typeof id === 'string' && id !== '' ? id : undefined;
  };
  let loggedMissingAgent = false;

  const record = (key: string): TurnRecord => {
    const existing = records.get(key);
    if (existing) return existing;
    const fresh: TurnRecord = {
      messages: [],
      messageIds: new Set(),
      toolCalls: [],
      lastCallIndex: -1,
      truncated: 0,
    };
    records.set(key, fresh);
    if (records.size > maxRecords) {
      const oldest = records.keys().next().value;
      if (typeof oldest === 'string') records.delete(oldest);
    }
    return fresh;
  };

  /**
   * The single place a message enters the payload, so the wire limit is applied
   * exactly once: surrogate-safe, line-preferring, with a visible marker.
   */
  const appendMessage = (key: string, message: WritebackMessage, id?: string): void => {
    if (message.content === '') return;
    const state = record(key);
    if (id !== undefined) {
      if (state.messageIds.has(id)) return;
      state.messageIds.add(id);
    }
    const clipped = truncateForCore(message.content, maxMessageChars);
    if (clipped.truncated) state.truncated += 1;
    state.messages.push({ ...message, content: clipped.text });
  };

  /** Warn once per process when the pending window overflows (no content in it). */
  let warnedPendingOverflow = false;

  const bufferUser = (id: string, entry: PendingUser): void => {
    const bucket = pendingUsers.get(id) ?? [];
    bucket.push(entry);
    if (bucket.length > maxPending) {
      const dropped = bucket.length - maxPending;
      pendingUsers.set(id, bucket.slice(-maxPending));
      if (!warnedPendingOverflow) {
        warnedPendingOverflow = true;
        deps.log?.warn?.(
          'agemem: writeback dropped the oldest buffered user message(s) at the pending limit',
          { sessionId: id, dropped, limit: maxPending },
        );
      }
      return;
    }
    pendingUsers.set(id, bucket);
  };

  const flushPending = (id: string, turn: unknown): void => {
    const bucket = pendingUsers.get(id);
    if (!bucket || bucket.length === 0) return;
    pendingUsers.delete(id);
    const key = keyOf(id, turn);
    for (const entry of bucket) {
      const text = textOfContent(entry.message.content).trim();
      if (text === '') continue;
      appendMessage(key, { role: 'user', content: text, timestamp: entry.timestamp }, entry.message.id);
    }
  };

  const noteTurn = (id: string, turn: unknown): unknown => {
    if (turn === undefined || turn === null) return turn;
    currentTurn.set(id, turn);
    flushPending(id, turn);
    return turn;
  };

  const finalize = (id: string, turn: unknown, status: 'completed' | 'error'): void => {
    try {
      if (turn === undefined || turn === null) return;
      const key = keyOf(id, turn);
      if (finalized.has(key)) return;
      const state = records.get(key);
      const messages = (state?.messages ?? []).slice();
      const toolCalls = state?.toolCalls ?? [];
      if (messages.length === 0) {
        // 没有可回写的文本（纯工具回合/空回合）：不投递，避免 v3 整批 400。
        finalized.add(key);
        records.delete(key);
        currentTurn.delete(id);
        return;
      }
      const usage = state?.usage;
      const truncated = state?.truncated ?? 0;
      if (truncated > 0) {
        deps.log?.debug?.(
          'agemem: writeback clipped ' + truncated + ' message(s) at the ' + maxMessageChars + '-char wire limit',
          { turnId: key },
        );
      }
      const assistantText = truncateForCore(
        messages
          .filter((message) => message.role === 'assistant')
          .map((message) => message.content)
          .join('\n')
          .trim(),
        maxChars,
      ).text;
      const payload: TurnWritebackPayload = {
        kind: 'l0',
        turnId: key,
        sessionId: id,
        workspaceId: deps.workspaceId,
        turn: Number(turn),
        status,
        messages,
        assistantText,
        toolCalls: toolCalls.map((call) => ({
          name: call.name,
          callId: call.callId,
          arguments: call.arguments,
          // Tool output is the noisiest part of a turn; keep it well below the
          // per-message limit (and code-point safe).
          result: call.result === undefined
            ? undefined
            : truncateForCore(call.result, Math.max(1, Math.floor(maxChars / 4))).text,
        })),
        usage,
        endedAt: new Date().toISOString(),
      };
      finalized.add(key);
      records.delete(key);
      currentTurn.delete(id);
      deps.outbox.enqueue(key, payload);
      // L2 rides a separate outbox key so a skill retry cannot replay L0.
      // Only completed turns: a half-finished error turn would poison the
      // skill buffer with an unanswered question.
      if (status === 'completed' && deps.skillFeed === true) {
        const skillMessages = buildSkillMessages(messages, toolCalls);
        if (skillMessages.length > 0) {
          const skillPayload: SkillWritebackPayload = {
            kind: 'skill',
            turnId: key + ':skill',
            sessionId: id,
            turn: Number(turn),
            status,
            messages: skillMessages,
            endedAt: new Date().toISOString(),
          };
          deps.outbox.enqueue(key + ':skill', skillPayload);
        }
      }
      void deps.outbox.flush();
    } catch (error) {
      deps.log?.warn?.('agemem: writeback finalize failed', error);
    }
  };

  const disposeSession = ctx.on('session/event', (session: SessionLike, event: SessionEventLike) => {
    try {
      const type = event?.type;
      const data: any = event?.data ?? {};
      const id = sessionKey(session);
      const timeOf = (): string => isoOf(
        data?.timestamp ?? data?.time ?? (event as any)?.timestamp ?? (event as any)?.time,
        () => new Date().toISOString(),
      );

      if (type === 'turn/start') {
        noteTurn(id, data?.turn ?? data?.turnId);
        return;
      }

      if (type === 'user/message') {
        // 事件体通常就是消息本身（id/role/source/content），也可能包在 message 里。
        const candidate: HostMessage | undefined = data?.message && typeof data.message === 'object' ? data.message : data;
        if (!candidate || typeof candidate !== 'object') return;
        if (candidate.role !== 'user') return;
        const text = textOfContent(candidate.content).trim();
        if (text === '') return;
        // P1-a (task-79): drop OUR OWN block, not messages that merely talk
        // about it. Identity (source kind / agemem id) decides first; the text
        // header is used only when the host gave no source at all.
        const sourceKind = sourceKindOf(candidate);
        if (isOurInjection(candidate, sourceKind)) return;
        if (sourceKind !== undefined) {
          // Real utterances say `user`; skill feed / runtime context carry their
          // own kind. A MISSING source is no longer treated as "not the user".
          if (sourceKind !== 'user') return;
        } else if (looksLikeInjectedBlock(text)) {
          return;
        }
        const timestamp = timeOf();
        const turn = noteTurn(id, data?.turn) ?? currentTurn.get(id);
        if (turn === undefined || turn === null) {
          bufferUser(id, { message: candidate, timestamp });
          return;
        }
        appendMessage(keyOf(id, turn), { role: 'user', content: text, timestamp }, candidate.id);
        return;
      }

      if (type === 'assistant/message') {
        const turn = noteTurn(id, data?.turn);
        if (turn === undefined || turn === null) return;
        const key = keyOf(id, turn);
        const message = data?.message;
        // Visible answer only — no reasoning/thinking parts (see visibleTextOfContent).
        const text = visibleTextOfContent(message?.content).trim();
        if (text !== '') {
          // 不按 id 去重 assistant：同一 message id 在多 step 里可能是两段不同文本。
          appendMessage(key, { role: 'assistant', content: text, timestamp: timeOf() });
        }
        const usage = usageOf(data?.usage);
        if (usage) record(key).usage = usage;
        return;
      }

      if (type === 'tool/call') {
        const turn = noteTurn(id, data?.turn);
        if (turn === undefined || turn === null) return;
        const state = record(keyOf(id, turn));
        state.toolCalls.push({
          name: typeof data.name === 'string' ? data.name : undefined,
          callId: typeof data.callId === 'string' ? data.callId : undefined,
          arguments: data.arguments,
        });
        state.lastCallIndex = state.toolCalls.length - 1;
        return;
      }

      if (type === 'tool/result') {
        const turn = noteTurn(id, data?.turn);
        if (turn === undefined || turn === null) return;
        const state = record(keyOf(id, turn));
        const text = textOfContent(data.message?.content);
        if (state.lastCallIndex >= 0) {
          const call = state.toolCalls[state.lastCallIndex];
          if (call) call.result = text;
        }
        return;
      }

      if (type === 'turn/end') {
        // The only close signal that ALWAYS arrives: the loop appends turn/end in
        // its finally block, while agent/turn-stopping is dispatched only when a
        // step returns normally (dsh-agent-loop/lib/index.js:1001). A rejected
        // pre-step (blocked), an empty first step and an aborted/interrupted turn
        // therefore close with NO turn-stopping — before this fallback those
        // messages sat in the record map until process exit and were never written
        // (measured: a GUI session whose turns 3/5/6 ended as `interrupted` produced
        // zero rows). Dedupe rides the finalized set: whichever signal arrives
        // first wins and the second is a no-op, so a normal turn is never
        // written twice.
        const turn = data?.turn ?? currentTurn.get(id);
        if (turn === undefined || turn === null) {
          // P1-b (task-79): finalize cannot run without a turn, so clearing the
          // buffer here deleted the buffered user text without writing anything
          // (review measured `writeback` payloads: 0). Keep it for the next
          // signal that knows the turn; the flush boundary must equal the
          // commit boundary.
          const pending = pendingUsers.get(id)?.length ?? 0;
          if (pending > 0) {
            deps.log?.debug?.('agemem: writeback.droppedPending', { sessionId: id, pending });
          }
          return;
        }
        flushPending(id, turn);
        finalize(id, turn, turnEndStatus(data?.reason));
        pendingUsers.delete(id);
        currentTurn.delete(id);
        return;
      }
    } catch (error) {
      deps.log?.warn?.('agemem: writeback tracking failed', error);
    }
  });

  const disposeTurnStopping = ctx.on(
    'agent/turn-stopping',
    (payload: { turn?: unknown; agent?: AgentLike }) => {
      // turn-stopping only fires on the clean path, so the status is fixed here
      // and turn/end (whatever its reason) becomes the no-op duplicate.
      const id = agentSessionId(payload?.agent);
      if (id === undefined) {
        if (!loggedMissingAgent) {
          loggedMissingAgent = true;
          deps.log?.debug?.(
            'agemem: agent/turn-stopping arrived without an agent session id; the turn/end fallback will finalize this turn',
          );
        }
        return;
      }
      finalize(id, payload?.turn, 'completed');
    },
  );

  return () => {
    disposeSession();
    disposeTurnStopping();
  };
}
