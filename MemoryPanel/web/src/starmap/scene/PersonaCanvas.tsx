/**
 * starmap/scene/PersonaCanvas.tsx — 人格恒星云（自己的一张星图，不是云页的变体）。
 *
 * 版式：中心一颗大而亮的人格恒星，外面四圈同心：
 *   人格九块（结构）→ 六轴特质（状态）→ 人物档案（关系）→ L3 记忆（养料）。
 *
 * 关系边只画真实存在的四类，不编：
 *   1. 人格 → 九块（组成）：九块就是人格卡本身；
 *   2. 人格 → 六轴（状态）：轴承载漂移，标签只是视图；
 *   3. 人物 → 人格（档案归属）：人物档案记在人格名下；
 *   4. L3 → 人格（提炼）：核心记忆是人格的养料。
 *
 * 视角与选中都放 ref：点星只换 selectedId，绝不把用户手动的旋转/缩放重置回默认。
 */
import { useEffect, useRef } from 'react';
import { makeDust } from './dust';

export type PersonaKind = 'persona' | 'block' | 'trait' | 'person' | 'core';

export interface PersonaStar {
  id: string;
  kind: PersonaKind;
  label: string;
  /** 视觉权重：九块=正文字数、六轴=nowWeight、人物=字段数、养料=显著性；只影响半径 */
  weight: number;
  /** 亮=有内容；暗=空块 / 无证据 / 未落版 */
  lit: boolean;
}

export interface PersonaEdge {
  source: string;
  target: string;
  kind: 'compose' | 'state' | 'archive' | 'feed';
}

interface Props {
  stars: PersonaStar[];
  edges: PersonaEdge[];
  selectedId: string | null;
  onPick: (id: string | null) => void;
}

export const PERSONA_COLOR: Record<PersonaKind, string> = {
  persona: '#fff0c9',
  block: '#9fe6c8',
  trait: '#7fc8ff',
  person: '#ffb86b',
  core: '#ffbe5c',
};

const RING: Record<PersonaKind, number> = { persona: 0, block: 0.66, trait: 1.18, person: 1.72, core: 2.22 };
const RING_ORDER: PersonaKind[] = ['block', 'trait', 'person', 'core'];
const GOLDEN = 2.399963229728653;
const DIM = '#66799b';

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

interface Placed {
  p: PersonaStar;
  pos: [number, number, number];
}

/**
 * 摆位：每圈内部按球面均匀（黄金角）铺开 —— 只在平面上按角度铺，
 * 投影出来是一条被 pitch 压扁的窄带，上下全是空白。
 */
function layoutStars(stars: PersonaStar[]): { placed: Placed[]; byId: Map<string, Placed> } {
  const groups = new Map<PersonaKind, PersonaStar[]>();
  for (const s of stars) {
    if (s.kind === 'persona') continue;
    const list = groups.get(s.kind);
    if (list) list.push(s);
    else groups.set(s.kind, [s]);
  }
  const placed: Placed[] = [];
  const center = stars.find((s) => s.kind === 'persona');
  if (center) placed.push({ p: center, pos: [0, 0, 0] });
  for (const kind of RING_ORDER) {
    const list = groups.get(kind) ?? [];
    const n = list.length;
    const R = RING[kind];
    for (let j = 0; j < n; j += 1) {
      const p = list[j];
      const y = n === 1 ? 0 : 1 - (2 * (j + 0.5)) / n;
      const rxz = Math.sqrt(Math.max(0, 1 - y * y));
      const th = j * GOLDEN + RING[kind] * 1.7;
      /* 圈厚 ±4%：同圈不至于像硬币排在一个球面上 */
      const rr = R * (0.96 + 0.08 * (((hash(p.id) >>> 9) % 1000) / 1000));
      placed.push({ p, pos: [Math.cos(th) * rxz * rr, y * rr, Math.sin(th) * rxz * rr] });
    }
  }
  return { placed, byId: new Map(placed.map((it) => [it.p.id, it])) };
}

function radiusOf(p: PersonaStar): number {
  if (p.kind === 'persona') return 13;
  if (p.kind === 'block') return 4.4 + Math.min(4.2, p.weight / 420);
  if (p.kind === 'trait') return 3.8 + 4.6 * Math.max(0, Math.min(1, p.weight));
  if (p.kind === 'person') return 3.6 + Math.min(4, p.weight * 0.7);
  return 3.2 + Math.min(3, p.weight * 2);
}

export default function PersonaCanvas({ stars, edges, selectedId, onPick }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;

  const dataRef = useRef({ stars, edges, selectedId });
  dataRef.current = { stars, edges, selectedId };

  const viewRef = useRef({ yaw: -0.36, pitch: 0.2, zoom: 1 });
  const layoutRef = useRef<{ src: PersonaStar[]; placed: Placed[]; byId: Map<string, Placed> } | null>(null);
  const dustRef = useRef<{ key: string; d: Float32Array }>({ key: '', d: new Float32Array(0) });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;
    let raf = 0;
    let drag = false;
    let moved = 0;
    let lx = 0;
    let ly = 0;
    const t0 = performance.now();
    const hits: { id: string; x: number; y: number; r: number }[] = [];

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = parent.clientWidth;
      const h = parent.clientHeight;
      canvas.width = Math.max(1, Math.floor(w * dpr));
      canvas.height = Math.max(1, Math.floor(h * dpr));
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(parent);

    /* 焦距：最外圈世界半径 2.22 铺到画布约 46%，前后景深比 1.8:1，不像广角那样中心糊成一团 */
    const project = (x: number, y: number, z: number, w: number, h: number) => {
      const { yaw, pitch, zoom } = viewRef.current;
      const cy = Math.cos(yaw);
      const sy = Math.sin(yaw);
      const cp = Math.cos(pitch);
      const sp = Math.sin(pitch);
      const x1 = x * cy - z * sy;
      const z1 = x * sy + z * cy;
      const y1 = y * cp - z1 * sp;
      const z2 = y * sp + z1 * cp;
      const f = (Math.min(w, h) * 1.52 * zoom) / (z2 + 7.3);
      return { x: w / 2 + x1 * f, y: h / 2 - y1 * f, s: f, z: z2 };
    };

    const draw = (now: number) => {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const { stars: st, edges: eds, selectedId: sel } = dataRef.current;
      /* 人格恒星是原点枢纽：它被选中时不当作「聚焦某颗星」，否则所有边都会变成彩色、其余星全压暗 */
      const focus = sel && sel !== 'persona:root' ? sel : null;
      if (!layoutRef.current || layoutRef.current.src !== st) {
        const built = layoutStars(st);
        layoutRef.current = { src: st, ...built };
      }
      const layout = layoutRef.current;
      const T = (now - t0) / 1000;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = canvas.width / dpr;
      const h = canvas.height / dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      hits.length = 0;

      const dkey = `${Math.round(w)}x${Math.round(h)}`;
      if (dustRef.current.key !== dkey) dustRef.current = { key: dkey, d: makeDust(w, h, 1.8) };
      const dust = dustRef.current.d;
      ctx.fillStyle = '#8fa4c8';
      for (let i = 0; i < dust.length; i += 3) {
        ctx.globalAlpha = dust[i + 2];
        ctx.fillRect(dust[i], dust[i + 1], 1, 1);
      }
      ctx.globalAlpha = 1;

      const cx = w / 2;
      const cy = h / 2;
      const dim = focus ? 0.5 : 1;

      /* 人格恒星的光核：全图唯一允许发光的东西（DESIGN.md：最亮一块必须是星场） */
      const cr = Math.min(w, h) * 0.085 * (1 + 0.02 * Math.sin(T * 0.7));
      const rg = ctx.createRadialGradient(cx, cy, 0, cx, cy, cr);
      rg.addColorStop(0, 'rgba(255,246,222,0.55)');
      rg.addColorStop(0.3, 'rgba(255,224,160,0.22)');
      rg.addColorStop(1, 'rgba(255,224,160,0)');
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = rg;
      ctx.beginPath();
      ctx.arc(cx, cy, cr, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;

      const proj = new Map<string, { x: number; y: number; s: number; z: number }>();
      for (const item of layout.placed) {
        proj.set(item.p.id, project(item.pos[0], item.pos[1], item.pos[2], w, h));
      }

      /* 边：常态极淡，且朝中心一侧淡出，避免二十多条线在恒星处糊成一团蛛网；
         选中时只留与它相连的，并用那颗星的颜色点亮。 */
      for (const e of eds) {
        const a = proj.get(e.source);
        const b = proj.get(e.target);
        if (!a || !b) continue;
        const hot = focus ? e.source === focus || e.target === focus : false;
        if (focus && !hot) continue;
        const star = layout.byId.get(e.source === focus ? e.target : e.source)?.p;
        const tint = star ? PERSONA_COLOR[star.kind] : PERSONA_COLOR.persona;
        /* 边画成向外弓的曲线：直线会让二十多条边在恒星处叠成一个黑点状的窟窿 */
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        const bow = Math.min(46, len * 0.16);
        const cxp = mx + (-dy / len) * bow;
        const cyp = my + (dx / len) * bow;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.quadraticCurveTo(cxp, cyp, b.x, b.y);
        if (hot) {
          ctx.lineWidth = 1;
          ctx.strokeStyle = tint;
          ctx.globalAlpha = 0.8;
        } else {
          const da = Math.hypot(a.x - cx, a.y - cy);
          const db = Math.hypot(b.x - cx, b.y - cy);
          const near = da <= db ? a : b;
          const far = da <= db ? b : a;
          const g = ctx.createLinearGradient(near.x, near.y, far.x, far.y);
          g.addColorStop(0, 'rgba(180,200,230,0.03)');
          g.addColorStop(1, 'rgba(180,200,230,0.30)');
          ctx.lineWidth = 0.9;
          ctx.strokeStyle = g;
          ctx.globalAlpha = 1;
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      const order = [...layout.placed].sort((a, b) => (proj.get(b.p.id)?.z ?? 0) - (proj.get(a.p.id)?.z ?? 0));
      for (const item of order) {
        const q = proj.get(item.p.id);
        if (!q) continue;
        const p = item.p;
        const hot = p.id === sel;
        const lit = p.id === focus;
        const tint = PERSONA_COLOR[p.kind];
        const scale = p.kind === 'persona' ? 1 : q.s / 120;
        const r = Math.max(2.2, radiusOf(p) * scale);
        if (p.kind === 'persona' || p.lit) {
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          ctx.globalAlpha = (p.kind === 'persona' ? 0.5 : hot ? 0.42 : 0.22) * dim;
          ctx.fillStyle = tint;
          ctx.beginPath();
          ctx.arc(q.x, q.y, r * (p.kind === 'persona' ? 2.2 : 2.4), 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
        ctx.globalAlpha = focus && !lit ? 0.24 : p.lit ? 0.95 : 0.42;
        ctx.fillStyle = p.lit || p.kind === 'persona' ? tint : DIM;
        ctx.beginPath();
        ctx.arc(q.x, q.y, hot ? r * 1.14 : r, 0, Math.PI * 2);
        ctx.fill();
        if (hot) {
          ctx.globalAlpha = 0.9;
          ctx.strokeStyle = tint;
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.arc(q.x, q.y, r + 7, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
        hits.push({ id: p.id, x: q.x, y: q.y, r: Math.max(11, r + 6) });
      }

      /* 标签只给人格恒星与选中星：满屏字会盖住星场（DESIGN.md 允许文字，但只有这一种） */
      const labelFor = (id: string, text: string, tint: string, y: number, x: number) => {
        ctx.font = '11.5px var(--font, system-ui), sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = tint;
        ctx.globalAlpha = 0.92;
        ctx.fillText(text, x, y);
        ctx.globalAlpha = 1;
        void id;
      };
      const centerProj = proj.get('persona:root');
      if (centerProj) {
        const total = st.length;
        labelFor('persona:root', `人格 · ${total} 星`, 'rgba(255,244,220,0.95)', centerProj.y + 30, centerProj.x);
      }
      if (sel && sel !== 'persona:root') {
        const s = proj.get(sel);
        const item = layout.byId.get(sel);
        if (s && item) {
          const text = item.p.label.length > 22 ? `${item.p.label.slice(0, 21)}…` : item.p.label;
          labelFor(sel, text, 'rgba(232,241,255,0.95)', s.y - radiusOf(item.p) * 1.9 - 8, s.x);
        }
      }

      if (!drag) viewRef.current.yaw += 0.0011;
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    const onDown = (e: PointerEvent) => {
      drag = true;
      moved = 0;
      lx = e.clientX;
      ly = e.clientY;
    };
    const onMove = (e: PointerEvent) => {
      if (!drag) return;
      const dx = e.clientX - lx;
      const dy = e.clientY - ly;
      moved += Math.abs(dx) + Math.abs(dy);
      lx = e.clientX;
      ly = e.clientY;
      const v = viewRef.current;
      v.yaw += dx * 0.005;
      v.pitch = Math.max(-1.2, Math.min(1.2, v.pitch + dy * 0.004));
    };
    const onUp = (e: PointerEvent) => {
      drag = false;
      if (moved > 6) return;
      const rect = canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      let best: string | null = null;
      let bestD = 1e9;
      for (const hit of hits) {
        const d = Math.hypot(hit.x - px, hit.y - py);
        if (d <= hit.r && d < bestD) {
          best = hit.id;
          bestD = d;
        }
      }
      onPickRef.current(best);
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = viewRef.current;
      v.zoom = Math.max(0.6, Math.min(2.6, v.zoom * Math.exp(-e.deltaY * 0.001)));
    };
    canvas.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('wheel', onWheel);
    };
  }, []);

  return <canvas ref={canvasRef} className="fb-canvas" data-testid="persona-canvas" />;
}
