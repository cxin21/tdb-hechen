/**
 * starmap/stations/MemoryStation.tsx — 记忆站（新壳）。
 *
 * 数据与写操作全部走 useChatMemory（复用既有分页/搜索/编辑逻辑，未改协议），
 * 只重画表现层：暗色列表 + 详情抽屉内的证据回指与治理动作。
 */
import { useEffect, useMemo, useState } from 'react';
import { chatMemoryApi, type ChatMemoryLayerItem } from '@/lib/teamApi';
import { useChatMemory } from '@/pages/ChatMemoryPage/hooks/useChatMemory';
import { Btn, Card2, Empty, Fields, Note, Pill, Seg, Skeleton, agoText, formatTime, errorText } from '../theme/ui';
import { Row } from '../kit';
import { useStarmap } from '../state/StarmapProvider';
import RecallJournalPanel from './recallJournal';
import MemoryGraphPanel from './MemoryGraphPanel';

type LayerKey = 'L0' | 'L1' | 'L2' | 'L3';
/** 页级两档：记忆块（旧 ChatMemoryPanel）/ 回放日志（旧 RecallJournalView）。 */
type ViewKey = 'blocks' | 'journal' | 'graph';

interface EvidenceRow {
  id?: string;
  record_id?: string;
  at?: string;
  quote?: string;
  role?: string;
  [k: string]: unknown;
}

export default function MemoryStation() {
  const sm = useStarmap();
  const mem = useChatMemory({ activeTeamId: sm.teamId });
  const [view, setView] = useState<ViewKey>('blocks');
  const [layer, setLayer] = useState<LayerKey>('L1');
  const [detailId, setDetailId] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<EvidenceRow[]>([]);
  const [evidenceErr, setEvidenceErr] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<ChatMemoryLayerItem[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const block = mem.selected;
  const items = useMemo(
    () => ((block?.layers?.[layer] ?? []) as unknown as ChatMemoryLayerItem[]),
    [block, layer],
  );
  const counts = block?.layerCounts ?? {};
  const page = block?.id ? (mem.layerPages?.[block.id]?.[layer as never] ?? 0) : 0;
  const total = mem.windowTotal || counts[layer] || items.length;
  const pageCount = Math.max(1, Math.ceil(total / mem.pageSize));

  useEffect(() => {
    setDetailId(null);
    setEvidence([]);
    setHits(null);
    setQuery('');
  }, [block?.id, layer]);

  // 与星图全局选中的记忆块保持同步：抽屉里的选择也回写星图，避免两处各选一个
  useEffect(() => {
    if (sm.activeBlockId && block?.id !== sm.activeBlockId) {
      mem.setSelectedId(sm.activeBlockId);
    }
  }, [sm.activeBlockId, block?.id, mem.blocks.length]);

  useEffect(() => {
    if (block?.id && block.id !== sm.activeBlockId) {
      sm.setActiveBlockId(block.id);
    }
  }, [block?.id]);

  const detail = useMemo(
    () => items.find((i) => i.id === detailId) ?? null,
    [items, detailId],
  );

  useEffect(() => {
    if (!block?.id || !detail?.id || layer === 'L0') {
      setEvidence([]);
      return;
    }
    let alive = true;
    setEvidenceErr(null);
    void chatMemoryApi
      .evidenceByIds(block.id, [detail.id])
      .then((rows) => {
        if (alive) setEvidence((rows ?? []) as unknown as EvidenceRow[]);
      })
      .catch((e: unknown) => {
        if (alive) {
          setEvidence([]);
          setEvidenceErr(errorText(e));
        }
      });
    return () => {
      alive = false;
    };
  }, [block?.id, detail?.id, layer]);

  const runSearch = async () => {
    if (!block?.id || !query.trim()) {
      setHits(null);
      return;
    }
    setBusy('search');
    try {
      const res = await mem.searchLayer(layer === 'L0' ? 'L0' : 'L1', query.trim());
      setHits(res as unknown as ChatMemoryLayerItem[]);
    } finally {
      setBusy(null);
    }
  };

  const list = hits ?? items;

  return (
    <div className="st-body">
      <div className="st-main">
        <div className="st-toolbar">
          <Seg<ViewKey>
            value={view}
            onChange={setView}
            options={[
              { value: 'blocks', label: '记忆块' },
              { value: 'journal', label: '回放日志' },
              { value: 'graph', label: '记忆图谱' },
            ]}
          />
          <span className="st-toolbar-right sm-dim2">
            {view === 'blocks'
              ? '分层条目 · 证据回指 · 失效标记'
              : view === 'graph'
                ? '以一条记忆为种子 · 邻居来自内核 l1_links 边 · 可查两点关联链'
                : '内核每次召回的原始日志 · 召回与跳过分开计数'}
          </span>
        </div>

        {view === 'graph' ? (
          <MemoryGraphPanel
            blockId={block?.id ?? ''}
            seed={
              layer === 'L0' || !items[0]
                ? null
                : { id: (detail ?? items[0]).id, label: (detail ?? items[0]).title, layer }
            }
          />
        ) : view === 'journal' ? (
          <RecallJournalPanel teamId={sm.teamId ?? ''} agentId={sm.activeAgentId ?? ''} />
        ) : (
        <>
        <div className="st-toolbar">
          <Seg<LayerKey>
            value={layer}
            onChange={(v) => {
              setLayer(v);
              mem.setLayer(v);
            }}
            options={[
              { value: 'L0', label: `L0 对话原文 ${counts.L0 ?? ''}`.trim() },
              { value: 'L1', label: `L1 原子记忆 ${counts.L1 ?? ''}`.trim() },
              { value: 'L2', label: `L2 场景记忆 ${counts.L2 ?? ''}`.trim() },
              { value: 'L3', label: `L3 核心记忆 ${counts.L3 ?? ''}`.trim() },
            ]}
          />
          <div className="st-toolbar-right">
            <input
              className="st-input"
              placeholder={layer === 'L0' ? '检索原文…' : '检索记忆…'}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void runSearch();
              }}
            />
            <Btn small onClick={() => void runSearch()} disabled={busy === 'search'}>
              检索
            </Btn>
            {hits ? (
              <Btn small ghost onClick={() => { setHits(null); setQuery(''); }}>
                清除
              </Btn>
            ) : null}
            <Btn small ghost onClick={() => mem.handleRefresh()} disabled={mem.blocksLoading}>
              刷新
            </Btn>
          </div>
        </div>

        {!block ? (
          <Empty
            text="还没有选中记忆块"
            hint="左侧选一个记忆块，或先在「团队」里给智能体绑定记忆。"
          />
        ) : mem.layerLoading ? (
          <Skeleton rows={8} height={14} />
        ) : list.length === 0 ? (
          <Empty
            text={hits ? '没有命中' : `这一层还没有内容`}
            hint={layer === 'L0' ? '可以往下翻或调整时间窗口。' : '记忆会随对话沉淀自动长出。'}
          />
        ) : (
          <>
            <div className="st-listhead">
              <span className="sm-dim2">
                {hits ? `命中 ${list.length} 条` : `共 ${total} 条 · 第 ${page + 1}/${pageCount} 页`}
              </span>
              {!hits ? (
                <span className="st-pager">
                  <Btn small ghost disabled={page <= 0} onClick={() => mem.handleLayerPageChange(page - 1)}>
                    上一页
                  </Btn>
                  <Btn
                    small
                    ghost
                    disabled={page + 1 >= pageCount}
                    onClick={() => mem.handleLayerPageChange(page + 1)}
                  >
                    下一页
                  </Btn>
                  {layer === 'L0' && !block.l0Ended ? (
                    <Btn small ghost onClick={() => mem.handleL0LoadMore()} disabled={mem.l0MoreLoading}>
                      加载更早
                    </Btn>
                  ) : null}
                </span>
              ) : null}
            </div>
            <div className="st-cards">
              {list.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`st-memcard ${detailId === item.id ? 'on' : ''}`}
                  onClick={() => setDetailId(detailId === item.id ? null : item.id)}
                >
                  <div className="st-memcard-head">
                    <span className="st-memcard-title">{item.title || item.body?.slice(0, 60) || item.id}</span>
                    <span className="sm-dim2">{agoText(item.occurred_at ?? item.created_at)}</span>
                  </div>
                  <div className="st-memcard-body">{item.body || '（无正文）'}</div>
                  <div className="st-memcard-meta">
                    {item.role ? <Pill>{item.role}</Pill> : null}
                    {(item.tags ?? []).slice(0, 4).map((t) => (
                      <Pill key={t}>{t}</Pill>
                    ))}
                    {typeof item.significance === 'number' ? (
                      <span className="sm-dim2">显著 {item.significance.toFixed(2)}</span>
                    ) : null}
                    {typeof item.valence === 'number' ? (
                      <span className="sm-dim2">效价 {item.valence.toFixed(2)}</span>
                    ) : null}
                    {item.certainty ? <span className="sm-dim2">{item.certainty}</span> : null}
                  </div>
                </button>
              ))}
            </div>
          </>
        )}
        </>
        )}
      </div>

      <aside className="st-side sm-scroll">
        {err ? <Note tone="warn">{err}</Note> : null}
        <Card2 title="记忆块" right={<span className="sm-dim2">{mem.filtered.length}</span>}>
          {mem.blocksLoading ? (
            <Skeleton rows={5} height={12} />
          ) : mem.filtered.length === 0 ? (
            <Empty text="没有记忆块" hint="先在团队里给智能体绑定或导入记忆。" />
          ) : (
            <div className="stk-list">
              {mem.filtered.map((b) => (
                <Row
                  key={b.id}
                  label={b.title}
                  meta={`L1 ${b.layer_counts.L1} · L0 ${b.layer_counts.L0_messages}`}
                  active={b.id === mem.selectedId}
                  onClick={() => mem.setSelectedId(b.id)}
                  trailing={b.scope ? <Pill tone={b.scope === 'private' ? 'warn' : undefined}>{b.scope === 'private' ? '私密' : '团队'}</Pill> : undefined}
                />
              ))}
            </div>
          )}
        </Card2>

        {block ? (
          <Card2 title="块信息">
            <Fields
              items={[
                { k: '标题', v: block.title },
                { k: '归属', v: mem.agentLabel(block.agent_id) || '团队资产' },
                { k: '更新', v: formatTime(block.updated_at_ms) },
                { k: 'L0/L1/L2/L3', v: `${block.layer_counts.L0_messages} / ${block.layer_counts.L1} / ${block.layer_counts.L2} / ${block.layer_counts.L3}` },
              ]}
            />
            <div className="st-side-actions">
              {/* 挂接 = 星图里「点亮这枚块」的唯一入口：分配后该块的星点与边对本 agent 变亮 */}
              {sm.teamId && sm.activeAgentId ? (
                <Btn
                  small
                  primary={block.agent_id !== sm.activeAgentId}
                  ghost={block.agent_id === sm.activeAgentId}
                  disabled={!!busy}
                  onClick={async () => {
                    if (!sm.teamId || !sm.activeAgentId) return;
                    const assigned = block.agent_id === sm.activeAgentId;
                    setBusy('alloc');
                    setErr(null);
                    try {
                      if (assigned) await chatMemoryApi.unbind(sm.teamId, block.id, sm.activeAgentId);
                      else await chatMemoryApi.allocate(sm.teamId, block.id, sm.activeAgentId);
                      mem.handleRefresh();
                    } catch (e: unknown) {
                      setErr(errorText(e));
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  {block.agent_id === sm.activeAgentId ? '从当前智能体移除' : '挂到当前智能体'}
                </Btn>
              ) : (
                <span className="sm-dim2">先在上方选一个智能体，记忆块才能挂接</span>
              )}
              <Btn
                small
                ghost
                disabled={!!busy}
                onClick={async () => {
                  setBusy('scope');
                  try {
                    await mem.handleToggleScope(
                      block,
                      block.scope === 'private' ? 'team' : 'private',
                    );
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                {block.scope === 'private' ? '改为团队可见' : '改为私密'}
              </Btn>
              <Btn
                small
                danger
                ghost
                disabled={!!busy}
                onClick={async () => {
                  setBusy('del');
                  try {
                    await mem.handleDeleteBlock(block.id);
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                删除块
              </Btn>
            </div>
          </Card2>
        ) : null}

        {detail ? (
          <Card2 title="条目详情">
            <div className="st-detail">
              <div className="st-detail-title">{detail.title || '（无标题）'}</div>
              <div className="sm-dim2 sm-mono">{detail.id}</div>
              <div className="st-detail-body">{detail.body || '（无正文）'}</div>
              <Fields
                items={[
                  { k: '记录时间', v: formatTime(detail.created_at) },
                  { k: '发生时间', v: formatTime(detail.occurred_at) },
                  { k: '有效期', v: `${detail.valid_start ?? '—'} → ${detail.valid_end ?? '—'}` },
                  { k: '时效', v: detail.certainty ?? '—' },
                ]}
              />
              {layer !== 'L0' ? (
                <div className="st-detail-actions">
                  <Btn
                    small
                    ghost
                    disabled={!!busy}
                    onClick={async () => {
                      if (!block?.id) return;
                      setBusy('invalidate');
                      try {
                        await chatMemoryApi.setInvalidated(
                          block.id,
                          detail.id,
                          detail.valid_end ? 'restore' : 'invalidate',
                        );
                        mem.handleRefresh();
                      } finally {
                        setBusy(null);
                      }
                    }}
                  >
                    {detail.valid_end ? '恢复有效' : '标记失效'}
                  </Btn>
                </div>
              ) : null}
            </div>
          </Card2>
        ) : null}

        {detail && layer !== 'L0' ? (
          <Card2 title="原文证据" right={<span className="sm-dim2">{evidence.length}</span>}>
            {evidenceErr ? (
              <Note tone="warn">证据读取失败：{evidenceErr}</Note>
            ) : evidence.length === 0 ? (
              <Empty text="没有回指证据" hint="这条记忆没带来源，属于推断内容。" />
            ) : (
              <div className="st-evidences">
                {evidence.map((e, i) => (
                  <div className="st-evidence" key={e.record_id ?? e.id ?? i}>
                    <div className="sm-dim2 sm-mono">{e.record_id ?? e.id ?? '—'}</div>
                    <div className="st-evidence-quote">{e.quote ?? '（无引文）'}</div>
                    <div className="sm-dim2">
                      {e.role ?? '—'} · {formatTime(e.at)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card2>
        ) : null}
      </aside>
    </div>
  );
}