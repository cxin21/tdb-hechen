/**
 * 心境注入（退役后回归）：人格渲染已移交插件（见 hooks/soul-assembler.ts 文件头），
 * buildSoulPrefix 只产出 <soul-feeling> 心境段。
 *
 * 原先这一例测的是「情绪改变人格条的层次序与预算」——那套 attention/budget 接线已随人格渲染
 * 一起退役（注意力/预算两类 meta 不再有写入方），
 * 所以这里改成等价断言：无 mood/state 时返回空串；有 mood 时只出 <soul-feeling>，
 * 不再出现人格段（## 我对自己 / ## 我和他的关系），也不再写任何 soul* meta。
 */
import { describe, expect, it } from 'vitest';
import { buildSoulPrefix } from '../../hooks/soul-assembler.js';
import type { SoulMoodState } from '../emotion.js';
import { resolveSoulConfig } from '../types.js';

const T = { teamId: 't-mood', userId: 'u-mood', agentId: 'a-mood' };
const NOW = '2026-11-06T12:00:00.000Z';

function mood(over: Partial<SoulMoodState>): SoulMoodState {
  return {
    valence: 0,
    arousal: 0.3,
    baselineValence: 0,
    baselineArousal: 0.3,
    updatedAt: NOW,
    sampleCount: 80,
    ...over,
  };
}

describe('心境注入（人格渲染退役后）', () => {
  it('无 mood/state → 空串；有 mood → 只出 <soul-feeling>（人格段与 meta 写回均已退役）', async () => {
    const store = {} as never;
    const opts = { soulMaintenance: resolveSoulConfig({}) };

    const empty = await buildSoulPrefix(store, T, undefined, opts);
    expect(empty).toBe('');

    const text = await buildSoulPrefix(
      store,
      T,
      undefined,
      {
        ...opts,
        soulMood: mood({
          valence: -0.3,
          arousal: 0.6,
          emotion: { object: '先取证再改', label: '愧疚', intensity: 0.6, at: NOW },
        }),
      },
    );
    expect(text).toContain('<soul-feeling>');
    expect(text.trimEnd().endsWith('</soul-feeling>')).toBe(true);
    // 人格段整体退役：卡由 card-service 出，这里一个字都不能再出。
    expect(text).not.toContain('## 我对自己');
    expect(text).not.toContain('## 我和他的关系');
    expect(text).not.toContain('## 我的底色');
    // 2026-11-07 task-12：元信息写回参数已删除，本函数只剩「返回文本」一种产出。
  });
});
