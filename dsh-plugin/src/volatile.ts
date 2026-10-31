import { agentKey, turnId } from './ids.js';
import type { RecallHit } from './memory-client.js';
import { clampBlockByLines, VOLATILE_HEADER } from './recall-source.js';
import type { AgememContext, HostMessage, LoggerLike, PreStepDecision } from './types.js';

/**
 * 每轮尾部注入块（volatile）——append-only、两级去重、fail-open。
 *
 * 宿主已验证行为（docs/ops/dsh-plugin-probe-report.md）：
 * - `agent/pre-step` 每个 STEP 触发一次，decision 只带本 step 认领的消息，所以追加点是尾部。
 * - 追加的消息会**落盘**为 `user/message` 会话事件，之后一直留在历史里
 *   （spec 的"volatile 不入历史"已被实测证伪）。
 * - `source.kind` 必须 producer-owned（`'plugin'` 会被宿主拒绝）。
 *
 * 因此注入策略是 append-only：**永不删除历史里的注入块**。
 * - 删掉历史注入块等于改写提示词前缀，provider 的基于前缀的 KV cache 会整段失效，
 *   长会话里重算 prefill 的代价（数十万 token 级）远大于多留几百字符。
 * - 代价是 token 逐轮累积：缺省上限 DEFAULT_VOLATILE_MAX_CHARS = 1200 字符
 *   （条目先逐条裁到 ENTRY_MAX_CHARS=360，通常只装 1–2 条，实测单轮注入 ≈ 400–800 字符），
 *   中文约 1 字符 ≈ 0.6–1 token，即每轮最多约 300–800 token；20 轮最坏累积约
 *   0.6–1.6 万 token，仍远低于一次前缀重算。
 * - 用两级去重把累积压到最小：① 同一 turn 只注入一次（进程内 Map + 历史消息 id 检查，
 *   因为 pre-step 每 step 都会触发）；② 最近 VOLATILE_RECENT_TURNS(=3) 轮内出现过
 *   **完全相同**的块文本时本轮跳过注入（同一份记忆反复召回时不重复占 token）。
 */

export const VOLATILE_SOURCE_KIND = 'plugin:tdb-agemem-dsh';

/**
 * 缺省块上限（字符）。实测（真 core 8420，/v3/recall）：
 * - maxResults=1 → 1 条、450 字符；maxResults=2 → 2 条、合计 1214 字符（单条 450–770）；
 * - maxResults=3 仍只返回 2 条（取几条由 v3 recall 决定，多取一条不多花 embedding：
 *   l1 只 embed 一次 query）。
 *
 * 早期「整行回退 + 1200 预算」只装得下 1 条（815 字符），第二条被整条丢弃 ⇒
 * recallMaxResults=2 白花一次 embedding。现在条目**先**逐条裁到 ENTRY_MAX_CHARS(360)
 * 再按预算装填（recall-source.ts），1200 通常装 2 条（≈800 字符），既提高信息密度，
 * 又降低 append-only 的累积成本。截断仍按整条丢弃，只有单条自身超预算时才裁。
 */
export const DEFAULT_VOLATILE_MAX_CHARS = 1200;

/** 完全相同块文本的抑制窗口（轮）。窗口外允许重新注入，避免记忆长期不可见。 */
export const VOLATILE_RECENT_TURNS = 3;

export function volatileMessageId(turn: unknown): string {
  return `agemem-volatile-${String(turn)}`;
}

/** What the block fetcher needs from the step it is serving. */
export interface VolatileTurnContext {
  turn?: unknown;
  /** Session key (agentKey) — sent to /v3/recall as x-tdai-session-id. */
  sessionId: string;
}

export interface VolatileDeps {
  enabled: boolean;
  /** 缺省 DEFAULT_VOLATILE_MAX_CHARS（1200）；显式传入仍生效（index.ts 传 config 值）。 */
  maxChars?: number;
  timeoutMs: number;
  getBlock: (turnText: string, context: VolatileTurnContext) => Promise<string | undefined>;
  log?: LoggerLike;
  now?: () => number;
}

interface RecentBlock {
  turn: number;
  text: string;
}

function textOf(message: HostMessage | undefined): string {
  if (!message) return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    const text = (block as { text?: unknown })?.text;
    if (typeof text === 'string') parts.push(text);
  }
  return parts.join('\n');
}

/** The real user's own text (and message id) from the messages claimed for this step. */
export interface TurnClaim {
  text: string;
  /** Host id of the claimed user message; used as the dedupe key when no turn number is given. */
  messageId?: string;
}

export function extractTurnClaim(messages: HostMessage[] | undefined): TurnClaim {
  if (!Array.isArray(messages)) return { text: '' };
  const claim = (message: HostMessage): TurnClaim => ({
    text: textOf(message).trim(),
    messageId: typeof message.id === 'string' && message.id !== '' ? message.id : undefined,
  });
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.role !== 'user') continue;
    if (message.source?.kind !== 'user') continue;
    const own = claim(message);
    if (own.text !== '') return own;
  }
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.role !== 'user') continue;
    if (message.source?.kind === VOLATILE_SOURCE_KIND) continue;
    const other = claim(message);
    if (other.text !== '') return other;
  }
  return { text: '' };
}

/** The real user's own text from the messages claimed for this step. */
export function extractTurnText(messages: HostMessage[] | undefined): string {
  return extractTurnClaim(messages).text;
}

/**
 * Stable pseudo turn key for a turn number the host did not provide: a cheap
 * FNV-1a over the user text. Without it the dedupe key was
 * 'agemem-volatile-undefined', so the first injection of a session blocked
 * every later one — silently, for the rest of the session.
 */
function textTurnKey(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return 'text-' + hash.toString(16);
}

function alreadyInjected(messages: HostMessage[] | undefined, turn: unknown): boolean {
  if (!Array.isArray(messages)) return false;
  const id = volatileMessageId(turn);
  return messages.some((message) => message?.id === id && message?.source?.kind === VOLATILE_SOURCE_KIND);
}

/** Turn numbers are numbers on this host, but never trust that blindly. */
function numericTurn(turn: unknown): number | undefined {
  const value = Number(turn);
  return Number.isFinite(value) ? value : undefined;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), Math.max(1, timeoutMs));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function installVolatile(ctx: AgememContext, deps: VolatileDeps): () => void {
  if (!deps.enabled) return () => {};
  const configuredMax = deps.maxChars;
  const maxChars = typeof configuredMax === 'number' && Number.isFinite(configuredMax)
    ? Math.max(0, configuredMax)
    : DEFAULT_VOLATILE_MAX_CHARS;

  /** turn key -> injected at; bounded, oldest evicted. */
  const injected = new Map<string, number>();
  const maxKeys = 512;

  /** session scope -> blocks injected in the recent window, oldest first. */
  const recent = new Map<string, RecentBlock[]>();
  const maxScopes = 512;

  const remember = (key: string): void => {
    injected.set(key, (deps.now ?? Date.now)());
    if (injected.size <= maxKeys) return;
    for (const oldest of injected.keys()) {
      injected.delete(oldest);
      if (injected.size <= maxKeys) break;
    }
  };

  const seenRecently = (scope: string, turn: number, text: string): boolean => {
    const entries = recent.get(scope);
    if (!entries) return false;
    return entries.some((entry) => entry.text === text && turn - entry.turn >= 0 && turn - entry.turn <= VOLATILE_RECENT_TURNS);
  };

  const recordBlock = (scope: string, turn: number, text: string): void => {
    const kept = (recent.get(scope) ?? []).filter((entry) => !(turn - entry.turn > VOLATILE_RECENT_TURNS));
    kept.push({ turn, text });
    // Re-insert so Map iteration order stays "least recently used first".
    recent.delete(scope);
    recent.set(scope, kept.slice(-(VOLATILE_RECENT_TURNS + 1)));
    while (recent.size > maxScopes) {
      const oldest = recent.keys().next().value;
      if (typeof oldest !== 'string') break;
      recent.delete(oldest);
    }
  };

  return ctx.on(
    'agent/pre-step',
    async (payload: { agent?: unknown; turn?: unknown; step?: unknown; signal?: unknown; messages?: HostMessage[] }, next: () => Promise<PreStepDecision>) => {
      const decision = await next();
      try {
        if (!decision || decision.kind === 'reject') return decision;
        const messages = Array.isArray(decision.messages) ? decision.messages : [];
        const scope = agentKey(payload?.agent as any);
        const claim = extractTurnClaim(messages);
        const turnNumber = numericTurn(payload?.turn);
        // A missing turn number used to produce the constant key
        // 'agemem-volatile-undefined' — one injection per session, no log. Fall
        // back to the claimed user message id, then to a hash of its text.
        const turnKey: unknown = turnNumber !== undefined
          ? turnNumber
          : claim.messageId !== undefined
            ? claim.messageId
            : textTurnKey(claim.text);
        const key = turnId(scope, turnKey);
        if (injected.has(key) || alreadyInjected(messages, turnKey)) {
          remember(key);
          return decision;
        }
        const turnText = claim.text;
        if (turnText === '') return decision;
        const block = await withTimeout(deps.getBlock(turnText, { turn: payload?.turn, sessionId: scope }), deps.timeoutMs);
        const text = typeof block === 'string' ? block.trim() : '';
        if (text === '') return decision;
        // Line-aware clamp: never cut a memory entry in the middle of its text.
        const clamped = clampBlockByLines(text, maxChars);
        if (clamped === '') return decision;

        if (turnNumber === undefined) {
          deps.log?.debug?.('agemem: turn number missing; using a pseudo key for the volatile dedupe', {
            fromMessageId: claim.messageId !== undefined,
            key: turnKey,
          });
        }
        if (turnNumber !== undefined && seenRecently(scope, turnNumber, clamped)) {
          remember(key);
          deps.log?.debug?.('agemem: volatile block identical within recent turns; skipping injection', {
            turn: turnNumber,
            chars: clamped.length,
          });
          return decision;
        }

        // Append-only: never remove or rewrite earlier injected messages (that
        // would shift the prompt prefix and invalidate the provider KV cache).
        const message: HostMessage = {
          id: volatileMessageId(turnKey),
          role: 'user',
          source: { kind: VOLATILE_SOURCE_KIND },
          content: [{ type: 'text', text: clamped }],
        };
        remember(key);
        if (turnNumber !== undefined) recordBlock(scope, turnNumber, clamped);
        return { ...decision, messages: [...messages, message] };
      } catch (error) {
        deps.log?.warn?.('agemem: volatile block skipped', error);
        return decision;
      }
    },
    { prepend: true },
  );
}

/**
 * Render recall hits as the per-turn block. Empty hits render as an empty
 * string so the caller can skip the append entirely (no noise, no extra token).
 */
export function formatVolatileBlock(hits: RecallHit[], maxChars: number): string {
  if (!Array.isArray(hits) || hits.length === 0) return '';
  const header = VOLATILE_HEADER;
  const lines = hits.map((hit) => {
    const label = hit.layer ? '[' + hit.layer + '] ' : '';
    const text = String(hit.text ?? '').replace(/\s+/g, ' ').trim();
    return '- ' + label + text;
  });
  const joined = header + String.fromCharCode(10) + lines.join(String.fromCharCode(10));
  return clampBlockByLines(joined, maxChars);
}
