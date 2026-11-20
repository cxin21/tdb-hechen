/**
 * 星图投影与画法 —— 整段移植自 VirtualSky（Stuart Lowe，https://slowe.github.io/VirtualSky/）。
 * 参考源码 virtualsky.js 共 3,592 行，落点：
 *   projections.stereo.azel2xy   :386-398
 *   drawStars                    :2599-2633
 *   drawConstellationLines       :2804-2870
 *   drawGridlines               :3099-3149
 *   joinpoint                    :3213-3241
 *   maxLine                      :3243-3247
 *   colours.normal               :858-878
 *
 * 除下列三处适配外逐行照抄（用户 m06192「你抄就抄全了啊…你先把代码扒下来再改」）：
 *  ①星点颜色用本项目的云/层色板（参考实现是单色 stars:'rgb(255,255,255)'）；
 *  ②星等由真实数据权重反推（参考实现直接读星表 mag），函数是 skyMagOf；
 *  ③网格与星座线挂在我们的画布坐标上（map 回调），投影公式一行未动。
 */

/** 参考实现的立体投影系数 f = 0.42（virtualsky.js:389）。 */
export const SKY_F = 0.42;

/** 参考实现的配色（virtualsky.js:858-878 colours.normal）。 */
export const SKY_COL = {
  stars: 'rgb(255,255,255)',
  constellation: 'rgba(180,180,255,0.8)',
  az: 'rgba(100,100,255,0.4)',
  eq: 'rgba(255,100,100,0.4)',
  gal: 'rgba(100,200,255,0.4)',
} as const;

export interface SkyXY {
  x: number;
  y: number;
  el: number;
}

/** 参考实现 projections.stereo.azel2xy（virtualsky.js:386-398），公式逐字照抄。 */
export function stereoAzElToXY(az: number, el: number, w: number, h: number): SkyXY {
  const f = SKY_F;
  const sinel1 = 0;
  const cosel1 = 1;
  const cosaz = Math.cos(az - Math.PI);
  const sinaz = Math.sin(az - Math.PI);
  const sinel = Math.sin(el);
  const cosel = Math.cos(el);
  const k = 2 / (1 + sinel1 * sinel + cosel1 * cosel * cosaz);
  return {
    x: w / 2 + f * k * h * cosel * sinaz,
    y: h - f * k * h * (cosel1 * sinel - sinel1 * cosel * cosaz),
    el,
  };
}

/** 参考实现 maxLine(f)（virtualsky.js:3243-3247）：连线长度上限，超过就断笔。 */
export function maxLine(tall: number, f = 3): number {
  return tall / f;
}

/** 参考实现 drawStars 的半径（virtualsky.js:2608-2623）：d = 0.8*max(3-mag/2.1,0.5)*fovf*scale。 */
export function skyStarRadius(mag: number, fov: number, scaleStars = 1): number {
  const fovf = Math.sqrt(30 / Math.max(1, fov));
  return 0.8 * Math.max(3 - mag / 2.1, 0.5) * fovf * scaleStars;
}

/**
 * 适配②：权重 → 星等。参考实现读星表的 mag（越小越亮），
 * 我们的真实数据只有权重（越大越重要），所以按 0.4～6.2 等线性反推。
 */
export function skyMagOf(weight: number, bead = false): number {
  const w = Math.max(0.06, Math.min(1, weight));
  return Math.max(0.4, 6.2 - w * 5.4 - (bead ? 0.6 : 0));
}

/** 画布映射：把 (az, el) 换成屏幕坐标。默认就是参考实现的立体投影。 */
export type SkyMap = (az: number, el: number) => SkyXY;

export interface SkyGridOptions {
  kind?: 'az';
  /** 网格间隔，单位「度」，参考实现默认 grid.step = 30。 */
  step?: number;
  colour?: string;
  lineWidth?: number;
  tall?: number;
  map?: SkyMap;
}

/**
 * 参考实现 drawGridlines + joinpoint（virtualsky.js:3099-3149 / 3213-3241）。
 * 经线循环在外、纬线循环在内，都是「一笔画到底、跳太远才 moveTo」，
 * 所以网格是连续的曲线而不是一堆短线段。
 */
export function drawSkyGrid(ctx: CanvasRenderingContext2D, w: number, h: number, opts: SkyGridOptions = {}): void {
  const kind = opts.kind ?? 'az';
  const stepDeg = typeof opts.step === 'number' ? opts.step : 30;
  const colour = opts.colour ?? SKY_COL[kind];
  const lineWidth = opts.lineWidth ?? 1;
  const tall = opts.tall ?? h;
  const map: SkyMap = opts.map ?? ((az, el) => stereoAzElToXY(az, el, w, h));
  const d2r = Math.PI / 180;
  const step = stepDeg * d2r;
  let bstep = 2 * d2r;
  const maxl = maxLine(tall, 5);
  const old = { x: -1, y: -1, moved: false };
  const join = (az: number, el: number) => {
    const pos = map(az, el);
    if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return;
    if (kind === 'az') {
      if (!old.moved || Math.sqrt(Math.pow(old.x - pos.x, 2) + Math.pow(old.y - pos.y, 2)) > tall / 2) ctx.moveTo(pos.x, pos.y);
      ctx.lineTo(pos.x, pos.y);
      old.moved = true;
    } else if (!old.moved || Math.sqrt(Math.pow(old.x - pos.x, 2) + Math.pow(old.y - pos.y, 2)) > maxl) {
      ctx.moveTo(pos.x, pos.y);
      old.moved = true;
    } else {
      ctx.lineTo(pos.x, pos.y);
    }
    old.x = pos.x;
    old.y = pos.y;
  };

  ctx.beginPath();
  ctx.strokeStyle = colour;
  ctx.lineWidth = lineWidth;
  /* 经线：方位角走一圈，仰角从 0 到 88° 每 2° 取一点 */
  const maxb = (90 - 2) * d2r;
  const minb = 0;
  for (let a = 0; a < Math.PI * 2; a += step) {
    old.moved = false;
    for (let b = minb; b <= maxb; b += bstep) join(a, b);
  }
  ctx.stroke();

  /* 纬线：仰角每隔 step 画一圈，方位角每 2° 取一点 */
  bstep = 2 * d2r;
  ctx.beginPath();
  const minb2 = 0;
  const maxb2 = 90 - bstep / d2r;
  for (let b = minb2; b < maxb2; b += step) {
    old.moved = false;
    for (let a = 0; a <= Math.PI * 2; a += bstep) join(a, b * d2r);
  }
  ctx.stroke();
}

export interface SkySegment {
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

/**
 * 参考实现 drawConstellationLines（virtualsky.js:2804-2870）的骨架：
 * 单色、单条 path、lineWidth 默认 0.75，长度超过 maxLine() 的段直接舍弃
 * （参考实现原话注释：constellations behind us often have very long lines so we'll zap them）。
 */
export function drawConstellationLines(
  ctx: CanvasRenderingContext2D,
  segs: SkySegment[],
  tall: number,
  colour: string = SKY_COL.constellation,
  lineWidth = 0.75,
): number {
  const maxl = maxLine(tall);
  ctx.beginPath();
  ctx.strokeStyle = colour;
  ctx.lineWidth = lineWidth;
  let drawn = 0;
  for (const sg of segs) {
    if (Math.abs(sg.ax - sg.bx) >= maxl || Math.abs(sg.ay - sg.by) >= maxl) continue;
    ctx.moveTo(sg.ax, sg.ay);
    ctx.lineTo(sg.bx, sg.by);
    drawn += 1;
  }
  ctx.stroke();
  return drawn;
}

/**
 * 参考实现 drawStars 的描边环（virtualsky.js:2604-2630）：
 * 所有星点累积在同一条 path 里，最后一次 fill —— 密集星场才不会被逐颗 stroke 拖慢。
 */
export function stencilStar(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.moveTo(x + r, y);
  ctx.arc(x, y, r, 0, Math.PI * 2, true);
}
