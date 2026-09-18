/**
 * memory-graph-semantic —— 记忆图语义通道纯函数（U-B1，DS-PANEL-UI-VISUAL-001 §2 S3）。
 *
 * 三条语义通道（S3）：
 *   1. 金色通道：节点 metadata.coreRefs 非空（这条记忆挂着价值观锚）→ 金 #f5c542
 *      （brief 修法逐字：nodeReducer `res.color = '#f5c542'`；sigma v2 默认节点
 *      程序无描边属性，取"或描边"分支的着色实现，图例注明金=有价值锚）。
 *   2. valence 色相通道：正→偏绿、负→偏红，基于节点基色（memNodeColor 产物）做
 *      HSL 偏移，最大 ±30°（|valence| 线性缩放）。方向取"朝目标色相最短弧"：
 *      蓝(≈224°) 正值 hue-30、琥珀(≈40°) 正值 hue+30——简单 ± 号在暖基色上会
 *      反向（偏绿变成偏红），故按目标色相（绿 120° / 红 0°）求最短弧方向。
 *   3. 边方向通道：evolve / conflict 边 → sigma 内置 'arrow' 程序（sigma v3
 *      DEFAULT_EDGE_PROGRAM_CLASSES 内置注册 arrow/line，已由
 *      tests/memory-graph-semantic.test.ts 对实际安装包做运行时断言——f53b173
 *      的教训是业务类型串 "similar" 等非注册名会抛 "could not find a suitable
 *      program" 崩整图；'arrow' 是注册名，可用）。similar/causal/part_of 语义
 *      仍走颜色通道（EDGE_KIND_COLOR），不加箭头。
 *
 * 零 import（照 soul-utils 先例，根 vitest node 环境直接单测；web 侧与 vitest
 * 共用本文件）。宽松校验：非法色值/无效 valence 一律原样返回，不抛错不造假。
 */

/** valence 色相偏移上限（度）——brief：±30°。 */
export const VALENCE_HUE_SHIFT_DEG = 30;

/** coreRef 金色（brief 修法逐字值）。 */
export const GOLD_CORE_REF_COLOR = '#f5c542';

/** 目标色相：绿（正 valence）/ 红（负 valence）。 */
const HUE_GREEN = 120;
const HUE_RED = 0;

/** 带方向语义的边类型（S3：evolve/conflict 加方向箭头）。 */
const DIRECTED_EDGE_KINDS: ReadonlySet<string> = new Set(['evolve', 'conflict']);

/** U-B1 验证结论编码：evolve/conflict 走 sigma 内置 'arrow' 程序。 */
export function isDirectedKind(kind: string): boolean {
  return DIRECTED_EDGE_KINDS.has(kind);
}

/** 边渲染程序名：only 'line' | 'arrow'（均为 sigma v3 内置注册名）。 */
export function directedEdgeType(kind: string): 'line' | 'arrow' {
  return isDirectedKind(kind) ? 'arrow' : 'line';
}

/** from → to 的最短弧有符号差，∈ (-180, 180]。 */
function shortestHueDelta(from: number, to: number): number {
  return (((to - from) % 360) + 540) % 360 - 180;
}

/** #rgb / #rrggbb → [r,g,b] 0..255；其余 → null。 */
function parseHex(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let s = m[1];
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  const n = parseInt(s, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHexByte(v: number): string {
  return Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0');
}

function hslToHex(h: number, s: number, l: number): string {
  const hn = (((h % 360) + 360) % 360) / 360;
  const sn = Math.max(0, Math.min(1, s));
  const ln = Math.max(0, Math.min(1, l));
  const q = ln < 0.5 ? ln * (1 + sn) : ln + sn - ln * sn;
  const p = 2 * ln - q;
  const channel = (t: number): number => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return `#${toHexByte(channel(hn + 1 / 3) * 255)}${toHexByte(channel(hn) * 255)}${toHexByte(channel(hn - 1 / 3) * 255)}`;
}

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = 60 * (((gn - bn) / d) % 6);
    else if (max === gn) h = 60 * ((bn - rn) / d + 2);
    else h = 60 * ((rn - gn) / d + 4);
  }
  return { h: ((h % 360) + 360) % 360, s, l };
}

/**
 * valence → 基色色相偏移（正偏绿 / 负偏红，最大 ±VALENCE_HUE_SHIFT_DEG，
 * |valence| 线性缩放；方向取朝目标色相最短弧）。
 * valence 无效（非有限数 / null / 0）或基色不可解析 → 基色原样返回。
 */
export function valenceHueShift(baseHex: string, valence?: number | null): string {
  if (typeof valence !== 'number' || !Number.isFinite(valence) || valence === 0) return baseHex;
  const rgb = parseHex(baseHex);
  if (!rgb) return baseHex;
  const { h, s, l } = rgbToHsl(rgb[0], rgb[1], rgb[2]);
  const magnitude = VALENCE_HUE_SHIFT_DEG * Math.min(1, Math.abs(valence));
  const target = valence > 0 ? HUE_GREEN : HUE_RED;
  const dir = Math.sign(shortestHueDelta(h, target));
  if (dir === 0) return baseHex;
  return hslToHex(h + dir * magnitude, s, l);
}

/**
 * 节点语义着色（S3 nodeReducer 用）：
 *   coreRefs 非空（有价值观锚）→ 金色（优先，图例注明）；
 *   否则 → valence 色相偏移色（无 valence → 基色）。
 */
/** S3（U3）：人物节点语义色（与金色价值锚区分——青紫调）。 */
export const PERSON_REF_COLOR = '#7c6cff';

/** U3：语义着色扩展——coreRefs 金色（价值锚）优先，personRefs 人物色次之，否则 valence 色相。 */
export function nodeSemanticColor(
  baseHex: string,
  opts: { valence?: number | null; hasCoreRefs: boolean; hasPersonRefs?: boolean },
): string {
  if (opts.hasCoreRefs) return GOLD_CORE_REF_COLOR;
  if (opts.hasPersonRefs) return PERSON_REF_COLOR;
  return valenceHueShift(baseHex, opts.valence ?? null);
}
