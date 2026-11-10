/**
 * starmap/stations/SkillsStation.tsx — 技能站（新壳）。
 *
 * 列 / 搜 / 读全文 / 读文件清单 / 删除，全部走 skill-api v3 既有端点。
 */
import { useCallback, useEffect, useState } from 'react';
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
import { useAuthStore } from '@/stores/auth';
import { Btn, Card2, Empty, Fields, Note, Pill, Skeleton, agoText, errorText } from '../theme/ui';
import { useStarmap } from '../state/StarmapProvider';

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
      setErr(errorText(e));
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
      setErr(errorText(e));
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
            技能包：清单、版本、资源文件
            <span className="sm-dim2"> · 范围 {scope === 'agent' ? '当前智能体' : '团队/用户'}</span>
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
            <Btn small onClick={() => void runSearch()} disabled={busy === 'search'}>
              搜索
            </Btn>
            <Btn small ghost onClick={() => { setQuery(''); void load(); }}>
              重置
            </Btn>
          </div>
        </div>

        {err ? <Note tone="warn">{err}</Note> : null}
        {loading ? (
          <Skeleton rows={8} height={14} />
        ) : items.length === 0 ? (
          <Empty text="没有技能" hint="技能由插件或导入生成。" />
        ) : (
          <div className="st-cards">
            {items.map((s) => (
              <button
                key={s.skill_id}
                type="button"
                className={`st-memcard ${detail?.skill_id === s.skill_id ? 'on' : ''}`}
                onClick={() => void open(s.skill_id)}
              >
                <div className="st-memcard-head">
                  <span className="st-memcard-title">{s.name}</span>
                  <span className="sm-dim2">v{s.version}</span>
                </div>
                <div className="st-memcard-body">{s.description || '（无描述）'}</div>
                <div className="st-memcard-meta">
                  <Pill tone={s.status === 'active' ? 'ok' : 'warn'}>{s.status}</Pill>
                  <span className="sm-dim2">更新 {agoText(s.updated_at_ms)}</span>
                  {s.owner_agent_id ? <span className="sm-dim2">{s.owner_agent_id}</span> : null}
                </div>
              </button>
            ))}
          </div>
        )}

        {detail ? (
          <Card2
            title="技能全文"
            en="CONTENT"
            right={
              <button type="button" className="sm-link" onClick={() => { setDetail(null); setListing(null); }}>
                关闭
              </button>
            }
          >
            <pre className="st-pre">{detail.content || '（空）'}</pre>
          </Card2>
        ) : null}
      </div>

      <aside className="st-side sm-scroll">
        <Card2 title="技能信息" en="SKILL">
          {!detail ? (
            <Empty text="选一个技能" hint="点左侧卡片读全文与文件清单。" />
          ) : (
            <>
              <div className="st-detail-title">{detail.name}</div>
              <div className="sm-dim2 sm-mono">{detail.skill_id}</div>
              <Fields
                items={[
                  { k: '版本', v: `v${detail.version}${detail.is_head ? '（head）' : ''}` },
                  { k: '状态', v: detail.status },
                  { k: '内容哈希', v: detail.content_hash ? detail.content_hash.slice(0, 12) : '—' },
                  { k: '文件数', v: String(detail.manifest?.length ?? 0) },
                  { k: '更新', v: agoText(detail.updated_at_ms) },
                ]}
              />
              {detail.manifest?.length ? (
                <div className="st-versions">
                  {detail.manifest.map((m) => (
                    <div className="st-version" key={m.path}>
                      <div className="st-version-head">
                        <span className="sm-mono">{m.path}</span>
                        <span className="sm-dim2">{m.size_bytes} B</span>
                      </div>
                      <div className="sm-dim2">{m.mime_type}</div>
                    </div>
                  ))}
                </div>
              ) : null}
              {listing?.listing ? (
                <div className="st-listing">
                  <div className="sm-label">清单（{listing.mode}）</div>
                  <pre className="st-pre st-pre-sm">{listing.listing}</pre>
                </div>
              ) : null}
              <div className="st-detail-actions">
                <Btn
                  small
                  danger
                  ghost
                  disabled={!!busy}
                  onClick={async () => {
                    setBusy('del');
                    try {
                      if (!userId || !sm.teamId || !sm.activeAgentId) {
                        setErr('删除需要团队/智能体/用户三个轴都在场（skill v3 契约）。');
                        return;
                      }
                      await deleteSkillV3({
                        skill_id: detail.skill_id,
                        user_id: userId,
                        team_id: sm.teamId,
                        agent_id: sm.activeAgentId,
                        expected_version: detail.version,
                      });
                      setDetail(null);
                      await load();
                    } catch (e: unknown) {
                      setErr(errorText(e));
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  删除技能
                </Btn>
              </div>
            </>
          )}
        </Card2>
      </aside>
    </div>
  );
}
