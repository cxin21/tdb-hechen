/**
 * starmap/scene/CloudSideCard.tsx — 进入一朵云后的侧卡：筛选 + 标准分页 + 本页详情。
 *
 * 不嵌旧面板。点星点看这颗和关联星；点侧卡「本页详情」看这一页的完整清单。
 * 分页统一走 kit 的 Pager（共 N 条 · 第 x/y 页 · ‹ [页码] ›），四朵云同一套。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { knowledgeApi, type CodeGraphDetail, type KnowledgeFixedItem, type WikiDetail } from '../../lib/api/knowledge-api';
import type { ChatMemoryBlock } from '../../lib/api/chat-memory';
import type { CloudKey } from '../data/overview';
import {
  MEMORY_LAYERS,
  PAGE_SIZE,
  layerTitle,
  litIds,
  loadCodePage,
  loadMemoryAll,
  loadMemoryPage,
  loadSkillPage,
  loadWikiPage,
  readMemoryItem,
  type MemoryLayer,
  type MemoryScope,
  type PageModel,
  type StarPoint,
} from './cloudPage';
import CloudCanvas, { type CloudPick } from './CloudCanvas';
import { Legend, Note, Pager, Row, Seg, Stage, StarDetail, Surface } from '../kit';

const ZH: Record<CloudKey, string> = { memory: '记忆星云', wiki: '典籍星云', code: '构筑星云', skills: '技艺星云' };
const CODE_KINDS = ['file', 'class', 'function'] as const;

interface Props {
  cloud: CloudKey;
  teamId: string;
  agentId: string;
  blockId: string | null;
  memoryBlocks: ChatMemoryBlock[];
  onExit: () => void;
}

/** 日期框（YYYY-MM-DD）→ ISO：起点当天 00:00，终点当天 23:59:59.999。空串 = 不限。 */
function dayStart(d: string): string | undefined {
  if (!d) return undefined;
  const t = new Date(d + 'T00:00:00');
  return Number.isNaN(t.getTime()) ? undefined : t.toISOString();
}
function dayEnd(d: string): string | undefined {
  if (!d) return undefined;
  const t = new Date(d + 'T23:59:59.999');
  return Number.isNaN(t.getTime()) ? undefined : t.toISOString();
}

export default function CloudSideCard({ cloud, teamId, agentId, blockId, memoryBlocks, onExit }: Props) {
  /* 忆云：scope=all 四层同屏；scope=单层 走该层标准分页 */
  const [scope, setScope] = useState<MemoryScope>('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [pageNo, setPageNo] = useState(1);

  const [page, setPage] = useState<PageModel | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState<CloudPick | null>(null);
  const [brief, setBrief] = useState(false);
  /* 场景记忆 / 核心记忆的点星正文：列表接口只给标题，正文按需整篇取回 */
  const [fullText, setFullText] = useState<string | null>(null);
  const [fullBusy, setFullBusy] = useState(false);

  const [wikis, setWikis] = useState<WikiDetail[]>([]);
  const [codes, setCodes] = useState<CodeGraphDetail[]>([]);
  const [fixed, setFixed] = useState<KnowledgeFixedItem[]>([]);
  const [wikiId, setWikiId] = useState<string | null>(null);
  const [codeId, setCodeId] = useState<string | null>(null);
  const [community, setCommunity] = useState<string>('');
  const [kinds, setKinds] = useState<string[]>([...CODE_KINDS]);
  const [skillScope, setSkillScope] = useState<'assigned' | 'all'>('assigned');
  const [blocks, setBlocks] = useState<ChatMemoryBlock[]>([]);
  const [memBlock, setMemBlock] = useState<string | null>(blockId);

  useEffect(() => { setMemBlock(blockId); }, [blockId]);
  useEffect(() => { setBlocks(memoryBlocks); }, [memoryBlocks]);

  /* 换云/换 agent：清筛选、回到第 1 页 */
  useEffect(() => {
    let alive = true;
    setPick(null);
    setBrief(false);
    setPageNo(1);
    setPage(null);
    setError(null);
    if (cloud === 'wiki' || cloud === 'code') {
      Promise.all([knowledgeApi.wiki.teamAssets(teamId), knowledgeApi.code.teamAssets(teamId)])
        .then(([wikiItems, codeItems]) => {
          if (!alive) return;
          setWikis(wikiItems);
          setCodes(codeItems);
        })
        .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
      knowledgeApi.agentFixed(agentId)
        .then((items) => { if (alive) setFixed(items); })
        .catch(() => { if (alive) setFixed([]); });
    }
    return () => { alive = false; };
  }, [cloud, teamId, agentId]);

  const wikiLit = useMemo(() => litIds(fixed, 'llm_wiki'), [fixed]);
  const codeLit = useMemo(() => litIds(fixed, 'code_graph'), [fixed]);

  useEffect(() => {
    if (cloud !== 'wiki') return;
    if (wikiId && wikis.some((w) => w.wiki_id === wikiId)) return;
    const bright = wikis.find((w) => wikiLit.has(w.wiki_id));
    setWikiId((bright ?? wikis[0])?.wiki_id ?? null);
    setCommunity('');
    setPageNo(1);
  }, [cloud, wikis, wikiLit, wikiId]);

  useEffect(() => {
    if (cloud !== 'code') return;
    if (codeId && codes.some((c) => c.code_graph_id === codeId)) return;
    const bright = codes.find((c) => codeLit.has(c.code_graph_id));
    setCodeId((bright ?? codes[0])?.code_graph_id ?? null);
    setPageNo(1);
  }, [cloud, codes, codeLit, codeId]);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (cloud === 'memory') {
        if (!memBlock) {
          setPage(null);
          setError('先选一个记忆块。');
          return;
        }
        const win = { blockId: memBlock, from: dayStart(from), to: dayEnd(to) };
        const offset = (pageNo - 1) * PAGE_SIZE;
        const next = scope === 'all'
          ? await loadMemoryAll({ ...win, offset })
          : await loadMemoryPage({ ...win, layer: scope, offset });
        setPage(next);
        return;
      }
      if (cloud === 'wiki') {
        if (!wikiId) { setPage(null); return; }
        setPage(await loadWikiPage({ wikiId, community: community || undefined, offset: (pageNo - 1) * PAGE_SIZE }));
        return;
      }
      if (cloud === 'code') {
        if (!codeId) { setPage(null); return; }
        setPage(await loadCodePage({ codeGraphId: codeId, kinds, offset: (pageNo - 1) * PAGE_SIZE }));
        return;
      }
      setPage(await loadSkillPage({ teamId, agentId, scope: skillScope, offset: (pageNo - 1) * PAGE_SIZE }));
    } catch (e) {
      setPage(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [cloud, memBlock, scope, from, to, pageNo, wikiId, community, codeId, kinds, teamId, agentId, skillScope]);

  useEffect(() => { void reload(); }, [reload]);

  /* 四朵云同一个口径：画布上的点就是后端这一页的 100 条，前端不再切片 */
  const points = page?.points ?? [];

  /* 标准分页读数：一律按后端 total / 页大小算，忆云「全部」也算（四层一起翻） */
  const pager = page
    ? {
        page: pageNo,
        pages: Math.max(1, Math.ceil((page.total || 0) / (page.limit || PAGE_SIZE))),
        total: page.total,
        pageSize: page.limit || PAGE_SIZE,
      }
    : null;

  const goto = (p: number) => {
    setPageNo(Math.max(1, p));
    setPick(null);
    setBrief(false);
    setFullText(null);
  };

  const onPick = (next: CloudPick | null) => {
    setPick(next);
    setBrief(false);
    setFullText(null);
  };

  const loadFullText = async () => {
    if (!memBlock || !pick || fullBusy) return;
    if (pick.kind !== 'L2' && pick.kind !== 'L3') return;
    setFullBusy(true);
    try {
      const item = await readMemoryItem({
        blockId: memBlock,
        layer: pick.kind,
        path: pick.kind === 'L2' ? pick.id : undefined,
      });
      setFullText(item.body || '（这篇是空的）');
    } catch (e) {
      setFullText('读取失败：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setFullBusy(false);
    }
  };

  const toggleKind = (k: string) => {
    setKinds((cur) => {
      const has = cur.includes(k);
      const next = has ? cur.filter((x) => x !== k) : [...cur, k];
      return next.length ? next : [k];
    });
    setPageNo(1);
  };

  /* L2/L3 是聚合产物，没有时间维度 */
  const aggregate = cloud === 'memory' && scope !== 'all' && (scope === 'L2' || scope === 'L3');

  /* ── 布局：星场铺满视口当背景，UI 浮在上层（DESIGN.md「布局」段） ── */
  const litCount = points.filter((p) => p.lit).length;
  const emptyText =
    cloud === 'memory'
      ? scope === 'all'
        ? '这个记忆块四层都是空的（或时间筛选把 L0/L1 挡完了）。'
        : scope === 'L2' || scope === 'L3'
          ? layerTitle(scope) + ' 是聚合产物：这个记忆块还没有生成。'
          : '当前筛选下没有 ' + layerTitle(scope) + '（时间范围可清空，或换一层看）。'
      : cloud === 'wiki'
        ? '这个库里没有可画的块（或当前社区为空）。'
        : cloud === 'code'
          ? '这张图里没有匹配当前类型过滤的节点。'
          : '没有可画的技能。';

  const statusNode = loading ? (
    <Note>正在取数…</Note>
  ) : error ? (
    <Note tone="bad">{error}</Note>
  ) : page?.hint ? (
    <Note tone="warn">{page.hint}</Note>
  ) : page && points.length === 0 ? (
    <Note tone="warn">{emptyText}</Note>
  ) : null;
  const statusTestId = loading ? 'loading-note' : error ? 'error-note' : page?.hint ? 'range-hint' : 'empty-layer';

  const legendItems =
    cloud === 'memory'
      ? [
          { tone: 'l3' as const, label: 'L3 稳定结论' },
          { tone: 'l2' as const, label: 'L2 经验' },
          { tone: 'l1' as const, label: 'L1 回合' },
          { tone: 'l0' as const, label: 'L0 原始' },
        ]
      : [
          { tone: 'ink' as const, label: '已挂载到本 agent' },
          { tone: 'dim' as const, label: '团队可见、未挂载' },
        ];

  const filters =
    cloud === 'memory' ? (
      <MemoryFilters
        blocks={blocks}
        blockId={memBlock}
        scope={scope}
        from={from}
        to={to}
        layerCounts={page?.layerCounts ?? []}
        layerErrors={page?.layerErrors ?? []}
        onBlock={(id) => { setMemBlock(id); setPageNo(1); setPick(null); setFullText(null); }}
        onScope={(s) => { setScope(s); setPageNo(1); setPick(null); setFullText(null); }}
        onFrom={(d) => { setFrom(d); setPageNo(1); }}
        onTo={(d) => { setTo(d); setPageNo(1); }}
        onClearDates={() => { setFrom(''); setTo(''); setPageNo(1); }}
      />
    ) : cloud === 'wiki' ? (
      <WikiFilters
        wikis={wikis}
        lit={wikiLit}
        wikiId={wikiId}
        community={community}
        communities={page?.communities ?? []}
        onWiki={(id) => { setWikiId(id); setCommunity(''); setPageNo(1); setPick(null); }}
        onCommunity={(id) => { setCommunity(id); setPageNo(1); }}
      />
    ) : cloud === 'code' ? (
      <CodeFilters
        codes={codes}
        lit={codeLit}
        codeId={codeId}
        kinds={kinds}
        onCode={(id) => { setCodeId(id); setPageNo(1); setPick(null); }}
        onKind={toggleKind}
      />
    ) : (
      <div className="stk-sec">
        <p className="stk-sec-title">范围</p>
        <Seg
          size="sm"
          ariaLabel="技能范围"
          value={skillScope}
          options={[
            { value: 'assigned', label: '已挂载' },
            { value: 'all', label: '全部' },
          ]}
          onChange={(v) => { setSkillScope(v); setPageNo(1); }}
        />
      </div>
    );


  const pickKv = pick
    ? [
        {
          k: '类型',
          v:
            cloud === 'memory' && MEMORY_LAYERS.includes(pick.kind as MemoryLayer)
              ? layerTitle(pick.kind as MemoryLayer)
              : pick.kind,
        },
        { k: '状态', v: pick.lit ? '已点亮' : '未挂载' },
        { k: '键', v: pick.id, mono: true },
      ]
    : [];

  const pickSubtitle = pick
    ? cloud === 'wiki'
      ? '所属库 · ' + (wikis.find((w) => w.wiki_id === wikiId)?.name ?? wikiId ?? '未选库')
      : cloud === 'code'
        ? '所属图 · ' + (codes.find((c) => c.code_graph_id === codeId)?.repo_name ?? codeId ?? '未选图')
        : undefined
    : undefined;

  return (
    <div className="starmap-root">
      <Stage
        field={
          <div className="cloud-field" data-testid="cloud-stage" data-cloud={cloud}>
            {page?.hint ? null : (
              <CloudCanvas
                cloud={cloud}
                points={points}
                edges={page?.edges ?? []}
                selectedId={pick?.id ?? null}
                onPick={onPick}
                total={page?.total ?? points.length}
              />
            )}
          </div>
        }
        top={
          <div className="cloud-top">
            <span className="cloud-top-name">{ZH[cloud]}</span>
            {page ? (
              <span className="cloud-top-meta">
                本页 {points.length} / 共 {(page.total ?? 0).toLocaleString('zh-CN')} 颗 · 已点亮 {litCount}
              </span>
            ) : null}
            <button type="button" className="stk-btn is-ghost" data-testid="back-to-overview" onClick={onExit}>
              返回全景
            </button>
          </div>
        }
        center={statusNode ? <div data-testid={statusTestId}>{statusNode}</div> : null}
        left={
          <Surface
            title={ZH[cloud] + ' · 筛选'}
            dense
            as="aside"
          >
            {filters}
            {cloud === 'memory' ? (
              <Note>
                {aggregate
                  ? '聚合产物 · 不带时间筛选'
                  : '时间口径：' + (from || '最早') + ' → ' + (to || '现在')}
              </Note>
            ) : null}
            {pager ? (
              <Pager
                page={pager.page}
                pages={pager.pages}
                total={pager.total}
                pageSize={pager.pageSize}
                loading={loading}
                onChange={goto}
              />
            ) : null}
            <div className="cloud-actions">
              <button
                type="button"
                className="stk-btn"
                disabled={!page || points.length === 0}
                onClick={() => { setBrief(true); setPick(null); }}
              >
                本页详情
              </button>
            </div>
          </Surface>
        }
        right={
          <Surface title={brief ? '本页清单' : pick ? '星点详情' : '星点详情'} dense as="aside">
            <div data-testid={brief ? 'page-brief-wrap' : pick ? 'star-detail-wrap' : 'detail-hint'}>
              <StarDetail
                title={brief ? '本页清单' : pick ? pick.label : undefined}
                subtitle={brief ? '当前页 ' + points.length + ' 条 / 合计 ' + (page?.total ?? points.length) : pickSubtitle}
                kv={brief ? undefined : pick ? pickKv : undefined}
                relations={brief || !pick ? undefined : pick.related.map((n) => ({ label: n.label, meta: n.kind }))}
                relationsTitle="关联星点"
                body={pick && cloud !== 'wiki' ? fullText ?? pick.detail ?? null : null}
                bodyLabel="正文"
                actions={
                  !brief && pick && cloud === 'memory' && (pick.kind === 'L2' || pick.kind === 'L3') ? (
                    <button type="button" className="stk-btn" disabled={fullBusy} onClick={() => void loadFullText()}>
                      {fullBusy ? '读取中…' : pick.kind === 'L2' ? '读这篇场景记忆' : '读整份核心记忆'}
                    </button>
                  ) : undefined
                }
                emptyText="点一颗星，或打开本页详情"
              >
                {brief ? <PageBrief points={points} total={page?.total ?? points.length} /> : null}
              </StarDetail>
            </div>
          </Surface>
        }
        bottom={<Legend items={legendItems} />}
      />
    </div>
  );
}

function PageBrief({ points, total }: { points: StarPoint[]; total: number }) {
  return (
    <div data-testid="page-brief">
      <div className="sm-dim2">当前页 {points.length} 条，合计 {total}</div>
      <div className="stk-list">
        {points.map((p) => (
          <Row key={p.id} label={p.label} meta={p.kind} title={p.detail} />
        ))}
      </div>
    </div>
  );
}

function MemoryFilters(props: {
  blocks: { id: string; title: string }[];
  blockId: string | null;
  scope: MemoryScope;
  from: string;
  to: string;
  layerCounts: { layer: MemoryLayer; loaded: number; total: number }[];
  layerErrors: { layer: MemoryLayer; message: string }[];
  onBlock: (id: string) => void;
  onScope: (s: MemoryScope) => void;
  onFrom: (d: string) => void;
  onTo: (d: string) => void;
  onClearDates: () => void;
}) {
  const counts = new Map(props.layerCounts.map((c) => [c.layer, c]));
  const single = props.scope !== 'all';
  /* 层内取回 0 条但库里明明有：只可能被时间筛选挡掉（向量库对跨度过大的范围静默返回空集），
     或该层的请求失败。两种都不该显示成一个光秃秃的 0。 */
  const emptyLayers = props.layerCounts.filter((c) => c.loaded === 0 && c.total > 0).map((c) => layerTitle(c.layer));
  const blocked = props.layerCounts.filter((c) => c.loaded === 0 && c.total === 0 && (props.from || props.to)).map((c) => layerTitle(c.layer));
  const emptyWarn = emptyLayers.length
    ? emptyLayers.join('、') + ' 本页 0 条，但库里总数不为 0 —— 先清空或缩小时间范围再看。'
    : blocked.length
      ? blocked.join('、') + ' 在 ' + (props.from || '最早') + ' → ' + (props.to || '现在') + ' 区间内是空的；时间跨度太大时向量库会直接返回空集。'
      : '';
  return (
    <div>
      <label className="stk-field-label">
        <span className="stk-kv-k">记忆块</span>
        <select value={props.blockId ?? ''} onChange={(e) => props.onBlock(e.target.value)}>
          {props.blocks.length === 0 ? <option value="">—</option> : null}
          {props.blocks.map((b) => <option key={b.id} value={b.id}>{b.title}</option>)}
        </select>
      </label>

      <div className="stk-sec">
        <p className="stk-sec-title">分层</p>
        <Row
          label="四层同屏"
          meta="全部层"
          active={props.scope === 'all'}
          onClick={() => props.onScope('all')}
          title="四层同屏（L3 内圈 → L0 外圈），每层各取本页 100 条"
        />
        {[...MEMORY_LAYERS].reverse().map((l) => {
          const c = counts.get(l);
          const empty = !!c && c.loaded === 0 && c.total > 0;
          return (
            <Row
              key={l}
              leading={<i className={'st-layer-dot k-' + l} />}
              label={layerTitle(l)}
              meta={c ? c.loaded + (c.total > 0 ? '/' + c.total : '') + (empty ? ' · 本页 0' : '') : undefined}
              active={props.scope === l}
              onClick={() => props.onScope(l)}
              title={layerTitle(l) + ' · 每页 ' + PAGE_SIZE + ' 条'}
            />
          );
        })}
      </div>

      <div className="stk-field-label">
        <span className="stk-kv-k">时间范围（L0/L1 生效，不填 = 不限）</span>
        <div className="st-date-row">
          <input type="date" value={props.from} max={props.to || undefined} onChange={(e) => props.onFrom(e.target.value)} aria-label="起始日期" />
          <span className="sm-dim2">→</span>
          <input type="date" value={props.to} min={props.from || undefined} onChange={(e) => props.onTo(e.target.value)} aria-label="结束日期" />
        </div>
        <div className="st-date-foot">
          <button type="button" className="stk-btn is-ghost is-sm" onClick={props.onClearDates}>清空时间</button>
          <span className="sm-dim2">{single ? '单层按标准分页翻' : '四层同屏：每层各取本页 ' + PAGE_SIZE + ' 条'}</span>
        </div>
        {props.layerErrors.length ? (
          <div className="st-layer-warn" data-testid="layer-error">
            {props.layerErrors.map((e) => layerTitle(e.layer) + ' 取数失败：' + e.message).join('；')}
          </div>
        ) : null}
        {emptyWarn ? (
          <div className="st-layer-warn" data-testid="layer-warn">{emptyWarn}</div>
        ) : null}
      </div>
    </div>
  );
}

function WikiFilters(props: {
  wikis: WikiDetail[];
  lit: Set<string>;
  wikiId: string | null;
  community: string;
  communities: { id: string; label: string; count: number }[];
  onWiki: (id: string) => void;
  onCommunity: (id: string) => void;
}) {
  return (
    <div>
      <div className="sm-label">库（已挂载点亮）</div>
      {props.wikis.length === 0 ? <Note>这个团队还没有 wiki 库。</Note> : null}
      {props.wikis.map((w) => (
        <Row
          key={w.wiki_id}
          label={w.name}
          meta={props.lit.has(w.wiki_id) ? '已挂载' : '未挂载'}
          active={w.wiki_id === props.wikiId}
          onClick={() => props.onWiki(w.wiki_id)}
        />
      ))}
      {props.communities.length ? (
        <label className="stk-field-label">
          <span className="stk-kv-k">社区</span>
          <select value={props.community} onChange={(e) => props.onCommunity(e.target.value)}>
            <option value="">按节点切片</option>
            {props.communities.map((c) => <option key={c.id} value={c.id}>{c.label} · {c.count}</option>)}
          </select>
        </label>
      ) : null}
    </div>
  );
}

function CodeFilters(props: {
  codes: CodeGraphDetail[];
  lit: Set<string>;
  codeId: string | null;
  kinds: string[];
  onCode: (id: string) => void;
  onKind: (k: string) => void;
}) {
  return (
    <div>
      <div className="sm-label">代码图（已挂载点亮）</div>
      {props.codes.length === 0 ? <Note>这个团队还没有代码图。</Note> : null}
      {props.codes.map((c) => (
        <Row
          key={c.code_graph_id}
          label={c.repo_name}
          meta={props.lit.has(c.code_graph_id) ? '已挂载' : '未挂载'}
          active={c.code_graph_id === props.codeId}
          onClick={() => props.onCode(c.code_graph_id)}
        />
      ))}
      <div className="stk-sec">
        <p className="stk-sec-title">节点类型</p>
        <div className="cloud-actions">
          {CODE_KINDS.map((k) => {
            const on = props.kinds.includes(k);
            return (
              <button
                key={k}
                type="button"
                className={on ? 'stk-btn' : 'stk-btn is-ghost'}
                aria-pressed={on}
                onClick={() => props.onKind(k)}
              >{k}</button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
