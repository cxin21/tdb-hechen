import { describe, expect, it } from 'vitest';
import { makeDust } from '../dust';

describe('makeDust（背景星尘）', () => {
  it('返回 [x, y, alpha] 三元组，长度是点数的三倍', () => {
    const d = makeDust(400, 300);
    expect(d.length % 3).toBe(0);
    expect(d.length / 3).toBe(Math.max(160, Math.round((400 * 300) / 2600)));
  });

  it('同一尺寸永远是同一张底图（逐帧重随机会让整屏闪）', () => {
    const a = makeDust(1280, 720);
    const b = makeDust(1280, 720);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('不同尺寸给出不同分布', () => {
    const a = makeDust(1280, 720);
    const b = makeDust(1281, 720);
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it('所有点落在画布内，alpha 在 0.05–0.20', () => {
    const w = 900;
    const h = 500;
    const d = makeDust(w, h);
    for (let i = 0; i < d.length; i += 3) {
      expect(d[i]).toBeGreaterThanOrEqual(0);
      expect(d[i]).toBeLessThan(w);
      expect(d[i + 1]).toBeGreaterThanOrEqual(0);
      expect(d[i + 1]).toBeLessThan(h);
      expect(d[i + 2]).toBeGreaterThanOrEqual(0.05);
      expect(d[i + 2]).toBeLessThanOrEqual(0.2);
    }
  });

  it('density 只放大点数，不改变分布规则', () => {
    const w = 2000;
    const h = 1200;
    const base = makeDust(w, h);
    const dense = makeDust(w, h, 1.8);
    expect(base.length / 3).toBe(Math.round((w * h) / 2600));
    expect(dense.length / 3).toBe(Math.round((w * h * 1.8) / 2600));
    expect(dense[2]).toBeGreaterThanOrEqual(0.05);
  });
});
