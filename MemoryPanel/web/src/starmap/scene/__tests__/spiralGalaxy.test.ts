import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NB, buildGalaxy, pickGalaxy, toneOf } from '../spiralGalaxy';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
/* 注释里点名了要禁的写法，断言前先剥注释（本仓库纪律测试的固定做法）。 */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('spiralGalaxy = enrichr galaxy-spiral 的逐行移植', () => {
  it('粒子公式与参考实现一致（pow 1.5 / 5.2 扭转 / 0.45 高斯 / core 0.14 / ±0.04 / 尺寸 0.5+r*r*1.6）', () => {
    const src = strip(read('../spiralGalaxy.ts'));
    expect(src).toContain('Math.pow(rand(), 1.5) * 0.95 + 0.02');
    expect(src).toContain('/ arms + rad * 5.2');
    expect(src).toContain('(rand() + rand() + rand() - 1.5) * 0.45');
    expect(src).toContain('ang += spread * (rad + 0.25)');
    expect(src).toContain('const core = rad < 0.14;');
    expect(src).toContain('rad * (0.5 + rand())');
    expect(src).toContain('rad + (rand() - 0.5) * 0.04');
    expect(src).toContain('0.5 + rand() * rand() * 1.6');
    expect(src).toContain('rad < 0.22 ? (cr < 0.6 ? 0 : 1)');
  });

  it('上屏规则与参考实现一致（8 深度桶 / alpha 0.18+depth*0.82 / 尺寸 0.7+depth*1.1 / R*0.46 / f=1/(1.6-z3*0.9) / span 0.9）', () => {
    const src = strip(read('../spiralGalaxy.ts'));
    expect(src).toContain('export const NB = 8;');
    expect(src).toContain('Math.min(w, h) * 0.46');
    expect(src).toContain('const f = 1 / (1.6 - z3 * 0.9);');
    expect(src).toContain('const span = 0.9;');
    expect(src).toContain('ctx.globalAlpha = 0.18 + depth * 0.82;');
    expect(src).toContain('const sz = 0.7 + depth * 1.1;');
    expect(src).toContain('const s = sz * g.size[m];');
    expect(src).toContain('ctx.fillRect(g.X[m] - s / 2, g.Y[m] - s / 2, s, s);');
  });

  it('粒子位置由实体 id 的 hash 定：同一批数据两次构建完全重合，换 id 就换位置', () => {
    const items = [
      { id: 'a', lit: true, color: '#7fc8ff' },
      { id: 'b', lit: false, color: '#9fe6c8' },
    ];
    const opts = { arms: 3, dust: 20, accent: '#7fc8ff', dim: '#66799b', seed: 11 };
    const g1 = buildGalaxy(items, opts);
    const g2 = buildGalaxy(items, opts);
    expect(Array.from(g1.x)).toEqual(Array.from(g2.x));
    const g3 = buildGalaxy([{ ...items[0], id: 'a2' }, items[1]], opts);
    expect(Array.from(g3.x)).not.toEqual(Array.from(g1.x));
    /* 半径必须落在参考实现的 [0.02, 0.97] 内 —— 越界说明公式被改过 */
    for (const v of g1.x) expect(Math.abs(v)).toBeLessThanOrEqual(1.1);
  });

  it('实体可点、星尘不可点；星尘颗数就是传进来的 dust', () => {
    const g = buildGalaxy([{ id: 'x', lit: true, color: '#7fc8ff' }], {
      arms: 3,
      dust: 40,
      accent: '#7fc8ff',
      dim: '#66799b',
      seed: 3,
    });
    expect(g.n).toBe(41);
    expect(g.entity[0]).toBe(0);
    expect(g.entity.filter((v) => v < 0).length).toBe(40);
    g.X[0] = 100;
    g.Y[0] = 100;
    for (let i = 1; i < g.n; i += 1) {
      g.X[i] = 500;
      g.Y[i] = 500;
    }
    expect(pickGalaxy(g, 101, 101, 12)).toBe(0);
    expect(pickGalaxy(g, 300, 300, 12)).toBe(-1);
  });

  it('四档明暗按参考实现分：核球压白、实体本色、外缘压向背景', () => {
    const accent = '#7fc8ff';
    const core = toneOf(accent, 0);
    const own = toneOf(accent, 1);
    const outer = toneOf(accent, 3);
    expect(own).toBe(accent);
    expect(core).not.toBe(accent);
    expect(outer).not.toBe(accent);
    const lum = (hex: string) => parseInt(hex.slice(1, 3), 16) + parseInt(hex.slice(3, 5), 16) + parseInt(hex.slice(5, 7), 16);
    expect(lum(core)).toBeGreaterThan(lum(accent));
    expect(lum(outer)).toBeLessThan(lum(accent));
  });

  it('深桶数量常量与调色板数量无关（palette 长度只影响桶的分组，不改变几何）', () => {
    expect(NB).toBe(8);
  });
});

describe('进云的画布必须交还给 spiralGalaxy（用户 m05333：星云详情照参考样式）', () => {
  const canvas = strip(read('../CloudCanvas.tsx'));
  it('用 spiralGalaxy 的 build/draw/pick，不再自创雾核、轨道、层壳', () => {
    expect(canvas).toContain("from './spiralGalaxy'");
    expect(canvas).toContain('buildGalaxy(');
    expect(canvas).toContain('drawGalaxy(ctx');
    expect(canvas).toContain('pickGalaxy(g,');
    for (const dead of ['makeNebula', 'Orbit', 'GOLDEN', 'R_IN', 'R_OUT', 'layoutPoints']) {
      expect(canvas).not.toContain(dead);
    }
  });

  it('resize 必须幂等（给 canvas.width 赋同值也会清空位图）', () => {
    expect(canvas).toContain('if (sizes.w === w && sizes.h === h && sizes.dpr === dpr) return;');
  });

  it('星尘密度随真实总条数开方，且不冒充实体', () => {
    expect(canvas).toContain('Math.min(16000, Math.round(Math.sqrt(total) * 90))');
    /* 点空处必须回落成「取消选中」，不能把星尘当成实体选中 */
    expect(canvas).toContain('const i = pickGalaxy(g,');
    expect(canvas).toContain('if (i < 0) {');
    expect(canvas).toContain('g.items[g.entity[i]]');
  });

  it('画布上不出现文字与人造图形（参考实现里没有）', () => {
    expect(canvas).not.toContain('fillText');
    expect(canvas).not.toContain('setLineDash');
    expect(canvas).not.toContain('shadowBlur');
  });
});
