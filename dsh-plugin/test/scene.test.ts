import { describe, expect, it } from 'vitest';

import { SCENE_LINES, computeScene, formatSceneLine } from '../src/scene.js';

/**
 * 阶段 4 / P4-A：场合氛围的纯函数判据。
 *
 * 五条都钉「可复算」：同一输入永远同一输出、三档话术 ≤60 字、空输入不表态、
 * 节奏（离上一条多久）确实改变档位、长交付确实被识别成「收」。
 */

describe('computeScene', () => {
  it('长交付（多段 + 代码块 + 礼貌词）→ 收', () => {
    const text = [
      '麻烦您看一下这个发布流程，我这边已经跑了三轮门禁，结果如下：',
      '',
      '## 门禁结果',
      '- typecheck Δ=-28 PASS',
      '- 全量测试 3966 passed',
      '',
      '```bash',
      'node scripts/typecheck-gate.mjs',
      '```',
      '',
      '请确认是否可以全量推开，谢谢。',
    ].join('\n');
    const r = computeScene({ lastUserText: text, recentUserTexts: [text], gapMs: 5_000 });
    expect(r.tone).toBe('收');
    expect(r.line).toBe(SCENE_LINES['收']);
  });

  it('短闲聊（短句 + emoji）→ 松', () => {
    const r = computeScene({ lastUserText: '在吗 😄', recentUserTexts: ['吃了吗', '在吗 😄'], gapMs: 30_000 });
    expect(r.tone).toBe('松');
    expect(r.line).toBe(SCENE_LINES['松']);
  });

  it('三档话术都 ≤60 字，注入行只多一个前缀', () => {
    for (const tone of ['松', '常', '收'] as const) {
      expect(SCENE_LINES[tone].length).toBeLessThanOrEqual(60);
      expect(formatSceneLine({ tone, line: SCENE_LINES[tone], signals: {} })).toBe('场合：' + SCENE_LINES[tone]);
    }
  });

  it('节奏影响档位：同样一句话，1 分钟内 vs 1 小时后', () => {
    // 这句话的基础分刻意落在两档之间（≈0.36），节奏权重 0.15 × 0.6 = 0.09 才够跨档。
    const text = '麻烦你看下这句，刚好。';
    const fast = computeScene({ lastUserText: text, recentUserTexts: [text], gapMs: 40_000 });
    const slow = computeScene({ lastUserText: text, recentUserTexts: [text], gapMs: 7_200_000 });
    expect(fast.signals.rhythm).toBe(0.2);
    expect(slow.signals.rhythm).toBe(0.8);
    expect(slow.signals.score! - fast.signals.score!).toBeCloseTo(0.09, 6);
    expect(slow.tone).not.toBe(fast.tone);
  });

  it('空输入 → 常（拿不到话时不收紧也不放松）', () => {
    const r = computeScene({ lastUserText: '   ', recentUserTexts: [] });
    expect(r.tone).toBe('常');
    expect(r.line).toBe(SCENE_LINES['常']);
  });
});