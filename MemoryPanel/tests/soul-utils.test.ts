/**
 * U-A1（DS-PANEL-UI-VISUAL-001 §2 S2 / 计划批 1）：灵魂区纯函数 soul-utils 测试。
 *
 * 覆盖 buildSoulView（L1 条目级 soul 数据 → 视图模型）与其依赖的纯函数：
 *   - valence 百分比/极性（-1..1 → 0..100，负红左/正绿右）
 *   - arousal/significance 归一（0..1 → 0..100 进度条）
 *   - coreRefs / recall_count 宽松解析（宁缺毋滥：损坏/缺失一律空态，不造假值）
 *   - 时间格式化（本地时区 YYYY-MM-DD HH:mm；不可解析返 null）
 *
 * soul-utils 必须零 import（照 anchor-utils 先例，根 vitest node 环境直接单测）。
 */
import { describe, it, expect } from 'vitest';
import {
  buildSoulView,
  buildSoulCardView,
  valencePercent,
  valencePolarityOf,
  ratio01Percent,
  formatSoulTime,
} from '../web/src/pages/ChatMemoryPage/components/block-detail/soul-utils';

describe('valencePercent', () => {
  it('-1..1 线性映射到 0..100', () => {
    expect(valencePercent(-1)).toBe(0);
    expect(valencePercent(0)).toBe(50);
    expect(valencePercent(1)).toBe(100);
    expect(valencePercent(0.8)).toBe(90);
  });
  it('越界 clamp；非有限数 → null（不造假值）', () => {
    expect(valencePercent(1.5)).toBe(100);
    expect(valencePercent(-2)).toBe(0);
    expect(valencePercent(null)).toBeNull();
    expect(valencePercent(undefined)).toBeNull();
    expect(valencePercent('x')).toBeNull();
    expect(valencePercent(NaN)).toBeNull();
  });
});

describe('valencePolarityOf', () => {
  it('负/零/正三极；非有限数 → null', () => {
    expect(valencePolarityOf(-0.3)).toBe('negative');
    expect(valencePolarityOf(0)).toBe('neutral');
    expect(valencePolarityOf(0.8)).toBe('positive');
    expect(valencePolarityOf('x')).toBeNull();
    expect(valencePolarityOf(undefined)).toBeNull();
  });
});

describe('ratio01Percent', () => {
  it('0..1 → 0..100；越界 clamp；非有限数 → null', () => {
    expect(ratio01Percent(0)).toBe(0);
    expect(ratio01Percent(0.9)).toBe(90);
    expect(ratio01Percent(1)).toBe(100);
    expect(ratio01Percent(1.2)).toBe(100);
    expect(ratio01Percent(-0.1)).toBe(0);
    expect(ratio01Percent('x')).toBeNull();
    expect(ratio01Percent(undefined)).toBeNull();
  });
});

describe('formatSoulTime', () => {
  it('ISO → 本地 YYYY-MM-DD HH:mm', () => {
    const iso = new Date(2026, 8, 10, 14, 30).toISOString(); // 本地 2026-09-10 14:30
    expect(formatSoulTime(iso)).toBe('2026-09-10 14:30');
  });
  it('不可解析/缺失 → null', () => {
    expect(formatSoulTime('not-a-date')).toBeNull();
    expect(formatSoulTime('')).toBeNull();
    expect(formatSoulTime(undefined)).toBeNull();
    expect(formatSoulTime(123 as unknown as string)).toBeNull();
  });
});

describe('buildSoulView', () => {
  it('完整 soul 条目：全字段解析（灵魂 8 字段 + metadata）', () => {
    const view = buildSoulView({
      occurred_at: '2026-09-10T06:30:00Z',
      valid_start: '2026-09-01T00:00:00Z',
      valid_end: '2026-10-01T00:00:00Z',
      certainty: 'inferred',
      source: 'distill',
      valence: 0.8,
      arousal: 0.5,
      significance: 0.9,
      metadata: {
        coreRefs: ['正确', '私有部署', ''],
        recall_count: 3,
        last_recalled_at: '2026-09-09T00:00:00Z',
      },
    });
    expect(view.hasSoul).toBe(true);
    expect(view.occurredText).not.toBeNull();
    expect(view.validityText).not.toBeNull();
    expect(view.valence).toBe(0.8);
    expect(view.valencePct).toBe(90);
    expect(view.valencePolarity).toBe('positive');
    expect(view.arousalPct).toBe(50);
    expect(view.significancePct).toBe(90);
    expect(view.certaintyKind).toBe('inferred');
    expect(view.certaintyLabel).toBe('推断');
    expect(view.source).toBe('distill');
    expect(view.coreRefs).toEqual(['正确', '私有部署']);
    expect(view.recallCount).toBe(3);
    expect(view.lastRecalledText).not.toBeNull();
  });

  it('空/缺省条目：hasSoul=false，各字段空态（宁缺毋滥）', () => {
    const view = buildSoulView(undefined);
    expect(view.hasSoul).toBe(false);
    expect(view.valencePct).toBeNull();
    expect(view.coreRefs).toEqual([]);
    expect(view.recallCount).toBeNull();
    const empty = buildSoulView({});
    expect(empty.hasSoul).toBe(false);
  });

  it('损坏值不造假：valence/强度非有限数 → null；未知 certainty 沿用既有 UI 语义显示实见', () => {
    const view = buildSoulView({
      valence: 'bad',
      arousal: NaN,
      significance: 2,
      certainty: 'weird',
    });
    expect(view.valencePct).toBeNull();
    expect(view.arousalPct).toBeNull();
    // significance 越界值仍可 clamp 成有效百分比（有穷数字即可信）
    expect(view.significancePct).toBe(100);
    // 既有 AtomicHead 行为：非 inferred 的非空 certainty 一律按实见徽章显示（行为不变）
    expect(view.certaintyKind).toBe('observed');
    expect(view.certaintyLabel).toBe('实见');
    expect(view.hasSoul).toBe(true); // 有 significance/certainty 原始值在场
  });

  it('metadata 缺失/损坏 → coreRefs []、recall null（前向兼容网关不返回 metadata）', () => {
    expect(buildSoulView({ valence: 0.1 }).coreRefs).toEqual([]);
    expect(buildSoulView({ metadata: { coreRefs: 'bad' } }).coreRefs).toEqual([]);
    expect(buildSoulView({ metadata: { recall_count: 'x' } }).recallCount).toBeNull();
  });

  it('仅 valid_start 无 end：validityText 只显示起点', () => {
    const view = buildSoulView({ valid_start: '2026-09-01T00:00:00Z' });
    expect(view.validityText).not.toBeNull();
    expect(view.validityText).not.toContain('~');
  });
});

describe('buildSoulCardView（U-A2 卡片摘要变体；批 2 图详情卡复用）', () => {
  it('完整条目：valence 文本带符号、chips 截前 3 个并给总数、recall/significance 文本', () => {
    const card = buildSoulCardView({
      valence: 0.8,
      significance: 0.9,
      metadata: { coreRefs: ['正确', '私有部署', '可靠性', '安全'], recall_count: 3 },
    });
    expect(card.hasCard).toBe(true);
    expect(card.valenceText).toBe('+0.8');
    expect(card.valencePolarity).toBe('positive');
    expect(card.coreRefs).toEqual(['正确', '私有部署', '可靠性']);
    expect(card.coreRefCount).toBe(4);
    expect(card.recallText).toBe('回忆 3 次');
    expect(card.significanceText).toBe('0.90');
  });

  it('负 valence 带负号；零显示 0.0；无效值 → null 文本', () => {
    expect(buildSoulCardView({ valence: -0.3 }).valenceText).toBe('-0.3');
    expect(buildSoulCardView({ valence: 0 }).valenceText).toBe('0.0');
    expect(buildSoulCardView({ valence: 'x' }).valenceText).toBeNull();
    expect(buildSoulCardView({ valence: 'x' }).valencePolarity).toBeNull();
  });

  it('空/无灵魂字段：hasCard=false，全部空态（宁缺毋滥）', () => {
    const card = buildSoulCardView(undefined);
    expect(card.hasCard).toBe(false);
    expect(card.coreRefs).toEqual([]);
    expect(card.recallText).toBeNull();
    expect(card.significanceText).toBeNull();
    expect(buildSoulCardView({}).hasCard).toBe(false);
  });
});
