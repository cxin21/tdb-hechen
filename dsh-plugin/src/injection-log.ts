/**
 * Append-only evidence log for what the plugin actually put into the prompt.
 *
 * Why this is separate from `debug-log.ts`:
 * - `debug.log` is opt-in (config.debug), human prose, and rotates at 5 MB.
 *   It answers "what happened" for a developer.
 * - this file is always on, one JSON object per line, and answers exactly one
 *   question: **did the persona card / turn block reach the model's prompt, and
 *   how many characters of it**. That is the L2 evidence our review keeps
 *   marking as 未采集, and it must not depend on a debug switch being flipped.
 *
 * What each event proves:
 * - `section-read`  the host called the systemPrompt section getter; `chars` and
 *                   `hash` are the exact bytes handed over. `hash` is SHA-256 of
 *                   those bytes. P1-2 之后人格卡是 identity / anchor 两个 section，
 *                   所以每行带 `section` 区分，`hash`/`chars` 都是**该段**的口径：
 *                   与 `GET /v3/soul/card` 的 `identity.hash` / `anchor.hash`
 *                   （同为 sha256(段文本)）直接对账；旧行没有 `section`，`hash`
 *                   对的是整卡 `textHash`。
 * - `turn-append`   the per-turn block was appended; `chars` is the clamped
 *                   length actually injected.
 * - `turn-skip`     dedupe skipped this turn; `chars` is 0 on purpose (the old
 *                   bug was logging the would-be length, which made skips look
 *                   identical to injections).
 *
 * Rules:
 * - FAIL-OPEN: any filesystem error stops further writes and is reported once
 *   through the host logger. Never throws into the turn path.
 * - Rotation: 2 MB then `<path>.1`, same helper as the debug log (one generation
 *   is enough — this is evidence for the last few days, not an archive).
 * - No card text and no user text: only lengths, hashes, session key, turn.
 */

import { createFileSink, type DebugLogSink } from './debug-log.js';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Rotate earlier than the debug log: one line per turn adds up. */
export const INJECTION_LOG_MAX_BYTES = 2 * 1024 * 1024;

export type InjectionEventKind =
  | 'section-read'
  | 'turn-append'
  | 'turn-skip'
  /** 会话绑定 agent 时取到（或清空）了卡；覆盖语义见 persona-card.ts。 */
  | 'card-bound'
  /** 绑定取卡失败，该会话保留上一份（冷启动就是没有卡）。 */
  | 'card-bound-failed'
  /**
   * 分支（fork/压缩）继承了父会话的冻结卡：同一对象、字节相同、零网络。
   * `parentSessionId` 记父会话键，`hash`/`chars` 与父会话第一次 section-read 相等即证明
   * 「同一段对话只有一个人设」。
   */
  | 'card-inherited'
  /**
   * 探针：`agent/created` 里尝试解析身份并取卡。它回答一个纯事实问题 ——
   * 宿主的提问服务在 turn 之外能不能弹窗。`reason` 为 'ok' 表示代码走完且
   * 没有抛错（未必取到卡：`chars` 才是结果），'threw:<msg>' 表示宿主拒绝。
   */
  | 'bind-probe';

export interface InjectionLogEvent {
  event: InjectionEventKind;
  /**
   * `section-read` 才有的段标记（P1-2）：人格卡拆成 identity（前置）/ anchor
   * （末尾锚）两个 section，两段各自记一行。`hash` 是该段文本的 SHA-256、`chars`
   * 是该段长度；不带这个字段的旧行 = 拆分前的整卡 section。
   */
  section?: 'identity' | 'anchor';
  /** Session scope (the agentKey the recall/identity calls use). */
  sessionId?: string;
  /** Host turn number when known; null is allowed (Core merges by session key). */
  turn?: number | null;
  /** Card version, `section-read` only. */
  version?: number;
  /** Content hash of the exact injected bytes (fnv1a, same as the report). */
  hash?: string;
  /** Bound identity triple team/user/agent (task-32). */
  identity?: string;
  /** card-bound-failed only: the version this session keeps after the failure. */
  keptVersion?: number;
  /** Characters actually injected (0 for `turn-skip` / cleared card). */
  chars: number;
  /** Failure reason for `card-bound-failed` (http_status / timeout / empty / parse). */
  reason?: string;
  /**
   * `section-read` only: where the session key came from — the host's agent
   * context, the last completed bind, or nothing at all (section returned '').
   */
  sidSource?: 'context-agent' | 'none';
  /** `section-read` only: which agent field matched (agent.session.id / agent.id / …). */
  sidField?: string;
  /** Writer pid — two plugin instances would both write here; this tells them apart. */
  pid?: number;
  /** `section-read` miss only: how many sessions currently hold a card. */
  boundCount?: number;
  /** `section-read` miss only: first few bound session keys, to expose a key mismatch. */
  knownSessions?: string;
  /**
   * `section-read` only: which path put the card into this assembly. task-34 之后
   * 只有 `getter` 一种：身份与卡在 `agent/created` 就位，getter 是唯一渲染者。
   * `assemble-hook` 只出现在 2026-11-08 之前的旧日志里，读历史行时仍要认。
   */
  via?: 'getter' | 'assemble-hook';
  /** `bind-probe` only: how long the identity+card attempt took, in ms. */
  ms?: number;
  /** `card-inherited` only: the parent session this card came from. */
  parentSessionId?: string;
}

export interface InjectionLog {
  readonly path: string;
  record(event: InjectionLogEvent): void;
  /** True once a write failed; the log went silent instead of throwing. */
  failed(): boolean;
}

/**
 * `TDB_PERSONA_LOG` wins verbatim; otherwise `$TDB_DATA_DIR/logs/…`, defaulting
 * to D:/TDB/data — the same tree the supervisor and Core already write to, so
 * one `ls` shows the whole chain. Kept pure for tests.
 */
export function resolveInjectionLogPath(env: Record<string, string | undefined> = process.env): string {
  const explicit = typeof env.TDB_PERSONA_LOG === 'string' ? env.TDB_PERSONA_LOG.trim() : '';
  if (explicit !== '') return explicit;
  const rawDir = typeof env.TDB_DATA_DIR === 'string' && env.TDB_DATA_DIR.trim() !== ''
    ? env.TDB_DATA_DIR.trim()
    : join('D:', 'TDB', 'data');
  return join(rawDir, 'logs', 'persona-injection.jsonl');
}

export interface CreateInjectionLogOptions {
  path?: string;
  sink?: DebugLogSink;
  maxBytes?: number;
  env?: Record<string, string | undefined>;
  /** Called once, the first time a write fails. */
  onError?: (error: unknown) => void;
}

export function createInjectionLog(options: CreateInjectionLogOptions = {}): InjectionLog {
  const path = options.path ?? resolveInjectionLogPath(options.env);
  const sink = options.sink ?? createFileSink(path);
  const maxBytes = options.maxBytes ?? INJECTION_LOG_MAX_BYTES;
  let failed = false;

  const record = (event: InjectionLogEvent): void => {
    if (failed) return;
    try {
      const line = JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...event }) + '\n';
      if (sink.size() + line.length > maxBytes) sink.rotate();
      sink.append(line);
    } catch (error) {
      failed = true;
      options.onError?.(error);
    }
  };

  return { path, record, failed: () => failed };
}

/** No-op used where the log is not wired (tests, or a host without a data dir). */
export const NOOP_INJECTION_LOG: InjectionLog = {
  path: '',
  record: () => {},
  failed: () => false,
};

/**
 * Defensive wrapper for call sites on the turn path: `createInjectionLog` already
 * catches, but a test double or a future sink must not be able to break injection
 * by throwing. Everything here is fail-open by contract.
 */
export function recordInjection(log: InjectionLog | undefined, event: InjectionLogEvent): void {
  try {
    log?.record(event);
  } catch {
    // 证据日志失败绝不能影响注入。
  }
}
