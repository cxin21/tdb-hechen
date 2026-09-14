/**
 * U-B1（DS-PANEL-UI-VISUAL-001 §2 S3 / 计划批 2）：记忆图语义通道纯函数测试。
 *
 * 覆盖三件事：
 *   1. valence 色相偏移（正→偏绿 +30°、负→偏红 -30°，基于 memNodeColor 基色 HSL 偏移）
 *   2. coreRef 金色通道（coreRefs 非空 → 金 #f5c542，优先于色相偏移）
 *   3. 边方向通道（evolve/conflict → 'arrow'，其余 → 'line'）
 *   4. ⚠️ Sigma arrow 可用性验证（f53b173 教训：type 只认注册程序名，传错抛
 *      "could not find a suitable program" 崩整图）——本测试是对**实际安装的
 *      sigma 包**做运行时断言：DEFAULT_EDGE_PROGRAM_CLASSES 必须内置注册
 *      'arrow' 与 'line'。断言失败 = sigma 升级后 arrow 不再内置，图的 arrow
 *      边会崩，届时必须退化为颜色标记方案并重审图例。
 *
 * memory-graph-semantic.ts 必须零 import（照 soul-utils 先例，根 vitest node
 * 环境直接单测；web 侧与 vitest 共用本文件）。
 */
import { describe, it, expect, vi } from 'vitest';
// 相对路径直连 web 侧实际安装的 sigma（根 package.json 无 sigma 依赖，
// 裸导入 'sigma/settings' 会解析到不存在的根 node_modules）。
// settings 传递依赖 rendering，其模块顶层引用 WebGL2RenderingContext（仅作
// GL 类型常量用途，不实际建上下文）—— node 环境无此全局，打桩后即可加载。
vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>;
  if (!g.WebGL2RenderingContext) g.WebGL2RenderingContext = class {};
  if (!g.WebGLRenderingContext) g.WebGLRenderingContext = class {};
});
import { DEFAULT_EDGE_PROGRAM_CLASSES } from '../web/node_modules/sigma/settings/dist/sigma-settings.esm.js';
import {
  VALENCE_HUE_SHIFT_DEG,
  GOLD_CORE_REF_COLOR,
  valenceHueShift,
  nodeSemanticColor,
  directedEdgeType,
  isDirectedKind,
} from '../web/src/pages/ChatMemoryPage/components/memory-graph-semantic';

// ── 4. Sigma arrow 可用性（硬性前置的验证结论，编码为常驻守卫测试）──

describe('Sigma arrow 内置程序可用性（实际安装包运行时断言）', () => {
  it('DEFAULT_EDGE_PROGRAM_CLASSES 注册了 arrow 与 line（sigma v3 内置）', () => {
    expect(Object.keys(DEFAULT_EDGE_PROGRAM_CLASSES)).toContain('arrow');
    expect(Object.keys(DEFAULT_EDGE_PROGRAM_CLASSES)).toContain('line');
  });
});

// ── 1. valence 色相偏移 ──

describe('valenceHueShift', () => {
  it('正 valence：色相 +30°（偏绿）', () => {
    // #4f7cff ≈ hue 224° → +30 = 254°… 注意方向定义：偏绿是 hue 朝 120 靠近，
    // 色环上从 224 顺时针 -94 才到 120。本实现取"绿向 = hue 减、红向 = hue 加"
    // 会在 224 基色上产生歧义 —— 因此断言以实现常量为准：
    // 正值偏移 = hue - 30（向 120 绿靠近的短弧），负值 = hue + 30（向 0 红靠近）。
    const out = valenceHueShift('#4f7cff', 1);
    expect(out).not.toBe('#4f7cff');
    expect(out).toMatch(/^#[0-9a-f]{6}$/);
    // 具体数值断言：基色 hue 224.7 → 正偏移 194.7（±0.5 容差）
    const base = hexToHslForTest('#4f7cff');
    const shifted = hexToHslForTest(out);
    expect(angleDelta(shifted.h, (base.h - VALENCE_HUE_SHIFT_DEG + 360) % 360)).toBeLessThan(0.5);
    // 明度/饱和度保持（只动 hue）
    expect(Math.abs(shifted.s - base.s)).toBeLessThan(1);
    expect(Math.abs(shifted.l - base.l)).toBeLessThan(1);
  });

  it('负 valence：色相 +30°（偏红）', () => {
    const base = hexToHslForTest('#4f7cff');
    const out = valenceHueShift('#4f7cff', -1);
    const shifted = hexToHslForTest(out);
    expect(angleDelta(shifted.h, (base.h + VALENCE_HUE_SHIFT_DEG) % 360)).toBeLessThan(0.5);
  });

  it('偏移量按 |valence| 线性缩放（±0.5 → ±15°）', () => {
    const base = hexToHslForTest('#4f7cff');
    const out = hexToHslForTest(valenceHueShift('#4f7cff', 0.5));
    expect(angleDelta(out.h, (base.h - VALENCE_HUE_SHIFT_DEG / 2 + 360) % 360)).toBeLessThan(0.5);
  });

  it('valence 0 / null / undefined / 非有限数 → 基色原样返回', () => {
    expect(valenceHueShift('#4f7cff', 0)).toBe('#4f7cff');
    expect(valenceHueShift('#4f7cff', null)).toBe('#4f7cff');
    expect(valenceHueShift('#4f7cff', undefined)).toBe('#4f7cff');
    expect(valenceHueShift('#4f7cff', Number.NaN)).toBe('#4f7cff');
    expect(valenceHueShift('#4f7cff', 'x' as unknown as number)).toBe('#4f7cff');
  });

  it('非法色值输入 → 原样返回（不抛错，宁缺毋滥）', () => {
    expect(valenceHueShift('', 1)).toBe('');
    expect(valenceHueShift('not-a-color', 1)).toBe('not-a-color');
    // 3 位缩写 #abc 支持
    expect(valenceHueShift('#abc', 1)).toMatch(/^#[0-9a-f]{6}$/);
  });
});

// ── 2. 金色 coreRef 通道 ──

describe('nodeSemanticColor', () => {
  it('coreRefs 非空 → 金色（优先于色相偏移）', () => {
    expect(nodeSemanticColor('#4f7cff', { valence: 1, hasCoreRefs: true })).toBe(GOLD_CORE_REF_COLOR);
    expect(nodeSemanticColor('#4f7cff', { valence: -1, hasCoreRefs: true })).toBe(GOLD_CORE_REF_COLOR);
  });

  it('coreRefs 空 → valence 色相偏移色', () => {
    expect(nodeSemanticColor('#4f7cff', { valence: 1, hasCoreRefs: false })).toBe(valenceHueShift('#4f7cff', 1));
  });

  it('coreRefs 空且无 valence → 基色', () => {
    expect(nodeSemanticColor('#4f7cff', { hasCoreRefs: false })).toBe('#4f7cff');
  });
});

// ── 3. 边方向通道 ──

describe('directedEdgeType / isDirectedKind', () => {
  it('evolve / conflict → arrow（带方向语义）', () => {
    expect(directedEdgeType('evolve')).toBe('arrow');
    expect(directedEdgeType('conflict')).toBe('arrow');
    expect(isDirectedKind('evolve')).toBe(true);
    expect(isDirectedKind('conflict')).toBe(true);
  });

  it('similar / causal / part_of / 未知类型 → line（颜色通道已承载语义）', () => {
    for (const kind of ['similar', 'causal', 'part_of', '', 'unknown_x']) {
      expect(directedEdgeType(kind)).toBe('line');
      expect(isDirectedKind(kind)).toBe(false);
    }
  });
});

// ── 测试内 HSL 参照实现（独立于被测代码，避免同源错误互相掩盖）──

function hexToHslForTest(hex: string): { h: number; s: number; l: number } {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`test helper: bad hex ${hex}`);
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d !== 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  return { h: ((h % 360) + 360) % 360, s: s * 100, l: l * 100 };
}

function angleDelta(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}
