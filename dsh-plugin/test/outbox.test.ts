import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Outbox } from '../src/outbox.js';

const dirs: string[] = [];

function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agemem-outbox-'));
  dirs.push(dir);
  return join(dir, 'outbox.jsonl');
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeOutbox(overrides: Partial<{
  maxAttempts: number;
  retryMs: number;
  maxBackoffMs: number;
  maxEntries: number;
  maxBytes: number;
  deliver: (entry: any) => Promise<any>;
  path: string;
  deadPath: string;
}> = {}) {
  let clock = 1_000_000;
  const deliver = overrides.deliver ?? vi.fn(async () => true);
  const logs: string[] = [];
  const outbox = new Outbox({
    path: overrides.path ?? tempPath(),
    deadPath: overrides.deadPath,
    deliver,
    maxAttempts: overrides.maxAttempts ?? 3,
    retryMs: overrides.retryMs ?? 1000,
    maxBackoffMs: overrides.maxBackoffMs,
    maxEntries: overrides.maxEntries,
    maxBytes: overrides.maxBytes,
    now: () => clock,
    log: {
      debug: (...parts: unknown[]) => logs.push('debug ' + parts.map(String).join(' ')),
      warn: (...parts: unknown[]) => logs.push('warn ' + parts.map(String).join(' ')),
    },
  });
  return { outbox, deliver, logs, advance: (ms: number) => { clock += ms; } };
}

describe('outbox', () => {
  it('dedupes by key so a retried turn is never queued twice', () => {
    const { outbox } = makeOutbox();
    outbox.enqueue('t1', { turnId: 't1' });
    outbox.enqueue('t1', { turnId: 't1' });
    expect(outbox.pendingCount()).toBe(1);
    expect(outbox.has('t1')).toBe(true);
  });

  it('drops an entry after a successful delivery', async () => {
    const { outbox } = makeOutbox();
    outbox.enqueue('t1', { turnId: 't1' });
    await outbox.flush();
    expect(outbox.pendingCount()).toBe(0);
  });

  it('keeps a failed entry and backs off before the next attempt', async () => {
    const deliver = vi.fn(async () => false);
    const { outbox, advance } = makeOutbox({ deliver, maxAttempts: 5 });
    outbox.enqueue('t1', { turnId: 't1' });

    await outbox.flush();
    expect(outbox.pendingCount()).toBe(1);
    expect(deliver).toHaveBeenCalledTimes(1);

    // Not due yet (nextAt = now + retryMs * attempts).
    await outbox.flush();
    expect(deliver).toHaveBeenCalledTimes(1);

    advance(1000);
    await outbox.flush();
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it('caps the retry backoff at maxBackoffMs so it never grows unbounded', async () => {
    const deliver = vi.fn(async () => false);
    const { outbox, advance } = makeOutbox({ deliver, maxAttempts: 10, retryMs: 1_000_000 });
    outbox.enqueue('t1', { turnId: 't1' });

    await outbox.flush();
    expect(deliver).toHaveBeenCalledTimes(1);

    // retryMs * attempt 已远超 5 分钟上限：提前 1ms 不该到期。
    advance(299_999);
    await outbox.flush();
    expect(deliver).toHaveBeenCalledTimes(1);

    advance(1);
    await outbox.flush();
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it('moves an entry into the dead-letter file once maxAttempts is reached (never drops it)', async () => {
    const path = tempPath();
    const deliver = vi.fn(async () => ({ ok: false, reason: 'http 500', status: 500 }));
    const { outbox, logs, advance } = makeOutbox({ deliver, maxAttempts: 2, path });
    outbox.enqueue('t1', { turnId: 't1' });

    await outbox.flush();
    advance(10_000);
    await outbox.flush();

    expect(outbox.pendingCount()).toBe(0);
    expect(outbox.deadCount()).toBe(1);
    expect(outbox.deadFilePath).toBe(join(path, '..', 'outbox.dead.jsonl'));

    const raw = readFileSync(outbox.deadFilePath, 'utf8').trim();
    const lines = raw.split('\n');
    expect(lines).toHaveLength(1);
    const dead = JSON.parse(lines[0]);
    expect(dead).toMatchObject({
      key: 't1',
      attempts: 2,
      reason: {
        reasonClass: 'attempts-exhausted',
        status: 500,
        attempt: 2,
        message: 'http 500',
      },
      payload: { turnId: 't1' },
    });
    expect(typeof dead.deadAt).toBe('number');
    expect(dead.reason.reasonClass).toBe('attempts-exhausted');
    // The warn line is operator-facing: class + endpoint, never the key or the text.
    const warn = logs.find((line) => line.includes('dead letter'));
    expect(warn).toBeDefined();
    expect(warn).toContain('class=attempts-exhausted');
    expect(warn).toContain('dead=');
    expect(warn).not.toContain('t1');
  });

  it('dead-letters a non-retryable outcome on the first attempt instead of replaying it', async () => {
    const path = tempPath();
    // e.g. the L2 skill feed: an HTTP response may already have mutated the
    // server buffer, so a replay would double-count the turn.
    const deliver = vi.fn(async () => ({
      ok: false,
      status: 503,
      retryable: false,
      reasonClass: 'skill-feed-no-retry-on-response',
      endpoint: '/v3/skill/conversation/add',
      messageLen: 42,
    }));
    const { outbox, logs } = makeOutbox({ deliver, maxAttempts: 5, path });
    outbox.enqueue('s1:turn:1:skill', { kind: 'skill' });

    await outbox.flush();

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(outbox.pendingCount()).toBe(0);
    expect(outbox.deadCount()).toBe(1);
    const dead = JSON.parse(readFileSync(outbox.deadFilePath, 'utf8').trim());
    expect(dead.attempts).toBe(1);
    expect(dead.reason).toMatchObject({
      reasonClass: 'skill-feed-no-retry-on-response',
      endpoint: '/v3/skill/conversation/add',
      status: 503,
      messageLen: 42,
      attempt: 1,
    });
    expect(logs.some((line) => line.includes('class=skill-feed-no-retry-on-response'))).toBe(true);
  });

  it('keeps an already dead-lettered key out of the queue (no silent replay)', async () => {
    const path = tempPath();
    const deliver = vi.fn(async () => ({ ok: false, status: 401, retryable: false, reasonClass: 'auth' }));
    const first = makeOutbox({ deliver, maxAttempts: 5, path }).outbox;
    first.enqueue('s1:turn:1:skill', { kind: 'skill' });
    await first.flush();
    expect(first.deadCount()).toBe(1);

    // A restarted process sees the same key again: it must not re-queue (a
    // second skill POST would double-count the L2 buffer).
    const deliverAgain = vi.fn(async () => true);
    const second = makeOutbox({ deliver: deliverAgain, maxAttempts: 5, path }).outbox;
    second.enqueue('s1:turn:1:skill', { kind: 'skill' });
    expect(second.pendingCount()).toBe(0);
    await second.flush();
    expect(deliverAgain).not.toHaveBeenCalled();

    // …but an explicit operator requeue still works.
    expect(second.requeueDead()).toBe(1);
    expect(second.pendingCount()).toBe(1);
  });

  it('requeues dead letters back into the pending queue', async () => {
    const path = tempPath();
    const deliver = vi.fn(async () => false);
    const first = makeOutbox({ deliver, maxAttempts: 2, path });
    first.outbox.enqueue('t1', { turnId: 't1' });
    await first.outbox.flush();
    first.advance(10_000);
    await first.outbox.flush();
    expect(first.outbox.deadCount()).toBe(1);

    expect(first.outbox.requeueDead()).toBe(1);
    expect(first.outbox.pendingCount()).toBe(1);
    expect(first.outbox.has('t1')).toBe(true);
    expect(first.outbox.deadCount()).toBe(0);

    // 重启后主队列仍带得走这条回灌的 entry。
    const ok = vi.fn(async () => true);
    const second = new Outbox({ path, deliver: ok, maxAttempts: 3, retryMs: 1000 });
    expect(second.has('t1')).toBe(true);
    await second.flush();
    expect(second.pendingCount()).toBe(0);
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it('survives a restart by reloading the JSONL file', async () => {
    const path = tempPath();
    const first = makeOutbox({ path, deliver: vi.fn(async () => false) });
    first.outbox.enqueue('t1', { turnId: 't1' });
    await first.outbox.flush();
    expect(readFileSync(path, 'utf8')).toContain('"t1"');

    const deliver = vi.fn(async () => true);
    const second = new Outbox({ path, deliver, maxAttempts: 3, retryMs: 1000 });
    expect(second.has('t1')).toBe(true);
    await second.flush();
    expect(second.pendingCount()).toBe(0);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('treats a torn line as empty instead of throwing', () => {
    const path = tempPath();
    const first = makeOutbox({ path });
    first.outbox.enqueue('t1', { turnId: 't1' });
    const outbox = new Outbox({ path, deliver: async () => true, maxAttempts: 2, retryMs: 1000 });
    expect(outbox.pendingCount()).toBe(1);
  });

  it('drops the OLDEST queued turn once maxEntries is exceeded, warning once', () => {
    const { outbox, logs, advance } = makeOutbox({ maxEntries: 3 });
    for (const key of ['t1', 't2', 't3', 't4', 't5']) {
      outbox.enqueue(key, { turnId: key });
      advance(10);
    }

    // A profile that cannot reach the core must not grow the JSONL forever.
    expect(outbox.pendingCount()).toBe(3);
    expect(outbox.has('t1')).toBe(false);
    expect(outbox.has('t5')).toBe(true);
    expect(outbox.droppedCount()).toBe(2);

    const warnings = logs.filter((line) => line.startsWith('warn') && line.includes('over capacity'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('maxOutboxEntries');
    expect(readFileSync(outbox.filePath, 'utf8')).not.toContain('"t1"');
  });

  it('drops the oldest turn when the queue would exceed maxOutboxBytes', () => {
    const { outbox, advance } = makeOutbox({ maxBytes: 6000 });
    for (const key of ['t1', 't2', 't3', 't4', 't5']) {
      outbox.enqueue(key, { turnId: key, text: 'x'.repeat(2000) });
      advance(10);
    }

    // Byte maths uses the real serialized row, not the character count.
    expect(outbox.has('t5')).toBe(true);
    expect(outbox.has('t1')).toBe(false);
    const bytes = Buffer.byteLength(readFileSync(outbox.filePath, 'utf8'), 'utf8');
    expect(bytes).toBeLessThanOrEqual(6000);
  });

  it('keeps the newest row even when that single turn alone exceeds maxOutboxBytes', () => {
    const { outbox } = makeOutbox({ maxBytes: 500 });
    outbox.enqueue('big', { turnId: 'big', text: 'y'.repeat(5000) });

    // Dropping the row we are writing right now would silently lose the turn.
    expect(outbox.pendingCount()).toBe(1);
    expect(outbox.has('big')).toBe(true);
  });

  it('never trims the dead-letter file when the queue drops turns over capacity', async () => {
    const path = tempPath();
    const dead = vi.fn(async () => ({ ok: false, retryable: false, reasonClass: 'auth', status: 401 }));
    const { outbox, advance } = makeOutbox({ deliver: dead, maxEntries: 2, path });
    outbox.enqueue('skill-1', { kind: 'skill' });
    await outbox.flush();
    expect(outbox.deadCount()).toBe(1);

    for (const key of ['a', 'b', 'c', 'd']) {
      outbox.enqueue(key, { turnId: key });
      advance(10);
    }

    expect(outbox.pendingCount()).toBe(2);
    expect(outbox.deadCount()).toBe(1);
  });

  it('flushes every due entry in one pass', async () => {
    const deliver = vi.fn(async () => true);
    const { outbox } = makeOutbox({ deliver });
    outbox.enqueue('t1', { turnId: 't1' });
    outbox.enqueue('t2', { turnId: 't2' });
    await outbox.flush();
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(outbox.pendingCount()).toBe(0);
  });
});
