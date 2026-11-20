import { describe, expect, it } from 'vitest';
import { pageWindow } from '../Pager';

describe('pageWindow', () => {
  it('单页只出一个槽位', () => {
    expect(pageWindow(1, 1)).toEqual([1]);
  });

  it('非法页数不炸，按单页处理', () => {
    expect(pageWindow(1, 0)).toEqual([1]);
    expect(pageWindow(1, -3)).toEqual([1]);
    expect(pageWindow(1, Number.NaN)).toEqual([1]);
  });

  it('总页数 ≤7 全列，不出现省略号', () => {
    expect(pageWindow(4, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('首页段：1..5 … N', () => {
    expect(pageWindow(1, 8)).toEqual([1, 2, 3, 4, 5, '…', 8]);
    expect(pageWindow(4, 8)).toEqual([1, 2, 3, 4, 5, '…', 8]);
  });

  it('中间段：1 … c-1 c c+1 … N', () => {
    expect(pageWindow(5, 9)).toEqual([1, '…', 4, 5, 6, '…', 9]);
  });

  it('尾页段：1 … N-4..N', () => {
    expect(pageWindow(8, 8)).toEqual([1, '…', 4, 5, 6, 7, 8]);
    expect(pageWindow(9, 9)).toEqual([1, '…', 5, 6, 7, 8, 9]);
  });

  it('越界页码被夹到边界，不产生空窗口', () => {
    expect(pageWindow(0, 20)).toEqual(pageWindow(1, 20));
    expect(pageWindow(99, 20)).toEqual(pageWindow(20, 20));
  });

  it('任意页数下槽位数恒定在 2..7，且首尾必为 1 与 N', () => {
    for (const pages of [2, 7, 8, 13, 200]) {
      for (let page = 1; page <= pages; page += 1) {
        const slots = pageWindow(page, pages);
        expect(slots[0]).toBe(1);
        expect(slots[slots.length - 1]).toBe(pages);
        expect(slots.length).toBeGreaterThanOrEqual(2);
        expect(slots.length).toBeLessThanOrEqual(7);
        // 当前页一定在窗口里，否则用户看不到自己在哪
        expect(slots).toContain(page);
      }
    }
  });
});
