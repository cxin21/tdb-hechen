/**
 * kit 视觉预览页 v2（离线截图复核用，不进主应用路由）。
 * v2 起按「星场是背景层」的布局：Stage.field = canvas 星场，其余面板浮在上面。
 * 数据全部示例。
 */
import { useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import '../../theme/tokens.css';
import {
  Gate,
  Legend,
  MetricRow,
  Note,
  Pager,
  Row,
  ScopeBar,
  Seg,
  Stage,
  StarDetail,
  Surface,
  Tag,
} from '../index';

const rows = [
  { id: 'a', label: 'L1 · 生产重启固定为备份核 sha256 → dry-run → apply', meta: '3 源', tone: 'l1', active: true },
  { id: 'b', label: 'L0 · 8420 重启后三服务 healthy', meta: '1 源', tone: 'l0' },
  { id: 'c', label: 'L1 · 不要用 alert 做验收提示', meta: '2 源', tone: 'l1' },
  { id: 'd', label: 'L2 · 用户偏好：一手实锤，结论锚 path:line', meta: '7 源', tone: 'l2' },
  { id: 'e', label: 'L3 · 工程审美＝纪律可照抄，门禁只紧不放', meta: '2 源', tone: 'l3' },
];

function rnd(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function StarField() {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const cvs = ref.current;
    if (!cvs) return;
    const ctx = cvs.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = cvs.clientWidth;
    const h = cvs.clientHeight;
    cvs.width = Math.max(1, Math.floor(w * dpr));
    cvs.height = Math.max(1, Math.floor(h * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const cs = getComputedStyle(document.documentElement);
    const pick = (name: string, fallback: string) => (cs.getPropertyValue(name) || fallback).trim();
    const col = {
      persona: pick('--ink', '#e8f1ff'),
      l3: pick('--layer-l3', '#9fe6c8'),
      l2: pick('--layer-l2', '#ffb86b'),
      l1: pick('--layer-l1', '#7fc8ff'),
      l0: pick('--layer-l0', '#7f93bd'),
      dim: pick('--star-dim', '#66799b'),
      edge: 'rgba(180,200,230,0.20)',
    };
    const cx = w * 0.5;
    const cy = h * 0.52;
    const R = Math.min(w, h) * 0.46;
    const rand = rnd(20261111);
    const GOLD = 2.399963229728653;

    type Star = { x: number; y: number; r: number; c: string; dim: boolean; layer: number };
    const stars: Star[] = [];
    const shells = [
      { layer: 3, n: 40, rIn: 0.2, rOut: 0.34, r: 6.5, c: col.l3 },
      { layer: 2, n: 90, rIn: 0.36, rOut: 0.56, r: 5, c: col.l2 },
      { layer: 1, n: 260, rIn: 0.58, rOut: 0.82, r: 4, c: col.l1 },
      { layer: 0, n: 320, rIn: 0.84, rOut: 1, r: 3.2, c: col.l0 },
    ];
    for (const s of shells) {
      for (let i = 0; i < s.n; i += 1) {
        const t = i * GOLD + rand() * 0.35;
        const rr = (s.rIn + (s.rOut - s.rIn) * ((i + rand() * 0.6) / s.n)) * R;
        const dim = rand() < 0.18;
        stars.push({
          layer: s.layer,
          x: cx + Math.cos(t) * rr,
          y: cy + Math.sin(t) * rr * 0.9,
          r: s.r * (dim ? 0.78 : 1),
          c: s.c,
          dim,
        });
      }
    }

    // 关系边：L1 ← L0、L2 ← L1、L3 ← L2（只画外层指向内层的一小部分）
    ctx.strokeStyle = col.edge;
    ctx.lineWidth = 1;
    for (const outer of stars.filter((s) => s.layer <= 2)) {
      const inner = stars.filter((s) => s.layer === outer.layer + 1);
      if (!inner.length) continue;
      const target = inner[Math.floor(rand() * inner.length)];
      if (rand() > 0.12) continue;
      ctx.beginPath();
      ctx.moveTo(outer.x, outer.y);
      ctx.lineTo(target.x, target.y);
      ctx.stroke();
    }

    for (const s of stars) {
      ctx.globalAlpha = s.dim ? 0.42 : 1;
      ctx.fillStyle = s.dim ? col.dim : s.c;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r / 2, 0, Math.PI * 2);
      ctx.fill();
    }

    // 人格恒星：唯一允许发光的东西
    ctx.globalAlpha = 1;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 64);
    g.addColorStop(0, 'rgba(232,241,255,0.42)');
    g.addColorStop(0.45, 'rgba(127,200,255,0.14)');
    g.addColorStop(1, 'rgba(127,200,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, 64, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = col.persona;
    ctx.beginPath();
    ctx.arc(cx, cy, 13, 0, Math.PI * 2);
    ctx.fill();
  }, []);

  return <canvas ref={ref} style={{ width: '100%', height: '100%', display: 'block' }} />;
}

function Scene() {
  return (
    <div className="starmap-root">
    <Stage
      field={<StarField />}
      top={
        <ScopeBar
          teams={[{ id: 't1', label: '用友业务产品部' }]}
          teamId="t1"
          agents={[
            { id: 'a1', label: 'agt-2m7buribzz · MemoryCore owner' },
            { id: 'a2', label: 'agt-2k12lgb650 · 审查者' },
          ]}
          agentId="a1"
          blocks={[{ id: 'b1', label: '记忆块 #12 · 2026-11-10' }]}
          blockId="b1"
          syncedAt="12:03"
          onTeam={() => {}}
          onAgent={() => {}}
          onBlock={() => {}}
          onRefresh={() => {}}
        />
      }
      left={
        <>
          <Surface title="记忆星云 · 筛选" aside={<Tag tone="l1">L1</Tag>} dense>
            <Seg
              value="all"
              options={[
                { value: 'all', label: '全部', count: 26278 },
                { value: 'l3', label: 'L3', count: 1 },
                { value: 'l2', label: 'L2', count: 15 },
                { value: 'l1', label: 'L1', count: 11480 },
                { value: 'l0', label: 'L0', count: 14782 },
              ]}
              onChange={() => {}}
            />
            <MetricRow
              items={[
                { k: '本页', v: 100, unit: '颗', tone: 'l1' },
                { k: '已挂载', v: 11480, unit: '条' },
              ]}
            />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 8 }}>
              {rows.map((r) => (
                <Row
                  key={r.id}
                  leading={<span className={`stk-dot stk-dot--${r.tone}`} />}
                  label={r.label}
                  meta={r.meta}
                  active={r.active}
                  onClick={() => {}}
                />
              ))}
            </div>
            <div style={{ marginTop: 8 }} className="stk-note-line">
              <Note tone="warn" stamp="12:03">
                代码星云未刷新
              </Note>
            </div>
            <div style={{ marginTop: 10 }}>
              <Legend
                items={[
                  { tone: 'l3', label: 'L3 稳定结论' },
                  { tone: 'l2', label: 'L2 经验' },
                  { tone: 'l1', label: 'L1 回合' },
                  { tone: 'l0', label: 'L0 原始' },
                ]}
              />
            </div>
          </Surface>
        </>
      }
      center={<span className="stk-hint">点击星点查看详情 · 滚轮缩放</span>}
      right={
        <>
          <Surface title="星点详情" aside={<span>mem-8f21</span>}>
            <StarDetail
              title="生产重启固定流程与回滚点"
              subtitle={
                <>
                  <Tag tone="l1">L1</Tag>
                  <span>2026-11-10 09:12</span>
                </>
              }
              kv={[
                { k: '层', v: 'L1 回合' },
                { k: '块', v: 'b1', mono: true },
                { k: '来源', v: '3 条 L0' },
                { k: '相似', v: null },
              ]}
              relationsTitle="关联星点"
              relations={[
                { tone: 'l0', label: 'L0 · 8420 重启后三服务 healthy', meta: '1' },
                { tone: 'l0', label: 'L0 · 备份核 sha256 一致', meta: '2' },
                { tone: 'l2', label: 'L2 · 生产变更必须人闸收口', meta: '5' },
                { tone: 'l3', label: 'L3 · 部署口径（稳定结论）', meta: '1' },
              ]}
              body={'1. 备份并核 sha256\n2. 只读 dry-run\n3. apply\n4. 幂等复验\n5. 重启换 PID\n6. 三服务 healthy'}
              actions={
                <>
                  <button type="button" className="stk-btn">分配记忆块</button>
                  <button type="button" className="stk-btn is-ghost">查看原始消息</button>
                </>
              }
            />
            <div style={{ marginTop: 10 }}>
              <Pager page={3} pages={115} total={11480} pageSize={100} onChange={() => {}} />
            </div>
          </Surface>
        </>
      }
      bottom={
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8 }}>
          <Gate label="记忆星云" count={26278} unit="颗" tone="l1" hint="L0–L3 · 提取关系" onClick={() => {}} />
          <Gate label="典籍星云" count={217} unit="条" tone="l2" hint="wiki · 引用关系" onClick={() => {}} />
          <Gate label="构筑星云" count={0} unit="点" tone="l3" hint="codegraph 索引为空" degraded onClick={() => {}} />
          <Gate label="技艺星云" count={339} unit="个" tone="ok" hint="skills · 51 已挂载" onClick={() => {}} />
        </div>
      }
    />
    </div>
  );
}

const el = document.getElementById('root');
if (el) createRoot(el).render(<Scene />);
