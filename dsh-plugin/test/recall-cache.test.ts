import { describe, expect, it, vi } from 'vitest';
import {
  RECALL_CACHE_TTL_MS,
  RECALL_INFLIGHT_MAX_ENTRIES,
  RecallCache,
  RecallInflight,
  normalizeRecallText,
  recallKey,
} from '../src/recall-cache.js';

describe('normalizeRecallText', () => {
  it('collapses whitespace and trims so the same question keys the same way', () => {
    expect(normalizeRecallText('  pnpm   用什么? ')).toBe('pnpm 用什么?');
    expect(normalizeRecallText('a\nb')).toBe('a b');
  });

  it('keeps only the head of a long question (a stable, cheap key)', () => {
    const text = normalizeRecallText('x'.repeat(500));
    expect(text).toHaveLength(200);
  });
});

describe('recallKey', () => {
  it('prefers the numeric turn: one turn is one key, whatever the text', () => {
    expect(recallKey('s1', 3, 'anything')).toBe('s1\u0000turn:3');
    expect(recallKey('s1', '3', 'other')).toBe(recallKey('s1', 3, 'x'));
  });

  it('falls back to the normalized text when the host gives no turn', () => {
    expect(recallKey('s1', undefined, 'pnpm   用什么?')).toBe(recallKey('s1', undefined, 'pnpm 用什么?'));
    expect(recallKey('s1', undefined, 'asked A')).not.toBe(recallKey('s1', undefined, 'asked B'));
    expect(recallKey('s1', undefined, 'q')).not.toBe(recallKey('s2', undefined, 'q'));
  });
});

describe('RecallCache', () => {
  it('serves a cached block until the TTL expires', () => {
    let now = 1000;
    const cache = new RecallCache(100, 10, () => now);
    cache.set('k', 'block');
    expect(cache.get('k')).toBe('block');
    now += 101;
    expect(cache.get('k')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('never stores an empty block (a degraded result must not be frozen)', () => {
    const cache = new RecallCache();
    cache.set('k', '');
    expect(cache.get('k')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('evicts the least recently used entry past the cap', () => {
    const cache = new RecallCache(RECALL_CACHE_TTL_MS, 2);
    cache.set('a', 'A');
    cache.set('b', 'B');
    expect(cache.get('a')).toBe('A'); // a is now the most recent
    cache.set('c', 'C');
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe('A');
    expect(cache.get('c')).toBe('C');
  });
});

describe('RecallInflight', () => {
  it('reuses the one request allowed per key (prefetch + pre-step share it)', async () => {
    const inflight = new RecallInflight<string>();
    const start = vi.fn(async () => 'block');
    const first = inflight.take('k', start);
    const second = inflight.take('k', start);
    expect(second).toBe(first);
    await expect(first).resolves.toBe('block');
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('releases a key once settled, so a later turn fetches again', async () => {
    const inflight = new RecallInflight<string>();
    await inflight.take('k', async () => 'block');
    expect(inflight.size).toBe(0);
    const start = vi.fn(async () => 'again');
    await expect(inflight.take('k', start)).resolves.toBe('again');
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('does not keep a failed request around', async () => {
    const inflight = new RecallInflight<string>();
    await expect(inflight.take('k', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(inflight.size).toBe(0);
    await expect(inflight.take('k', async () => 'ok')).resolves.toBe('ok');
  });

  it('forgets a key on demand and bounds the map', async () => {
    const inflight = new RecallInflight<string>(RECALL_INFLIGHT_MAX_ENTRIES);
    const pending = inflight.take('k', () => new Promise<string>(() => {}));
    expect(inflight.peek('k')).toBe(pending);
    inflight.forget('k');
    expect(inflight.peek('k')).toBeUndefined();
  });
});
