/**
 * neighbor-attrs —— 邻接记忆的属性摘要（P2，2026-11-04）。
 *
 * 为什么单独成文件：内核 /v3/atomic/neighbors 一直返回 occurred_at、valid_start/end、
 * certainty、valence、arousal、significance（MemoryCore/src/gateway/v2-router.ts
 * handleAtomicNeighbors），而面板只画 type/content/strength ⇒ 邻接属性被静默丢弃。
 * 摘要规则与 React 组件分离，才能在无 DOM/localStorage 的 node 测试环境里直接断言
 * （组件模块会连带 chatMemoryApi → i18n → localStorage）。
 *
 * 只做展示：不改写入、不补默认值；没有值的属性不占位。
 */
import { attrLabel } from '@/lib/attr-labels';

/** 与内核出参字段逐字对齐（可空者全部标 ?）。 */
export type Neighbor = {
  id: string;
  type: string;
  strength?: number;
  hop?: number;
  content?: string;
  occurred_at?: string;
  valid_start?: string;
  valid_end?: string;
  certainty?: string;
  valence?: number;
  arousal?: number;
  significance?: number;
};

/** 邻居属性 chips：显著性 → 确定性 → 有效期 → 事件时刻（空数组 = 该邻居无属性可显示）。 */
export function neighborAttrChips(n: Neighbor): string[] {
  const chips: string[] = [];
  if (typeof n.significance === 'number') {
    chips.push(attrLabel('significance') + ' ' + n.significance.toFixed(2));
  }
  if (n.certainty === 'inferred') chips.push(attrLabel('certainty') + ' 推断');
  else if (n.certainty === 'observed') chips.push(attrLabel('certainty') + ' 实见');
  if (n.valid_end) {
    // 软失效语义：过期不等于被排除，只降权（validity-policy soft），故写「已过期」而非「已删除」。
    chips.push(
      Date.parse(n.valid_end) <= Date.now()
        ? attrLabel('valid_end') + ' 已过期'
        : attrLabel('valid_end') + ' ' + n.valid_end.slice(0, 10),
    );
  }
  if (n.occurred_at) chips.push(attrLabel('occurred_at') + ' ' + n.occurred_at.slice(0, 10));
  return chips;
}
