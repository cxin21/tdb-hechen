/**
 * health-utils 的 embedding 四态测试（#123）。
 *
 * 背景：网关对 embeddingConfigured=false（noop / 读不到 provider）也会把
 * embedding 置成 'degraded'，Panel 若只看 embedding 就会把「没配 embedder」
 * 一律显示成「向量召回降级（FTS 兜底中）」，运维会去查错误的根因。
 * 本测试锁四态优先级与回落：
 *   unconfigured（configured=false）优先于 degraded 优先于 ok；
 *   老网关缺字段 → configured=null、provider=null，按 embedding 原值回落，不臆断。
 * 零 import（health-utils 本身零依赖），node 环境可直接跑。
 */
import { describe, it, expect } from 'vitest';
import {
  buildMemoryHealthView,
  formatVectorCoverage,
  healthRingTone,
  type MemoryHealthInfo,
} from '../web/src/pages/ChatMemoryPage/utils/health-utils';

const base: Partial<MemoryHealthInfo> = {
  vectorCoverage: 0.8123,
  vecRows: 812,
  metaRows: 1000,
  degradedSince: '2026-10-30T10:00:00.000Z',
  lastVecWriteAt: '2026-10-31T09:00:00.000Z',
};

describe('buildMemoryHealthView embedding 四态', () => {
  it('configured=false → unconfigured（优先于 degraded，这是 #123 的核心）', () => {
    const view = buildMemoryHealthView({
      ...base,
      embedding: 'degraded',
      embeddingConfigured: false,
      embeddingProvider: 'noop',
    });
    expect(view.hasData).toBe(true);
    expect(view.embeddingState).toBe('unconfigured');
    expect(view.embeddingOk).toBe(false);
    expect(view.embeddingConfigured).toBe(false);
    expect(view.embeddingProvider).toBe('noop');
    // degraded 仍为 true：网关确实置了 degraded，两个信号都要能读到（文案层再做区分）
    expect(view.degraded).toBe(true);
  });

  it('configured=false 且 embedding=ok（畸形网关）也判 unconfigured', () => {
    const view = buildMemoryHealthView({
      ...base,
      embedding: 'ok',
      embeddingConfigured: false,
      embeddingProvider: 'noop',
    });
    expect(view.embeddingState).toBe('unconfigured');
    expect(view.embeddingOk).toBe(false);
  });

  it('缺 embeddingConfigured + provider=noop + degraded → degraded（老网关回落，不臆断为未配置）', () => {
    const view = buildMemoryHealthView({ ...base, embedding: 'degraded', embeddingProvider: 'noop' });
    expect(view.embeddingState).toBe('degraded');
    expect(view.embeddingConfigured).toBeNull();
    expect(view.embeddingProvider).toBe('noop');
    expect(view.embeddingOk).toBe(false);
  });

  it('configured=true + embedding=ok → ok，且 embeddingOk 才为 true', () => {
    const view = buildMemoryHealthView({
      ...base,
      embedding: 'ok',
      embeddingConfigured: true,
      embeddingProvider: 'local',
    });
    expect(view.embeddingState).toBe('ok');
    expect(view.embeddingOk).toBe(true);
    expect(view.degraded).toBe(false);
  });

  it('configured=true + embedding=degraded → degraded（配了但写不进去）', () => {
    const view = buildMemoryHealthView({
      ...base,
      embedding: 'degraded',
      embeddingConfigured: true,
      embeddingProvider: 'openai',
    });
    expect(view.embeddingState).toBe('degraded');
    expect(view.embeddingOk).toBe(false);
  });

  it('完全缺新增字段（老网关）→ configured/provider 都是 null，状态按 embedding 回落', () => {
    const view = buildMemoryHealthView({ ...base, embedding: 'ok' });
    expect(view.embeddingState).toBe('ok');
    expect(view.embeddingConfigured).toBeNull();
    expect(view.embeddingProvider).toBeNull();
  });

  it('没有 memory 子对象 / 字段不全 → unknown + hasData=false，不造默认值', () => {
    for (const missing of [undefined, null, {}, { vectorCoverage: 0.5 } as any]) {
      const view = buildMemoryHealthView(missing as any);
      expect(view).toMatchObject({
        hasData: false,
        degraded: false,
        coverageText: '',
        coveragePct: 0,
        embeddingOk: false,
        embeddingState: 'unknown',
        embeddingConfigured: null,
        embeddingProvider: null,
        degradedSince: null,
      });
    }
  });
});

describe('buildMemoryHealthView 覆盖率与降级时间透出', () => {
  it('覆盖率四舍五入成整数，文案与数值同源', () => {
    const view = buildMemoryHealthView({
      ...base,
      vectorCoverage: 0.8123,
      embedding: 'ok',
      embeddingConfigured: true,
    });
    expect(view.coverageText).toBe('81%');
    expect(view.coveragePct).toBe(81);
  });

  it('degradedSince 原样透出（缺省 null）', () => {
    expect(
      buildMemoryHealthView({ ...base, embedding: 'degraded', embeddingConfigured: true }).degradedSince,
    ).toBe('2026-10-30T10:00:00.000Z');
    expect(
      buildMemoryHealthView({ ...base, embedding: 'ok', degradedSince: undefined }).degradedSince,
    ).toBeNull();
  });

  it('formatVectorCoverage 边界：0 / 0.5 / 1', () => {
    expect(formatVectorCoverage(0)).toBe('0%');
    expect(formatVectorCoverage(0.5)).toBe('50%');
    expect(formatVectorCoverage(1)).toBe('100%');
  });
});

describe('healthRingTone 档位边界（U-C1：<70 红 / 70-90 黄 / >90 绿）', () => {
  it('69/70/90/91 分别落在 low/mid/mid/high', () => {
    expect(healthRingTone(69)).toBe('low');
    expect(healthRingTone(70)).toBe('mid');
    expect(healthRingTone(90)).toBe('mid');
    expect(healthRingTone(91)).toBe('high');
  });
});
