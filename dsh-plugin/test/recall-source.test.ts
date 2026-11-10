import { describe, expect, it } from 'vitest';
import {
  ENTRY_MAX_CHARS,
  VOLATILE_HEADER,
  clampBlockByLines,
  clipEntry,
  dedupeEntries,
  extractRelevantMemories,
  memoryLines,
  recallBlockText,
  renderMemoryBlock,
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
 * Shapes below mirror the live /v3/recall block: a <relevant-memories> section
 * whose first entries are the same guidance text we already inject as the
 * answer-guidance section.
 */

const BLOCK = [
  '<relevant-memories>',
  '【币值判定规则】',
  '- [L1][work_fact] 偏好 pnpm workspace。（热度 3）',
  '- [L1][work_fact] 结论先行。（热度 2）',
  '</relevant-memories>',
].join(String.fromCharCode(10));

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

