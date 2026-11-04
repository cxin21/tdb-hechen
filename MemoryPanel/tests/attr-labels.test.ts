/**
 * 任务 C（2026-11-04）：属性字段译名单一事实源 `@/lib/attr-labels` 的锁。
 *
 * 为什么放 MemoryPanel/tests（不是 web）：web 只有 vite、没有测试运行器
 * （MemoryPanel/web/package.json 无 vitest 依赖、无 test 脚本），根包才有 vitest。
 * 根 vitest 的 alias `@` → MemoryPanel/web/src（vitest.config.ts:14），
 * 与 chat-memory-409-classifier.test.ts 直测 web 源码同一路径，故此处可直 import。
 *
 * 守三件事：
 *   1) 10 个登记字段的中文标签逐字固定（措辞漂移 = 红）；
 *   2) 未登记键回退原键（不抛、不吞、不造伪译名）；
 *   3) 红线：翻译只影响展示——AttributesSection 的「复制 JSON」必须保留原始字段名。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ATTR_LABELS, attrLabel } from '@/lib/attr-labels';

/** 定案映射（任务 C 原文，逐字钉住；改这里必须同步改任务合同）。 */
const EXPECTED: Record<string, string> = {
  importance: '重要度(1-10)',
  significance: '显著性(0-1)',
  valence: '情感效价',
  arousal: '唤醒度',
  certainty: '确定性',
  sensitivity: '敏感度',
  occurred_at: '事件时刻',
  valid_start: '生效起',
  valid_end: '生效止',
  source_message_ids: '原话溯源',
};

describe('attr-labels：属性译名单一事实源', () => {
  it('10 个登记字段的译名逐字固定', () => {
    for (const [key, label] of Object.entries(EXPECTED)) {
      expect(attrLabel(key), `字段 ${key} 的译名漂移了`).toBe(label);
    }
  });

  it('ATTR_LABELS 恰好登记 10 个字段（多登记=漂移源，少登记=漏译）', () => {
    expect(Object.keys(ATTR_LABELS).sort()).toEqual(Object.keys(EXPECTED).sort());
    expect(Object.keys(ATTR_LABELS)).toHaveLength(10);
  });

  it('未登记键回退原键（不抛错、不返回空）', () => {
    for (const key of ['id', 'version', 'importance_reason', '不是字段', '', 'with space']) {
      expect(attrLabel(key)).toBe(key);
    }
    expect(attrLabel('unregistered_field')).toBe('unregistered_field');
  });

  it('译名不与原键相同（否则等于没译，界面上仍是英文字段名）', () => {
    for (const [key, label] of Object.entries(ATTR_LABELS)) {
      expect(label).not.toBe(key);
    }
  });

  it('红线：AttributesSection 的「复制 JSON」不含译名（导出恒用原始字段名）', () => {
    const src = readFileSync(
      fileURLToPath(
        new URL(
          '../web/src/pages/ChatMemoryPage/components/block-detail/AttributesSection.tsx',
          import.meta.url,
        ),
      ),
      'utf8',
    );
    const start = src.indexOf('function handleCopy()');
    expect(start, 'handleCopy 不见了：复制 JSON 的原始字段名契约无从校验').toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf('\n  }\n', start));
    // 原始字段名仍在（证据不因译名改造而丢字段）
    expect(block).toContain('significance: item.significance');
    expect(block).toContain('importance: item.importance');
    expect(block).toContain('occurred_at: item.occurred_at');
    // 中文键不得写进 JSON
    expect(block).not.toContain('attrLabel(');
    for (const label of Object.values(ATTR_LABELS)) {
      expect(block).not.toContain(`${label}:`);
    }
  });
});
