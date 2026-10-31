import { describe, expect, it } from 'vitest';
import {
  ENTRY_MAX_CHARS,
  SOUL_FEELING_CLOSE,
  SOUL_FEELING_OPEN,
  SOUL_IDENTITY_CLOSE,
  SOUL_IDENTITY_OPEN,
  VOLATILE_HEADER,
  clampBlockByLines,
  clipEntry,
  dedupeEntries,
  extractRelevantMemories,
  extractSoul,
  measureSoul,
  memoryLines,
  recallBlockText,
  renderMemoryBlock,
  renderSoulBlock,
} from '../src/recall-source.js';

const NL = String.fromCharCode(10);

describe('per-entry clipping and budget filling', () => {
  it('clips one entry to 360 chars with an ellipsis instead of dropping it whole', () => {
    const long = '- [L1][work_fact] ' + 'x'.repeat(700);
    const clipped = clipEntry(long);
    expect(ENTRY_MAX_CHARS).toBe(360);
    expect(clipped.length).toBe(360);
    expect(clipped.endsWith('…')).toBe(true);
    expect(clipped.startsWith('- [L1][work_fact] ')).toBe(true);
    expect(clipEntry('- [L1] short')).toBe('- [L1] short');
  });

  it('never splits a surrogate pair at the clip boundary', () => {
    const entry = '- ' + 'a'.repeat(357) + '😀' + 'b'.repeat(200);
    const clipped = clipEntry(entry, 360);
    expect(clipped.length).toBeLessThanOrEqual(360);
    expect(clipped.isWellFormed()).toBe(true);
    expect(clipped.endsWith('…')).toBe(true);
  });

  it('fits two measured entries into the shipped 1200 budget', () => {
    const first = '- [L1][work_fact] ' + 'a'.repeat(432);
    const second = '- [L1][episodic] ' + 'b'.repeat(436);
    const text = renderMemoryBlock([first, second], 1200);
    const lines = text.split(String.fromCharCode(10));
    expect(lines[0]).toBe(VOLATILE_HEADER);
    expect(lines).toHaveLength(3);
    expect(lines[1].length).toBe(360);
    expect(lines[2].length).toBe(360);
    expect(text.length).toBeLessThanOrEqual(1200);
  });

  it('drops the tail entry when the budget only fits two of three', () => {
    const entries = [1, 2, 3].map((n) => '- [L1] ' + String(n).repeat(350));
    const budget = VOLATILE_HEADER.length + 1 + 360 + 1 + 360;
    const text = renderMemoryBlock(entries, budget);
    expect(text.split(String.fromCharCode(10))).toHaveLength(3);
    expect(text).toContain('- [L1] 111');
    expect(text).not.toContain('- [L1] 333');
  });

  it('dedupes entries that only differ in their leading type markers', () => {
    const a = '- [work_fact] 偏好 pnpm workspace，不喜欢 npm install。';
    const b = '- [episodic] 偏好 pnpm workspace，不喜欢 npm install。';
    const c = '- [work_fact] 另一个完全不同的结论。';
    expect(dedupeEntries([a, b, c])).toEqual([a, c]);
  });
});

/**
 * Shapes below mirror the live /v3/recall block captured on 2026-11-01: soul
 * wrappers around a <relevant-memories> section whose first entries are the
 * same guidance text we already inject as the answer-guidance section.
 */

const BLOCK = [
  '<soul-identity>你是记忆助手</soul-identity>',
  '<soul-feeling>简洁</soul-feeling>',
  '<relevant-memories>',
  '【币值判定规则】',
  '- [L1][work_fact] 偏好 pnpm workspace。（热度 3）',
  '- [L1][work_fact] 结论先行。（热度 2）',
  '</relevant-memories>',
].join(String.fromCharCode(10));

/**
 * The soul fragments are a WINDOW into the distilled persona, not a copy of it:
 * the live core sends 3343-3388 chars of <soul-identity>, and everything the
 * old path did was keep the `- [` memory lines and drop the persona entirely.
 */
describe('soul fragments', () => {
  it('extracts both fragments and ignores anything outside the tags', () => {
    expect(extractSoul(BLOCK)).toEqual({ identity: '你是记忆助手', feeling: '简洁' });
    expect(extractSoul(undefined)).toEqual({});
    expect(extractSoul('no tags')).toEqual({});
    // Empty bodies are absent, not empty strings: an empty pair must never be injected.
    expect(extractSoul('<soul-identity>   </soul-identity>')).toEqual({});
    // An unclosed tag is not a fragment (fail open, never guess where it ends).
    expect(extractSoul('<soul-identity>未闭合</soul-identity')).toEqual({});
  });

  it('renders identity first, feeling second, inside its own tags', () => {
    const soul = renderSoulBlock({ identity: '何晨', feeling: '平静' }, { maxChars: 600 });
    expect(soul).toBe(
      SOUL_IDENTITY_OPEN + '何晨' + SOUL_IDENTITY_CLOSE + String.fromCharCode(10)
      + SOUL_FEELING_OPEN + '平静' + SOUL_FEELING_CLOSE,
    );
  });

  it('drops the feeling line when includeFeeling is false or it does not fit', () => {
    const disabled = renderSoulBlock({ identity: '何晨', feeling: '平静' }, { maxChars: 600, includeFeeling: false });
    expect(disabled).toBe(SOUL_IDENTITY_OPEN + '何晨' + SOUL_IDENTITY_CLOSE);
    expect(disabled).not.toContain('soul-feeling');
    // Identity alone, no feeling present: same shape.
    expect(renderSoulBlock({ identity: '何晨' }, { maxChars: 600 })).toBe(disabled);
  });

  it('returns nothing when the block carries no soul at all (atomic fallback)', () => {
    expect(renderSoulBlock({}, { maxChars: 600 })).toBe('');
    expect(renderSoulBlock({ identity: '   ' }, { maxChars: 600 })).toBe('');
    expect(renderSoulBlock({ identity: 'x' }, { maxChars: 0 })).toBe('');
  });

  it('clips a long identity to the budget without splitting a surrogate pair', () => {
    const identity = '身'.repeat(200) + '😀'.repeat(50);
    const soul = renderSoulBlock({ identity }, { maxChars: 300 });
    const inner = soul.slice(SOUL_IDENTITY_OPEN.length, soul.length - SOUL_IDENTITY_CLOSE.length);
    expect(soul.length).toBeLessThanOrEqual(300);
    expect(inner.endsWith('…')).toBe(true);
    expect(inner.isWellFormed()).toBe(true);
  });

  it('gives identity the budget and keeps feeling inside the same cap', () => {
    const identity = '身'.repeat(1000);
    const feeling = '情'.repeat(200);
    const soul = renderSoulBlock({ identity, feeling }, { maxChars: 200 });
    expect(soul.length).toBeLessThanOrEqual(200);
    expect(soul.startsWith(SOUL_IDENTITY_OPEN)).toBe(true);
    // Whatever comes after identity is the feeling pair, still inside the cap.
    if (soul.includes(SOUL_FEELING_OPEN)) {
      expect(soul.endsWith(SOUL_FEELING_CLOSE)).toBe(true);
      expect(soul.indexOf(SOUL_FEELING_OPEN)).toBeGreaterThan(soul.indexOf(SOUL_IDENTITY_CLOSE));
    }
  });

  it('measures the soul prefix of a composed block for cache-hit logging', () => {
    const soul = renderSoulBlock({ identity: '何晨', feeling: '平静' }, { maxChars: 600 });
    const block = soul + String.fromCharCode(10) + '【agemem 记忆提示】' + String.fromCharCode(10) + '- [L1] x';
    expect(measureSoul(block)).toBe(soul.length);
    expect(measureSoul('【agemem 记忆提示】' + String.fromCharCode(10) + '- [L1] x')).toBe(0);
    expect(measureSoul('')).toBe(0);
    // Identity-only block (feeling off) also measures correctly.
    const identityOnly = SOUL_IDENTITY_OPEN + '何晨' + SOUL_IDENTITY_CLOSE;
    expect(measureSoul(identityOnly + String.fromCharCode(10) + '- [L1] x')).toBe(identityOnly.length);
  });
});

describe('recall block -> volatile lines', () => {
  it('keeps only the "- [" entries inside <relevant-memories>', () => {
    const section = extractRelevantMemories(BLOCK);
    expect(section).toBeDefined();
    const lines = memoryLines(section);
    expect(lines).toEqual([
      '- [L1][work_fact] 偏好 pnpm workspace。（热度 3）',
      '- [L1][work_fact] 结论先行。（热度 2）',
    ]);
    // The duplicated guidance banner is dropped, not injected twice.
    expect(lines.join(String.fromCharCode(10))).not.toContain('币值判定规则');
  });

  it('renders the plugin header plus whole entries', () => {
    const text = recallBlockText(BLOCK, 1200);
    const lines = text.split(String.fromCharCode(10));
    expect(lines[0]).toBe(VOLATILE_HEADER);
    expect(lines.slice(1)).toEqual([
      '- [L1][work_fact] 偏好 pnpm workspace。（热度 3）',
      '- [L1][work_fact] 结论先行。（热度 2）',
    ]);
  });

  it('returns nothing when the section or its entries are missing', () => {
    expect(extractRelevantMemories(undefined)).toBeUndefined();
    expect(extractRelevantMemories('no tags here')).toBeUndefined();
    expect(extractRelevantMemories('<relevant-memories>only prose</relevant-memories>')).toBe(
      'only prose',
    );
    expect(memoryLines('only prose')).toEqual([]);
    expect(recallBlockText('only prose', 1200)).toBe('');
    expect(recallBlockText(undefined, 1200)).toBe('');
  });

  it('drops entries that do not fit instead of cutting the last one mid-text', () => {
    const first = '- [L1] ' + 'a'.repeat(40);
    const second = '- [L1] ' + 'b'.repeat(40);
    const block = '<relevant-memories>' + String.fromCharCode(10) + first
      + String.fromCharCode(10) + second + String.fromCharCode(10) + '</relevant-memories>';
    const budget = VOLATILE_HEADER.length + 1 + first.length;
    const text = recallBlockText(block, budget);
    expect(text).toBe(VOLATILE_HEADER + String.fromCharCode(10) + first);
    expect(text).not.toContain('bb');
  });

  it('clamps generic text at line boundaries and can return an empty block', () => {
    expect(clampBlockByLines('one', 100)).toBe('one');
    expect(clampBlockByLines('heading' + String.fromCharCode(10) + 'body', 8)).toBe('heading');
    // Nothing whole fits next to the heading -> keep just the heading.
    expect(clampBlockByLines('heading' + String.fromCharCode(10) + 'body', 7)).toBe('heading');
    expect(clampBlockByLines('', 10)).toBe('');
    expect(renderMemoryBlock([], 100)).toBe('');
    // The header alone already blows the budget: append nothing at all.
    expect(renderMemoryBlock(['- [L1] x'], 5)).toBe('');
  });
});
