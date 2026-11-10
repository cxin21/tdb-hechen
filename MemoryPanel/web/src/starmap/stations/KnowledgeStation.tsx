/**
 * starmap/stations/KnowledgeStation.tsx — 知识与代码两站共用。
 *
 * 只读列资产 + 三条真实写操作（新建 / 同步重建 / 删除），全部走 knowledgeApi 既有端点。
 */
import { useCallback, useEffect, useState } from 'react';
import { knowledgeApi, type CodeGraphDetail, type WikiDetail } from '@/lib/api/knowledge-api';
import { Btn, Card2, Empty, Fields, Note, Pill, Skeleton, agoText, errorText } from '../theme/ui';
import { useStarmap } from '../state/StarmapProvider';

type Kind = 'wiki' | 'code';

interface Row {
  id: string;
  name: string;
  status: string;
  summary: string | null;
  owner: string;
  pages?: number | null;
  stats?: { files: number; nodes: number; edges: number } | null;
  lastSync: string | null;
  syncError: string | null;
  repoUrl?: string;
  branch?: string | null;
}

function toRow(kind: Kind, d: WikiDetail | CodeGraphDetail): Row {
  if (kind === 'wiki') {
    const w = d as WikiDetail;
    return {
      id: w.wiki_id,
      name: w.name,
      status: w.status,
      summary: w.summary ?? null,
      owner: w.owner_user_id ?? '',
      pages: w.page_count ?? null,
      lastSync: w.last_sync_at ?? null,
      syncError: w.sync_error ?? null,
      branch: w.branch ?? null,
    };
  }
  const c = d as CodeGraphDetail;
  return {
    id: c.code_graph_id,
    name: c.repo_name,
    status: c.status,
    summary: c.summary ?? null,
    owner: c.owner_user_id ?? '',
    stats: c.stats ?? null,
    lastSync: c.last_sync_at ?? null,
    syncError: c.sync_error ?? null,
    repoUrl: c.repo_url,
    branch: c.branch,
  };
}

function statusTone(status: string): 'ok' | 'warn' | 'bad' | undefined {
  if (status === 'ready' || status === 'active') return 'ok';
  if (status === 'failed' || status === 'error') return 'bad';
  if (status === 'pending' || status === 'processing' || status === 'draft') return 'warn';
  return undefined;
}

export default function KnowledgeStation({ kind }: { kind: Kind }) {
  const sm = useStarmap();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', repoUrl: '', branch: 'main' });

  const load = useCallback(async () => {
    if (!sm.teamId) return;
    setLoading(true);
    setErr(null);
    try {
      const list =
        kind === 'wiki'
          ? await knowledgeApi.wiki.teamAssets(sm.teamId)
          : await knowledgeApi.code.teamAssets(sm.teamId);
      setRows(list.map((d) => toRow(kind, d)));
    } catch (e: unknown) {
      setRows([]);
      setErr(errorText(e));
    } finally {
      setLoading(false);
    }
  }, [kind, sm.teamId]);

  useEffect(() => {
    void load();
  }, [load]);

  const current = rows.find((r) => r.id === sel) ?? null;

  const doSync = async (id: string) => {
    setBusy('sync');
    try {
      if (kind === 'wiki') await knowledgeApi.wiki.sync(id);
      else await knowledgeApi.code.sync(id);
      await load();
    } catch (e: unknown) {
      setErr(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const doDelete = async (id: string) => {
    setBusy('del');
    try {
      if (kind === 'wiki') await knowledgeApi.wiki.delete(id);
      else await knowledgeApi.code.delete(id);
      setSel(null);
      await load();
    } catch (e: unknown) {
      setErr(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const doCreate = async () => {
    if (!sm.teamId) return;
    setBusy('create');
    setErr(null);
    try {
      if (kind === 'wiki') {
        await knowledgeApi.wiki.create(sm.teamId, form.name.trim());
      } else {
        await knowledgeApi.code.create({
          teamId: sm.teamId,
          repoUrl: form.repoUrl.trim(),
          branch: form.branch.trim() || 'main',
          repoName: form.name.trim() || undefined,
        });
      }
      setCreating(false);
      setForm({ name: '', repoUrl: '', branch: 'main' });
      await load();
    } catch (e: unknown) {
      setErr(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="st-body">
      <div className="st-main">
        <div className="st-toolbar">
          <div className="st-toolbar-left sm-dim2">
            {kind === 'wiki' ? '文档库：拉取、编译、检索' : '代码图谱：仓库索引与代码检索'}
          </div>
          <div className="st-toolbar-right">
            <Btn small onClick={() => void load()} disabled={loading}>
              刷新
            </Btn>
            <Btn small primary onClick={() => setCreating((v) => !v)}>
              {kind === 'wiki' ? '新建文档库' : '登记仓库'}
            </Btn>
          </div>
        </div>

        {err ? <Note tone="warn">{err}</Note> : null}

        {creating ? (
          <Card2 title={kind === 'wiki' ? '新建文档库' : '登记仓库'} en="NEW">
            <div className="st-form">
              <label className="st-field-row">
                <span>{kind === 'wiki' ? '名称' : '仓库名'}</span>
                <input
                  className="st-input"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder={kind === 'wiki' ? '例如：产品文档' : '例如：td-agemem'}
                />
              </label>
              {kind === 'code' ? (
                <>
                  <label className="st-field-row">
                    <span>仓库地址</span>
                    <input
                      className="st-input"
                      value={form.repoUrl}
                      onChange={(e) => setForm({ ...form, repoUrl: e.target.value })}
                      placeholder="https://…"
                    />
                  </label>
                  <label className="st-field-row">
                    <span>分支</span>
                    <input
                      className="st-input"
                      value={form.branch}
                      onChange={(e) => setForm({ ...form, branch: e.target.value })}
                    />
                  </label>
                </>
              ) : null}
              <div className="st-detail-actions">
                <Btn
                  small
                  primary
                  disabled={busy === 'create' || !form.name.trim() || (kind === 'code' && !form.repoUrl.trim())}
                  onClick={() => void doCreate()}
                >
                  提交
                </Btn>
                <Btn small ghost onClick={() => setCreating(false)}>
                  取消
                </Btn>
              </div>
            </div>
          </Card2>
        ) : null}

        {loading ? (
          <Skeleton rows={6} height={14} />
        ) : rows.length === 0 ? (
          <Empty
            text={kind === 'wiki' ? '团队还没有文档库' : '团队还没有代码图谱'}
            hint={kind === 'wiki' ? '新建后触发编译，页面才会长出知识。' : '登记仓库后索引会异步构建。'}
          />
        ) : (
          <div className="st-cards">
            {rows.map((r) => (
              <button
                key={r.id}
                type="button"
                className={`st-memcard ${sel === r.id ? 'on' : ''}`}
                onClick={() => setSel(sel === r.id ? null : r.id)}
              >
                <div className="st-memcard-head">
                  <span className="st-memcard-title">{r.name}</span>
                  <Pill tone={statusTone(r.status)}>{r.status}</Pill>
                </div>
                {r.summary ? <div className="st-memcard-body">{r.summary}</div> : null}
                <div className="st-memcard-meta">
                  {kind === 'wiki' ? (
                    <span className="sm-dim2">页数 {r.pages ?? '—'}</span>
                  ) : (
                    <span className="sm-dim2">
                      文件 {r.stats?.files ?? '—'} · 节点 {r.stats?.nodes ?? '—'} · 边 {r.stats?.edges ?? '—'}
                    </span>
                  )}
                  <span className="sm-dim2">同步 {agoText(r.lastSync)}</span>
                  {r.branch ? <span className="sm-dim2">{r.branch}</span> : null}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      <aside className="st-side sm-scroll">
        <Card2 title="资产详情" en="ASSET">
          {!current ? (
            <Empty text="选一个资产" hint="点左侧卡片查看状态与操作。" />
          ) : (
            <>
              <div className="st-detail-title">{current.name}</div>
              <div className="sm-dim2 sm-mono">{current.id}</div>
              <Fields
                items={[
                  { k: '状态', v: current.status },
                  { k: '归属', v: current.owner },
                  { k: '最近同步', v: agoText(current.lastSync) },
                  ...(current.repoUrl ? [{ k: '仓库', v: current.repoUrl }] : []),
                  ...(current.branch ? [{ k: '分支', v: current.branch }] : []),
                ]}
              />
              {current.syncError ? <Note tone="bad">{current.syncError}</Note> : null}
              <div className="st-detail-actions">
                <Btn small primary disabled={!!busy} onClick={() => void doSync(current.id)}>
                  {kind === 'wiki' ? '重新拉取' : '重新索引'}
                </Btn>
                <Btn small danger ghost disabled={!!busy} onClick={() => void doDelete(current.id)}>
                  删除
                </Btn>
              </div>
            </>
          )}
        </Card2>
      </aside>
    </div>
  );
}
