/**
 * starmap/stations/knowledgeDeep.tsx — 知识与代码两站的深操作面（P7）。
 *
 * 目的：把旧 WikiPage / CodePage 里「只有完整视图才有」的动手能力搬到新壳里，
 * 不再靠 ?full=1 嵌旧页。全部走 knowledgeApi 既有端点，不新增后端契约。
 *
 * 面板划分：
 *   wiki  → 来源（改/测/重拉/编译）、页面（列表 + 读正文 + 删页）、搜索、原始文档（列表/读/删/上传）
 *   code  → 结构（按 kind 取节点）、检索（search / explore 文本块）
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  knowledgeApi,
  type CodeGraphStructureEdge,
  type CodeGraphStructureNode,
  type WikiDetail,
  type WikiPage,
} from '@/lib/api/knowledge-api';
import { KvList, Note, Row, Seg, Skeleton, StarDetail, Surface } from '../kit';
import { cacheKey, fetchCodeStructure, useApiResource } from '../cache';
import RelGraphCanvas, { type RelEdge, type RelNode } from '../scene/RelGraphCanvas';
import { Btn, Empty, errorText, agoText } from '../theme/ui';

/* ---------------------------------------------------------------- wiki 来源 */

export function WikiSourcePanel({ detail, onChanged }: { detail: WikiDetail; onChanged: () => void }) {
  const [url, setUrl] = useState(detail.source_url ?? '');
  const [branch, setBranch] = useState(detail.branch ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'warn' | 'bad' | 'ok'; text: string } | null>(null);
  const [progress, setProgress] = useState<string | null>(null);

  useEffect(() => {
    setUrl(detail.source_url ?? '');
    setBranch(detail.branch ?? '');
  }, [detail.wiki_id, detail.source_url, detail.branch]);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setMsg(null);
    try {
      await fn();
    } catch (e: unknown) {
      setMsg({ tone: 'bad', text: errorText(e) });
    } finally {
      setBusy(null);
    }
  };

  const dirty = url !== (detail.source_url ?? '') || branch !== (detail.branch ?? '');

  return (
    <div className="stk-stack">
      <KvList
        items={[
          { k: '源类型', v: detail.source_type ?? 'local' },
          { k: '分支', v: detail.branch ?? '—' },
          { k: '包含', v: detail.path_include ?? '—' },
          { k: '排除', v: detail.path_exclude ?? '—' },
          { k: '源开关', v: detail.enabled === false ? '已暂停' : '开启' },
          { k: '待重拉', v: detail.stale ? '是（改源后需重新拉取）' : '否' },
          { k: '最近同步', v: agoText(detail.last_sync_at) },
        ]}
      />

      <label className="st-field-row">
        <span>源地址</span>
        <input className="st-input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="git@host:repo.git 或 https://…" />
      </label>
      <label className="st-field-row">
        <span>分支</span>
        <input className="st-input" value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" />
      </label>

      <div className="stk-row-actions">
        <Btn
          small
          disabled={!!busy}
          onClick={() =>
            void run('test', async () => {
              const r = await knowledgeApi.wiki.testSource(detail.wiki_id, url || undefined);
              setMsg(
                r.reachable
                  ? { tone: 'ok', text: '可达 · 远端分支 ' + (r.branches.slice(0, 6).join(' / ') || '—') }
                  : { tone: 'warn', text: '不可达：' + (r.error ?? '未知原因') },
              );
            })
          }
        >
          测试连接
        </Btn>
        <Btn
          small
          primary
          disabled={!!busy || !dirty}
          onClick={() =>
            void run('save', async () => {
              await knowledgeApi.wiki.updateSource(detail.wiki_id, {
                ...(url !== (detail.source_url ?? '') ? { source_url: url } : {}),
                ...(branch !== (detail.branch ?? '') ? { branch } : {}),
              });
              setMsg({ tone: 'ok', text: '已保存。地址或分支变更会把该源页面标记为待重新拉取。' });
              onChanged();
            })
          }
        >
          保存源
        </Btn>
        <Btn
          small
          disabled={!!busy}
          onClick={() =>
            void run('refetch', async () => {
              const r = await knowledgeApi.wiki.refetch(detail.wiki_id);
              setMsg({ tone: 'ok', text: '已触发重新拉取（status=' + r.status + '），完成后自动刷新。' });
              onChanged();
            })
          }
        >
          重新拉取
        </Btn>
        <Btn
          small
          disabled={!!busy}
          onClick={() =>
            void run('ingest', async () => {
              setProgress('正在编译…');
              await knowledgeApi.wiki.ingestWithPolling(
                detail.wiki_id,
                {
                  onProgress: (ev) => setProgress(ev.detail ?? '编译中…'),
                  onComplete: (r) => setProgress('编译完成：' + r.ingested + ' / ' + r.total),
                  onError: (m) => setProgress('编译失败：' + m),
                },
                detail.team_id,
              );
              onChanged();
            })
          }
        >
          编译
        </Btn>
      </div>

      {busy === 'ingest' && progress ? <Note>{progress}</Note> : null}
      {msg ? <Note tone={msg.tone === 'ok' ? undefined : msg.tone}>{msg.text}</Note> : null}
    </div>
  );
}

/* ---------------------------------------------------------------- wiki 页面 */

export function WikiPagesPanel({ wikiId }: { wikiId: string }) {
  const [pages, setPages] = useState<WikiPage[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const [body, setBody] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  /** 两段式删除：没有弹窗组件也要有「真的要点两次」这一道。 */
  const [confirmPath, setConfirmPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    setPages(null);
    setPath(null);
    setBody(null);
    setErr(null);
    knowledgeApi.wiki
      .pages(wikiId)
      .then((items) => alive.current && setPages(items))
      .catch((e: unknown) => alive.current && setErr(errorText(e)));
    return () => {
      alive.current = false;
    };
  }, [wikiId]);

  const removePage = async (p: string) => {
    setBusy(true);
    setErr(null);
    try {
      await knowledgeApi.wiki.pageDelete(wikiId, [p]);
      setPages(null);
      const items = await knowledgeApi.wiki.pages(wikiId);
      if (alive.current) setPages(items);
      if (path === p) {
        setPath(null);
        setBody(null);
      }
    } catch (e: unknown) {
      if (alive.current) setErr('删除失败：' + errorText(e));
    } finally {
      if (alive.current) {
        setBusy(false);
        setConfirmPath(null);
      }
    }
  };

  const open = async (p: string) => {
    setPath(p);
    setReading(true);
    setBody(null);
    try {
      const r = await knowledgeApi.wiki.read(wikiId, p);
      setBody(r.content || '（空页面）');
    } catch (e: unknown) {
      setBody('读取失败：' + errorText(e));
    } finally {
      setReading(false);
    }
  };

  return (
    <div className="stk-stack">
      {err ? <Note tone="bad">{err}</Note> : null}
      {pages === null && !err ? <Skeleton rows={6} /> : null}
      {pages && pages.length === 0 ? <Empty text="这个库还没有编译出页面" hint="先在「来源」里拉取并编译。" /> : null}
      {pages && pages.length > 0 ? (
        <div className="stk-list">
          {pages.slice(0, 200).map((p) => (
            <Row
              key={p.path}
              label={p.title || p.path}
              meta={p.type || undefined}
              title={p.path}
              active={path === p.path}
              onClick={() => void open(p.path)}
            />
          ))}
        </div>
      ) : null}
      {path ? (
        <div className="stk-fold">
          <div className="stk-fold-head">
            <span className="stk-mono">{path}</span>
            <Btn small ghost onClick={() => { setPath(null); setBody(null); }}>
              收起
            </Btn>
            <Btn
              small
              danger
              disabled={busy}
              onClick={() => (confirmPath === path ? void removePage(path) : setConfirmPath(path))}
            >
              {confirmPath === path ? '确认删除' : '删除本页'}
            </Btn>
          </div>
          {reading ? <Skeleton rows={5} /> : <pre className="stk-pre">{body}</pre>}
        </div>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------- wiki 搜索 */

export function WikiSearchPanel({ wikiId }: { wikiId: string }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<Array<{ path: string; title: string; snippet: string; score: number }> | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [body, setBody] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const go = async () => {
    const query = q.trim();
    if (!query) return;
    setBusy(true);
    setErr(null);
    setRows(null);
    setOpen(null);
    setBody(null);
    try {
      const r = await knowledgeApi.wiki.search(wikiId, query, 30);
      setRows(r.results ?? []);
    } catch (e: unknown) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stk-stack">
      <div className="stk-row-actions">
        <input
          className="st-input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void go()}
          placeholder="全文检索：关键词"
        />
        <Btn small primary disabled={busy || !q.trim()} onClick={() => void go()}>
          搜索
        </Btn>
      </div>
      {err ? <Note tone="bad">{err}</Note> : null}
      {busy ? <Skeleton rows={4} /> : null}
      {rows && rows.length === 0 ? <Empty text="没有命中" hint="换一个关键词，或先在「来源」里编译。" /> : null}
      {rows && rows.length > 0
        ? rows.map((r) => (
            <div key={r.path} className="stk-stack">
              <Row
                label={r.title || r.path}
                meta={r.score.toFixed(2)}
                title={r.path}
                active={open === r.path}
                onClick={() =>
                  void (async () => {
                    setOpen(r.path);
                    setBody(null);
                    try {
                      const b = await knowledgeApi.wiki.read(wikiId, r.path);
                      setBody(b.content || '（空页面）');
                    } catch (e: unknown) {
                      setBody('读取失败：' + errorText(e));
                    }
                  })()
                }
              />
              {r.snippet ? <div className="stk-snippet">{r.snippet}</div> : null}
              {open === r.path ? <pre className="stk-pre">{body ?? '读取中…'}</pre> : null}
            </div>
          ))
        : null}
    </div>
  );
}

/* ---------------------------------------------------------------- code 结构 */

const CODE_KINDS = [
  { value: 'all', label: '全部' },
  { value: 'file', label: '文件' },
  { value: 'class', label: '类' },
  { value: 'function', label: '函数' },
  { value: 'method', label: '方法' },
] as const;

export function CodeStructurePanel({ codeGraphId }: { codeGraphId: string }) {
  const [kind, setKind] = useState<string>('all');
  const [nodes, setNodes] = useState<CodeGraphStructureNode[] | null>(null);
  const [total, setTotal] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState<CodeGraphStructureNode | null>(null);

  useEffect(() => {
    let alive = true;
    setNodes(null);
    setErr(null);
    setSel(null);
    knowledgeApi.code
      .structure(codeGraphId, { kinds: kind === 'all' ? undefined : [kind], limit: 120, offset: 0 })
      .then((r) => {
        if (!alive) return;
        setNodes(r.nodes ?? []);
        setTotal(r.total ?? 0);
      })
      .catch((e: unknown) => alive && setErr(errorText(e)));
    return () => {
      alive = false;
    };
  }, [codeGraphId, kind]);

  return (
    <div className="stk-stack">
      <Seg value={kind} options={CODE_KINDS.map((k) => ({ value: k.value, label: k.label }))} onChange={setKind} size="sm" ariaLabel="节点类型" />
      {err ? <Note tone="bad">{err}</Note> : null}
      {nodes === null && !err ? <Skeleton rows={6} /> : null}
      {nodes && nodes.length === 0 ? <Empty text="这个图还没有索引出节点" hint="先触发重新索引。" /> : null}
      {nodes && nodes.length > 0 ? (
        <>
          <div className="stk-hint-inline">本页 {nodes.length} 个 · 共 {total.toLocaleString('zh-CN')} 个</div>
          <div className="stk-list">
            {nodes.map((n) => (
              <Row
                key={n.id}
                label={n.name}
                meta={n.kind}
                title={n.filePath + ':' + n.startLine}
                active={sel?.id === n.id}
                onClick={() => setSel(n)}
              />
            ))}
          </div>
        </>
      ) : null}
      {sel ? (
        <div className="stk-fold">
          <div className="stk-fold-head">
            <span className="stk-mono">{sel.qualifiedName || sel.name}</span>
          </div>
          <KvList
            items={[
              { k: '类型', v: sel.kind },
              { k: '文件', v: sel.filePath + ':' + sel.startLine + '-' + sel.endLine, mono: true },
              { k: '语言', v: sel.language },
              { k: '导出', v: sel.isExported ? '是' : '否' },
            ]}
          />
          {sel.signature ? <pre className="stk-pre">{sel.signature}</pre> : null}
        </div>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------- code 检索 */

export function CodeSearchPanel({ codeGraphId }: { codeGraphId: string }) {
  const [q, setQ] = useState('');
  const [mode, setMode] = useState<'search' | 'explore'>('search');
  const [text, setText] = useState<string | null>(null);
  const [isErr, setIsErr] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const go = useCallback(async () => {
    const query = q.trim();
    if (!query) return;
    setBusy(true);
    setErr(null);
    setText(null);
    try {
      const r =
        mode === 'search'
          ? await knowledgeApi.code.search({ codeGraphId, query, limit: 10 })
          : await knowledgeApi.code.explore(codeGraphId, query);
      setText(r.text);
      setIsErr(r.isError);
    } catch (e: unknown) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }, [codeGraphId, mode, q]);

  return (
    <div className="stk-stack">
      <Seg
        value={mode}
        options={[
          { value: 'search', label: '搜索' },
          { value: 'explore', label: '探索' },
        ]}
        onChange={setMode}
        size="sm"
        ariaLabel="检索方式"
      />
      <div className="stk-row-actions">
        <input
          className="st-input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void go()}
          placeholder={mode === 'search' ? '符号名 / 关键字' : '描述一段调用链或问题'}
        />
        <Btn small primary disabled={busy || !q.trim()} onClick={() => void go()}>
          检索
        </Btn>
      </div>
      {err ? <Note tone="bad">{err}</Note> : null}
      {busy ? <Skeleton rows={5} /> : null}
      {text !== null ? <pre className="stk-pre">{text || '（无内容）'}</pre> : null}
      {isErr ? <Note tone="warn">检索返回了错误结果，见上方文本。</Note> : null}
    </div>
  );
}

/* ------------------------------------------------------------ wiki 原始文档 */

function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * raw 原始文档：编译成页面之前的原料。
 * 旧 WikiPage 有这一块（列表/读/删/上传），新壳此前没接，删除与上传只能去旧控制台。
 */
export function WikiRawPanel({ wikiId, teamId }: { wikiId: string; teamId: string }) {
  const [files, setFiles] = useState<Array<{ filename: string; size: number }> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [body, setBody] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmName, setConfirmName] = useState<string | null>(null);
  const [uploadName, setUploadName] = useState('');
  const [uploadBody, setUploadBody] = useState('');
  const alive = useRef(true);

  const loadList = useCallback(async () => {
    setErr(null);
    try {
      const r = await knowledgeApi.wiki.rawList(wikiId);
      if (alive.current) setFiles(r.files);
    } catch (e: unknown) {
      if (alive.current) setErr(errorText(e));
    }
  }, [wikiId]);

  useEffect(() => {
    alive.current = true;
    setFiles(null);
    setSel(null);
    setBody(null);
    void loadList();
    return () => {
      alive.current = false;
    };
  }, [loadList]);

  const open = async (name: string) => {
    setSel(name);
    setBody(null);
    try {
      const r = await knowledgeApi.wiki.rawRead(wikiId, [name]);
      const item = r.items?.[0];
      setBody(item?.not_found ? '（后端说这个文件不存在了）' : (item?.content ?? '（空文件）'));
    } catch (e: unknown) {
      setBody('读取失败：' + errorText(e));
    }
  };

  const remove = async (name: string) => {
    setBusy(true);
    setErr(null);
    try {
      await knowledgeApi.wiki.rawDelete(wikiId, [name]);
      if (sel === name) {
        setSel(null);
        setBody(null);
      }
      await loadList();
    } catch (e: unknown) {
      if (alive.current) setErr('删除失败：' + errorText(e));
    } finally {
      if (alive.current) {
        setBusy(false);
        setConfirmName(null);
      }
    }
  };

  const upload = async () => {
    const name = uploadName.trim();
    if (!name) {
      setErr('先填文件名');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      if (!teamId) throw new Error('缺少团队上下文，无法上传');
      await knowledgeApi.wiki.upload({ teamId, wikiId, filename: name, content: uploadBody });
      setUploadName('');
      setUploadBody('');
      await loadList();
    } catch (e: unknown) {
      if (alive.current) setErr('上传失败：' + errorText(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  return (
    <div className="stk-stack">
      <div className="stk-row-actions">
        <span className="stk-hint-inline">
          {files === null ? '读取中…' : `共 ${files.length} 个原始文档`}
        </span>
        <Btn small ghost onClick={() => void loadList()}>
          刷新
        </Btn>
      </div>
      {err ? <Note tone="bad">{err}</Note> : null}
      {files === null && !err ? <Skeleton rows={5} /> : null}
      {files && files.length === 0 ? (
        <Empty text="这个库还没有原始文档" hint="在下面填文件名与正文上传，或在「来源」里从 git 拉取。" />
      ) : null}
      {files && files.length > 0 ? (
        <div className="stk-list">
          {files.slice(0, 200).map((f) => (
            <Row
              key={f.filename}
              label={f.filename}
              meta={humanSize(f.size)}
              active={sel === f.filename}
              onClick={() => void open(f.filename)}
            />
          ))}
        </div>
      ) : null}
      {sel ? (
        <div className="stk-fold">
          <div className="stk-fold-head">
            <span className="stk-mono">{sel}</span>
            <Btn small ghost onClick={() => { setSel(null); setBody(null); }}>
              收起
            </Btn>
            <Btn
              small
              danger
              disabled={busy}
              onClick={() => (confirmName === sel ? void remove(sel) : setConfirmName(sel))}
            >
              {confirmName === sel ? '确认删除' : '删除文档'}
            </Btn>
          </div>
          {body === null ? <Skeleton rows={5} /> : <pre className="stk-pre">{body}</pre>}
        </div>
      ) : null}

      <div className="stk-fold">
        <div className="stk-fold-head">上传原始文档</div>
        <div className="stk-row-actions">
          <input
            className="st-input"
            placeholder="文件名，例如 intro.md"
            value={uploadName}
            onChange={(e) => setUploadName(e.target.value)}
          />
          <Btn small primary disabled={busy} onClick={() => void upload()}>
            上传
          </Btn>
        </div>
        <textarea
          className="st-input stk-textarea"
          rows={6}
          placeholder="文档正文（纯文本 / markdown）"
          value={uploadBody}
          onChange={(e) => setUploadBody(e.target.value)}
        />
      </div>
    </div>
  );
}


/* ------------------------------------------------------- code 关系图谱（G4） */

/**
 * 代码星云的「关系图谱」：把 code-graph/structure 的 nodes+edges 画成一张关系星图。
 *
 * 为什么不照抄旧 CodePage 的画布：那边是力导向，同一份数据两次打开长得不一样。
 * 这里用 RelGraphCanvas 的确定性摆位——以「边最多的那个节点」为圆心，按 BFS 跳数分环，
 * 摆位只由数据决定，读图的人第二次还能记住位置。
 *
 * 数据只来自既有端点（code-graph/graph），不新增后端契约；截断与总数如实写出来。
 */
const CODE_GRAPH_LIMIT = 120;
// 空数组要提到模块级常量：写成 `res.data?.nodes ?? []` 会让 useMemo 的依赖每次渲染都换新引用
const NO_NODES: CodeGraphStructureNode[] = [];
const NO_EDGES: CodeGraphStructureEdge[] = [];

function buildCodeGraphRel(
  nodes: CodeGraphStructureNode[],
  edges: CodeGraphStructureEdge[],
): { relNodes: RelNode[]; relEdges: RelEdge[]; hub: string | null } {
  const deg = new Map<string, number>();
  for (const e of edges) {
    deg.set(e.source, (deg.get(e.source) ?? 0) + 1);
    deg.set(e.target, (deg.get(e.target) ?? 0) + 1);
  }
  const sorted = [...nodes].sort((a, b) => (deg.get(b.id) ?? 0) - (deg.get(a.id) ?? 0) || a.id.localeCompare(b.id));
  const hub = sorted[0]?.id ?? null;

  // BFS 只为了分环（hop），不改顺序：同 hop 内的排布由 RelGraphCanvas 的黄金角决定
  const hop = new Map<string, number>();
  if (hub) {
    const adj = new Map<string, string[]>();
    for (const e of edges) {
      adj.set(e.source, [...(adj.get(e.source) ?? []), e.target]);
      adj.set(e.target, [...(adj.get(e.target) ?? []), e.source]);
    }
    hop.set(hub, 0);
    let frontier = [hub];
    for (let d = 1; d <= 3 && frontier.length > 0; d += 1) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const nb of adj.get(id) ?? []) {
          if (hop.has(nb)) continue;
          hop.set(nb, d);
          next.push(nb);
        }
      }
      frontier = next;
    }
  }
  const maxDeg = Math.max(1, ...[...deg.values()]);
  const relNodes: RelNode[] = nodes.map((n) => ({
    id: n.id,
    label: n.name || n.qualifiedName || n.id,
    group: n.kind,
    hop: hop.get(n.id) ?? 3,
    weight: Math.min(1, (deg.get(n.id) ?? 0) / maxDeg),
    lit: true,
  }));
  const relEdges: RelEdge[] = edges.map((e) => ({ source: e.source, target: e.target, kind: e.kind, strength: 0.5 }));
  return { relNodes, relEdges, hub };
}

export function CodeGraphPanel({ codeGraphId }: { codeGraphId: string }) {
  // 结构图可能一次要画上百个节点：走 read 泳道 + TTL，切走再回来不重打
  const res = useApiResource({
    key: cacheKey('code.graph', codeGraphId, CODE_GRAPH_LIMIT),
    run: (o) => fetchCodeStructure({ codeGraphId, kinds: [], limit: CODE_GRAPH_LIMIT, offset: 0 }, { force: o.force }),
    enabled: Boolean(codeGraphId),
  });
  const nodes = res.data?.nodes ?? NO_NODES;
  const edges = res.data?.edges ?? NO_EDGES;
  const total = res.data?.total ?? 0;
  const built = useMemo(() => buildCodeGraphRel(nodes, edges), [nodes, edges]);

  const [sel, setSel] = useState<string | null>(null);
  // 一进图就把中心（度数最高的节点）选中：右栏空着等于让人猜「这里能点」
  useEffect(() => {
    setSel(null);
  }, [codeGraphId]);
  useEffect(() => {
    if (built.hub) setSel((cur) => cur ?? built.hub);
  }, [built.hub]);
  const selNode = nodes.find((n) => n.id === sel) ?? null;
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const related = useMemo(() => {
    if (!sel) return [];
    const out: Array<{ id: string; kind: string }> = [];
    const seen = new Set<string>();
    for (const e of edges) {
      const other = e.source === sel ? e.target : e.target === sel ? e.source : null;
      if (!other || !byId.has(other)) continue;
      // 同一对节点之间可能有多条边（calls 跨多行、calls+contains 并存）：
      // 关系列表按「节点+关系」去重，否则右栏会出现两行同名项。
      const sig = other + '|' + e.kind;
      if (seen.has(sig)) continue;
      seen.add(sig);
      out.push({ id: other, kind: e.kind });
    }
    return out.slice(0, 24);
  }, [sel, edges, byId]);

  return (
    <div className="stk-stack">
      <Note>
        {nodes.length > 0
          ? '已取 ' + nodes.length + ' 个节点 / ' + edges.length + ' 条边（服务端共 ' + total + ' 个节点' + (res.data?.truncated ? '，已截断' : '') + '）。画的是以「' + (byId.get(built.hub ?? '')?.name ?? '—') + '」为中心的三跳邻域。'
          : '代码图谱的关系图需要先索引出节点。'}
      </Note>
      {res.loading && !res.data ? <Skeleton rows={6} /> : null}
      {res.error && !res.data ? <Note tone="bad">{errorText(res.error)}</Note> : null}
      {res.stale && res.data ? <Note tone="warn">数据未刷新（这次读取失败，显示的是上次结果）。</Note> : null}
      {!res.loading && !res.error && nodes.length === 0 ? (
        <Empty text="这个图还没有索引出节点" hint="先触发重新索引。" />
      ) : null}
      {nodes.length > 0 ? (
        <div className="stk-graph-body">
          <div className="stk-graph-canvas">
            <RelGraphCanvas
              className="stk-graph-host"
              nodes={built.relNodes}
              edges={built.relEdges}
              focusId={built.hub}
              selectedId={sel}
              onSelect={setSel}
              emptyText="没有可画的关系"
            />
          </div>
          <Surface dense as="aside">
            <StarDetail
              title={selNode ? selNode.name || selNode.qualifiedName : undefined}
              subtitle={selNode ? selNode.kind + ' · ' + selNode.language : undefined}
              kv={
                selNode
                  ? [
                      { k: '限定名', v: selNode.qualifiedName, mono: true },
                      { k: '位置', v: selNode.filePath + ':' + selNode.startLine + '-' + selNode.endLine, mono: true },
                      { k: '导出', v: selNode.isExported ? '是' : '否' },
                      { k: '签名', v: selNode.signature || '—', mono: true },
                    ]
                  : undefined
              }
              relationsTitle="关联节点"
              relations={related.map((r) => ({
                label: byId.get(r.id)?.name ?? r.id,
                meta: r.kind,
                onClick: () => setSel(r.id),
              }))}
              emptyText="点一颗星看它的位置与关联；方向键也能走。"
            />
          </Surface>
        </div>
      ) : null}
    </div>
  );
}