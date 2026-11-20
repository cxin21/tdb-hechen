/**
 * starmap/scene/FiveBodies.tsx — 五体星图：人格恒星 + 四团星云。
 *
 * 几何：真 3D。每团云有自己的世界坐标圆心与半径，星点撒在云的体积里；
 *  4x4 旋转矩阵 + 透视除法（focal / (depth + z)）投影，深度决定大小与亮度。
 *  这与 painter-7/memory-starmap 的做法一致：星云不是贴在屏幕上的圆，是球壳里的一团雾。
 *
 * 雾：只有云核一圈径向渐变（颜色标识），不再有星云贴图——旧版 fbm 贴图被用户判成「光斑」。
 *  再叠一层 0.7 倍反向偏移的薄雾制造体积；中心人格恒星另有一团白紫雾与亮核。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { loadOverview, type CloudKey, type MemoryLayer, type OverviewModel } from '../data/overview';
import { loadCodeNodes, loadWikiWebs, type CodeNodeLite, type WikiWeb } from './realNodes';
import type { StarmapGraph } from '../data/graph';
import { fbm, nebulaSprite } from './nebula';
import {
  SKY_COL,
  drawConstellationLines,
  drawSkyGrid,
  skyMagOf,
  skyStarRadius,
  stereoAzElToXY,
  type SkySegment,
} from './sky';

/* 星图风格开关（用户 m05983「试试换成 https://slowe.github.io/VirtualSky/ 这个样式」）：
   sky  = 星图（真实星等式的散点 + 星座细线 + 极淡天球网格，无雾、无光晕、无旋转）
   galaxy = 之前的写实螺旋星系（雾 + 旋臂 + 公转自转）
   两套共用同一份真实数据与同一套投影，切换只改画法。 */
const SKY_MODE = false;

/* 星点尺寸：照抄 VirtualSky 的 drawStars 公式（见 ./sky.ts 的 skyStarRadius），
   只把视场与缩放调成本项目画布的尺度——参考实现在整屏 900px 高时 fov≈30..60。 */
const SKY_FOV = 55;
const SKY_STAR_SCALE = 3.1;

/** 每朵云的「共多少 / 已点亮多少」——画布建完场景后回报，左栏据此展示，不另取一遍接口 */
export type CloudTotals = Record<CloudKey, { total: number; lit: number }>;
export type AssetLegendItem = { key: string; cloud: CloudKey; label: string; color: string; count: number };

interface Props {
  teamId: string | null;
  agentId: string | null;
  /** 忆云 L1 的真实节点与真实关联（同会话/同人物/显式引用），由 StarmapProvider 的 buildStarmapGraph 提供 */
  graph?: StarmapGraph | null;
  /** 受控聚焦：由外壳用 URL 决定当前只看哪朵云，null = 全景 */
  focus: CloudKey | null;
  onOpen: (key: CloudKey) => void;
  onOpenPersona: () => void;
  /** 聚焦某朵云时把「这朵云有什么」交给外壳做简略卡；退回全景时给 null */
  onFocusChange?: (focus: { key: CloudKey; total: number; lit: number } | null) => void;
  /** 外壳右侧栏里留给星点卡的槽位。有槽位就 portal 进去，不再自己 fixed 定位。 */
  slot?: HTMLElement | null;
  /** 星点卡出现/消失，让外壳决定是否让出「星点详情」那张卡 */
  onCard?: (has: boolean) => void;
  /** 把画布上真正画出来的四层数量交给外壳，避免侧栏另算一套（曾出现侧栏 L1 50、画布 11521） */
  onLayers?: (n: { L3: number; L2: number; L1: number; L0: number; persons: number }) => void;
  /** 画布实际连线数与星点数（含结构线），供侧栏如实展示「画了多少」 */
  onScene?: (n: { links: number; stars: number; linksShown?: number }) => void;
  /** 四朵云各自的「共多少 / 已点亮多少」，左栏「星云构成」卡用它，避免再打一遍接口 */
  onClouds?: (n: CloudTotals) => void;
  /** 典籍云/构筑云里每个库（资产）的星点颜色，供左栏色例——画布按 id 哈希取色，面板必须同源 */
  onAssets?: (n: AssetLegendItem[]) => void;
}

// 层色与 tokens.css 的 --c-l0..l3 逐字对齐：画布取不到 CSS 变量时用同一个字面量，
// 改色只改 tokens.css 与本表两处，别的文件不许再写死（DESIGN.md 验收第 6 条）。
const LAYER_COLOR: Record<MemoryLayer, string> = {
  L3: '#9fe6c8',
  L2: '#ffb86b',
  L1: '#7fc8ff',
  L0: '#7f93bd',
};
/** 暗星＝团队可见但未挂到本 agent。旧的 #41506e 对面板底只有 2.39:1，低于 3:1 地板。 */
/* 同一朵云里「不同库」用不同色：典籍云是冷青绿系变体、构筑云是暖金橙系变体。
   颜色由资产 id 哈希取，增删别的库不会改变某个库的颜色。 */
const ASSET_PALETTE: Partial<Record<CloudKey, string[]>> = {
  wiki: ['#5fe0b0', '#59cfe6', '#8edc86', '#4bbcff', '#a5e0c0', '#5fd8d8'],
  code: ['#ffc65c', '#ff9d6e', '#f3d06a', '#e98f4a', '#ffbe86', '#d8c66a'],
};
const assetPalette = (key: CloudKey): string[] => ASSET_PALETTE[key] ?? [CLOUD_COLOR[key].star];
/** 某朵云里某个资产的星点颜色（库/代码图各自一色；技能云没有多色需求，仍按云色） */
export const assetColor = (key: CloudKey, id: string): string => {
  const pal = assetPalette(key);
  return pal[idHash(id) % pal.length];
};
/* 每朵云读起来的亮度要拉平：忆云真实星点最多（L0/L1 上千），技艺云最少（几十个）。
   否则同一套上屏参数下，忆云糊成死白、技艺云只剩几颗暗点。 */
/* 公转与自转：用户 m05820「星云必须自转，且多个星云围绕灵魂恒星公转」。
   公转一圈约 90–140 秒、自转一圈约 45–80 秒——能看出在动，又不至于晃眼。 */
/* 四云同半径同速（刚性共转）：原型 C 实测——半径/速度各不相同时四朵盘会互相穿过，
   叠在一起就分不出几团云。自转仍各云独立，视觉上仍有差速感。 */
const ORBIT_SPEED: Record<CloudKey, number> = { memory: 0.045, wiki: 0.045, code: 0.045, skills: 0.045 };
const SPIN_SPEED: Record<CloudKey, number> = { memory: 0.085, wiki: -0.071, code: 0.061, skills: -0.093 };
/* 每朵云的盘面扁率：不扁的正圆盘自转是不可避免「看不出来」的 */
const FLAT: Record<CloudKey, number> = { memory: 0.70, wiki: 0.78, code: 0.66, skills: 0.80 };
const CLOUD_GAIN: Record<CloudKey, number> = { memory: 0.64, wiki: 1.02, code: 1.06, skills: 1.18 };
const STAR_DIM = '#66799b';
/* 雾体取「中间调」而不是近白：四团都用近白内芯，叠加后整张图会被洗成一团蓝白，
     四色在画面上根本分不出来（左栏色点与画布对不上就是这个原因）。 */
export const CLOUD_COLOR: Record<CloudKey, { inner: string; outer: string; star: string }> = {
  memory: { inner: '#4f9dff', outer: '#1d3f86', star: '#9db8ff' },
  wiki: { inner: '#25c795', outer: '#0f5b45', star: '#5fe0b0' },
  code: { inner: '#f7ae35', outer: '#6b4409', star: '#ffc65c' },
  skills: { inner: '#f269bb', outer: '#6b1f48', star: '#ff86cc' },
};
/* 云名与星门（STATIONS）逐字一致：画布写「忆云」、星门写「记忆星云」会被读成两个地方。
   en 字段只作内部标识，不渲染——全大写英文副标在 DESIGN.md 里是禁令。 */
const CLOUD_LABEL: Record<CloudKey, { zh: string; en: string }> = {
  memory: { zh: '记忆星云', en: 'MEMORY' },
  wiki: { zh: '典籍星云', en: 'WIKI' },
  code: { zh: '构筑星云', en: 'CODE' },
  skills: { zh: '技艺星云', en: 'SKILLS' },
};
const CLOUD_KEYS: CloudKey[] = ['memory', 'wiki', 'code', 'skills'];

/* 世界坐标：人格恒星在原点（用户 m04975「以人格恒星为定点」）。
   总览是一个「写实螺旋星系」：四条旋臂，一朵云一条臂（用户 m05588 选定 ①+③）。
   —— 半径 = 深度（忆云 L3 贴核 → L0 外缘），角度 = 臂角 + rad×5.2 的拧紧度，
   所以四朵云不再是四座孤岛，而是同一个盘里颜色不同的四段旋臂。
   盘面躺在屏幕平面 x-y 上、y 压扁 GAL_FLAT 造透视；自旋绕 z 轴（盘面内转）。 */
const ARM_ANGLE: Record<CloudKey, number> = { memory: -Math.PI / 2, wiki: 0, code: Math.PI / 2, skills: Math.PI };
/* 每条臂占的半径区间（0=核，1=盘外缘）。忆云最长：它要放下 L3→L0 四个半径带。 */

/* 四朵云各自是一个「小银河」：盘心绕人格恒星均布，盘半径 DISC_R。
   用户 m05588 选定 enrichr 写实螺旋；这里把「一个大盘的四条臂」改成「四个各自完整的小盘」——
   臂是每朵云内部的旋臂，四朵云才是星图级的四个象限，这样每朵云都读得出旋臂，
   又不会像之前那样四条臂横跨整张画布、被读成几何线条。 */
const RING_D = 1.34;
const DISC_R = 0.94;
const DISC_FLAT = 0.86;

/* 每朵盘各自的 z 偏移：共转之后四朵盘仍在同一圆周上，靠盘面厚度错开才读得出「四团」。 */
const DISC_Z: Record<CloudKey, number> = { memory: -0.11, wiki: -0.04, code: 0.04, skills: 0.11 };

function discCenter(key: CloudKey): [number, number, number] {
  const a = ARM_ANGLE[key] + Math.PI / 4;
  return [Math.cos(a) * RING_D, Math.sin(a) * RING_D * 0.74, DISC_Z[key]];
}

/** 把云内的局部螺旋坐标（u、v 落在单位盘里，z 是盘厚）贴到该云的盘上。 */
function armPlace(key: CloudKey, u: number, v: number, z: number): [number, number, number] {
  const c = discCenter(key);
  return [c[0] + u * DISC_R, c[1] + v * DISC_R * DISC_FLAT, z * 0.62];
}

function cloudCenter(key: CloudKey): [number, number, number] {
  return discCenter(key);
}

/* 旋臂星点分布：照 enrichr.dev/elements/galaxy-spiral 的数学——
   pow(r, 1.35) 让中心更密，arm 决定落在哪条臂，rad * 5.2 是拧紧度，
   三次均匀随机相减得臂厚，芯区（rad < 0.18）角度全随机成球核。
   返回值是云内局部坐标（u、v 在屏幕平面，z 是盘的厚度）。 */
const CLOUD_ARMS: Record<CloudKey, number> = { memory: 3, wiki: 3, code: 2, skills: 3 };
/* 忆云四带的半径区间：L3 内芯 → L0 外缘，层与层不重叠 */
const BAND_RANGE: [number, number][] = [[0.02, 0.34], [0.22, 0.58], [0.42, 0.82], [0.60, 1.0]];

function makeRand(seed: number): () => number {
  let s = (seed | 0) || 7;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/* 螺旋分布：逐行照抄 https://enrichr.dev/js/lib/galaxy-spiral.js 的 build()。
   rad 的 pow(r,1.5) 让星点在中心更密；ang 的 spread 用三次均匀相减当高斯；
   core(rad<0.14) 的角度全随机，形成核球；rr 的 ±0.04 抖动打散「完美圆弧」感。
   与参考的唯一差别：把 [0.02,0.97] 的参考半径线性映射到本朵云自己的 [rMin,rMax]。 */
function spiralPoint(
  rand: () => number,
  arms: number,
  rMin: number,
  rMax: number,
): { u: number; v: number; z: number; rad: number; core: boolean; band: number; size: number; arm: number } {
  const rad0 = Math.pow(rand(), 1.5) * 0.95 + 0.02;
  const arm = Math.floor(rand() * arms);
  let ang = (arm * Math.PI * 2) / arms + rad0 * 5.2;
  /* 原型 C 的臂厚只有 ±0.13：0.30*(rad0+0.25) 在外缘能抹到 ±0.45 rad，臂就散成同心碎片了 */
  ang += (rand() + rand() + rand() - 1.5) * 0.19;
  const core = rad0 < 0.14;
  const q = core ? rand() * Math.PI * 2 : ang;
  const rr0 = core ? rad0 * (0.5 + rand()) : rad0 + (rand() - 0.5) * 0.04;
  const rr = rMin + rr0 * ((rMax - rMin) / 0.97);
  const cr = rand();
  const band = rad0 < 0.22 ? (cr < 0.6 ? 0 : 1) : rad0 < 0.55 ? (cr < 0.25 ? 0 : cr < 0.6 ? 1 : 2) : cr < 0.12 ? 1 : cr < 0.45 ? 2 : 3;
  const size = 0.5 + rand() * rand() * 1.6;
  return {
    arm,
    u: Math.cos(q) * rr,
    v: Math.sin(q) * rr,
    z: (rand() + rand() - 1) * (core ? 0.15 : 0.04) * (1.2 - rad0) * 3,
    rad: rr,
    core,
    band,
    size,
  };
}

/* 四朵云各自的 4 色档：index 0 近白（核）、1 是 accent（该云/该库的主色）、2 中调、3 深调。
   accent 不在这里，星点自己的 color 字段就是 accent（忆云=层色 / 典籍构筑=库色 / 技艺=云色）。 */
const CLOUD_SHADES: Record<CloudKey, [string, string, string, string]> = {
  memory: ['#fbf8f1', '#9db8ff', '#3f6fb8', '#1d3f86'],
  wiki: ['#fbf8f1', '#5fe0b0', '#2b8f72', '#0f5b45'],
  code: ['#fffdf5', '#ffc65c', '#b07a20', '#6b4409'],
  skills: ['#fff7fb', '#ff86cc', '#a8437a', '#6b1f48'],
};

/* 臂段的世界半径（聚焦相机的取景尺度、云命中半径都用它）：忆云占满整条臂，其余为一段 */
const CLOUD_R: Record<CloudKey, number> = { memory: 1.30, wiki: 1.05, code: 0.98, skills: 0.86 };
const CORE_R = 0.30;
/* 默认相机：四云半径与河带尺度的函数。删掉假星点后星数变少，必须拉近才填得满视口。 */
const BASE_ZOOM = 1.78;

interface Star3 {
  x: number;
  y: number;
  z: number;
  /** 这个星点代表什么：忆云的层号 / 典籍云的库名 / 技艺云的技能序号 */
  tag?: string;
  pages?: number;
  library?: string;
  /** 连到这个星点的边数（buildScene 末尾回填） */
  deg?: number;
  color: string;
  size: number;
  weight: number;
  bead: boolean;
  /** 所属星座的名字（同一会话 / 同一人物 / 同一个库）：只画星座骨架线，不画全量关系边 */
  group?: string;
  /** 参考实现里的四档色带（0 近白 / 1 accent / 2 中调 / 3 深调），由 spiralPoint 算出 */
  band: number;
  /** 这颗星落在该云的第几条旋臂（0..arms-1）：臂线按它攒点连折线 */
  arm?: number;
  /** 云内尘：按真实条数决定密度铺在螺旋臂里，不是可点的对象 */
  dust?: boolean;
}
interface Link3 {
  a: [number, number, number];
  b: [number, number, number];
  /** 跨区线权重更高 */
  cross: boolean;
  w: number;
  /** 关系语义，选中星点时用来解释这条线是什么 */
  rel?: string;
  /** 这条线属于哪朵云（云内部/云心连线）；空表示人格恒星的连线，聚焦时保留 */
  owner?: CloudKey;
  /** 这条线的颜色（按资产区分时用）；缺省按 rel 取色 */
  col?: string;
  /** 若两端就是星点，记下它在 stars 数组里的下标，供选中高亮用 */
  aIdx?: number;
  bIdx?: number;
  /** 连到云心的线：公转时这条线的外端要跟着云走 */
  toCloud?: CloudKey;
}
/** 星座：一组「共有某个东西」的星点（同一会话 / 同一人物 / 同一个库）。
    照 Obsidian Constellations 的做法——星座由共有属性定义，只画星座内骨架线，
    不把每颗星的每一条关系都画出来（画全了就成知识图谱，不是星图）。 */
interface Constellation {
  id: number;
  /** 星座名：同会话 / 同人物 / 库名；只在侧栏与选中卡显示，不上画布 */
  name: string;
  color: string;
  /** 星座内星点在 stars 数组里的下标，已按绕质心角度排好，相邻两点连骨架线 */
  idx: number[];
}

interface Cloud3 {
  key: CloudKey;
  center: [number, number, number];
  r: number;
  stars: Star3[];
  total: number;
  lit: number;
  subs: [number, number, number][];
  groups?: Constellation[];
  /** 每朵云的旋臂点列：按臂号分组、按半径排好，画布上连成一条连续折线 */
  arms?: [number, number, number][][];
}

function rgbOf(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function hashN(n: number): number {
  let x = (n | 0) ^ 0x9e3779b9;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return (x ^ (x >>> 16)) >>> 0;
}
function rnd(seed: number): number {
  return (hashN(seed) % 100000) / 100000;
}

function makeSprite(color: string, lum: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d');
  if (!g) return c;
  const [r, gg, b] = rgbOf(color);
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  const light = (v: number) => 'rgba(' + Math.min(255, Math.round(r + (255 - r) * v)) + ',' + Math.min(255, Math.round(gg + (255 - gg) * v)) + ',' + Math.min(255, Math.round(b + (255 - b) * v)) + ',';
  grad.addColorStop(0, light(0.92) + (0.95 * lum) + ')');
  grad.addColorStop(0.18, light(0.6) + (0.86 * lum) + ')');
  grad.addColorStop(0.44, light(0.3) + (0.62 * lum) + ')');
  grad.addColorStop(0.72, light(0.1) + (0.24 * lum) + ')');
  grad.addColorStop(0.90, light(0.05) + (0.07 * lum) + ')');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return c;
}
function idHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0);
  return h;
}

/** 星点不许重叠：同朵云内两星的世界距离小于 minD 就丢掉较暗的一颗。
    网格按 minD 分桶，只查 3×3 邻桶，1600 颗星也是线性时间。 */
function thinStars(stars: Star3[], minD: number): Star3[] {
  const cell = minD;
  const grid = new Map<string, Star3[]>();
  const kept: Star3[] = [];
  const d2 = minD * minD;
  for (const s of stars) {
    const gx = Math.floor(s.x / cell);
    const gy = Math.floor(s.y / cell);
    let clash = false;
    for (let ix = gx - 1; ix <= gx + 1 && !clash; ix += 1) {
      for (let iy = gy - 1; iy <= gy + 1 && !clash; iy += 1) {
        const bucket = grid.get(ix + ':' + iy);
        if (!bucket) continue;
        for (const o of bucket) {
          const dx = o.x - s.x;
          const dy = o.y - s.y;
          if (dx * dx + dy * dy < d2) {
            clash = true;
            break;
          }
        }
      }
    }
    if (clash) continue;
    kept.push(s);
    const key = gx + ':' + gy;
    const b = grid.get(key);
    if (b) b.push(s);
    else grid.set(key, [s]);
  }
  return kept;
}

/** 星座内骨架线按角度串起来：绕星座质心排一圈，相邻两点连线，读起来就是星座连线图。 */
function sortAround(stars: Star3[], idx: number[]): number[] {
  let ax = 0;
  let ay = 0;
  for (const i of idx) {
    ax += stars[i].x;
    ay += stars[i].y;
  }
  ax /= Math.max(1, idx.length);
  ay /= Math.max(1, idx.length);
  return idx
    .slice()
    .sort(
      (a, b) =>
        Math.atan2(stars[a].y - ay, stars[a].x - ax) - Math.atan2(stars[b].y - ay, stars[b].x - ax),
    );
}

/** 把一朵云里的星点按「共有属性」分成星座。
    - 典籍云 / 构筑云：同一个库 / 同一张代码图的星点 = 一个星座（库名来自真实资产列表）；
    - 忆云：内核 l1_links 里同会话 / 同人物边连成一片的星点 = 一个星座（不是编的边）；
    - 技艺云：技能之间没有共有属性，宁可不分组也不造假。 */
function buildConstellations(key: CloudKey, stars: Star3[], links: Link3[]): Constellation[] {
  const out: Constellation[] = [];
  if (key === 'skills') return out;
  if (key === 'wiki' || key === 'code') {
    const byLib = new Map<string, number[]>();
    stars.forEach((s, i) => {
      if (!s.library) return;
      const arr = byLib.get(s.library);
      if (arr) arr.push(i);
      else byLib.set(s.library, [i]);
    });
    let id = 0;
    for (const [lib, idx] of byLib) {
      if (idx.length < 2) continue;
      const litIdx = idx.find((i) => stars[i].color !== STAR_DIM);
      const col = stars[litIdx === undefined ? idx[0] : litIdx].color;
      out.push({ id: id++, name: lib, color: col === STAR_DIM ? '#8fa3c8' : col, idx: sortAround(stars, idx) });
    }
    return out;
  }
  /* 忆云：并查集把同会话 / 同人物连成一片的 L1 星点归成一个星座。
     连线两端是建场时的世界坐标，与星点坐标逐位相等，所以用坐标找回下标。 */
  const key3 = (x: number, y: number, z: number) => x.toFixed(4) + ',' + y.toFixed(4) + ',' + z.toFixed(4);
  const pos = new Map<string, number>();
  stars.forEach((s, i) => pos.set(key3(s.x, s.y, s.z), i));
  const parent = stars.map((_, i) => i);
  const find = (i0: number): number => {
    let i = i0;
    while (parent[i] !== i) i = parent[i];
    let j = i0;
    while (parent[j] !== i) {
      const nx = parent[j];
      parent[j] = i;
      j = nx;
    }
    return i;
  };
  const relOf = new Map<number, string>();
  for (const lk of links) {
    if (lk.rel !== '同会话' && lk.rel !== '同人物') continue;
    const ia = pos.get(key3(lk.a[0], lk.a[1], lk.a[2]));
    const ib = pos.get(key3(lk.b[0], lk.b[1], lk.b[2]));
    if (ia === undefined || ib === undefined) continue;
    const ra = find(ia);
    const rb = find(ib);
    if (ra !== rb) parent[ra] = rb;
    relOf.set(ra, lk.rel);
    relOf.set(rb, lk.rel);
  }
  const buckets = new Map<number, number[]>();
  stars.forEach((_, i) => {
    const r = find(i);
    const arr = buckets.get(r);
    if (arr) arr.push(i);
    else buckets.set(r, [i]);
  });
  let id = 0;
  let nSess = 0;
  let nPerson = 0;
  for (const [root, idx] of buckets) {
    if (idx.length < 3) continue;
    const rel = relOf.get(root) ?? relOf.get(find(idx[0])) ?? '同会话';
    const name = rel === '同人物' ? '同人物 · ' + (nPerson += 1) : '同会话 · ' + (nSess += 1);
    out.push({
      id: id++,
      name,
      color: rel === '同人物' ? '#f08fa8' : '#4ec9d9',
      idx: sortAround(stars, idx),
    });
  }
  return out;
}

function buildScene(model: OverviewModel, blocksCount: number, webMap?: Record<string, WikiWeb>, codeNodes?: Record<string, CodeNodeLite[]>, graph?: StarmapGraph | null, viewSmall = 800): { clouds: Cloud3[]; blocks: { x: number; y: number; z: number; chars: number }[]; persons: { x: number; y: number; z: number; name: string; key: string; relations: number }[]; links: Link3[]; mem: { l1Nodes: number; l1Edges: number; l0Nodes: number; l0Edges: number; l2Nodes: number; l3Nodes: number; extractEdges: number; l3Edges: number } } {
  const clouds: Cloud3[] = [];
  const links: Link3[] = [];
  /* 星点去重必须按「屏幕像素」判，不能按世界单位：世界半径是固定的，
     可视口、缩放一变，同一个 0.03 就代表完全不同的屏上间距（m00788）。 */
  const pxPerUnit = (viewSmall * 0.62 * BASE_ZOOM) / 4.2;
  const minDOf = (px: number) => px / Math.max(1, pxPerUnit);
  /** 两颗星在屏上至少要隔这么多像素，才允许同时出现 */
  const MIN_STAR_PX = 2.8;
  const bandSamples: [number, number, number][][] = [];
  const bandSampleIdx: number[][] = [];
  /** 忆云 L1 带的真实节点（graph 里 kind==='L1'）与它们的星点下标 */
  const l1Real: { nodeId: string; weight: number; gi: number }[] = [];
  if (graph) {
    graph.nodes.forEach((n, gi) => {
      if (n.kind === 'L1' && l1Real.length < 1600) l1Real.push({ nodeId: n.id, weight: n.weight, gi });
    });
  }
  /** 忆云 L2 带的真实场景记忆节点（graph 里 kind==='L2'） */
  const l2Real: { nodeId: string; weight: number; gi: number }[] = [];
  /** 忆云 L3 带的真实核心记忆节点（graph 里 kind==='L3'） */
  const l3Real: { nodeId: string; weight: number; gi: number }[] = [];
  if (graph) {
    graph.nodes.forEach((n, gi) => {
      if (n.kind === 'L2' && l2Real.length < 400) l2Real.push({ nodeId: n.id, weight: n.weight, gi });
      if (n.kind === 'L3' && l3Real.length < 60) l3Real.push({ nodeId: n.id, weight: n.weight, gi });
    });
  }
  /** 忆云 L0 带的真实原文节点（graph 里 kind==='L0'，由 L1 的 source_message_ids 反向长出） */
  const l0Real: { nodeId: string; weight: number; gi: number }[] = [];
  if (graph) {
    graph.nodes.forEach((n, gi) => {
      if (n.kind === 'L0' && l0Real.length < 1600) l0Real.push({ nodeId: n.id, weight: n.weight, gi });
    });
  }
  const l1StarOf = new Map<number, number>();
  const l0StarOf = new Map<number, number>();
  const l2StarOf = new Map<number, number>();
  const l3StarOf = new Map<number, number>();
  let l1EdgeCount = 0;
  let l0EdgeCount = 0;
  let l2EdgeCount = 0;
  let l3EdgeCount = 0;
  CLOUD_KEYS.forEach((key, ki) => {
    const center = cloudCenter(key);
    const r = CLOUD_R[key];
    const stars: Star3[] = [];
    const subs: [number, number, number][] = [];
    let seed = 1000 + ki * 7919;

    if (key === 'memory') {
      /* 只用真实节点：L3/L2/L1/L0 四带各取 graph 里的真节点，没有就不画。
         旧版在没有真实节点时按 BAND_STARS 铺「合成分星点」，那是假星点（用户 m04975 要求全去）。 */
      model.memory.bands.forEach((band, bi) => {
        const sample: [number, number, number][] = [];
        const sampleIdx: number[] = [];
        const realL3 = bi === 0 && l3Real.length >= 1;
        const realL2 = bi === 1 && l2Real.length >= 1;
        const realL1 = bi === 2 && l1Real.length >= 8;
        const realL0 = bi === 3 && l0Real.length >= 4;
        const realSet = realL3 ? l3Real : realL2 ? l2Real : realL1 ? l1Real : realL0 ? l0Real : null;
        if (!realSet) {
          /* 这一层没有真实节点就一颗也不撒：星点必须由数据承载
             （用户 m05624「以真实数据作为星点，不要有假星点」）。
             空层的体量感由旋臂气团提供，气是雾不是星。 */
          bandSamples.push(sample);
          bandSampleIdx.push(sampleIdx);
          return;
        }
        const n = realSet.length;
        for (let i = 0; i < n; i++) {
          seed += 17;
          const rec = realSet[i];
          const h = idHash(rec.nodeId);
          const sp = spiralPoint(makeRand(h ^ (bi * 2654435)), CLOUD_ARMS.memory, 0.02, 0.80);
          const spp = armPlace('memory', sp.u, sp.v, sp.z);
          stars.push({
            x: spp[0],
            y: spp[1],
            z: spp[2],
            color: LAYER_COLOR[band.layer],
            size: sp.size,
            weight: 0.6 + Math.min(1, rec.weight) * 0.4,
            bead: h % 10 === 0,
            band: BAND_RANGE[3][0] <= sp.rad ? 3 : BAND_RANGE[2][0] <= sp.rad ? 2 : BAND_RANGE[1][0] <= sp.rad ? 1 : 0,
            arm: sp.arm,
            tag: band.layer,
          });
          if (realL3) l3StarOf.set(rec.gi, stars.length - 1);
          else if (realL2) l2StarOf.set(rec.gi, stars.length - 1);
          else if (realL1) l1StarOf.set(rec.gi, stars.length - 1);
          else l0StarOf.set(rec.gi, stars.length - 1);
          if (i % Math.max(1, Math.floor(n / 10)) === 0 && sample.length < 10) {
            const st = stars[stars.length - 1];
            sample.push([st.x, st.y, st.z]);
            sampleIdx.push(stars.length - 1);
          }
        }
        bandSamples.push(sample);
        bandSampleIdx.push(sampleIdx);
        if (bi > 0 && n > 0) {
          const prev = bandSamples[bi - 1];
          for (let s2 = 0; s2 < sample.length && prev.length > 0; s2++) {
            links.push({ a: prev[s2 % prev.length], b: sample[s2], cross: true, w: 0.5, aIdx: bandSampleIdx[bi - 1][s2 % prev.length], bIdx: sampleIdx[s2], owner: 'memory', rel: '提取' });
          }
        }
      });

      // L1 内部真实关系边：同一会话（session）、同一人物（person）、显式引用（ref）
      if (graph && l1StarOf.size >= 8) {
        const kinds = graph.nodes.map((n) => n.kind);
        let used = 0;
        for (const l of graph.links) {
          if (used >= 1200) break;
          if (kinds[l.a] !== 'L1' || kinds[l.b] !== 'L1') continue;
          const ia = l1StarOf.get(l.a);
          const ib = l1StarOf.get(l.b);
          if (ia === undefined || ib === undefined) continue;
          const A = stars[ia];
          const B = stars[ib];
          if (!A || !B) continue;
          links.push({
            a: [A.x, A.y, A.z],
            b: [B.x, B.y, B.z],
            cross: false,
            w: 0.55 + 0.45 * Math.min(1, Math.max(0, l.weight)),
            aIdx: ia,
            bIdx: ib,
            owner: 'memory',
            rel: l.kind === 'session' ? '同会话' : l.kind === 'person' ? '同人物' : l.kind === 'ref' ? '引用' : '关联',
          });
          used++;
        }
        l1EdgeCount = used;
      }

      // 层间真实提取边：L3←L2、L2←L1、L1←L0，全部来自 graph 的 kind==='extract'
      if (graph) {
        for (const l of graph.links) {
          if (l.kind !== 'extract') continue;
          let ia: number | undefined;
          let ib: number | undefined;
          const rel = '提取';
          if (l3StarOf.has(l.a) && l2StarOf.has(l.b)) {
            ia = l3StarOf.get(l.a);
            ib = l2StarOf.get(l.b);
            l3EdgeCount++;
          } else if (l2StarOf.has(l.a) && l1StarOf.has(l.b)) {
            ia = l2StarOf.get(l.a);
            ib = l1StarOf.get(l.b);
          } else if (l1StarOf.has(l.a) && l0StarOf.has(l.b)) {
            ia = l1StarOf.get(l.a);
            ib = l0StarOf.get(l.b);
            l0EdgeCount++;
          }
          if (ia === undefined || ib === undefined) continue;
          const A = stars[ia];
          const B = stars[ib];
          if (!A || !B) continue;
          links.push({
            a: [A.x, A.y, A.z],
            b: [B.x, B.y, B.z],
            cross: false,
            w: 0.9,
            aIdx: ia,
            bIdx: ib,
            owner: 'memory',
            rel,
          });
          l2EdgeCount++;
        }
      }
    } else {
      const pts = model.clouds[key].points;
      const arms = CLOUD_ARMS[key];
      const nPts = pts.length;
      pts.forEach((pt, pti) => {
        seed += 13;
        const lit = pt.lit;
        const assetCol = assetColor(key, pt.id);
        /* 资产本身就是一颗真星：一个库 / 一张代码图 / 一个技能，都是产物里真实存在的对象。
           旧版在没有页列表时按 count 铺「合成分星点」，那是假星点（用户 m04975 要求全去）。 */
        /* 一朵云只走一条连续螺旋：库 / 图 / 技能按序位分「色段」，不再各自撒满整个盘。
           每个锚点单独 spiralPoint 撒开，两个库就会落成两团、看起来像两朵星云（用户 m00785）。 */
        /* 资产少到每条臂摊不上两颗时，就全排在同一条臂上：两个库各占一条臂、
           隔 120° 落点，画面上还是两团；排成一条弧的两段，才读成「一朵云里两种颜色」（m00785）。 */
        const useArms = nPts >= arms * 2 ? arms : 1;
        const perArm = Math.max(1, Math.ceil(nPts / useArms));
        const armIdx = pti % useArms;
        const slotInArm = Math.floor(pti / useArms);
        const slot = perArm <= 1 ? 0.5 : (slotInArm + 0.5) / perArm;
        const rrA = 0.12 + 0.74 * slot;
        const thA = (armIdx * Math.PI * 2) / useArms + 0.55 + slot * 2.15 + (rnd(seed ^ 0x7f4a7c15) - 0.5) * 0.10;
        const spa = {
          u: Math.cos(thA) * rrA,
          v: Math.sin(thA) * rrA,
          z: (rnd(seed ^ 0x2545f491) - 0.5) * 0.05,
          size: 1.15 + rnd(seed) * 0.75,
          band: 1,
          arm: armIdx,
        };
        const sub: [number, number, number] = armPlace(key, spa.u, spa.v, spa.z);
        subs.push(sub);
        const anchorIdx = stars.length;
        stars.push({
          x: sub[0],
          y: sub[1],
          z: sub[2],
          color: lit ? assetCol : STAR_DIM,
          size: spa.size + 0.5,
          weight: 1,
          bead: pt.lit,
          band: spa.band,
          arm: spa.arm,
          tag: pt.label,
          pages: pt.count ?? 0,
          library: key === 'wiki' || key === 'code' ? pt.label : undefined,
        });
        links.push({ a: center, b: sub, cross: false, w: key === 'skills' ? 0.35 : 0.6, owner: key, rel: '归属', col: lit ? assetCol : undefined, bIdx: anchorIdx, aIdx: -1 });
        const pageStars = webMap?.[pt.id]?.pages ?? [];
        const pageEdges = webMap?.[pt.id]?.edges ?? [];
        /* 代码图的真实节点：某个图不是 wiki，它的块来自 code-graph/structure。
           每个节点都是真块，颜色跟它所属的图一致（一图一色）。 */
        const codeList = codeNodes?.[pt.id] ?? [];
        const kids = codeList.length > 0 ? codeList : pageStars.map((pg) => ({ id: pg.id, label: pg.label, kind: 'page' }));
        const local = Math.min(0.34, 0.10 + 0.16 * Math.sqrt(Math.min(Math.max(kids.length, pageStars.length), 420) / 220));
        const starStart = stars.length;
        for (let j = 0; j < kids.length; j++) {
          seed += 7;
          const sp = spiralPoint(makeRand(seed ^ 0x2545f491), 2, 0.04, 0.80);
          const kid = kids[j];
          /* 代码节点的种类决定星点大小：文件 > 类 > 函数 > 方法，读起来才有层次 */
          const kindBoost = kid.kind === 'file' ? 0.85 : kid.kind === 'class' ? 0.55 : kid.kind === 'function' ? 0.35 : kid.kind === 'page' ? 0.25 : 0.15;
          stars.push({
            x: sub[0] + sp.u * local,
            y: sub[1] + sp.v * local,
            z: sub[2] + sp.z * local * 1.6,
            color: lit ? assetCol : STAR_DIM,
            size: sp.size + kindBoost * 0.9,
            weight: pt.weight,
            bead: (lit ? rnd(seed + 4) < 0.10 : rnd(seed + 4) < 0.04) || kid.kind === 'file',
            band: sp.band,
            tag: kid.label,
            pages: pt.count ?? 0,
            library: key === 'wiki' || key === 'code' ? pt.label : undefined,
          });
        }
        /* 同样不铺「云内尘」：这条臂上只有真实资产与真实块（m05624）。 */
        if (pageStars.length > 1 && pageEdges.length > 0) {
          for (const [ea, eb] of pageEdges) {
            const sa = stars[starStart + ea];
            const sb = stars[starStart + eb];
            if (!sa || !sb) continue;
            links.push({ a: [sa.x, sa.y, sa.z], b: [sb.x, sb.y, sb.z], cross: true, w: 1.5, aIdx: starStart + ea, bIdx: starStart + eb, owner: key, rel: '引用', col: lit ? assetCol : undefined });
          }
        }
      });
    }

    links.push({ a: [0, 0, 0], b: center, cross: true, w: 1, toCloud: key });
    /* 星点密集处必须去重，否则屏幕上挤成一片亮斑（用户 m05820 第一条要求）。 */
    const kept = thinStars(stars, minDOf(MIN_STAR_PX));
    /* 星座按「共有属性」分（同会话 / 同人物 / 同一个库），星点记下星座名供选中卡显示 */
    const groups = buildConstellations(key, kept, links);
    for (const g0 of groups) {
      for (const gi of g0.idx) {
        const st0 = kept[gi];
        if (st0) st0.group = g0.name;
      }
    }
    /* 原型 C 的做法：把每朵云的星点按臂号攒起来、按到云心的距离排序，
       画布上连成一条连续折线——臂的轮廓是画出来的，不再只靠真实关系边。
       代码块/页节点（撒在资产周围）没有臂号，不参与，否则会把折线拽歪。 */
    const armBuckets: [number, number, number][][] = [];
    for (const s0 of kept) {
      if (s0.arm === undefined) continue;
      const ai = s0.arm;
      if (!armBuckets[ai]) armBuckets[ai] = [];
      armBuckets[ai].push([s0.x, s0.y, s0.z]);
    }
    const armPaths = armBuckets
      .filter((pts) => Array.isArray(pts) && pts.length > 3)
      .map((pts) => pts.sort((p1, p2) => Math.hypot(p1[0] - center[0], p1[1] - center[1]) - Math.hypot(p2[0] - center[0], p2[1] - center[1])));

    clouds.push({ key, center, r, stars: kept, total: model.clouds[key].total, lit: model.clouds[key].mounted, subs, groups, arms: armPaths });
  });

  /* 臂与臂之间不再连线：四朵云已经是同一个盘的四条旋臂，臂间连线读成蜘蛛网。
     每朵云到核的那条「归属」线（上面 links.push({a:[0,0,0],b:center})）就是唯一的骨架。 */

  /* 星点不许穿云：九块与人物是按球面撒的，半径一抖就落进星云球里，
     投到屏幕上就是「星云里冒出一颗人格星」，读起来像两套系统叠在一起。
     沿云心→星点方向推到云外（0.92 倍半径，留一点贴边感），两轮足够收敛。 */
  const keepOut = (x0: number, y0: number, z0: number): [number, number, number] => {
    /* 四朵云现在是四条旋臂、包住整个盘，所以不再有「云球」可以往外推。
       唯一必须避开的是核心核球：人格九块与人物档案不许压在人造白核上。 */
    const d = Math.hypot(x0, y0, z0);
    const min = CORE_R * 1.9;
    if (d > 0.0001 && d < min) {
      const f = min / d;
      return [x0 * f, y0 * f, z0 * f];
    }
    if (d <= 0.0001) return [min, 0, 0];
    return [x0, y0, z0];
  };

  const blocks: { x: number; y: number; z: number; chars: number }[] = [];
  const n = Math.max(blocksCount, 6);
  for (let i = 0; i < n; i++) {
    const ph = Math.acos(1 - (2 * (i + 0.5)) / n);
    const th = i * 2.399963;
    /* 每颗半径单独抖：等距球面投影出来是一个规整光圈，读成粒子加速器环（用户 m04730）。
       散成 1.2–3.0 倍半径的一团晕，才是「围着恒星的人格块」。 */
    const rrB = CORE_R * (0.42 + rnd(9103 + i * 17) * 1.0);
    const [bx, by, bz] = keepOut(
      Math.sin(ph) * Math.cos(th) * rrB,
      Math.cos(ph) * rrB * 0.72,
      Math.sin(ph) * Math.sin(th) * rrB,
    );
    blocks.push({ x: bx, y: by, z: bz, chars: 0 });
    const bb = blocks[blocks.length - 1];
    links.push({ a: [0, 0, 0], b: [bb.x, bb.y, bb.z], cross: false, w: 0.4 });
  }
  /* 人格恒星云的外围：人物档案星点（人名来自真实档案，不是编的） */
  const persons: { x: number; y: number; z: number; name: string; key: string; relations: number }[] = [];
  const people = model.persona.personList ?? [];
  people.slice(0, 40).forEach((p, i) => {
    const n = Math.max(people.length, 1);
    const ph = Math.acos(1 - (2 * (i + 0.5)) / Math.max(n, 8));
    const th = i * 2.399963 + 0.6;
    const rr = CORE_R * (1.0 + rnd(3703 + i * 13) * 1.1);
    const [px, py, pz] = keepOut(
      Math.sin(ph) * Math.cos(th) * rr,
      Math.cos(ph) * rr * 0.75,
      Math.sin(ph) * Math.sin(th) * rr,
    );
    persons.push({ x: px, y: py, z: pz, name: p.name, key: p.key, relations: p.relations });
    links.push({ a: [0, 0, 0], b: [px, py, pz], cross: false, w: 0.55, rel: '人物' });
  });

  const degMap = new Map<string, number>();
  const key3 = (x: number, y: number, z: number) => x.toFixed(4) + ',' + y.toFixed(4) + ',' + z.toFixed(4);
  for (const lk of links) {
    degMap.set(key3(lk.a[0], lk.a[1], lk.a[2]), (degMap.get(key3(lk.a[0], lk.a[1], lk.a[2])) ?? 0) + 1);
    degMap.set(key3(lk.b[0], lk.b[1], lk.b[2]), (degMap.get(key3(lk.b[0], lk.b[1], lk.b[2])) ?? 0) + 1);
  }
  for (const c of clouds) for (const s of c.stars) s.deg = degMap.get(key3(s.x, s.y, s.z)) ?? 0;

  return {
    clouds,
    blocks,
    persons,
    links,
    mem: { l1Nodes: l1Real.length, l1Edges: l1EdgeCount, l0Nodes: l0Real.length, l0Edges: l0EdgeCount, l2Nodes: l2Real.length, l3Nodes: l3Real.length, extractEdges: l2EdgeCount, l3Edges: l3EdgeCount },
  };
}

export default function FiveBodies({ teamId, agentId, graph, focus, onOpen, onOpenPersona, onFocusChange, onLayers, onScene, onClouds, onAssets, slot, onCard }: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const onSceneRef = useRef<Props['onScene']>(onScene);
  const onCloudsRef = useRef<Props['onClouds']>(onClouds);
  const onAssetsRef = useRef<Props['onAssets']>(onAssets);
  useEffect(() => {
    onSceneRef.current = onScene;
  }, [onScene]);
  useEffect(() => {
    onCloudsRef.current = onClouds;
  }, [onClouds]);
  useEffect(() => {
    onAssetsRef.current = onAssets;
  }, [onAssets]);
  const [model, setModel] = useState<OverviewModel | null>(null);
  const [webMap, setWebMap] = useState<Record<string, WikiWeb>>({});
  const [codeNodes, setCodeNodes] = useState<Record<string, CodeNodeLite[]>>({});
  type SelNeighbor = { tag: string; cloud: CloudKey; rel: string; lit: boolean; degree: number; x: number; y: number; z: number; s?: Star3 };
  type Sel = { cloud: CloudKey; tag: string; lit: boolean; degree: number; pages: number; library?: string; group?: string; x: number; y: number; z: number; neighbors: SelNeighbor[] };
  const [sel, setSel] = useState<Sel | null>(null);
  const [selPerson, setSelPerson] = useState<{ name: string; key: string; relations: number } | null>(null);
  const selWorld = useRef<{ x: number; y: number; z: number } | null>(null);
  /* 选中的星点必须按「对象身份 + 所属云」记，不能记世界坐标：
     公转/自转每帧都在改世界坐标，记坐标会让高亮边和圆环飘到画面外（用户 m05905 报的就是这个）。 */
  const selNode = useRef<{ cloud: CloudKey; s: Star3 } | null>(null);
  /* 关联星点列表在 effect 外渲染，要通过 ref 调回 effect 里的 selectStar */
  const selectStarRef = useRef<(cloud: CloudKey, s: Star3) => void>(() => {});
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [paused, setPaused] = useState(false);

  /* 场景 effect 只认「内容签名」，不认对象身份：父组件每次渲染都可能造出新的 graph/web 对象，
     若把它们放进依赖，effect 会每帧重跑、cleanup 取消上一帧的 rAF，星场永远只画一帧就停。
     实测过：3.2 秒内 effect 重挂 23 次、frame 卡在 1，画布看着像被清空。 */
  const modelRef = useRef<OverviewModel | null>(null);
  const webMapRef = useRef<Record<string, WikiWeb>>({});
  const codeNodesRef = useRef<Record<string, CodeNodeLite[]>>({});
  const graphRef = useRef<Props['graph']>(graph);
  const focusRef = useRef<CloudKey | null>(focus);
  const pausedRef = useRef(false);
  const onOpenRef = useRef(onOpen);
  const onPersonaRef = useRef(onOpenPersona);
  modelRef.current = model;
  webMapRef.current = webMap;
  codeNodesRef.current = codeNodes;
  graphRef.current = graph;
  focusRef.current = focus;
  pausedRef.current = paused;
  onOpenRef.current = onOpen;
  onPersonaRef.current = onOpenPersona;
  const sceneKey = model
    ? [
        model.persona.version,
        model.persona.chars,
        model.persona.persons,
        model.persona.blocks.length,
        model.clouds.wiki.mounted,
        model.clouds.wiki.total,
        model.clouds.code.total,
        model.clouds.skills.mounted,
        model.clouds.skills.total,
        model.memory.bands.map((b) => (b.layer ?? '') + b.total).join('~'),
      ].join('|')
    : '';
  const graphKey = graph ? graph.nodes.length + ':' + graph.links.length : '';
  /* 真实块的内容签名：每个库取到多少页、每张图取到多少节点，变了就得重建场景 */
  const webKey = useMemo(() => {
    const w = ['wiki', ...Object.keys(webMap).sort()].map((id) => {
      const m = webMap[id];
      return id + ':' + (m ? m.pages.length + ':' + m.edges.length : '0');
    });
    const c = ['code', ...Object.keys(codeNodes).sort()].map((id) => id + ':' + (codeNodes[id]?.length ?? 0));
    return w.concat(c).join('|');
  }, [webMap, codeNodes]);

  /* 有星点/人物被选中时，外壳要让出自己那张「星点详情」，否则右侧栏会并排两张空卡 */
  const hasCard = !!(sel || selPerson);
  useEffect(() => {
    onCard?.(hasCard);
  }, [hasCard, onCard]);
  useEffect(() => () => { onCard?.(false); }, [onCard]);

  useEffect(() => {
    if (!teamId || !agentId) return;
    let alive = true;
    setLoading(true);
    /* 换智能体先把上一只的画面清掉，避免新数据没到时还显示旧星云。 */
    setModel(null);
    setWebMap({});
    setCodeNodes({});
    setSel(null);
    setSelPerson(null);
    loadOverview({ teamId, agentId })
      .then((m) => {
        if (!alive) return;
        setModel(m);
        setErrors(m.errors);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setErrors({ overview: e instanceof Error ? e.message : String(e) });
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [teamId, agentId]);

  useEffect(() => {
    if (!model) return;
    let alive = true;
    /* 每朵云里每个资产都要把自己真实的块取回来：一个库/一张图只画一颗锚点星，
       画不出旋臂（用户 m04975：只保留真星点）。取数走缓存层，切回智能体不重打。 */
    Promise.all([
      loadWikiWebs(model.clouds.wiki.points),
      loadCodeNodes(model.clouds.code.points),
    ])
      .then(([webs, codes]) => {
        if (!alive) return;
        setWebMap(webs);
        setCodeNodes(codes);
      })
      .catch(() => { /* 取不到就只画锚点星，不编造 */ });
    return () => { alive = false; };
  }, [model]);

  useEffect(() => {
    if (!model || !onLayers) return;
    const band = (l: MemoryLayer) => model.memory.bands.find((b) => b.layer === l)?.total ?? 0;
    onLayers({ L3: band('L3'), L2: band('L2'), L1: band('L1'), L0: band('L0'), persons: model.persona.persons });
  }, [model, onLayers]);

  const counts = useMemo(() => {
    if (!model) return '';
    const layers = model.memory.bands.map((b) => b.layer + '=' + b.total).join(',');
    return 'memory:' + layers + ';wiki:' + model.clouds.wiki.mounted + '/' + model.clouds.wiki.total +
      ';code:' + model.clouds.code.total + ';skills:' + model.clouds.skills.mounted + '/' + model.clouds.skills.total +
      ';blocks:' + model.persona.blocks.length;
  }, [model]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    const model = modelRef.current;
    const webMap = webMapRef.current;
    const codeNodes = codeNodesRef.current;
    const graph = graphRef.current;
    if (!canvas || !wrap || !model) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let W = 0, H = 0, DPR = 1, small = 800;
    const rot = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    /* 灵魂恒星是整张星图的定点：拖拽只改「看它的角度」，绝不位移（m00730）。
       offX/offY 只由聚焦改（聚焦某朵云时把那朵云挪到画面中央），拖拽一律不碰。 */
    let zoom = BASE_ZOOM, targetZoom = BASE_ZOOM, offX = 0, offY = 0, targetOffX = 0, targetOffY = 0;
    let rollVel = 0, tiltVel = 0, tiltSum = 0, dragging = false, moved = 0, lastX = 0, lastY = 0;
    const MAX_TILT = 1.05;
    /* 俯仰总量夹在 ±MAX_TILT：不夹的话反复上下拖会把盘翻过去，星图的上下关系就反了。 */
    const applyTilt = (d: number) => {
      const nd = Math.max(-MAX_TILT, Math.min(MAX_TILT, tiltSum + d));
      const real = nd - tiltSum;
      tiltSum = nd;
      if (real) rotateTilt(real);
      return real;
    };
    let pausedLocal = pausedRef.current;
    /* 与 React 的 focus 状态对齐：effect 依赖含 focus，重跑后不能把聚焦丢掉 */
    let focusKey: CloudKey | null = focusRef.current;
    let raf = 0, frame = 0, lastShownLinks = -1;
    const t0 = performance.now();
    let focusApplied = false;
    const proj = new Map<CloudKey, { x: number; y: number; k: number; z: number }>();
    const coreProj = { x: 0, y: 0, k: 1, z: 0 };

    const scene = buildScene(model, model.persona.blocks.length, webMap, codeNodes, graph, Math.min(W, H) || 800);
    const sceneStars = scene.clouds.reduce((n, c) => n + c.stars.length, 0);
    canvas.dataset.links = String(scene.links.length);
    onSceneRef.current?.({ links: scene.links.length, stars: sceneStars, linksShown: 0 });
    {
      const totals = {} as CloudTotals;
      for (const c of scene.clouds) totals[c.key] = { total: c.total, lit: c.lit };
      onCloudsRef.current?.(totals);
      /* 典籍云/构筑云的多色色例：颜色必须由同一个 assetColor() 算，
         面板自己拍颜色就会和画布对不上。 */
      const legend: AssetLegendItem[] = [];
      for (const key of ['wiki', 'code'] as CloudKey[]) {
        for (const pt of model.clouds[key].points) {
          legend.push({ key: key + ':' + pt.id, cloud: key, label: pt.label, color: pt.lit ? assetColor(key, pt.id) : STAR_DIM, count: pt.count ?? 0 });
        }
      }
      onAssetsRef.current?.(legend);
    }
    canvas.dataset.memNodes = String(scene.mem.l1Nodes);
    canvas.dataset.memEdges = String(scene.mem.l1Edges);
    canvas.dataset.memL0 = String(scene.mem.l0Nodes ?? 0);
    canvas.dataset.memL0Edges = String(scene.mem.l0Edges ?? 0);
    canvas.dataset.memL2 = String(scene.mem.l2Nodes ?? 0);
    canvas.dataset.memL3 = String(scene.mem.l3Nodes ?? 0);
    canvas.dataset.memExtract = String(scene.mem.extractEdges ?? 0);
    canvas.dataset.memL3Edges = String(scene.mem.l3Edges ?? 0);
    canvas.dataset.wikiEdges = String(Object.values(webMap).reduce((n, m) => n + m.edges.length, 0));
    /* 人格恒星不用星云贴图：贴图里那套 (th + turn*log r) 的旋臂数学会在圆心汇成
       一圈硬射线，看着像旧版镜头光晕。改用两层纯径向渐变，柔和、无硬边。 */
    const makeGlow = (stops: [number, string][], size = 256): HTMLCanvasElement => {
      const c = document.createElement('canvas');
      c.width = size;
      c.height = size;
      const g = c.getContext('2d');
      if (!g) return c;
      const gr = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      for (const [at, col] of stops) gr.addColorStop(at, col);
      g.fillStyle = gr;
      g.fillRect(0, 0, size, size);
      return c;
    };
    const coreFog = makeGlow([[0, 'rgba(255,250,255,0.45)'], [0.26, 'rgba(224,214,255,0.16)'], [0.62, 'rgba(150,132,232,0.045)'], [1, 'rgba(110,96,200,0)']]);
    const coreWarm = makeGlow([[0, 'rgba(255,236,252,0.38)'], [0.4, 'rgba(206,180,255,0.10)'], [1, 'rgba(140,110,230,0)']]);
    const sprites = new Map<string, HTMLCanvasElement>();
    const spriteOf = (color: string) => {
      let s = sprites.get(color);
      if (!s) { s = makeSprite(color, 0.6); sprites.set(color, s); }
      return s;
    };
    /* 有体积的星：照 Constellation（Vision Pro 版）的 3D 球体——高光偏左上、边缘稍暗，
       但**边界必须清晰**。不是高斯光斑：光斑叠起来整张图会糊成一片（上一轮被判"糊"的原因）。 */
    const orbSprites = new Map<string, HTMLCanvasElement>();
    const orbOf = (color: string) => {
      let s = orbSprites.get(color);
      if (s) return s;
      const sz = 64;
      s = document.createElement('canvas');
      s.width = sz;
      s.height = sz;
      const g = s.getContext('2d');
      if (!g) return s;
      const [r0, g0, b0] = rgbOf(color);
      const grad = g.createRadialGradient(sz * 0.42, sz * 0.38, 0, sz / 2, sz / 2, sz / 2);
      const lift = (v: number) =>
        'rgba(' +
        Math.round(r0 + (255 - r0) * v) + ',' +
        Math.round(g0 + (255 - g0) * v) + ',' +
        Math.round(b0 + (255 - b0) * v) + ',';
      grad.addColorStop(0, lift(0.88) + '1)');
      grad.addColorStop(0.26, lift(0.34) + '0.99)');
      grad.addColorStop(0.64, 'rgba(' + r0 + ',' + g0 + ',' + b0 + ',0.94)');
      grad.addColorStop(0.91, 'rgba(' + Math.round(r0 * 0.62) + ',' + Math.round(g0 * 0.62) + ',' + Math.round(b0 * 0.62) + ',0.88)');
      grad.addColorStop(0.985, 'rgba(' + Math.round(r0 * 0.5) + ',' + Math.round(g0 * 0.5) + ',' + Math.round(b0 * 0.5) + ',0.55)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, sz, sz);
      orbSprites.set(color, s);
      return s;
    };

    const project = (x: number, y: number, z: number): [number, number, number] => [
      rot[0] * x + rot[1] * y + rot[2] * z,
      rot[3] * x + rot[4] * y + rot[5] * z,
      rot[6] * x + rot[7] * y + rot[8] * z,
    ];
    /* 盘在 x-y 平面里：拖拽横向绕 z 轴（盘面内的角），纵向绕 x 轴（俯仰），两者的不动点都是原点。 */
    const rotateRoll = (d: number) => {
      const c = Math.cos(d), s = Math.sin(d);
      for (let r = 0; r < 9; r += 3) {
        const x = rot[r], y = rot[r + 1];
        rot[r] = x * c - y * s;
        rot[r + 1] = x * s + y * c;
      }
    };
    const rotateTilt = (d: number) => {
      const c = Math.cos(d), s = Math.sin(d);
      for (let j = 0; j < 3; j++) {
        const y = rot[3 + j], z = rot[6 + j];
        rot[3 + j] = y * c - z * s;
        rot[6 + j] = y * s + z * c;
      }
    };
    const resetRot = () => {
      const cy = Math.cos(-0.35), sy = Math.sin(-0.35), cp = Math.cos(0.22), sp = Math.sin(0.22);
      rot[0] = cy; rot[1] = 0; rot[2] = sy;
      rot[3] = sp * sy; rot[4] = cp; rot[5] = -sp * cy;
      rot[6] = -cp * sy; rot[7] = sp; rot[8] = cp * cy;
    };
    resetRot();

    let backdrop: HTMLCanvasElement | null = null;
    const buildBackdrop = () => {
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(W * DPR));
      c.height = Math.max(1, Math.round(H * DPR));
      const g = c.getContext('2d');
      if (!g) return;
      g.scale(DPR, DPR);
      g.fillStyle = 'rgba(4,6,13,0.94)';
      g.fillRect(0, 0, W, H);
      const R = Math.max(W, H) * 0.78;
      const rg = g.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, R);
      rg.addColorStop(0, 'rgba(34,24,70,0.20)');
      rg.addColorStop(0.45, 'rgba(16,18,46,0.22)');
      rg.addColorStop(1, 'rgba(7,10,22,0.10)');
      g.fillStyle = rg;
      g.fillRect(0, 0, W, H);
      const vg = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.32, W / 2, H / 2, Math.max(W, H) * 0.78);
      vg.addColorStop(0, 'rgba(0,0,0,0)');
      vg.addColorStop(1, 'rgba(0,0,0,0.30)');
      g.fillStyle = vg;
      g.fillRect(0, 0, W, H);
      backdrop = c;
    };

    /* 幂等 resize：给 canvas.width 赋任何值（哪怕同值）都会清空位图。
       以前每次 ResizeObserver 回调都无条件赋值，观测循环会让星场每帧被抹掉一次（实测约 13 次/秒）。 */
    const resize = () => {
      const rect = wrap.getBoundingClientRect();
      const nw = Math.max(320, Math.round(rect.width));
      const nh = Math.max(320, Math.round(rect.height));
      const nd = Math.min(2, window.devicePixelRatio || 1);
      const bw = Math.round(nw * nd);
      const bh = Math.round(nh * nd);
      if (nw === W && nh === H && nd === DPR && bw === canvas.width && bh === canvas.height) return;
      W = nw;
      H = nh;
      DPR = nd;
      small = Math.min(W, H);
      canvas.width = bw;
      canvas.height = bh;
      canvas.style.width = nw + 'px';
      canvas.style.height = nh + 'px';
      buildBackdrop();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    const focalOf = () => small * 0.62 * zoom;
    const depthOf = (z: number) => 4.2 + z;

    
    /* 只动相机，不通知 React——用于 effect 重跑后的复位，避免与父组件来回触发 */
    const focusCamera = (key: CloudKey | null) => {
        focusKey = key;
        focusApplied = true;
        if (!key) {
          targetZoom = BASE_ZOOM;
          targetOffX = 0;
          targetOffY = 0;
          return;
        }
        const c = scene.clouds.find((x) => x.key === key);
        if (!c) return;
        const p = project(c.center[0], c.center[1], c.center[2]);
        const kNow = focalOf() / Math.max(depthOf(p[2]), 0.2);
        const sx = W / 2 + offX + p[0] * kNow;
        const sy = H / 2 + offY + p[1] * kNow;
        targetOffX = offX + (W / 2 - sx);
        targetOffY = offY + (H / 2 - sy);
        targetZoom = Math.max(1.15, Math.min(6, small * 0.36 * depthOf(p[2]) / (c.r * small * 0.62)));
      };
      const focusOn = (key: CloudKey | null) => {
        focusCamera(key);
        if (onFocusChange) {
          const c = key ? scene.clouds.find((x) => x.key === key) : undefined;
          onFocusChange(key && c ? { key, total: c.total, lit: c.lit } : null);
        }
      };
      let starHits: Array<{ x: number; y: number; r: number; s: any; cloud: CloudKey }> = [];
      let personHitList: Array<{ x: number; y: number; r: number; p: any }> = [];
      const paint = (now2: number) => {
        try {
          const T = (now2 - t0) / 1e3;
          frame++;
          /* 松手后按拖拽速度继续转一小段：同样的「只改角度」，不位移 */
          if (!dragging && (Math.abs(rollVel) > 4e-5 || Math.abs(tiltVel) > 4e-5)) {
            rotateRoll(rollVel);
            applyTilt(tiltVel);
            rollVel *= 0.93;
            tiltVel *= 0.93;
          }
          if (!dragging && !pausedLocal) rotateRoll(16e-4);
          zoom += (targetZoom - zoom) * 0.09;
          offX += (targetOffX - offX) * 0.09;
          offY += (targetOffY - offY) * 0.09;
          if (focusKey && !focusApplied && W > 0) focusCamera(focusKey);
          const focal = focalOf();
          const cx = W / 2 + offX;
          const cy = H / 2 + offY;
          ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
          ctx.clearRect(0, 0, W, H);
          if (backdrop) ctx.drawImage(backdrop, 0, 0, W, H);
          else {
            ctx.fillStyle = "#04060d";
            ctx.fillRect(0, 0, W, H);
          }
          const kOf = (z: number) => focal / Math.max(depthOf(z), 0.35);
          const kRef = small * 0.62 / 4.2;
          const cloudXf = new Map<CloudKey, { c0: [number, number, number]; cNow: [number, number, number]; cos: number; sin: number }>();
          for (const c of scene.clouds) {
            const a0 = Math.atan2(c.center[1] / (RING_D * 0.74), c.center[0] / RING_D);
            const oa = a0 + (SKY_MODE ? 0 : ORBIT_SPEED[c.key] * T);
            const spin = SKY_MODE ? 0 : SPIN_SPEED[c.key] * T;
            cloudXf.set(c.key, {
              c0: c.center,
              cNow: [Math.cos(oa) * RING_D, Math.sin(oa) * RING_D * 0.74, 0],
              cos: Math.cos(spin),
              sin: Math.sin(spin)
            });
          }
          const applyXf = (p: [number, number, number], key: CloudKey): [number, number, number] => {
            const t2 = cloudXf.get(key);
            if (!t2) return p;
            const dx = p[0] - t2.c0[0];
            const dy = (p[1] - t2.c0[1]) * FLAT[key];
            return [t2.cNow[0] + dx * t2.cos - dy * t2.sin, t2.cNow[1] + dx * t2.sin + dy * t2.cos, p[2]];
          };
          for (const c of scene.clouds) {
            if (focusKey && c.key !== focusKey) continue;
            const cc = applyXf(c.center, c.key);
            const p = project(cc[0], cc[1], cc[2]);
            const k = kOf(p[2]);
            proj.set(c.key, { x: cx + p[0] * k, y: cy + p[1] * k, k, z: p[2] });
          }
          {
            const p = project(0, 0, 0);
            const k = kOf(p[2]);
            coreProj.x = cx + p[0] * k;
            coreProj.y = cy + p[1] * k;
            coreProj.k = k;
            coreProj.z = p[2];
          }
          ctx.globalCompositeOperation = "lighter";
          if (!SKY_MODE) {
            for (const c of scene.clouds) {
              if (focusKey && c.key !== focusKey) continue;
              const sp = nebulaSprite(CLOUD_COLOR[c.key].inner, 11);
              const dens = Math.min(1, Math.max(0.30, c.stars.length / 260));
              /* 气点必须沿臂铺：原型 C 的星云是「每条臂上的一层雾」，
                 沿圆环撒一圈只会得到一坨与旋臂无关的光斑（用户 m00630）。 */
              const gasArms = c.arms ?? [];
              for (let ai = 0; ai < gasArms.length; ai += 1) {
                const path = gasArms[ai];
                const STEPS = 40;
                for (let i = 0; i < STEPS; i += 1) {
                  const t = (i + 0.5) / STEPS;
                  const fi = t * (path.length - 1);
                  const j = Math.floor(fi);
                  const f = fi - j;
                  const p0 = path[j];
                  const p1 = path[Math.min(path.length - 1, j + 1)];
                  const wp0 = applyXf([p0[0] + (p1[0] - p0[0]) * f, p0[1] + (p1[1] - p0[1]) * f, p0[2] + (p1[2] - p0[2]) * f], c.key);
                  const pr = project(wp0[0], wp0[1], wp0[2]);
                  const k = kOf(pr[2]);
                  const x = cx + pr[0] * k;
                  const y = cy + pr[1] * k;
                  const n = fbm(i * 0.19 + ai * 2.7, c.key.length * 3.1, 17);
                  const size = small * 1.16 * (0.34 + 0.18 * n) * (k / kRef);
                  ctx.globalAlpha = 0.030 * (0.45 + 0.55 * n) * (0.5 + 0.5 * dens) * (0.55 + 0.45 * t);
                  ctx.drawImage(sp, x - size / 2, y - size / 2, size, size);
                }
              }
            }
            ctx.globalAlpha = 1;
            const order = scene.clouds.filter((c) => !focusKey || c.key === focusKey).map((c) => ({ c, p: proj.get(c.key) })).filter((o) => !!o.p).sort((a, b) => (a.p as any).z - (b.p as any).z);
            for (const { c, p: atRaw } of order) {
              const at = atRaw as { x: number; y: number; z: number; k: number };
              const isFocus = focusKey === c.key;
              const near = 1 - Math.min(Math.abs(at.z) / 6.5, 0.6);
              const nucA = (isFocus ? 0.26 : 0.16) * Math.max(0.35, near) * (focusKey && !isFocus ? 0.4 : 1);
              const R = Math.max(12, c.r * at.k);
              const layers: [string, number, number, number][] = [
                [CLOUD_COLOR[c.key].outer, 1.45, 0.055, 0.5],
                [CLOUD_COLOR[c.key].inner, 0.98, 0.065, 2.1],
                [CLOUD_COLOR[c.key].star, 0.60, 0.070, 4.3]
              ];
              for (let li = 0; li < layers.length; li += 1) {
                const [tint, sz, al, rot2] = layers[li];
                const sp = nebulaSprite(tint, 3 + li);
                const d = R * sz * 2;
                ctx.save();
                ctx.translate(at.x, at.y);
                ctx.rotate(rot2 + (focusKey === c.key ? 0 : T * 0.02 * (li + 1)));
                ctx.globalAlpha = al * nucA;
                ctx.drawImage(sp, -d / 2, -d / 2, d, d);
                ctx.restore();
              }
              ctx.globalAlpha = 1;
            }
            /* 原型 C 的两件事一起补在这里：
               ① 每朵云两块随自转的径向渐变（体积感，不是一圈气点）；
               ② 每条臂一条连续折线（臂的轮廓要画出来，否则只有真实关系边的碎线）。
               都在核球之后、连线与星点之前落笔。 */
            for (const { c, p: atRaw } of order) {
              const at = atRaw as { x: number; y: number; z: number; k: number };
              const isFocus = focusKey === c.key;
              const [br, bg, bb] = rgbOf(CLOUD_COLOR[c.key].inner);
              const rBlob = Math.max(18, at.k * (0.20 + c.r * 0.18));
              const blob = (rr2: number, al: number) => {
                const g2 = ctx.createRadialGradient(at.x, at.y, 0, at.x, at.y, rr2);
                g2.addColorStop(0, "rgba(" + br + "," + bg + "," + bb + "," + al + ")");
                g2.addColorStop(0.55, "rgba(" + br + "," + bg + "," + bb + "," + (al * 0.42) + ")");
                g2.addColorStop(1, "rgba(" + br + "," + bg + "," + bb + ",0)");
                ctx.globalAlpha = 1;
                ctx.fillStyle = g2;
                ctx.beginPath();
                ctx.arc(at.x, at.y, rr2, 0, Math.PI * 2);
                ctx.fill();
              };
              blob(rBlob, isFocus ? 0.085 : 0.062);
              blob(rBlob * 0.55, isFocus ? 0.045 : 0.032);
              ctx.strokeStyle = "rgba(" + br + "," + bg + "," + bb + ",1)";
              ctx.lineWidth = 2.1;
              for (const path of c.arms ?? []) {
                ctx.globalAlpha = isFocus ? 0.26 : 0.215;
                ctx.beginPath();
                for (let pi = 0; pi < path.length; pi += 1) {
                  const wp = applyXf(path[pi], c.key);
                  const pr = project(wp[0], wp[1], wp[2]);
                  const kk = kOf(pr[2]);
                  const sx = cx + pr[0] * kk;
                  const sy = cy + pr[1] * kk;
                  if (pi === 0) ctx.moveTo(sx, sy);
                  else ctx.lineTo(sx, sy);
                }
                ctx.stroke();
              }
            }
            ctx.globalAlpha = 1;
            const ck = coreProj.k;
            const haloR = CORE_R * 2.9 * ck;
            ctx.save();
            ctx.translate(coreProj.x, coreProj.y);
            ctx.rotate(T * 0.05);
            ctx.globalAlpha = (0.042 + 0.010 * Math.sin(T * 0.8)) * (focusKey ? 0.5 : 1);
            ctx.drawImage(coreFog, -haloR, -haloR, haloR * 2, haloR * 2);
            ctx.rotate(-T * 0.11);
            ctx.globalAlpha = 0.038 * (focusKey ? 0.5 : 1);
            ctx.drawImage(coreWarm, -haloR * 0.72, -haloR * 0.72, haloR * 1.44, haloR * 1.44);
            ctx.restore();
            const cr = CORE_R * 1.10 * ck * (1 + 0.035 * Math.sin(T * 0.9));
            const rg = ctx.createRadialGradient(coreProj.x, coreProj.y, 0, coreProj.x, coreProj.y, Math.max(cr, 2));
            rg.addColorStop(0, 'rgba(255,253,255,0.050)');
            rg.addColorStop(0.1, "rgba(243,238,255,0.070)");
            rg.addColorStop(0.26, "rgba(214,204,255,0.070)");
            rg.addColorStop(0.5, "rgba(176,166,248,0.040)");
            rg.addColorStop(0.78, "rgba(150,134,240,0.015)");
            rg.addColorStop(1, "rgba(120,110,255,0)");
            ctx.globalAlpha = 0.7;
            ctx.fillStyle = rg;
            ctx.beginPath();
            ctx.arc(coreProj.x, coreProj.y, Math.max(cr, 2), 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = focusKey ? 0.24 : 0.32;
            ctx.fillStyle = "#ffffff";
            ctx.beginPath();
            ctx.arc(coreProj.x, coreProj.y, Math.max(1.2, cr * 0.07), 0, Math.PI * 2);
            ctx.fill();
            for (let i = 0; i < 6; i++) {
              const ang = i * Math.PI * 2 / 6 + 0.4;
              const rr = cr * (0.42 + 0.12 * (i * 37 % 5));
              const sz = 1.2 + i * 53 % 7 / 5;
              ctx.globalAlpha = (focusKey ? 0.4 : 0.8) * (1 - i * 0.06);
              ctx.fillRect(coreProj.x + Math.cos(ang) * rr - sz / 2, coreProj.y + Math.sin(ang) * rr - sz / 2, sz, sz);
            }
            ctx.globalAlpha = 1;
            ctx.globalAlpha = 1;
          }
          if (SKY_MODE) {
            const skyScale = zoom / BASE_ZOOM;
            ctx.save();
            ctx.globalAlpha = 0.5;
            drawSkyGrid(ctx, W, H, {
              kind: "az",
              step: 30,
              lineWidth: 0.75,
              tall: Math.max(W, H),
              map: (az, el) => {
                const q = stereoAzElToXY(az, el, W, H);
                return { x: cx + (q.x - W / 2) * skyScale, y: cy + (q.y - H / 2) * skyScale, el: q.el };
              }
            });
            ctx.restore();
          }
          const REL_COLOR = {
            同会话: '#4ec9d9',
            同人物: '#f08fa8',
            引用: '#6fd39a',
            归属: '#6fd39a',
            人物: '#ffcf7a',
            星河: '#8fa4d8',
            关联: '#88aee0'
          };
          const relBuckets =  new Map();
          const linkSeg = [];
          let linkSkip = 0, linkDrawn = 0;
          const showLinks = true;
          for (const lk of showLinks ? scene.links : []) {
            if (SKY_MODE) {
              const rel = lk.rel ?? "";
              if (!(rel === '提取' || rel === '人物' || rel === '归属')) continue;
              linkSkip = linkSkip * 1664525 + 1013904223 >>> 0;
              if (rel === '归属' && (linkSkip >>> 7) % 2 !== 0) continue;
            }
            if (focusKey && lk.owner && lk.owner !== focusKey) continue;
            if (focusKey && !lk.owner) continue;
            if (!SKY_MODE && !focusKey && lk.owner) {
              linkSkip = linkSkip * 2654435761 + 1013904223 >>> 0;
              if ((linkSkip >>> 8) % 3 !== 0) continue;
            }
            if (!SKY_MODE && !focusKey && !selWorld.current) {
              if (lk.rel === '引用') continue;
              if (lk.w < 0.55) continue;
              linkSkip = linkSkip * 1103515245 + 12345 >>> 0;
              if ((linkSkip >>> 9) % 2 !== 0) continue;
            }
            const wa = lk.owner ? applyXf(lk.a, lk.owner) : lk.a;
            const wb = lk.owner ? applyXf(lk.b, lk.owner) : lk.toCloud ? applyXf(lk.b, lk.toCloud) : lk.b;
            const pa = project(wa[0], wa[1], wa[2]);
            const pb = project(wb[0], wb[1], wb[2]);
            const xa = cx + pa[0] * kOf(pa[2]), ya = cy + pa[1] * kOf(pa[2]);
            const xb = cx + pb[0] * kOf(pb[2]), yb = cy + pb[1] * kOf(pb[2]);
            if (!SKY_MODE && !focusKey && !selWorld.current && Math.hypot(xb - xa, yb - ya) > small * 0.30) continue;
            linkSeg.push([xa, ya, xb, yb]);
            const dz = (Math.abs(pa[2]) + Math.abs(pb[2])) / 2;
            const la = Math.min(0.4, 0.05 + lk.w * 0.12) * (1 - Math.min(dz / 3.2, 0.62)) * (lk.cross ? 1.5 : 0.66);
            if (la < 0.01) continue;
            const bi = Math.max(0, Math.min(3, Math.floor(la / 0.4 * 4)));
            const key = (lk.col ?? (REL_COLOR as Record<string, string>)[lk.rel ?? "关联"] ?? "#88aee0") + "|" + bi;
            const bucket = relBuckets.get(key);
            if (bucket) bucket.push(xa, ya, xb, yb);
            else relBuckets.set(key, [xa, ya, xb, yb]);
            linkDrawn += 1;
          }
          if (linkDrawn !== lastShownLinks) {
            lastShownLinks = linkDrawn;
            canvas.dataset.linksShown = String(linkDrawn);
            onSceneRef.current?.({ links: scene.links.length, stars: sceneStars, linksShown: linkDrawn });
          }
          ctx.lineCap = "round";
          ctx.lineWidth = SKY_MODE ? 0.6 : 0.7;
          for (const [key, arr] of relBuckets) {
            const bar = key.lastIndexOf("|");
            ctx.strokeStyle = key.slice(0, bar);
            ctx.globalAlpha = (Number(key.slice(bar + 1)) + 0.5) / 4 * (SKY_MODE ? 0.17 : 0.13);
            ctx.beginPath();
            for (let i2 = 0; i2 < arr.length; i2 += 4) {
              ctx.moveTo(arr[i2], arr[i2 + 1]);
              ctx.lineTo(arr[i2 + 2], arr[i2 + 3]);
            }
            ctx.stroke();
          }
          ctx.globalAlpha = 1;
          if (SKY_MODE) {
            const segs: SkySegment[] = [];
            for (const c of scene.clouds) {
              if (focusKey && c.key !== focusKey) continue;
              for (const g2 of c.groups ?? []) {
                let prev = null;
                let n2 = 0;
                for (const gi of g2.idx) {
                  const s2 = c.stars[gi];
                  if (!s2) continue;
                  const w2 = applyXf([s2.x, s2.y, s2.z], c.key);
                  const p2 = project(w2[0], w2[1], w2[2]);
                  const pt2 = [cx + p2[0] * kOf(p2[2]), cy + p2[1] * kOf(p2[2])];
                  if (prev) segs.push({ ax: prev[0], ay: prev[1], bx: pt2[0], by: pt2[1] });
                  prev = pt2;
                  n2 += 1;
                  if (n2 >= 22) break;
                }
              }
            }
            ctx.globalAlpha = 0.18;
            drawConstellationLines(ctx, segs, Math.max(W, H), SKY_COL.constellation, 0.75);
            ctx.globalAlpha = 1;
          }
          const sn = selNode.current;
          if (sn) {
            const near = (p: number[]) => Math.abs(p[0] - sn.s.x) < 1e-4 && Math.abs(p[1] - sn.s.y) < 1e-4 && Math.abs(p[2] - sn.s.z) < 1e-4;
            ctx.strokeStyle = "rgba(255,206,242,0.85)";
            ctx.lineWidth = 1.35;
            ctx.globalAlpha = 1;
            ctx.beginPath();
            for (const lk of scene.links) {
              if (!near(lk.a) && !near(lk.b)) continue;
              const wa = lk.owner ? applyXf(lk.a, lk.owner) : lk.a;
              const wb = lk.owner ? applyXf(lk.b, lk.owner) : lk.toCloud ? applyXf(lk.b, lk.toCloud) : lk.b;
              const pa = project(wa[0], wa[1], wa[2]);
              const pb = project(wb[0], wb[1], wb[2]);
              ctx.moveTo(cx + pa[0] * kOf(pa[2]), cy + pa[1] * kOf(pa[2]));
              ctx.lineTo(cx + pb[0] * kOf(pb[2]), cy + pb[1] * kOf(pb[2]));
            }
            ctx.stroke();
            const swNow = applyXf([sn.s.x, sn.s.y, sn.s.z], sn.cloud);
            const ps = project(swNow[0], swNow[1], swNow[2]);
            const ks = kOf(ps[2]);
            const sx = cx + ps[0] * ks, sy = cy + ps[1] * ks;
            ctx.strokeStyle = "rgba(255,226,250,0.9)";
            ctx.lineWidth = 1.4;
            ctx.beginPath();
            ctx.arc(sx, sy, 11, 0, Math.PI * 2);
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(sx, sy, 18, 0, Math.PI * 2);
            ctx.strokeStyle = "rgba(255,206,242,0.32)";
            ctx.stroke();
            ctx.globalAlpha = 1;
          }
          for (let i3 = 0; focusKey && i3 < linkSeg.length; i3 += 13) {
            const [xa, ya, xb, yb] = linkSeg[i3];
            const d = Math.hypot(xb - xa, yb - ya);
            if (d < 30 || d > Math.min(W, H) * 1.4) continue;
            ctx.globalAlpha = 0.02 * (1 - Math.min(d / (Math.min(W, H) * 1.4), 0.7));
            ctx.strokeStyle = i3 % 3 === 0 ? "#6c5aa8" : "#4f6d9c";
            ctx.lineWidth = 4 + i3 % 4 * 2;
            ctx.beginPath();
            ctx.moveTo(xa, ya);
            ctx.lineTo(xb, yb);
            ctx.stroke();
          }
          ctx.globalAlpha = 1;
          ctx.lineCap = "butt";
          const pts = [];
          for (const c of scene.clouds) {
            if (focusKey && c.key !== focusKey) continue;
            for (const s of c.stars) {
              const w = applyXf([s.x, s.y, s.z], c.key);
              const p = project(w[0], w[1], w[2]);
              pts.push({ x: cx + p[0] * kOf(p[2]), y: cy + p[1] * kOf(p[2]), z: p[2], k: kOf(p[2]), s, cloud: c.key });
            }
          }
          pts.sort((a, b) => a.z - b.z);
          starHits = [];
          for (const q of pts) {
            if (q.s.dust) continue;
            const scale = q.k / kRef;
            starHits.push({ x: q.x, y: q.y, r: Math.max(6, (q.s.bead ? 9 : 6) * scale), cloud: q.cloud, s: q.s });
          }
          for (const q of pts) {
            const bright = !SKY_MODE && (q.s.bead || q.s.weight > 0.86);
            if (!bright) continue;
            const shades = CLOUD_SHADES[q.cloud];
            const col = q.s.band === 0 ? shades[0] : q.s.band === 1 ? q.s.color : shades[2];
            const rr = Math.max(3, 5 * (q.k / kRef));
            ctx.globalAlpha = (q.s.color === STAR_DIM ? 0.030 : 0.055) * (0.55 + 0.45 * (q.k / kRef)) * CLOUD_GAIN[q.cloud];
            ctx.drawImage(spriteOf(col), q.x - rr, q.y - rr, rr * 2, rr * 2);
          }
          ctx.globalAlpha = 1;
          const NB = 8;
          const starBuckets =  new Map();
          for (const q of pts) {
            const dd = Math.max(0, Math.min(0.999, (q.z / 2.2 + 1) / 2));
            const db = Math.floor(dd * NB);
            const shades = CLOUD_SHADES[q.cloud];
            const col = q.s.band === 0 ? shades[0] : q.s.band === 1 ? q.s.color : q.s.band === 2 ? shades[2] : shades[3];
            const dim = q.s.color === STAR_DIM || q.s.weight < 0.72 ? 1 : 0;
            const key = db + '|' + dim + '|' + col;
            let arr = starBuckets.get(key);
            if (!arr) {
              arr = [];
              starBuckets.set(key, arr);
            }
            arr.push(q.x, q.y, q.s.size * CLOUD_GAIN[q.cloud], q.k);
          }
          if (SKY_MODE) {
            for (const q of pts) {
              if (q.s.dust) continue;
              const dimStar = q.s.color === STAR_DIM || q.s.weight < 0.72;
              const mag = skyMagOf(q.s.weight, q.s.bead);
              const r = skyStarRadius(mag, SKY_FOV, SKY_STAR_SCALE) * (dimStar ? 0.62 : 1);
              ctx.globalAlpha = dimStar ? 0.42 : 0.48 + SKY_STAR_SCALE * r / 22;
              const orb = orbOf(q.s.color === STAR_DIM ? "#8fa3c8" : q.s.color);
              const orbR = r * 1.55;
              ctx.drawImage(orb, q.x - orbR, q.y - orbR, orbR * 2, orbR * 2);
              if (q.s.bead && !dimStar) {
                ctx.globalAlpha = 0.5;
                ctx.strokeStyle = q.s.color;
                ctx.lineWidth = 0.7;
                ctx.beginPath();
                ctx.moveTo(q.x - r * 3, q.y);
                ctx.lineTo(q.x + r * 3, q.y);
                ctx.moveTo(q.x, q.y - r * 3);
                ctx.lineTo(q.x, q.y + r * 3);
                ctx.stroke();
              }
            }
            ctx.globalAlpha = 1;
          }
          for (const [key, arr] of SKY_MODE ? [] : starBuckets) {
            const b1 = key.indexOf("|");
            const b2 = key.indexOf("|", b1 + 1);
            const db = Number(key.slice(0, b1));
            const dim = key.slice(b1 + 1, b2) === "1";
            const col = key.slice(b2 + 1);
            const depth = (db + 0.5) / NB;
            ctx.globalAlpha = (0.10 + depth * 0.40) * (dim ? 0.45 : 1);
            ctx.fillStyle = col;
            const szf = 0.7 + depth * 1.1;
            for (let i = 0; i < arr.length; i += 4) {
              const sz = Math.max(1.25, Math.min(3.2, szf * arr[i + 2] * (arr[i + 3] / kRef) * 1.95));
              ctx.fillRect(arr[i] - sz / 2, arr[i + 1] - sz / 2, sz, sz);
            }
          }
          ctx.globalAlpha = 1;
          if (!SKY_MODE && !focusKey && linkSeg.length > 0) {
            const want = Math.min(48, Math.max(10, Math.floor(linkSeg.length / 70)));
            for (let i4 = 0; i4 < want; i4++) {
              const seg = linkSeg[(i4 * 92821 + 7) % linkSeg.length];
              const ph = i4 * 37 % 100 / 100;
              const sp = 0.09 + i4 * 13 % 100 / 700;
              const u = (T * sp + ph) % 1;
              const x = seg[0] + (seg[2] - seg[0]) * u;
              const y = seg[1] + (seg[3] - seg[1]) * u;
              if (x < -20 || x > W + 20 || y < -20 || y > H + 20) continue;
              const sz = 5;
              ctx.globalAlpha = 0.14 + 0.86 * Math.sin(Math.PI * u);
              ctx.drawImage(spriteOf("#a9c6ff"), x - sz / 2, y - sz / 2, sz, sz);
            }
          }
          ctx.globalAlpha = 1;
          const personHits = [];
          for (const ps of scene.persons) {
            const p = project(ps.x, ps.y, ps.z);
            const k = kOf(p[2]);
            const x = cx + p[0] * k;
            const y = cy + p[1] * k;
            const r = Math.max(1.6, 2.4 * (k / (small * 1.24)));
            const near = Math.max(0.35, 1 - Math.abs(p[2]) / 4.2);
            ctx.globalAlpha = 0.42 * near;
            ctx.drawImage(orbOf("#ffd479"), x - r * 1.6, y - r * 1.6, r * 3.2, r * 3.2);
            ctx.globalAlpha = 0.75 * near;
            ctx.fillStyle = "#ffe9b8";
            ctx.beginPath();
            ctx.arc(x, y, r * 0.5, 0, Math.PI * 2);
            ctx.fill();
            personHits.push({ x, y, r: Math.max(7, r * 2.6), p: ps });
          }
          ctx.globalAlpha = 1;
          if (wrapRef.current && frame % 12 === 0) {
            wrapRef.current.dataset.personsCount = String(scene.persons.length);
            wrapRef.current.dataset.persons = JSON.stringify(
              personHits.slice(0, 24).map((h) => ({
                x: Math.round((h.x - W / 2) / small * 1e3) / 1e3,
                y: Math.round((h.y - H / 2) / small * 1e3) / 1e3,
                name: h.p.name,
                rel: h.p.relations
              }))
            );
          }
          personHitList = personHits;
          for (const b of scene.blocks) {
            const p = project(b.x, b.y, b.z);
            const k = kOf(p[2]);
            const x = cx + p[0] * k;
            const y = cy + p[1] * k;
            const r = Math.max(1.4, 2.6 * (k / (small * 1.24)));
            ctx.globalAlpha = 0.50;
            ctx.fillStyle = "#f2eaff";
            ctx.beginPath();
            ctx.arc(x, y, r, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.globalAlpha = 1;
          ctx.globalCompositeOperation = "source-over";
          if (frame % 12 === 0 && wrapRef.current) {
            wrapRef.current.dataset.wiki = JSON.stringify(model.clouds.wiki.points.map((q) => ({ id: q.id, l: q.label, c: q.count ?? 0 })));
            canvas.dataset.webId = Object.keys(webMap ?? {}).sort()[0] ?? "none";
            {
              let best = starHits[0];
              for (const h of starHits) if ((h.s.deg ?? 0) > (best?.s.deg ?? 0)) best = h;
              if (best) {
                canvas.dataset.hot = JSON.stringify({
                  x: Math.round((best.x - W / 2) / small * 1e3) / 1e3,
                  y: Math.round((best.y - H / 2) / small * 1e3) / 1e3,
                  d: best.s.deg ?? 0,
                  t: best.s.tag ?? "",
                  c: best.cloud
                });
              }
            }
            wrapRef.current.dataset.stars = JSON.stringify(
              starHits.slice(0, 12).map((h) => ({
                x: Math.round((h.x - W / 2) / small * 1e3) / 1e3,
                y: Math.round((h.y - H / 2) / small * 1e3) / 1e3,
                c: h.cloud,
                t: h.s.tag ?? "",
                d: h.s.deg ?? 0
              }))
            );
            const norm: Record<string, [number, number]> = {};
            for (const [key, p] of proj) norm[key] = [Math.round((p.x - W / 2) / small * 1e3) / 1e3, Math.round((p.y - H / 2) / small * 1e3) / 1e3];
            wrapRef.current.dataset.centers = JSON.stringify(norm);
          }
        } catch (e: any) {
          if (wrapRef.current) wrapRef.current.dataset.paintErr = String(e instanceof Error ? e.message + " @ " + (e.stack || "").split("\n")[1] : e);
        }
        raf = requestAnimationFrame(paint);
      };
      raf = requestAnimationFrame(paint);
      const hit = (x: number, y: number) => {
        let best = null;
        let bestD = 1e9;
        for (const c of scene.clouds) {
          if (focusKey && c.key !== focusKey) continue;
          const p = proj.get(c.key);
          if (!p) continue;
          const d = Math.hypot(p.x - x, p.y - y);
          const lim = Math.max(46, c.r * p.k * 0.95);
          if (d < lim && d < bestD) {
            best = c.key;
            bestD = d;
          }
        }
        return best;
      };
      const onPointerDown = (e: PointerEvent) => {
        dragging = true;
        moved = 0;
        lastX = e.clientX;
        lastY = e.clientY;
        canvas.style.cursor = "grabbing";
        canvas.setPointerCapture(e.pointerId);
      };
      const onPointerMove = (e: PointerEvent) => {
        const rect = canvas.getBoundingClientRect();
        if (!dragging) {
          canvas.style.cursor = hit(e.clientX - rect.left, e.clientY - rect.top) ? "pointer" : "grab";
          return;
        }
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        lastX = e.clientX;
        lastY = e.clientY;
        moved += Math.abs(dx) + Math.abs(dy);
        /* 只转角度：横向 = 盘面内的角（自转轴不动），纵向 = 俯仰。
           任何角度都不移动原点，所以灵魂恒星在画面上始终钉在正中。 */
        const rollD = dx * 0.0055;
        if (rollD) rotateRoll(rollD);
        rollVel = rollD;
        tiltVel = applyTilt(dy * 0.0042);
      };
      const onPointerUp = (e: PointerEvent) => {
        dragging = false;
        canvas.style.cursor = "grab";
        if (moved > 6) return;
        const rect = canvas.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;
        let pick = null;
        let pickD = 1e9;
        for (const h of starHits) {
          const d = Math.hypot(h.x - px, h.y - py);
          if (d <= h.r && d < pickD) {
            pick = h;
            pickD = d;
          }
        }
        if (pick) {
          selectStar(pick.cloud, pick.s);
          return;
        }
        for (const h of personHitList) {
          if (Math.hypot(h.x - px, h.y - py) <= h.r) {
            setSelPerson({ name: h.p.name, key: h.p.key, relations: h.p.relations });
            selWorld.current = { x: h.p.x, y: h.p.y, z: h.p.z };
            return;
          }
        }
        const k = hit(px, py);
        if (!k) {
          selWorld.current = null;
          setSel(null);
          if (focusKey) focusOn(null);
          return;
        }
        if (focusKey === k) {
          focusOn(null);
          return;
        }
        focusOn(k);
      };
      const selectStar = (cloud: CloudKey, st: any) => {
        selWorld.current = { x: st.x, y: st.y, z: st.z };
        selNode.current = { cloud, s: st };
        const near = (p: number[]) => Math.abs(p[0] - st.x) < 1e-4 && Math.abs(p[1] - st.y) < 1e-4 && Math.abs(p[2] - st.z) < 1e-4;
        const k3 = (x: number, y: number, z: number) => x.toFixed(4) + "," + y.toFixed(4) + "," + z.toFixed(4);
        const starAt = new Map<string, { cloud: CloudKey; s: any }>();
        for (const c of scene.clouds) for (const x of c.stars) starAt.set(k3(x.x, x.y, x.z), { cloud: c.key, s: x });
        const neighbors = [];
        let degree = 0;
        for (const lk of scene.links) {
          const a = near(lk.a);
          const b = near(lk.b);
          if (!a && !b) continue;
          degree++;
          if (neighbors.length >= 24) continue;
          const other = starAt.get(k3(...a ? lk.b : lk.a));
          neighbors.push({
            s: other?.s,
            tag: other?.s.tag ?? "星点",
            cloud: other?.cloud ?? cloud,
            rel: lk.rel ?? "关联",
            lit: (other?.s.weight ?? 0) > 0.8,
            degree: other?.s.deg ?? 0,
            x: a ? lk.b[0] : lk.a[0],
            y: a ? lk.b[1] : lk.a[1],
            z: a ? lk.b[2] : lk.a[2]
          });
        }
        setSel({ cloud, tag: st.tag ?? "星点", lit: st.weight > 0.8, degree, pages: st.pages ?? 0, library: st.library, group: st.group, x: st.x, y: st.y, z: st.z, neighbors });
      };
      selectStarRef.current = selectStar;
      const devHook = ((import.meta as any).env?.DEV === true) || (window as any).__FB_DEV === true;
      if (devHook) {
        (window as any).__fbPick = (cloud: CloudKey, idx: number) => {
          const c = scene.clouds.find((x) => x.key === cloud);
          if (c && c.stars[idx]) selectStarRef.current(cloud, c.stars[idx]);
        };
        (window as any).__fbStars = scene.clouds.map((c) => ({ key: c.key, n: c.stars.length }));
      }
      const onWheel = (e: WheelEvent) => {
        e.preventDefault();
        const factor = Math.exp(-e.deltaY * 12e-4);
        targetZoom = Math.max(BASE_ZOOM * 0.45, Math.min(BASE_ZOOM * 3.6, targetZoom * factor));
      };
      const onKey = (e: KeyboardEvent) => {
        if (e.code === "Space") {
          e.preventDefault();
          pausedLocal = !pausedLocal;
          setPaused(pausedLocal);
        } else if (e.key === "r" || e.key === "R") {
          resetRot();
          targetZoom = BASE_ZOOM;
          targetOffX = 0;
          targetOffY = 0;
          offX = 0;
          offY = 0;
          rollVel = 0;
          tiltVel = 0;
          tiltSum = 0;
        } else if (e.key === "Escape") {
          selWorld.current = null;
          setSel(null);
          if (focusKey) focusOn(null);
        }
      };
      const onDblClick = (e: MouseEvent) => {
        const rect = canvas.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;
        let pick = null;
        let pickD = 1e9;
        for (const h of starHits) {
          const d = Math.hypot(h.x - px, h.y - py);
          if (d <= h.r && d < pickD) {
            pick = h;
            pickD = d;
          }
        }
        if (pick) {
          selectStar(pick.cloud, pick.s);
          return;
        }
        const k = hit(px, py);
        if (k) onOpenRef.current(k);
      };
      canvas.addEventListener("pointerdown", onPointerDown);
      canvas.addEventListener("pointermove", onPointerMove);
      canvas.addEventListener("pointerup", onPointerUp);
      canvas.addEventListener("wheel", onWheel, { passive: false });
      canvas.addEventListener("dblclick", onDblClick);
      window.addEventListener("keydown", onKey);
      return () => {
        cancelAnimationFrame(raf);
        ro.disconnect();
        canvas.removeEventListener("pointerdown", onPointerDown);
        canvas.removeEventListener("pointermove", onPointerMove);
        canvas.removeEventListener("pointerup", onPointerUp);
        canvas.removeEventListener("wheel", onWheel);
        canvas.removeEventListener("dblclick", onDblClick);
        window.removeEventListener("keydown", onKey);
      };
    }, [sceneKey, graphKey, webKey, focus, teamId, agentId]);
    const ERR_LABEL = {
      "soul-card": "人格卡",
      "soul-persons": "人物档案",
      knowledge: "知识库",
      chatMemory: "记忆块",
      layer: "记忆分层",
      wiki: "典籍星云",
      code: "构筑星云",
      skills: "技艺星云",
      "skills.team": "技艺星云（团队可见）",
      overview: "星图总览"
    };
    const errList = Array.from(new Set(Object.keys(errors).map((k) => (ERR_LABEL as Record<string, string>)[k] ?? k)));
    const focusTitle = focus ? CLOUD_LABEL[focus].zh : "";
    if (!teamId || !agentId) {
      return <div className="five-bodies fb-status">先选团队与智能体</div>;
    }
    const cards = (
      <>
        {selPerson ? (
          <div className="fb-sel" data-testid="person-detail">
            <button
              type="button"
              className="fb-sel-x"
              onClick={() => {
                setSelPerson(null);
                selWorld.current = null;
              }}
              aria-label="关闭"
            >
              ×
            </button>
            <div className="fb-sel-kicker">人物档案</div>
            <div className="fb-sel-title">{selPerson.name}</div>
            <div className="fb-sel-grid">
              <span>关系边</span>
              <b>{selPerson.relations}</b>
            </div>
            <div className="fb-sel-actions">
              <button type="button" onClick={onOpenPersona}>进入人物档案</button>
              <button
                type="button"
                onClick={() => {
                  setSelPerson(null);
                  selWorld.current = null;
                }}
              >
                关闭
              </button>
            </div>
          </div>
        ) : null}
        {sel ? (
          <div className="fb-sel" data-testid="star-detail">
            <div className="fb-sel-head">
              <span>{CLOUD_LABEL[sel.cloud].zh}</span>
              <button
                type="button"
                onClick={() => {
                  selWorld.current = null;
                  selNode.current = null;
                  setSel(null);
                }}
              >
                ×
              </button>
            </div>
            <div className="fb-sel-row">
              <span>{sel.library ? '分块' : sel.cloud === 'wiki' ? '库' : sel.cloud === 'code' ? '图' : '对象'}</span>
              <b>{sel.tag}</b>
            </div>
            {sel.library ? (
              <div className="fb-sel-row" data-testid="overview-library">
                <span>所属库</span>
                <b>{sel.library}</b>
              </div>
            ) : null}
            <div className="fb-sel-row">
              <span>状态</span>
              <b>{sel.lit ? '已点亮' : '未挂载'}</b>
            </div>
            <div className="fb-sel-row">
              <span>关联线</span>
              <b>{sel.degree} 条</b>
            </div>
            {sel.group ? (
              <div className="fb-sel-row" data-testid="sel-constellation">
                <span>星座</span>
                <b>{sel.group}</b>
              </div>
            ) : null}
            {sel.neighbors.length ? (
              <div className="fb-sel-near">
                <div className="fb-sel-near-head">关联星点</div>
                {sel.neighbors.map((n, i) => (
                  <button
                    key={n.tag + i}
                    type="button"
                    className="fb-sel-near-row"
                    onClick={() => {
                      if (n.s) {
                        selectStarRef.current(n.cloud, n.s);
                        return;
                      }
                      selWorld.current = { x: n.x, y: n.y, z: n.z };
                      setSel({ cloud: n.cloud, tag: n.tag, lit: n.lit, degree: n.degree, pages: 0, x: n.x, y: n.y, z: n.z, neighbors: [] });
                    }}
                  >
                    <span className="fb-sel-near-rel">{n.rel}</span>
                    <span className="fb-sel-near-tag">{n.tag}</span>
                    <span className="fb-sel-near-deg">{n.degree}</span>
                  </button>
                ))}
              </div>
            ) : null}
            <div className="fb-sel-actions">
              <button type="button" onClick={() => onOpen(sel.cloud)}>
                进入{CLOUD_LABEL[sel.cloud].zh}
              </button>
              {sel.cloud === 'memory' ? <button type="button" onClick={onOpenPersona}>看人格卡</button> : null}
            </div>
          </div>
        ) : null}
      </>
    );
    return (
      <div
        ref={wrapRef}
        className="five-bodies"
        data-testid="five-bodies"
        data-counts={counts}
        data-focus={focus ?? 'none'}
      >
        <canvas ref={canvasRef} className="fb-canvas" />
        <div className="fb-hint">
          {paused ? '已暂停 · 空格继续' : '拖拽旋转 · 滚轮缩放 · 空格暂停 · R 归位 · 单击星云聚焦'}
        </div>
        {focus ? (
          <div className="fb-focus">
            <span>{focusTitle}</span>
            <button type="button" data-act="enter" onClick={() => onOpen(focus)}>进入</button>
            <button type="button" onClick={() => onFocusChange && onFocusChange(null)}>返回全景</button>
          </div>
        ) : null}
        {slot ? createPortal(cards, slot) : <div className="st-card-stack">{cards}</div>}
        {loading ? <div className="fb-status">正在取数…</div> : null}
        {errList.length > 0 ? (
          <div className="fb-status fb-status-warn">
            部分未采集：{errList.join('、')}
            <button
              type="button"
              className="fb-refresh"
              onClick={() => {
                setErrors({});
                setModel(null);
                setLoading(true);
                if (teamId && agentId) {
                  loadOverview({ teamId, agentId, force: true }).then((m) => {
                    setModel(m);
                    setErrors(m.errors);
                    setLoading(false);
                  }).catch((e) => {
                    setErrors({ overview: e instanceof Error ? e.message : String(e) });
                    setLoading(false);
                  });
                }
              }}
            >
              刷新
            </button>
          </div>
        ) : null}
      </div>
    );
  }
