import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 全景星图的硬约束（都是被视觉复核反复咬过的地方，落成机器断言）：
 * 画布不写字、不随机、不糊大半张画幅、四云四色与四层四色互不相同、
 * 渲染 effect 只认内容签名（放对象进去会导致每帧重挂 → 只画一帧）。
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const five = fs.readFileSync(path.join(root, 'scene/FiveBodies.tsx'), 'utf8');
const layout = fs.readFileSync(path.join(root, 'StarmapLayout.tsx'), 'utf8');
const tokens = fs.readFileSync(path.join(root, 'theme/tokens.css'), 'utf8');

function stripComments(src: string) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

describe('全景星图约束', () => {
  it('画布上不写任何文字（云名与读数都在左栏卡里）', () => {
    const src = stripComments(five);
    expect(src).not.toContain('ctx.fillText');
    expect(src).not.toContain('drawLabels');
  });

  it('不使用 Math.random：同样的输入必须画出同一张星图', () => {
    expect(stripComments(five)).not.toContain('Math.random');
  });

  it('渲染 effect 只依赖内容签名，不依赖对象身份（否则每帧重挂只画一帧）', () => {
    const src = stripComments(five);
    expect(src).toContain('sceneKey');
    expect(src).toContain('graphKey');
    const m = src.match(/\}, \[([^\]]*)\]\);/g) ?? [];
    const depLine = m.find((s) => s.includes('sceneKey'));
    expect(depLine, '找不到带 sceneKey 的依赖数组').toBeTruthy();
    expect(depLine).not.toMatch(/\bgraph\b\s*,|,\s*graph\b/);
    expect(depLine).not.toMatch(/\bweb\b\s*,|,\s*web\b/);
  });

  it('四朵云各自一种色相，且与四层记忆颜色互不相同', () => {
    const grab = (block: string) => (block.match(/'#[0-9a-fA-F]{6}'/g) ?? []).map((s) => s.toLowerCase());
    const blockAt = (marker: string) => {
      const start = five.indexOf(marker);
      return start < 0 ? '' : five.slice(start, five.indexOf('};', start) + 2);
    };
    const cloudBlock = blockAt('const CLOUD_COLOR');
    const layerBlock = blockAt('const LAYER_COLOR');
    const cloudStars = ['memory', 'wiki', 'code', 'skills'].map((k) => {
      const at = cloudBlock.indexOf(k + ': {');
      const seg = cloudBlock.slice(at, at + 160);
      return (seg.match(/'#[0-9a-fA-F]{6}'/g) ?? [])[2];
    });
    expect(new Set(cloudStars).size).toBe(4);
    const all = new Set(grab(cloudBlock));
    for (const hex of grab(layerBlock)) expect(all.has(hex)).toBe(false);
  });

  it('左栏是「星云构成」卡，四行可点聚焦；没有记忆四带与旧样式', () => {
    expect(layout).toContain('data-testid="cloud-composition"');
    expect(layout).toContain('focusCloud');
    expect(stripComments(layout)).not.toContain('记忆四带');
    expect(tokens).not.toContain('.st-cloud-layers');
  });

  it('图例色与画布边色同源（同会话/同人物/引用归属）', () => {
    expect(five).toContain("同会话: '#4ec9d9'");
    expect(five).toContain("同人物: '#f08fa8'");
    expect(five).toContain("引用: '#6fd39a'");
    expect(tokens).toContain('i.l-session { background: #4ec9d9');
    expect(tokens).toContain('i.l-person { background: #f08fa8');
    expect(tokens).toContain('i.l-ref { background: #6fd39a');
  });

  it('螺旋分布逐行照抄 enrichr galaxy-spiral 的 build()', () => {
    const src = stripComments(five);
    // rad 的 1.5 次方（中心更密）、arm 扭转 5.2、三次均匀相减当高斯、core 阈值 0.14、rr ±0.04 抖动
    expect(src).toContain('Math.pow(rand(), 1.5) * 0.95 + 0.02');
    expect(src).toContain('rad0 * 5.2');
    // 臂厚收到 ±0.13：原型 C 的臂是一整条，0.30*(rad0+0.25) 会把臂抹成同心碎片（m00645）
    expect(src).toContain('(rand() + rand() + rand() - 1.5) * 0.19');
    expect(src).toContain('    arm,');
    expect(src).toContain('rad0 < 0.14');
    expect(src).toContain('(rand() - 0.5) * 0.04');
    // 四档色带与粒子尺寸也照抄（s = 0.5 + r()*r()*1.6）
    expect(src).toContain('0.5 + rand() * rand() * 1.6');
    expect(src).toMatch(/const band = rad0 < 0\.22/);
  });

  it('画布上没有「瞄准镜」几何，但总览画细线关系边（m05542 + m05588 ③）', () => {
    const src = stripComments(five);
    expect(src).not.toContain('setLineDash');
    expect(src).toContain('const showLinks = true;');
    expect(src).toContain('for (const lk of showLinks ? scene.links : []) {');
    // 两个分支的线宽/alpha：星图 0.6/0.17，螺旋 0.7/0.13
    expect(src).toContain('ctx.lineWidth = SKY_MODE ? 0.6 : 0.7;');
    expect(src).toContain("(SKY_MODE ? 0.17 : 0.13)");
    // 星图模式只画「星座骨架」：层间提取 / 人物 / 云归属（归属再 1/2 抽样）
    expect(src).toContain("if (!(rel === '提取' || rel === '人物' || rel === '归属')) continue;");
    expect(src).toContain("if (rel === '归属' && (linkSkip >>> 7) % 2 !== 0) continue;");
    // 螺旋分支：只留强关系、只留 1/2，长边必须掐掉（否则读成 3D 线框）
    expect(src).toContain("if (lk.rel === '引用') continue;");
    expect(src).toContain('if (lk.w < 0.55) continue;');
    expect(src).toContain('if ((linkSkip >>> 9) % 2 !== 0) continue;');
    expect(src).toContain('Math.hypot(xb - xa, yb - ya) > small * 0.30');
  });

  it('上屏照抄参考实现的 8 深度桶 × 4 色档 + fillRect，尺寸上限 2.6px、亮度压到不刺眼，并给亮星补柔光', () => {
    const src = stripComments(five);
    expect(src).toContain('const NB = 8;');
    expect(src).toContain("const key = db + '|' + dim + '|' + col;");
    expect(src).toContain('ctx.globalAlpha = (0.10 + depth * 0.40) * (dim ? 0.45 : 1);');
    expect(src).toContain('const szf = 0.7 + depth * 1.1;');
    expect(src).toContain('CLOUD_GAIN[q.cloud]');
    expect(src).toContain('ctx.fillRect(arr[i] - sz / 2, arr[i + 1] - sz / 2, sz, sz);');
    expect(src).toContain('Math.min(3.2, szf * arr[i + 2]');
    // 不再用径向渐变 sprite 铺星点（放大后就是一坨失焦光斑）
    expect(src).not.toContain('drawImage(spriteOf(q.s.color)');
  });

  it('四朵云各有自己的 4 色档，accent 仍取星点自己的颜色（忆云=层色 / 典籍构筑=库色）', () => {
    const src = stripComments(five);
    expect(src).toContain('const CLOUD_SHADES: Record<CloudKey, [string, string, string, string]>');
    expect(src).toContain("const shades = CLOUD_SHADES[q.cloud];");
    expect(src).toContain('q.s.band === 1 ? q.s.color');
    for (const k of ['memory:', 'wiki:', 'code:', 'skills:']) expect(src).toContain(k);
  });

  it('没有真实数据承载的星点一律不画（m05624）', () => {
    const src = stripComments(five);
    expect(src).not.toMatch(/const dustN =/);
    expect(src).not.toContain('cloudDust');
    expect(src).not.toContain('dust: true');
    // 命中仍然跳过 dust 标记（类型与旧数据兼容），但今天没有任何地方再生产它
    expect(src).toContain('if (q.s.dust) continue;');
    expect(src).not.toContain('setLineDash');
  });

  it('中心是分层弥散的核球，不是一个过曝白点', () => {
    const src = stripComments(five);
    expect(src).toContain("rg.addColorStop(0, 'rgba(255,253,255,0.050)')");
    expect(src).toContain("const cr = CORE_R * 1.10 * ck");
    expect(src).toContain('const haloR = CORE_R * 2.9 * ck;');
    expect(src).toContain('const nucA = (isFocus ? 0.26 : 0.16)');
    // 四云气岛叠加会烧成白斑 → 单层 alpha 必须压到 0.15 上下
    expect(src).toContain('const layers: [string, number, number, number][] = [');
    expect(src).toContain('ctx.globalAlpha = al * nucA;');
  });

  it('云朵是三层 fbm 气团 + 每条旋臂一串气体（星云川），不是一圈纯径向渐变', () => {
    const src = stripComments(five);
    expect(src).toContain("import { fbm, nebulaSprite } from './nebula';");
    expect(src).toContain('const sp = nebulaSprite(tint, 3 + li);');
    expect(src).not.toContain('createRadialGradient(at.x, at.y, 0, at.x, at.y, nucR)');
    // 旋臂气团：沿「臂点列」插值铺 14 个气团（原型 C 的雾是臂上的一层，不是一圈圆环）
    expect(src).toContain('const gasArms = c.arms ?? [];');
    expect(src).toContain('const STEPS = 40;');
    expect(src).toContain('const wp0 = applyXf([p0[0] + (p1[0] - p0[0]) * f, p0[1] + (p1[1] - p0[1]) * f, p0[2] + (p1[2] - p0[2]) * f], c.key);');
    expect(src).toContain('const n = fbm(i * 0.19 + ai * 2.7, c.key.length * 3.1, 17);');
    // 体积感靠两块随自转的径向渐变（原型 C 的 0.19 / 0.10）
    expect(src).toContain('const rBlob = Math.max(18, at.k * (0.20 + c.r * 0.18));');
  });

  it('每条旋臂是一条画出来的连续折线，不是只有真实关系边的碎线（m00645 对齐原型 C）', () => {
    const src = stripComments(five);
    expect(src).toContain('const armBuckets: [number, number, number][][] = [];');
    expect(src).toContain('if (s0.arm === undefined) continue;');
    expect(src).toContain('arms: armPaths });');
    expect(src).toContain('for (const path of c.arms ?? []) {');
    expect(src).toContain('ctx.globalAlpha = isFocus ? 0.26 : 0.215;');
  });

  it('四朵云各是一个独立小盘（盘心绕核均布），盘内仍是 enrichr 螺旋', () => {
    const src = stripComments(five);
    expect(src).toContain('const ARM_ANGLE: Record<CloudKey, number> = { memory: -Math.PI / 2, wiki: 0, code: Math.PI / 2, skills: Math.PI };');
    expect(src).toContain('function armPlace(key: CloudKey, u: number, v: number, z: number)');
    // 每朵云是一个完整小盘：盘心绕核均布，盘内仍是 enrichr 的螺旋
    expect(src).toContain('const RING_D = 1.34;');
    expect(src).toContain('const DISC_R = 0.94;');
    expect(src).toContain('function discCenter(key: CloudKey)');
    expect(src).toContain('const c = discCenter(key);');
  });

  it('页脚报「可见连线」而不是 scene.links 总数', () => {
    expect(stripComments(five)).toContain('canvas.dataset.linksShown');
    expect(five).toContain('linksShown: linkDrawn');
    expect(layout).toContain('可见连线 ');
    expect(layout).toContain('连线聚焦后出现 · 共 ');
    expect(layout).not.toContain('画布 {sceneNums ? sceneNums.links');
  });

  it('五条硬要求（m05820/m05843）：星云自转 + 绕人格恒星公转 + 星点去重 + 有连线 + 不刺眼', () => {
    const src = stripComments(five);
    // ① 公转与自转：每朵云速度不同，方向有正有负（不然看起来像整体刚性旋转）
    expect(src).toContain('const ORBIT_SPEED: Record<CloudKey, number> =');
    expect(src).toContain('const SPIN_SPEED: Record<CloudKey, number> =');
    for (const k of ['memory:', 'wiki:', 'code:', 'skills:']) {
      expect(src).toContain(k);
    }
    expect(src).toMatch(/wiki: -0\.0/);
    // ② 刚体变换用在三处：云心、星点、连线端点
    expect(src).toContain('const cc = applyXf(c.center, c.key);');
    expect(src).toContain('const w = applyXf([s.x, s.y, s.z], c.key);');
    expect(src).toContain('const wa = lk.owner ? applyXf(lk.a, lk.owner) : lk.a;');
    expect(src).toContain('lk.toCloud ? applyXf(lk.b, lk.toCloud) : lk.b');
    // ③ 星点去重：网格贪心，且不带随机
    expect(src).toContain('function thinStars(stars: Star3[], minD: number): Star3[]');
    // 阈值按屏幕像素折算成世界单位：271 颗星时臂上没星，就是这条阈值按世界单位定死的（m00788）
    expect(src).toContain('const pxPerUnit = (viewSmall * 0.62 * BASE_ZOOM) / 4.2;');
    expect(src).toContain('const MIN_STAR_PX = 2.8;');
    expect(src).toContain('const kept = thinStars(stars, minDOf(MIN_STAR_PX));');
    // ④ 连线可见：1/2 抽样、长度上限 small*0.30、alpha 桶 * 0.13
    expect(src).toContain('if ((linkSkip >>> 9) % 2 !== 0) continue;');
    expect(src).toContain('Math.hypot(xb - xa, yb - ya) > small * 0.30');
    expect(src).toContain('(SKY_MODE ? 0.17 : 0.13)');
    // ⑤ 亮度上限：星点 ≤2.6px、深度桶 alpha ≤0.70、柔光 alpha ≤0.11
    expect(src).toContain('Math.min(3.2, szf * arr[i + 2]');
    expect(src).toContain('(0.10 + depth * 0.40)');
    expect(src).toContain('? 0.030 : 0.055)');
  });
});
