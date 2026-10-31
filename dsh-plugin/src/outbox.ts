import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { LoggerLike } from './types.js';

/**
 * Durable local outbox for turn writeback.
 *
 * The turn must close immediately, so delivery is fire-and-forget: `enqueue`
 * only touches a local JSONL file (synchronously, never awaiting the network),
 * and `flush` retries whatever is still pending with per-entry backoff.
 * Entries are keyed by turn id so a retry after a restart cannot duplicate a
 * turn that already landed.
 *
 * 零删红线：投递重试到 maxAttempts 后**不允许静默丢弃**（过去的实现直接
 * delete，用户几轮对话的记忆就这么没了）。满次数时条目移动到同目录的
 * `outbox.dead.jsonl`（追加写，带失败原因与最后一次响应状态），主 outbox
 * 只保留待重试条目以保持文件有界；`requeueDead()` 提供人工/运维回灌。
 * 死信文件是一次 append 的日志，不参与 flush。
 */

export interface OutboxEntry {
  key: string;
  payload: unknown;
  attempts: number;
  nextAt: number;
  createdAt: number;
}

/** Richer delivery result: lets the caller tell "rejected" from "transport failed". */
export interface DeliveryOutcome {
  ok: boolean;
  reason?: string;
  status?: number;
  /**
   * Default `true`. Return `false` when replaying the payload is unsafe (the
   * skill buffer has no server-side dedupe, so a second delivery doubles it):
   * the entry is dead-lettered on this attempt instead of after maxAttempts.
   */
  retryable?: boolean;
  /** Short ops-facing class: `http`, `auth`, `transport`, `skill-feed-no-retry-on-response`, … */
  reasonClass?: string;
  /** Endpoint path that failed (never a full URL with credentials). */
  endpoint?: string;
  /** Characters in the attempted batch — a size, never the text itself. */
  messageLen?: number;
}

/**
 * Structured dead-letter reason. Deliberately carries no session id, turn key or
 * message body: the dead-letter file is an ops artifact and must not become a
 * second copy of the user's conversation.
 */
export interface DeadLetterReason {
  reasonClass: string;
  endpoint?: string;
  status?: number;
  attempt: number;
  messageLen?: number;
  /** Human-readable detail from the delivery layer. */
  message?: string;
}

export interface DeadLetterEntry extends OutboxEntry {
  deadAt: number;
  /** attempts consumed before the entry was dead-lettered. */
  attempts: number;
  reason: DeadLetterReason;
}

export interface OutboxDeps {
  path?: string;
  /** 缺省 `<outbox dir>/outbox.dead.jsonl`。 */
  deadPath?: string;
  deliver: (entry: OutboxEntry) => Promise<boolean | DeliveryOutcome>;
  maxAttempts: number;
  retryMs: number;
  /** 退避上限，缺省 5 分钟，避免线性退避无限增长。 */
  maxBackoffMs?: number;
  /** 队列条数上限，超出时丢最旧的一条（缺省不限）。 */
  maxEntries?: number;
  /** 队列字节上限（按每条 JSON 的实际字节算），超出时丢最旧（缺省不限）。 */
  maxBytes?: number;
  now?: () => number;
  log?: LoggerLike;
}

function positiveLimit(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : Number.POSITIVE_INFINITY;
}

/** Default outbox location: `$DSH_HOME/agemem/outbox.jsonl` (or ~/.dsh). */
export function defaultOutboxPath(): string {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh');
  return join(home, 'agemem', 'outbox.jsonl');
}

export class Outbox {
  private readonly entries = new Map<string, OutboxEntry>();
  private readonly path: string;
  private readonly deadPath: string;
  private readonly now: () => number;
  private readonly maxBackoffMs: number;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private dropped = 0;
  private warnedCapacity = false;
  private loaded = false;
  private flushing: Promise<void> | undefined;
  private deadKeyCache: Set<string> | undefined;

  constructor(private readonly deps: OutboxDeps) {
    this.path = deps.path?.trim() || defaultOutboxPath();
    this.deadPath = deps.deadPath?.trim() || join(dirname(this.path), 'outbox.dead.jsonl');
    this.now = deps.now ?? Date.now;
    const configuredBackoff = deps.maxBackoffMs;
    this.maxBackoffMs = typeof configuredBackoff === 'number' && Number.isFinite(configuredBackoff)
      ? Math.max(1000, configuredBackoff)
      : 300_000;
    this.maxEntries = positiveLimit(deps.maxEntries);
    this.maxBytes = positiveLimit(deps.maxBytes);
  }

  get filePath(): string {
    return this.path;
  }

  /** 死信文件的路径（warn 里会给出来，便于运维回灌）。 */
  get deadFilePath(): string {
    return this.deadPath;
  }

  /** 待回灌的死信条数；文件缺失/损坏时返回 0。 */
  deadCount(): number {
    return this.readDead().length;
  }

  pendingCount(): number {
    this.load();
    return this.entries.size;
  }

  has(key: string): boolean {
    this.load();
    return this.entries.has(key);
  }

  /**
   * Keys already parked in the dead letter file. Re-queueing one of them would
   * silently undo a deliberate "stop retrying" decision (the skill feed is
   * dead-lettered on purpose: its buffer has no dedupe, so a replay after a
   * restart would double-count the turn). Operators can still recover a row
   * explicitly through requeueDead().
   */
  private deadKeys(): Set<string> {
    if (this.deadKeyCache === undefined) {
      this.deadKeyCache = new Set(this.readDead().map((entry) => entry.key));
    }
    return this.deadKeyCache;
  }

  /** Queue one turn for delivery. Synchronous, never throws, never awaits. */
  enqueue(key: string, payload: unknown): void {
    try {
      this.load();
      if (this.entries.has(key)) return;
      if (this.deadKeys().has(key)) {
        this.deps.log?.debug?.(
          'agemem: outbox kept an already dead-lettered key out of the queue (requeue it explicitly)',
          { dead: this.deadPath },
        );
        return;
      }
      this.entries.set(key, {
        key,
        payload,
        attempts: 0,
        nextAt: this.now(),
        createdAt: this.now(),
      });
      this.enforceCapacity();
      this.persist();
    } catch (error) {
      this.deps.log?.warn?.('agemem: outbox enqueue failed', error);
    }
  }

  /**
   * Turn rows dropped by the capacity guard so far. Exposed for tests/ops: the
   * warn fires once per process, the counter keeps counting.
   */
  droppedCount(): number {
    return this.dropped;
  }

  private entryBytes(entry: OutboxEntry): number {
    try {
      return Buffer.byteLength(JSON.stringify(entry), 'utf8');
    } catch {
      return 0;
    }
  }

  private totalBytes(): number {
    let total = 0;
    for (const entry of this.entries.values()) total += this.entryBytes(entry);
    return total;
  }

  /**
   * Keep the queue inside its bounds by dropping the OLDEST turns first: a
   * profile that cannot reach the core must not grow the JSONL forever. The
   * newest row is always kept (one turn may legitimately exceed maxBytes), and
   * the dead-letter file is never trimmed — that is the audit trail of turns
   * that failed for good.
   */
  private enforceCapacity(): number {
    if (this.maxEntries === Number.POSITIVE_INFINITY && this.maxBytes === Number.POSITIVE_INFINITY) return 0;
    let dropped = 0;
    while (this.entries.size > 1 && (this.entries.size > this.maxEntries || this.totalBytes() > this.maxBytes)) {
      let oldestKey: string | undefined;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [key, entry] of this.entries) {
        const at = typeof entry.createdAt === 'number' ? entry.createdAt : 0;
        if (at < oldestAt) {
          oldestAt = at;
          oldestKey = key;
        }
      }
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
      dropped += 1;
    }
    if (dropped > 0) {
      this.dropped += dropped;
      if (!this.warnedCapacity) {
        this.warnedCapacity = true;
        this.deps.log?.warn?.(
          'agemem: outbox over capacity — dropped the oldest queued turn(s); raise writeback.maxOutboxEntries / maxOutboxBytes or fix the core connection',
          { dropped: this.dropped, maxEntries: this.maxEntries, maxBytes: this.maxBytes, path: this.path },
        );
      } else {
        this.deps.log?.debug?.('agemem: outbox dropped more turns over capacity', { dropped: this.dropped });
      }
    }
    return dropped;
  }

  /** Deliver every due entry; safe to call concurrently. */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    const run = (async () => {
      this.load();
        for (const [key, entry] of [...this.entries]) {
          if (entry.nextAt > this.now()) continue;
          let delivered = false;
          let reason = 'delivery rejected';
          let status: number | undefined;
          let retryable = true;
          let reasonClass: string | undefined;
          let endpoint: string | undefined;
          let messageLen: number | undefined;
          try {
            const outcome = await this.deps.deliver(entry);
            if (outcome === true) {
              delivered = true;
            } else if (outcome && typeof outcome === 'object') {
              delivered = outcome.ok === true;
              if (!delivered) {
                reason = outcome.reason ?? 'delivery rejected';
                status = outcome.status;
                retryable = outcome.retryable !== false;
                reasonClass = outcome.reasonClass;
                endpoint = outcome.endpoint;
                messageLen = outcome.messageLen;
              }
            }
          } catch (error) {
            this.deps.log?.debug?.('agemem: outbox delivery threw', error);
            delivered = false;
            reason = error instanceof Error ? error.message : String(error);
          }
          if (delivered) {
            this.entries.delete(key);
            continue;
          }
          entry.attempts += 1;
          const exhausted = entry.attempts >= Math.max(1, this.deps.maxAttempts);
          // !retryable means a replay would corrupt state (skill buffer has no
          // dedupe): dead-letter on this attempt instead of retrying to the cap.
          if (exhausted || !retryable) {
            // 零删：移到死信文件，绝不静默丢弃。
            const deadReason: DeadLetterReason = {
              reasonClass: reasonClass ?? (exhausted ? 'attempts-exhausted' : 'not-retryable'),
              endpoint,
              status,
              attempt: entry.attempts,
              messageLen,
              message: reason,
            };
            const dead: DeadLetterEntry = {
              key: entry.key,
              payload: entry.payload,
              attempts: entry.attempts,
              nextAt: entry.nextAt,
              createdAt: entry.createdAt,
              deadAt: this.now(),
              reason: deadReason,
            };
            if (this.appendDead(dead)) {
              this.entries.delete(key);
              // No key, no ids, no body: class + endpoint + status is enough to
              // act on, and the dead-letter file has the details.
              this.deps.log?.warn?.(
                `agemem: outbox moved an entry to the dead letter file after ${entry.attempts} attempt(s) `
                + `(class=${deadReason.reasonClass}, endpoint=${endpoint ?? 'unknown'}, `
                + `status=${status === undefined ? 'none' : status}, dead=${this.deadPath})`,
                {
                  reasonClass: deadReason.reasonClass,
                  endpoint,
                  status,
                  attempt: entry.attempts,
                  messageLen,
                  deadLetter: this.deadPath,
                },
              );
            } else {
              // 死信写不进去时宁可继续留在主队列重试，也不能丢。
              entry.nextAt = this.now() + this.backoffMs(entry.attempts);
              this.deps.log?.warn?.(
                'agemem: outbox dead-letter write failed; entry kept for retry',
                { key: entry.key, deadLetter: this.deadPath },
              );
            }
            continue;
          }
          entry.nextAt = this.now() + this.backoffMs(entry.attempts);
        }
      this.persist();
    })();
    // The latch is released from a microtask, never from inside the async
    // body: a flush whose body has nothing due completes synchronously, so an
    // in-body release would run before `run` is assigned and leave a stale
    // resolved promise latched, wedging every later flush.
    const clear = () => {
      if (this.flushing === run) this.flushing = undefined;
    };
    this.flushing = run;
    void run.then(clear, clear);
    return run;
  }

  /** Periodically retry pending entries; returns the stop handle. */
  startTimer(intervalMs?: number): () => void {
    const timer = setInterval(() => {
      if (this.pendingCount() > 0) void this.flush();
    }, Math.max(1000, intervalMs ?? this.deps.retryMs));
    (timer as { unref?: () => void }).unref?.();
    return () => clearInterval(timer);
  }

  /** 线性退避，但封顶 maxBackoffMs（缺省 5 分钟）。 */
  private backoffMs(attempts: number): number {
    const base = Math.max(1000, this.deps.retryMs);
    return Math.min(base * Math.max(1, attempts), this.maxBackoffMs);
  }

  private appendDead(dead: DeadLetterEntry): boolean {
    try {
      mkdirSync(dirname(this.deadPath), { recursive: true });
      appendFileSync(this.deadPath, JSON.stringify(dead) + '\n', 'utf8');
      this.deadKeyCache?.add(dead.key);
      return true;
    } catch (error) {
      this.deps.log?.warn?.('agemem: outbox dead-letter append failed', error);
      return false;
    }
  }

  private readDead(): DeadLetterEntry[] {
    try {
      const raw = readFileSync(this.deadPath, 'utf8');
      const entries: DeadLetterEntry[] = [];
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '') continue;
        try {
          const parsed = JSON.parse(trimmed) as DeadLetterEntry;
          if (parsed && typeof parsed.key === 'string') entries.push(parsed);
        } catch {
          // 半行/坏行忽略，不影响其余死信。
        }
      }
      return entries;
    } catch {
      return [];
    }
  }

  /**
   * 把死信文件里的条目按 key 移回主队列（attempts 归零，立即到期）。
   * 用于人工/运维恢复；返回成功回灌的条数。已在主队列的 key 保留在死信里不动。
   */
  requeueDead(): number {
    try {
      const raw = readFileSync(this.deadPath, 'utf8');
      this.load();
      const keep: string[] = [];
      let moved = 0;
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '') continue;
        let entry: DeadLetterEntry;
        try {
          entry = JSON.parse(trimmed) as DeadLetterEntry;
        } catch {
          keep.push(trimmed);
          continue;
        }
        if (!entry || typeof entry.key !== 'string') {
          keep.push(trimmed);
          continue;
        }
        if (this.entries.has(entry.key)) {
          keep.push(trimmed);
          continue;
        }
        this.entries.set(entry.key, {
          key: entry.key,
          payload: entry.payload,
          attempts: 0,
          nextAt: this.now(),
          createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : this.now(),
        });
        moved += 1;
      }
      if (moved > 0) {
        this.persist();
        this.rewriteDead(keep);
        // Keys left the dead letter file, so the guard must be rebuilt lazily.
        this.deadKeyCache = undefined;
      }
      return moved;
    } catch (error) {
      this.deps.log?.debug?.('agemem: outbox requeueDead unavailable', error);
      return 0;
    }
  }

  private rewriteDead(lines: string[]): void {
    try {
      mkdirSync(dirname(this.deadPath), { recursive: true });
      const body = lines.join('\n');
      const temporary = `${this.deadPath}.${process.pid}.tmp`;
      writeFileSync(temporary, body === '' ? '' : `${body}\n`, 'utf8');
      renameSync(temporary, this.deadPath);
    } catch (error) {
      this.deps.log?.warn?.('agemem: outbox dead-letter rewrite failed', error);
    }
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = readFileSync(this.path, 'utf8');
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '') continue;
        try {
          const entry = JSON.parse(trimmed) as OutboxEntry;
          if (entry && typeof entry.key === 'string') this.entries.set(entry.key, entry);
        } catch {
          // A torn last line from a crash is expected; the rest stays usable.
        }
      }
    } catch {
      // Missing file means an empty outbox.
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const body = [...this.entries.values()].map((entry) => JSON.stringify(entry)).join('\n');
      const temporary = `${this.path}.${process.pid}.tmp`;
      writeFileSync(temporary, body === '' ? '' : `${body}\n`, 'utf8');
      renameSync(temporary, this.path);
    } catch (error) {
      this.deps.log?.warn?.('agemem: outbox persist failed', error);
    }
  }
}
