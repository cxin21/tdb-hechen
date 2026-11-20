/**
 * starmap/stations/SkillsStation.tsx — 技能站（新壳）。
 *
 * 列 / 搜 / 读全文 / 读文件清单，全部走 skill-api v3 既有端点。
 *
 * 「挂载」的语义见 lib/api/skills.ts 文件头：让技能真正归属某 agent 的唯一机制是 fork
 * 一份 owner_agent_id 指向该 agent 的独立副本（acl/grant 只改 meta 授权层，对运行时注入无效）。
 * 因此：
 *  - 未挂到本 agent → 「挂到当前智能体」＝ fork 一份副本；
 *  - 已挂到本 agent → 「从当前智能体移除」＝ 归档这份副本（两段式确认）。
 * 这两个动作对同一份副本等价，所以**不再并列一个「删除技能」**：那会变成对同一个 id
 * 的两个按钮，点哪个都是归档，只增加误点概率。团队资产（owner_agent_id 为空、没有副本）
 * 才需要真的删掉源件，那种情况单独给一个危险动作，且同样两段式。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  deleteSkillV3,
  getSkill,
  getSkillListing,
  listSkills,
  searchSkills,
  type ListingResult,
  type SkillDetail,
  type SkillSummary,
} from '@/lib/api/skill-api';
import { skillApi } from '@/lib/api/skills';
import { getErrorMessage } from '@/lib/error-message';
import { useAuthStore } from '@/stores/auth';
import { agoText } from '../theme/ui';
import { Empty, KvList, Note, Row, Skeleton, Surface, Tag } from '../kit';
import { useStarmap } from '../state/StarmapProvider';

function errText(e: unknown): string {
  return getErrorMessage(e);
}

export default function SkillsStation() {
  const sm = useStarmap();
  const auth = useAuthStore((s) => s.auth);
  const userId = auth && typeof auth === 'object' ? auth.user_id : undefined;
  const [items, setItems] = useState<SkillSummary[]>([]);
  const [scope, setScope] = useState<'agent' | 'team'>('team');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [listing, setListing] = useState<ListingResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** 归档不可逆，两个删除类动作都先落一次确认态。 */
  const [confirmDetach, setConfirmDetach] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      // 先按当前智能体取；该智能体没有技能时退回团队/用户面，避免「什么都没有」的假空
      let res = await listSkills({
        user_id: userId,
        team_id: sm.teamId ?? undefined,
        agent_id: sm.activeAgentId ?? undefined,
        pagination: { limit: 100, offset: 0 },
      });
      let nextScope: 'agent' | 'team' = 'agent';
      if (!(res.items ?? []).length) {
        res = await listSkills({
          user_id: userId,
          team_id: sm.teamId ?? undefined,
          pagination: { limit: 100, offset: 0 },
        });
        nextScope = 'team';
      }
      setScope(nextScope);
      setItems(res.items ?? []);
    } catch (e: unknown) {
      setItems([]);
      setErr(errText(e));
    } finally {
      setLoading(false);
    }
  }, [sm.teamId, sm.activeAgentId, userId]);

  useEffect(() => {
    void load();
  }, [load]);

  const open = async (id: string) => {
    setBusy('open');
    setErr(null);
    setConfirmDetach(null);
    setConfirmDelete(null);
    try {
      setDetail(await getSkill({ skill_id: id, user_id: userId, team_id: sm.teamId ?? undefined }));
      if (sm.activeAgentId) {
        getSkillListing({
          user_id: userId,
          team_id: sm.teamId ?? undefined,
          agent_id: sm.activeAgentId,
        })
          .then(setListing)
          .catch(() => setListing(null));
      } else {
        setListing(null);
      }
    } catch (e: unknown) {
      setErr(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const assigned = detail ? Boolean(sm.activeAgentId) && detail.owner_agent_id === sm.activeAgentId : null;

  const toggleMount = async (s: SkillDetail) => {
    if (!sm.teamId || !sm.activeAgentId) return;
    if (!userId) {
      setErr('没有登录用户，无法按 v3 契约改动技能归属。');
      return;
    }
    setBusy('mount');
    setErr(null);
    try {
      if (s.owner_agent_id === sm.activeAgentId) {
        await deleteSkillV3({
          skill_id: s.skill_id,
          user_id: userId,
          team_id: sm.teamId,
          agent_id: s.owner_agent_id || sm.activeAgentId,
          expected_version: s.version,
        });
        setConfirmDetach(null);
        setDetail(null);
      } else {
        await skillApi.forkToAgent(sm.teamId, s.skill_id, sm.activeAgentId);
      }
      await load();
    } catch (e: unknown) {
      setErr(errText(e));
    } finally {
      setBusy(null);
    }
  };

  /** 删源件：只在没有 owner 副本时出现（团队资产），按 v3 契约仍需 agent 轴。 */
  const removeSource = async (s: SkillDetail) => {
    if (!userId || !sm.teamId) {
      setErr('删除需要团队/用户两个轴都在场（skill v3 契约）。');
      return;
    }
    const owner = s.owner_agent_id || sm.activeAgentId;
    if (!owner) {
      setErr('这份技能没有 owner agent，无法按 v3 契约归档。');
      return;
    }
    setBusy('del');
    setErr(null);
    try {
      await deleteSkillV3({
        skill_id: s.skill_id,
        user_id: userId,
        team_id: sm.teamId,
        agent_id: owner,
        expected_version: s.version,
      });
      setConfirmDelete(null);
      setDetail(null);
      await load();
    } catch (e: unknown) {
      setErr(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const runSearch = async () => {
    if (!query.trim()) {
      void load();
      return;
    }
    setBusy('search');
    setErr(null);
    try {
      const res = await searchSkills({
        user_id: userId,
        team_id: sm.teamId ?? undefined,
        agent_id: sm.activeAgentId ?? undefined,
        query: query.trim(),
        top_k: 30,
      });
      setItems(res.items ?? []);
    } catch (e: unknown) {
      setErr(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const mountText = useMemo(() => {
    if (!detail) return '—';
    if (detail.owner_agent_id === sm.activeAgentId && sm.activeAgentId) return '已挂到本智能体';
    if (detail.owner_agent_id) return '挂在 ' + detail.owner_agent_id + ' 上';
    return '未挂载（团队可见）';
  }, [detail, sm.activeAgentId]);

  const assignedCount = useMemo(
    () => items.filter((s) => s.owner_agent_id && s.owner_agent_id === sm.activeAgentId).length,
    [items, sm.activeAgentId],
  );

  return (
    <div className="starmap-root">
      <div className="st-body">
        <div className="st-main">
          <div className="st-toolbar">
            <div className="st-toolbar-left sm-dim2">
              技能包：清单、版本、资源文件
              <span className="stk-meta"> · 范围 {scope === 'agent' ? '当前智能体' : '团队/用户'}</span>
            </div>
            <div className="st-toolbar-right">
              <input
                className="st-input"
                placeholder="搜技能…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void runSearch();
                }}
              />
              <button type="button" className="stk-btn is-sm" disabled={busy === 'search'} onClick={() => void runSearch()}>
                搜索
              </button>
              <button
                type="button"
                className="stk-btn is-ghost is-sm"
                onClick={() => {
                  setQuery('');
                  void load();
                }}
              >
                重置
              </button>
            </div>
          </div>

          <Surface
            dense
            title="技能清单"
            aside={
              <span className="stk-meta">
                共 {items.length} 份 · 已挂到本智能体 {assignedCount} 份
              </span>
            }
          >
            {err ? <Note tone="bad">{err}</Note> : null}
            {loading ? (
              <Skeleton rows={8} />
            ) : items.length === 0 ? (
              <Empty title="没有技能" hint="技能由插件或导入生成。" />
            ) : (
              <div className="stk-list">
                {items.map((s) => (
                  <Row
                    key={s.skill_id}
                    label={s.name}
                    meta={'v' + s.version + ' · 更新 ' + agoText(s.updated_at_ms)}
                    active={detail?.skill_id === s.skill_id}
                    onClick={() => void open(s.skill_id)}
                    trailing={
                      <span className="stk-row-tools">
                        <Tag tone={s.status === 'active' ? 'ink' : 'warn'}>{s.status}</Tag>
                        <Tag tone={s.owner_agent_id === sm.activeAgentId && sm.activeAgentId ? 'ok' : undefined}>
                          {s.owner_agent_id === sm.activeAgentId && sm.activeAgentId
                            ? '本智能体'
                            : s.owner_agent_id
                              ? '其他智能体'
                              : '团队可见'}
                        </Tag>
                      </span>
                    }
                  />
                ))}
              </div>
            )}
          </Surface>

          {detail ? (
            <Surface
              dense
              title="技能全文"
              aside={
                <button
                  type="button"
                  className="stk-btn is-ghost is-sm"
                  onClick={() => {
                    setDetail(null);
                    setListing(null);
                  }}
                >
                  关闭
                </button>
              }
            >
              <pre className="stk-pre">{detail.content || '（空）'}</pre>
            </Surface>
          ) : null}
        </div>

        <aside className="st-side sm-scroll">
          <Surface dense title="技能信息">
            {!detail ? (
              <Empty title="选一份技能" hint="点左侧列表读全文与资源文件清单。" />
            ) : (
              <>
                <div className="st-detail-title">{detail.name}</div>
                <div className="stk-mono">{detail.skill_id}</div>
                <KvList
                  items={[
                    { k: '挂载', v: mountText },
                    { k: '版本', v: 'v' + detail.version + (detail.is_head ? '（head）' : '') },
                    { k: '状态', v: detail.status },
                    { k: '内容哈希', v: detail.content_hash ? detail.content_hash.replace(/^sha256:/, '').slice(0, 12) : '—', mono: true },
                    { k: '文件数', v: String(detail.manifest?.length ?? 0) },
                    { k: '更新', v: agoText(detail.updated_at_ms) },
                  ]}
                />
                {detail.manifest?.length ? (
                  <div className="st-versions">
                    {detail.manifest.map((m) => (
                      <div className="st-version" key={m.path}>
                        <div className="st-version-head">
                          <span className="stk-mono">{m.path}</span>
                          <span className="stk-meta">{m.size_bytes} B</span>
                        </div>
                        <div className="stk-meta">{m.mime_type}</div>
                      </div>
                    ))}
                  </div>
                ) : null}
                {listing?.listing ? (
                  <div className="st-listing">
                    <div className="stk-meta">清单（{listing.mode}）</div>
                    <pre className="stk-pre st-pre-sm">{listing.listing}</pre>
                  </div>
                ) : null}
                <div className="stk-row-actions">
                  {sm.teamId && sm.activeAgentId ? (
                    confirmDetach === detail.skill_id ? (
                      <>
                        <button
                          type="button"
                          className="stk-btn is-danger is-sm"
                          disabled={busy === 'mount'}
                          onClick={() => void toggleMount(detail)}
                        >
                          确认移除
                        </button>
                        <button
                          type="button"
                          className="stk-btn is-ghost is-sm"
                          disabled={busy === 'mount'}
                          onClick={() => setConfirmDetach(null)}
                        >
                          取消
                        </button>
                      </>
                    ) : assigned ? (
                      <button
                        type="button"
                        className="stk-btn is-ghost is-sm"
                        disabled={!!busy}
                        onClick={() => setConfirmDetach(detail.skill_id)}
                      >
                        从当前智能体移除
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="stk-btn is-sm"
                        disabled={!!busy}
                        onClick={() => void toggleMount(detail)}
                      >
                        挂到当前智能体
                      </button>
                    )
                  ) : (
                    <span className="stk-meta">先选一个智能体，技能才能挂接</span>
                  )}
                  {detail.owner_agent_id ? null : confirmDelete === detail.skill_id ? (
                    <>
                      <button
                        type="button"
                        className="stk-btn is-danger is-sm"
                        disabled={busy === 'del'}
                        onClick={() => void removeSource(detail)}
                      >
                        确认删除源件
                      </button>
                      <button
                        type="button"
                        className="stk-btn is-ghost is-sm"                        onClick={() => setConfirmDelete(null)}
                      >
                        取消
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="stk-btn is-ghost is-sm"
                      disabled={!!busy}
                      onClick={() => setConfirmDelete(detail.skill_id)}
                    >
                      删除源件
                    </button>
                  )}
                </div>
                <p className="stk-hint-inline">
                  「移除」归档的是本智能体这份副本，团队源件照常保留；「删除源件」只在没有副本归属时出现，删掉就没了。
                </p>
              </>
            )}
          </Surface>
        </aside>
      </div>
    </div>
  );
}
