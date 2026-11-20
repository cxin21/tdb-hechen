import { describe, expect, it } from 'vitest';
import { proofSummary, unattributedRows } from '../soul-injection-summary';

describe('unattributedRows', () => {
  it('非零桶按固定顺序列出，0 与缺键都不出现', () => {
    const rows = unattributedRows({ other: 12, sectionRead: 5, noCard: 0, noSession: undefined });
    expect(rows).toEqual([
      { key: 'sectionRead', count: 5 },
      { key: 'other', count: 12 },
    ]);
  });

  it('全零或缺段返回空数组（调用方据此整段不渲染，不拿 0 冒充「没发生」）', () => {
    expect(unattributedRows({ sectionRead: 0, other: 0 })).toEqual([]);
    expect(unattributedRows(undefined)).toEqual([]);
    expect(unattributedRows(null)).toEqual([]);
  });

  it('NaN/负数不进列表（上游脏值不当成计数）', () => {
    expect(unattributedRows({ sectionRead: Number.NaN, other: -3, cleared: 2 })).toEqual([
      { key: 'cleared', count: 2 },
    ]);
  });
});

describe('proofSummary', () => {
  it('分母为 0 但段读行 > 0：hostPending（宿主未上报整卡 hash，不是「匹配失败」）', () => {
    expect(
      proofSummary({ sectionReadCount: 8, textHashMatched: 0, sessionsWithProof: 0, sectionCardHashCount: 0 }),
    ).toEqual({ sectionReadCount: 8, sectionCardHashCount: 0, matched: 0, hostPending: true });
  });

  it('有分母时照实给命中数，hostPending=false', () => {
    expect(
      proofSummary({ sectionReadCount: 8, textHashMatched: 3, sessionsWithProof: 5, sectionCardHashCount: 7 }),
    ).toEqual({ sectionReadCount: 8, sectionCardHashCount: 7, matched: 5, hostPending: false });
  });

  it('全零或缺段返回 null（不渲染对账行）', () => {
    expect(proofSummary({ sectionReadCount: 0, sectionCardHashCount: 0, sessionsWithProof: 0 })).toBeNull();
    expect(proofSummary(undefined)).toBeNull();
  });
});
