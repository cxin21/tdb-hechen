import { describe, expect, it } from 'vitest';
import {
  SKY_COL,
  drawConstellationLines,
  drawSkyGrid,
  maxLine,
  skyMagOf,
  skyStarRadius,
  stereoAzElToXY,
} from '../sky';

/** 记录调用序列的假 ctx：移植过来的画法只用到 beginPath / moveTo / lineTo / stroke。 */
function fakeCtx() {
  const calls: { op: string; args: number[] }[] = [];
  const ctx = {
    strokeStyle: '',
    lineWidth: 1,
    beginPath: () => calls.push({ op: 'beginPath', args: [] }),
    moveTo: (x: number, y: number) => calls.push({ op: 'moveTo', args: [x, y] }),
    lineTo: (x: number, y: number) => calls.push({ op: 'lineTo', args: [x, y] }),
    stroke: () => calls.push({ op: 'stroke', args: [] }),
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, raw: ctx, calls };
}

describe('sky.ts（VirtualSky 移植）', () => {
  it('立体投影逐字照抄参考实现：az=π el=0 落在画布底边中心', () => {
    const p = stereoAzElToXY(Math.PI, 0, 800, 600);
    expect(p.x).toBeCloseTo(400, 6);
    expect(p.y).toBeCloseTo(600, 6);
    expect(p.el).toBe(0);
  });

  it('el=π/2 抬到 y = h - f*2*h（f=0.42）', () => {
    const p = stereoAzElToXY(Math.PI, Math.PI / 2, 800, 600);
    expect(p.x).toBeCloseTo(400, 6);
    expect(p.y).toBeCloseTo(600 - 0.42 * 2 * 600, 6);
  });

  it('az=π/2 往左偏 f*2*h，az=3π/2 对称往右', () => {
    const left = stereoAzElToXY(Math.PI / 2, 0, 800, 600);
    const right = stereoAzElToXY((Math.PI * 3) / 2, 0, 800, 600);
    expect(left.x).toBeCloseTo(400 - 0.42 * 2 * 600, 6);
    expect(right.x).toBeCloseTo(400 + 0.42 * 2 * 600, 6);
    expect(left.y).toBeCloseTo(600, 6);
  });

  it('星点半径照抄 drawStars：0.8*max(3-mag/2.1,0.5)*sqrt(30/fov)*scale', () => {
    expect(skyStarRadius(1, 30, 1)).toBeCloseTo(0.8 * (3 - 1 / 2.1), 9);
    expect(skyStarRadius(9, 30, 1)).toBeCloseTo(0.8 * 0.5, 9);
    expect(skyStarRadius(1, 30, 2)).toBeCloseTo(2 * 0.8 * (3 - 1 / 2.1), 9);
  });

  it('星等由真实权重反推：权重越大星等越小（越亮），亮星不会超过 0.4 等', () => {
    expect(skyMagOf(1)).toBeLessThan(skyMagOf(0.5));
    expect(skyMagOf(1, true)).toBeLessThan(skyMagOf(1, false));
    expect(skyMagOf(0)).toBeGreaterThanOrEqual(0.4);
    expect(skyMagOf(1)).toBeGreaterThanOrEqual(0.4);
  });

  it('maxLine 默认 tall/3（参考实现 maxLine(f=3)）', () => {
    expect(maxLine(900)).toBe(300);
    expect(maxLine(900, 5)).toBe(180);
  });

  it('网格走 az 帧：单色 SKY_COL.az、经线纬线都画在一条 path 里 stroke 两次', () => {
    const { ctx, raw, calls } = fakeCtx();
    drawSkyGrid(ctx, 800, 600, { step: 30 });
    expect(raw.strokeStyle).toBe(SKY_COL.az);
    expect(calls.filter((c) => c.op === 'stroke').length).toBe(2);
    expect(calls.filter((c) => c.op === 'lineTo').length).toBeGreaterThan(100);
    expect(calls[0].op).toBe('beginPath');
  });

  it('网格间隔可调：步长越小线越多', () => {
    const a = fakeCtx();
    drawSkyGrid(a.ctx, 800, 600, { step: 60 });
    const b = fakeCtx();
    drawSkyGrid(b.ctx, 800, 600, { step: 15 });
    expect(b.calls.length).toBeGreaterThan(a.calls.length);
  });

  it('星座线单色 0.75 线宽，超过 maxLine() 的段被舍弃', () => {
    const { ctx, raw, calls } = fakeCtx();
    const drawn = drawConstellationLines(
      ctx,
      [
        { ax: 10, ay: 10, bx: 40, by: 40 },
        { ax: 0, ay: 0, bx: 9000, by: 0 },
      ],
      900,
    );
    expect(drawn).toBe(1);
    expect(raw.strokeStyle).toBe(SKY_COL.constellation);
    expect(raw.lineWidth).toBe(0.75);
    expect(calls.filter((c) => c.op === 'lineTo').length).toBe(1);
  });

  it('不做随机：移植过来的画法必须是纯函数（无 Math.random）', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
    const src = fs.readFileSync(path.resolve(here, '../sky.ts'), 'utf8');
    expect(src).not.toMatch(/Math\.random/);
    expect(src).toMatch(/0\.42/);
  });
});
