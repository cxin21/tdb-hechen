/**
 * starmap/engine/Starfield.tsx — 星图画布引擎。
 *
 * 深空底 → 星云雾 → 星尘 → 旋臂 → 轨道 → 关系线 → 光点 → 星门锚点 → 脉冲。
 * 纯 Canvas 2D + 手工三维投影，无 WebGL、无图表库。
 */
import { useEffect, useRef } from 'react';
import {
  KIND_COLOR,
  fbm,
  layoutNodes,
  makeArms,
  makeDust,
  mulberry32,
  project,
  rotate,
  type MapLink,
  type MapNode,
  type Vec3,
} from './geometry';

export interface StationAnchor {
  id: string;
  label: string;
  en: string;
  /** 外层环上的角度（弧度） */
  angle: number;
  /** 环半径 */
  radius: number;
  /** 高度 */
  height: number;
}

interface Props {
  nodes: MapNode[];
  links: MapLink[];
  stations: StationAnchor[];
  focusId: string | null;
  activeStation: string | null;
  onPickNode: (id: string | null) => void;
  onPickStation: (id: string) => void;
  onHover: (node: MapNode | null, screen: { x: number; y: number } | null) => void;
}

const DUST = 190;
const ARM_ARM = 3;
const ARM_PER = 190;
const PULSES = 9;

interface Sprite {
  canvas: HTMLCanvasElement;
  size: number;
}

function makeSprite(color: string, size: number): Sprite {
  const c = document.createElement('canvas');
  c.width = c.height = size * 2;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(size, size, 0, size, size, size);
  grad.addColorStop(0, 'rgba(255,255,255,0.95)');
  grad.addColorStop(0.18, color);
  grad.addColorStop(0.55, hexA(color, 0.28));
  grad.addColorStop(1, hexA(color, 0));
  g.fillStyle = grad;
  g.beginPath();
  g.arc(size, size, size, 0, Math.PI * 2);
  g.fill();
  return { canvas: c, size };
}

function hexA(hex: string, a: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

export default function Starfield(props: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    let w = 0, h = 0, dpr = 1;
    let raf = 0;
    let yaw = 0.4, pitch = -0.16, zoom = 1;
    let targetZoom = 1;
    let vyaw = 0.00022, vpitch = 0;
    let dragging = false;
    let lastX = 0, lastY = 0;
    let paused = false;
    let hoverId: string | null = null;
    let stationHit: string | null = null;
    let dust = makeDust(DUST, 20261110);
    let arms = makeArms(ARM_ARM, ARM_PER, 90210);
    let bg: HTMLCanvasElement | null = null;
    let nodePos: Vec3[] = [];
    let lastNodeKey = '';
    const screenMap = new Map<string, { x: number; y: number; r: number; depth: number }>();
    const stationScreen = new Map<string, { x: number; y: number; r: number }>();
    const sprites = new Map<string, Sprite>();
    for (const [k, color] of Object.entries(KIND_COLOR)) sprites.set(k, makeSprite(color, 26));
    sprites.set('station', makeSprite('#9fd0ff', 34));

    const rnd = mulberry32(777);
    const pulses = Array.from({ length: PULSES }, () => ({
      link: Math.floor(rnd() * 999),
      t: rnd(),
      speed: 0.05 + rnd() * 0.09,
    }));

    /* ---------- 背景烘焙 ---------- */
    function bakeBackground() {
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.floor(w * dpr));
      c.height = Math.max(1, Math.floor(h * dpr));
      const g = c.getContext('2d')!;
      g.scale(dpr, dpr);

      const base = g.createRadialGradient(w * 0.5, h * 0.46, 0, w * 0.5, h * 0.46, Math.max(w, h) * 0.78);
      base.addColorStop(0, '#0a1224');
      base.addColorStop(0.42, '#070d1a');
      base.addColorStop(1, '#03050b');
      g.fillStyle = base;
      g.fillRect(0, 0, w, h);

      // 两层 fbm 星云（降采样后放大，够快也够软）
      const sw = 220, sh = Math.max(80, Math.round((220 * h) / w));
      const n1 = document.createElement('canvas');
      n1.width = sw; n1.height = sh;
      const n1g = n1.getContext('2d')!;
      const img = n1g.createImageData(sw, sh);
      for (let y = 0; y < sh; y++) {
        for (let x = 0; x < sw; x++) {
          const i = (y * sw + x) * 4;
          const nx = x / sw * 3.4, ny = y / sh * 3.4;
          const v = fbm(nx, ny, 4);
          const v2 = fbm(nx * 1.9 + 11, ny * 1.9 - 7, 3);
          const cloud = Math.max(0, v - 0.44) * 1.9;
          const cool = Math.max(0, v2 - 0.5) * 1.5;
          img.data[i] = 32 + cool * 60;
          img.data[i + 1] = 52 + cloud * 90;
          img.data[i + 2] = 96 + cloud * 150 + cool * 60;
          img.data[i + 3] = Math.min(255, (cloud * 0.72 + cool * 0.5) * 255);
        }
      }
      n1g.putImageData(img, 0, 0);
      g.save();
      g.globalCompositeOperation = 'screen';
      g.globalAlpha = 0.55;
      g.filter = 'blur(12px)';
      g.drawImage(n1, -w * 0.1, -h * 0.1, w * 1.2, h * 1.2);
      g.globalAlpha = 0.4;
      g.drawImage(n1, -w * 0.05, -h * 0.2, w * 1.1, h * 1.3);
      g.restore();

      // 中心白核
      const core = g.createRadialGradient(w * 0.5, h * 0.5, 0, w * 0.5, h * 0.5, Math.min(w, h) * 0.16);
      core.addColorStop(0, 'rgba(190,222,255,.20)');
      core.addColorStop(0.45, 'rgba(120,170,255,.06)');
      core.addColorStop(1, 'rgba(120,170,255,0)');
      g.fillStyle = core;
      g.fillRect(0, 0, w, h);

      // 暗角
      const vin = g.createRadialGradient(w * 0.5, h * 0.5, Math.min(w, h) * 0.32, w * 0.5, h * 0.5, Math.max(w, h) * 0.78);
      vin.addColorStop(0, 'rgba(0,0,0,0)');
      vin.addColorStop(1, 'rgba(0,0,0,.62)');
      g.fillStyle = vin;
      g.fillRect(0, 0, w, h);

      bg = c;
    }

    function resize() {
      const rect = canvas!.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      w = Math.max(1, rect.width);
      h = Math.max(1, rect.height);
      canvas!.width = Math.floor(w * dpr);
      canvas!.height = Math.floor(h * dpr);
      bakeBackground();
    }

    /* ---------- 每帧 ---------- */
    function frame(ts: number) {
      raf = requestAnimationFrame(frame);
      const p = propsRef.current;
      const time = ts / 1000;

      if (!paused) {
        if (!dragging) {
          yaw += vyaw;
          pitch += vpitch;
          vpitch *= 0.95;
          vyaw += (0.00022 - vyaw) * 0.02;
        }
      }
      zoom += (targetZoom - zoom) * 0.12;

      const focal = Math.min(w, h) * 1.02 * zoom;

      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx!.clearRect(0, 0, w, h);
      if (bg) ctx!.drawImage(bg, 0, 0, w, h);

      // ---- 星尘 + 旋臂 ----
      const dustPoints = dust.concat(arms);
      ctx!.globalCompositeOperation = 'lighter';
      for (const s of dustPoints) {
        const rp = rotate(s, yaw * 0.55, pitch * 0.55);
        const pr = project(rp, w, h, focal * 0.92);
        if (!pr.visible) continue;
        const tw = 0.55 + 0.45 * Math.sin(time * 1.4 + s.phase);
        const rad = Math.max(0.35, s.r * pr.scale * 1.5);
        ctx!.globalAlpha = Math.max(0, s.alpha * tw * (pr.depth > 0 ? 0.7 : 1));
        ctx!.fillStyle = s.r > 1.1 ? '#cfe4ff' : '#8fb6e8';
        ctx!.beginPath();
        ctx!.arc(pr.x, pr.y, rad, 0, Math.PI * 2);
        ctx!.fill();
      }
      ctx!.globalAlpha = 1;

      // ---- 轨道 ----
      for (let i = 0; i < 5; i++) {
        const radius = 1.12 + i * 0.33;
        const tilt = 0.16 + i * 0.055;
        ctx!.beginPath();
        for (let a = 0; a <= 128; a++) {
          const ang = (a / 128) * Math.PI * 2;
          const v = { x: Math.cos(ang) * radius, y: Math.sin(ang) * radius * tilt, z: Math.sin(ang) * radius };
          const rp = rotate(v, yaw * 0.9 + i * 0.4, pitch * 0.9);
          const pr = project(rp, w, h, focal);
          if (a === 0) ctx!.moveTo(pr.x, pr.y);
          else ctx!.lineTo(pr.x, pr.y);
        }
        ctx!.strokeStyle = `rgba(${120 + i * 12},${170 + i * 8},255,${0.05 + i * 0.012})`;
        ctx!.lineWidth = 0.7;
        ctx!.stroke();
      }

      // ---- 节点投影 ----
      const key = p.nodes.length + ':' + p.nodes.map((n) => n.id).join(',').slice(0, 400);
      if (key !== lastNodeKey) {
        nodePos = layoutNodes(p.nodes);
        lastNodeKey = key;
      }
      const projected = p.nodes.map((n, i) => {
        const base = nodePos[i] ?? { x: 0, y: 0, z: 0 };
        const rp = rotate(base, yaw, pitch);
        return { n, pr: project(rp, w, h, focal), base };
      });
      projected.sort((a, b) => a.pr.depth - b.pr.depth);
      const projById = new Map<string, { x: number; y: number; visible: boolean; depth: number; scale: number }>();
      for (const { n, pr } of projected) projById.set(n.id, pr);

      // 焦点邻接
      const focus = p.focusId;
      const neighbors = new Set<string>();
      if (focus) {
        for (const l of p.links) {
          const an = p.nodes[l.a]?.id, bn = p.nodes[l.b]?.id;
          if (an === focus && bn) neighbors.add(bn);
          if (bn === focus && an) neighbors.add(an);
        }
      }

      // ---- 关系线 ----
      ctx!.globalCompositeOperation = 'lighter';
      const linkNodes: { a: string; b: string; l: MapLink }[] = [];
      for (const l of p.links) {
        const na = p.nodes[l.a], nb = p.nodes[l.b];
        if (!na || !nb) continue;
        const pa = projById.get(na.id), pb = projById.get(nb.id);
        if (!pa || !pb || !pa.visible || !pb.visible) continue;
        linkNodes.push({ a: na.id, b: nb.id, l });
      }
      const focusRelated = (a: string, b: string) => (focus ? a === focus || b === focus : true);
      const drawLinks = (weightIdx: number) => {
        const alpha = focus ? 0.1 : [0.075, 0.11, 0.16][weightIdx];
        const width = [0.5, 0.75, 1.05][weightIdx];
        ctx!.beginPath();
        for (const { a, b, l } of linkNodes) {
          const k = l.weight > 0.8 ? 2 : l.weight > 0.55 ? 1 : 0;
          if (k !== weightIdx) continue;
          const pa = projById.get(a)!, pb = projById.get(b)!;
          const mx = (pa.x + pb.x) / 2;
          const my = (pa.y + pb.y) / 2;
          const dx = pb.x - pa.x, dy = pb.y - pa.y;
          const curve = 0.08;
          ctx!.moveTo(pa.x, pa.y);
          ctx!.quadraticCurveTo(mx - dy * curve, my + dx * curve, pb.x, pb.y);
        }
        ctx!.strokeStyle = `rgba(140,190,255,${alpha})`;
        ctx!.lineWidth = width;
        ctx!.stroke();
      };
      drawLinks(0); drawLinks(1); drawLinks(2);

      // 焦点邻接高亮
      if (focus) {
        ctx!.beginPath();
        for (const { a, b } of linkNodes) {
          if (!focusRelated(a, b)) continue;
          const pa = projById.get(a)!, pb = projById.get(b)!;
          ctx!.moveTo(pa.x, pa.y);
          ctx!.lineTo(pb.x, pb.y);
        }
        ctx!.strokeStyle = 'rgba(150,205,255,.42)';
        ctx!.lineWidth = 1;
        ctx!.stroke();
      }

      // ---- 光点 ----
      screenMap.clear();
      for (const { n, pr } of projected) {
        if (!pr.visible) continue;
        const isFocus = n.id === focus;
        const isNeighbor = neighbors.has(n.id);
        const dimmed = focus ? !(isFocus || isNeighbor) : false;
        const near = pr.depth > 0;
        const baseR = (near ? 2.4 : 4.2) * (0.62 + n.weight * 0.95) * (0.75 + pr.scale * 0.7);
        const r = Math.max(0.9, baseR * (isFocus ? 1.9 : 1));
        const sprite = sprites.get(n.kind)!;
        const alpha = dimmed ? 0.05 : isFocus ? 1 : isNeighbor ? 0.92 : 0.72;
        const drawSize = Math.max(8, r * 9);
        ctx!.globalAlpha = alpha;
        ctx!.drawImage(sprite.canvas, pr.x - drawSize / 2, pr.y - drawSize / 2, drawSize, drawSize);
        ctx!.globalAlpha = dimmed ? 0.1 : 0.92;
        ctx!.fillStyle = '#f2f8ff';
        ctx!.beginPath();
        ctx!.arc(pr.x, pr.y, Math.max(0.6, r * 0.34), 0, Math.PI * 2);
        ctx!.fill();
        screenMap.set(n.id, { x: pr.x, y: pr.y, r: Math.max(6, r * 2.2), depth: pr.depth });
      }
      ctx!.globalAlpha = 1;

      // ---- 脉冲 ----
      ctx!.globalCompositeOperation = 'lighter';
      for (const pulse of pulses) {
        if (!p.links.length) break;
        const l = p.links[pulse.link % p.links.length];
        const a = screenMap.get(p.nodes[l.a]?.id ?? '');
        const b = screenMap.get(p.nodes[l.b]?.id ?? '');
        if (!a || !b) continue;
        if (!paused) {
          pulse.t += pulse.speed * 0.01;
          if (pulse.t > 1) { pulse.t = 0; pulse.link = Math.floor(Math.random() * p.links.length); }
        }
        const x = a.x + (b.x - a.x) * pulse.t;
        const y = a.y + (b.y - a.y) * pulse.t;
        const g = ctx!.createRadialGradient(x, y, 0, x, y, 7);
        g.addColorStop(0, 'rgba(200,230,255,.85)');
        g.addColorStop(1, 'rgba(140,190,255,0)');
        ctx!.fillStyle = g;
        ctx!.beginPath();
        ctx!.arc(x, y, 7, 0, Math.PI * 2);
        ctx!.fill();
      }
      ctx!.globalAlpha = 1;
      ctx!.globalCompositeOperation = 'source-over';

      // ---- 星门锚点 ----
      stationScreen.clear();
      for (const st of p.stations) {
        const v: Vec3 = {
          x: Math.cos(st.angle) * st.radius,
          y: st.height,
          z: Math.sin(st.angle) * st.radius,
        };
        const rp = rotate(v, yaw * 0.32, pitch * 0.32);
        const pr = project(rp, w, h, focal * 0.96);
        if (!pr.visible) continue;
        const active = st.id === p.activeStation;
        const hovered = st.id === stationHit;
        const radius = (active ? 13 : 9.5) * (0.85 + pr.scale * 0.6);
        stationScreen.set(st.id, { x: pr.x, y: pr.y, r: radius + 10 });

        // 光晕
        const halo = ctx!.createRadialGradient(pr.x, pr.y, 0, pr.x, pr.y, radius * 3.4);
        halo.addColorStop(0, active ? 'rgba(180,220,255,.55)' : 'rgba(150,200,255,.30)');
        halo.addColorStop(0.45, 'rgba(110,170,255,.10)');
        halo.addColorStop(1, 'rgba(110,170,255,0)');
        ctx!.fillStyle = halo;
        ctx!.beginPath();
        ctx!.arc(pr.x, pr.y, radius * 3.4, 0, Math.PI * 2);
        ctx!.fill();

        // 环
        ctx!.beginPath();
        ctx!.arc(pr.x, pr.y, radius, 0, Math.PI * 2);
        ctx!.strokeStyle = active || hovered ? 'rgba(190,225,255,.95)' : 'rgba(150,200,255,.55)';
        ctx!.lineWidth = active ? 1.5 : 1;
        ctx!.stroke();

        // 内点
        ctx!.beginPath();
        ctx!.arc(pr.x, pr.y, active ? 3.4 : 2.4, 0, Math.PI * 2);
        ctx!.fillStyle = active ? '#eaf5ff' : '#a8ccf5';
        ctx!.fill();

        // 刻度
        ctx!.beginPath();
        for (let k = 0; k < 12; k++) {
          const ang = (k / 12) * Math.PI * 2 + time * 0.06;
          const r1 = radius + 3;
          const r2 = radius + (k % 3 === 0 ? 7 : 5);
          ctx!.moveTo(pr.x + Math.cos(ang) * r1, pr.y + Math.sin(ang) * r1);
          ctx!.lineTo(pr.x + Math.cos(ang) * r2, pr.y + Math.sin(ang) * r2);
        }
        ctx!.strokeStyle = 'rgba(140,190,255,.30)';
        ctx!.lineWidth = 0.7;
        ctx!.stroke();

        // 标签
        ctx!.font = '500 10.5px -apple-system, "PingFang SC", system-ui, sans-serif';
        ctx!.textAlign = 'center';
        ctx!.fillStyle = active || hovered ? 'rgba(232,241,255,.95)' : 'rgba(180,205,235,.72)';
        ctx!.fillText(st.label, pr.x, pr.y + radius + 17);
        ctx!.font = '8px -apple-system, system-ui, sans-serif';
        ctx!.fillStyle = 'rgba(120,150,190,.6)';
        ctx!.fillText(st.en.toUpperCase(), pr.x, pr.y + radius + 27);
      }

      // ---- 悬停高亮环 ----
      if (hoverId) {
        const s = screenMap.get(hoverId);
        if (s) {
          ctx!.beginPath();
          ctx!.arc(s.x, s.y, s.r + 4, 0, Math.PI * 2);
          ctx!.strokeStyle = 'rgba(200,230,255,.55)';
          ctx!.lineWidth = 1;
          ctx!.stroke();
        }
      }

      // ---- 提示文字（无数据） ----
      if (!p.nodes.length) {
        ctx!.font = '11px -apple-system, "PingFang SC", system-ui, sans-serif';
        ctx!.textAlign = 'center';
        ctx!.fillStyle = 'rgba(140,170,205,.5)';
        ctx!.fillText('等待记忆数据 · 打开「记忆」星门导入或选择记忆块', w / 2, h * 0.62);
      }
    }

    /* ---------- 交互 ---------- */
    function pick(px: number, py: number): { station: string | null; node: string | null } {
      for (const [id, s] of stationScreen) {
        if (Math.hypot(px - s.x, py - s.y) <= s.r) return { station: id, node: null };
      }
      let best: { id: string; d: number } | null = null;
      for (const [id, s] of screenMap) {
        const d = Math.hypot(px - s.x, py - s.y);
        if (d <= s.r + 2 && (!best || d < best.d)) best = { id, d };
      }
      return { station: null, node: best?.id ?? null };
    }

    const onDown = (e: PointerEvent) => {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      canvas!.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      const rect = canvas!.getBoundingClientRect();
      if (dragging) {
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        yaw += dx * 0.005;
        pitch += dy * 0.0032;
        pitch = Math.max(-1.15, Math.min(1.15, pitch));
        vyaw = dx * 0.0009;
        vpitch = dy * 0.0004;
        lastX = e.clientX;
        lastY = e.clientY;
        return;
      }
      const hit = pick(e.clientX - rect.left, e.clientY - rect.top);
      stationHit = hit.station;
      hoverId = hit.node;
      canvas!.style.cursor = hit.station || hit.node ? 'pointer' : 'grab';
      const p = propsRef.current;
      const node = hit.node ? p.nodes.find((n) => n.id === hit.node) ?? null : null;
      p.onHover(node, node ? { x: e.clientX - rect.left, y: e.clientY - rect.top } : null);
    };
    const onUp = (e: PointerEvent) => {
      const wasDragging = dragging;
      dragging = false;
      try { canvas!.releasePointerCapture(e.pointerId); } catch { /* 已释放 */ }
      if (wasDragging) {
        const rect = canvas!.getBoundingClientRect();
        const moved = Math.hypot(e.clientX - lastX, e.clientY - lastY);
        if (moved > 6) return;
        const hit = pick(e.clientX - rect.left, e.clientY - rect.top);
        const p = propsRef.current;
        if (hit.station) p.onPickStation(hit.station);
        else p.onPickNode(hit.node);
      }
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      targetZoom = Math.max(0.42, Math.min(4.2, targetZoom * (e.deltaY > 0 ? 0.9 : 1.1)));
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space') { paused = !paused; e.preventDefault(); }
      if (e.key === 'r' || e.key === 'R') { yaw = 0.4; pitch = -0.16; targetZoom = 1; }
    };

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKey);
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  return <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }} />;
}
