/**
 * starmap/StarmapLayout.tsx — 单页星图外壳。
 *
 * 记忆星图是唯一的常驻背景；九块功能变成绕图的「星门」与右侧停靠面板，
 * 需要深读时才升起 .station-veil 抽屉（仍然是同一条 hash 路由，刷新/分享都不丢）。
 */
import { useEffect, useMemo } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import Starfield from './engine/Starfield';
import { Btn, Card2, Pill, Skeleton, agoText } from './theme/ui';
import { useStarmap } from './state/StarmapProvider';
import { KIND_COLOR, type MapNode } from './engine/geometry';
import './theme/tokens.css';

interface StationDef {
  id: string;
  path: string;
  label: string;
  en: string;
  hint: string;
  angle: number;
}

const STATIONS: StationDef[] = [
  { id: 'memory', path: '/memory', label: '记忆', en: 'MEMORY', hint: '分层记忆 · 证据回指', angle: -90 },
  { id: 'soul', path: '/soul', label: '人格', en: 'SOUL', hint: '人格卡 · 情绪 · 人物关系', angle: -30 },
  { id: 'wiki', path: '/wiki', label: '知识', en: 'WIKI', hint: '文档库 · 编译状态', angle: 30 },
  { id: 'code', path: '/code', label: '代码', en: 'CODE', hint: '代码图谱 · 仓库索引', angle: 90 },
  { id: 'skills', path: '/skills', label: '技能', en: 'SKILLS', hint: '技能包 · 版本 · 文件', angle: 150 },
  { id: 'team', path: '/team/members', label: '团队', en: 'TEAM', hint: '成员 · 智能体 · 密钥', angle: 210 },
];

const KIND_LABEL: Record<MapNode['kind'], string> = {
  L0: '原文',
  L1: '记忆',
  L2: '日目录',
  L3: '结论',
  person: '人物',
  day: '日期',
};

export default function StarmapLayout() {
  return <LayoutInner />;
}

function LayoutInner() {
  const nav = useNavigate();
  const loc = useLocation();
  const sm = useStarmap();


  const activeStation = useMemo(() => {
    const hit = STATIONS.find((s) => loc.pathname.startsWith(s.path) || loc.pathname === s.path);
    if (hit) return hit.id;
    if (loc.pathname.startsWith('/team') || loc.pathname.startsWith('/settings')) return 'team';
    return null;
  }, [loc.pathname]);

  const stations = useMemo(
    () =>
      STATIONS.map((s) => ({
        id: s.id,
        label: s.label,
        en: s.en,
        angle: s.angle,
        radius: 1.42,
        height: 0.24,
      })),
    [],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && activeStation) nav('/');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeStation, nav]);

  const onPickStation = (id: string) => {
    const s = STATIONS.find((x) => x.id === id);
    if (s) nav(s.path);
  };

  const onPickNode = (node: MapNode | null) => {
    sm.setSelected(node);
    sm.setFocusId(node?.id ?? null);
  };

  const selected = sm.selected;
  const stats = sm.graph.stats;
  const hasGraph = sm.graph.nodes.length > 0;

  return (
    <div className="starmap-root">
      <div className="st-bg">
        <Starfield
          nodes={sm.graph.nodes}
          links={sm.graph.links}
          stations={stations}
          focusId={sm.focusId}
          activeStation={activeStation}
          onPickNode={(id) =>
            onPickNode(id ? sm.graph.nodes.find((n) => n.id === id) ?? null : null)
          }
          onPickStation={onPickStation}
          onHover={() => undefined}
        />
      </div>

      {/* 顶栏 */}
      <header className="st-top">
        <div className="st-brand">
          <span className="st-brand-dot" />
          <div>
            <div className="st-brand-zh">记忆星图</div>
            <div className="st-brand-en">MEMORY STARMAP</div>
          </div>
        </div>

        <div className="st-top-right">
          <SelectBox
            label="团队"
            value={sm.teamId ?? ''}
            options={sm.teams.map((t) => ({ value: t.team_id, text: t.name }))}
            onChange={(v) => sm.setTeamId(v)}
          />
          <SelectBox
            label="智能体"
            value={sm.activeAgentId ?? ''}
            options={sm.agents.map((a) => ({ value: a.agent_id, text: a.name }))}
            onChange={(v) => sm.setActiveAgentId(v || null)}
          />
          <SelectBox
            label="记忆块"
            value={sm.activeBlockId ?? ''}
            options={sm.blocks.map((b) => ({ value: b.id, text: b.title }))}
            onChange={(v) => sm.setActiveBlockId(v || null)}
          />
          <Btn small onClick={sm.refreshGraph} disabled={sm.graphLoading}>
            重算星图
          </Btn>
        </div>
      </header>

      {/* 左 HUD */}
      <aside className="st-left">
        <Card2
          title="观测对象"
          en="TARGET"
          live={!!sm.activeAgentId}
          right={<span className="sm-dim">{sm.activeBlock ? '已绑定' : '未绑定'}</span>}
        >
          <div className="st-obj">
            <div className="st-obj-name">
              {sm.agents.find((a) => a.agent_id === sm.activeAgentId)?.name ?? '未选择智能体'}
            </div>
            <div className="sm-dim2 sm-mono">{sm.activeAgentId ?? '—'}</div>
            <div className="sm-dim2">{sm.teamName || '未选择团队'}</div>
          </div>
          <div className="st-obj-block">
            <div className="sm-label">记忆块</div>
            <div className="st-obj-title">{sm.activeBlock?.title ?? '（无）'}</div>
            <div className="sm-dim2">
              {sm.activeBlock
                ? `原文 ${sm.activeBlock.layer_counts.L0_messages ?? 0} · 记忆 ${sm.graph.stats.l1} · 日目录 ${sm.graph.stats.l2} · 结论 ${sm.graph.stats.l3}`
                : '先选择团队与智能体'}
            </div>
          </div>
        </Card2>

        <Card2 title="星体构成" en="COMPOSITION">
          {sm.graphLoading ? (
            <Skeleton rows={4} height={12} />
          ) : (
            <>
              <StatMini label="记忆" value={stats.l1} color={KIND_COLOR.L1} />
              <StatMini label="结论" value={stats.l3} color={KIND_COLOR.L3} />
              <StatMini label="日目录" value={stats.l2 || stats.days} color={KIND_COLOR.L2} />
              <StatMini label="人物" value={stats.persons} color={KIND_COLOR.person} />
              <div className="st-stat-foot">
                <span className="sm-dim2">关系线 {stats.links} 条</span>
                {stats.truncated ? <Pill tone="warn">已截断</Pill> : null}
              </div>
            </>
          )}
        </Card2>

        <Card2 title="星门" en="GATES">
          <div className="rowlist">
            {STATIONS.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`rowitem ${activeStation === s.id ? 'on' : ''}`}
                onClick={() => nav(s.path)}
              >
                <span className="rowitem-main">
                  <span className="rowitem-zh">{s.label}</span>
                  <span className="rowitem-en">{s.en}</span>
                </span>
                <span className="sm-dim2 rowitem-hint">{s.hint}</span>
              </button>
            ))}
            <button type="button" className="rowitem" onClick={() => nav('/settings')}>
              <span className="rowitem-main">
                <span className="rowitem-zh">设置</span>
                <span className="rowitem-en">SETTINGS</span>
              </span>
              <span className="sm-dim2 rowitem-hint">实例 · 检索 · 模型</span>
            </button>
          </div>
        </Card2>
      </aside>

      {/* 右 HUD：选中的星 */}
      <aside className="st-right">
        <Card2
          title="星点详情"
          en="INSPECTOR"
          right={
            selected ? (
              <button type="button" className="sm-link" onClick={() => onPickNode(null)}>
                清除
              </button>
            ) : null
          }
        >
          {!selected ? (
            <div className="st-hint">
              <div className="st-hint-zh">点一颗星</div>
              <div className="sm-dim2">左侧星门切换功能，星点只显示真实存在的记忆/人物/日期。</div>
            </div>
          ) : (
            <div className="st-node">
              <div className="st-node-head">
                <span className="st-node-dot" style={{ background: KIND_COLOR[selected.kind] }} />
                <span className="st-node-kind">{KIND_LABEL[selected.kind]}</span>
                {selected.at ? <span className="sm-dim2">{agoText(selected.at)}</span> : null}
              </div>
              <div className="st-node-title">{selected.full || selected.label}</div>
              {selected.at ? <div className="sm-dim2 sm-mono">{selected.at}</div> : null}
              <div className="fields">
                <dt>节点键</dt>
                <dd className="sm-mono">{selected.id}</dd>
                <dt>显著性</dt>
                <dd>{selected.weight.toFixed(2)}</dd>
              </div>
              <div className="st-node-actions">
                <Btn small primary onClick={() => nav('/memory')}>
                  在记忆里展开
                </Btn>
                <Btn small onClick={() => sm.setFocusId(selected.id)}>
                  聚焦邻居
                </Btn>
              </div>
            </div>
          )}
        </Card2>

        <Card2 title="图例" en="LEGEND">
          <div className="st-legend">
            {(Object.keys(KIND_LABEL) as MapNode['kind'][]).map((k) => (
              <span key={k} className="st-legend-item">
                <i style={{ background: KIND_COLOR[k] }} />
                {KIND_LABEL[k]}
              </span>
            ))}
          </div>
          <div className="st-legend-lines">
            <span><i className="l-session" />同会话</span>
            <span><i className="l-person" />同人物</span>
            <span><i className="l-ref" />引用/归属</span>
          </div>
          <div className="sm-dim2 st-legend-tip">
            {hasGraph
              ? '拖拽旋转 · 滚轮缩放 · 空格暂停 · R 归位'
              : '该记忆块还没有可画的星，先积累 L1 记忆。'}
          </div>
        </Card2>
      </aside>

      {/* 站台抽屉 */}
      {activeStation ? (
        <div className="station-veil" onClick={() => nav('/')}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-head">
              <div className="sheet-head-title">
                <span className="sheet-head-zh">
                  {STATIONS.find((s) => s.id === activeStation)?.label ?? '设置'}
                </span>
                <span className="sheet-head-en">
                  {STATIONS.find((s) => s.id === activeStation)?.en ?? 'SETTINGS'}
                </span>
              </div>
              <div className="sheet-head-right">
                <button type="button" className="sm-btn ghost sm" onClick={() => nav('/')}>
                  收起
                </button>
              </div>
            </div>
            <div className="sheet-body sm-scroll">
              <Outlet />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function StatMini({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="st-stat">
      <span className="st-stat-dot" style={{ background: color }} />
      <span className="st-stat-label">{label}</span>
      <span className="st-stat-value">{value}</span>
    </div>
  );
}

function SelectBox({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; text: string }>;
  onChange: (v: string) => void;
}) {
  return (
    <label className="st-select">
      <span className="st-select-label">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.length === 0 ? <option value="">—</option> : null}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.text}
          </option>
        ))}
      </select>
    </label>
  );
}
