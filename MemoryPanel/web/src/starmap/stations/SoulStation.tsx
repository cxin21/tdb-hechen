/**
 * starmap/stations/SoulStation.tsx — 人格站（新壳）。
 *
 * 五个面：人格卡全文 / 特质两栏 / 情绪明细 / 人物与关系 / 注入观测。
 * 全部只读，接口沿用 chat-memory-soul（不改协议、不伪造数据：失败原样展示 message）。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  fetchSoulCard,
  fetchSoulEmotions,
  fetchSoulInjectionStats,
  fetchSoulPerson,
  fetchSoulPersons,
  fetchSoulTraitState,
  fetchSoulVersions,
  type SoulCardPayload,
  type SoulEmotionRow,
  type SoulInjectionStatsPayload,
  type SoulPersonDetailPayload,
  type SoulPersonRow,
  type SoulTraitStatePayload,
  type SoulVersionsPayload,
} from '@/lib/api/chat-memory-soul';
import { useAuthStore } from '@/stores/auth';
import { Card2, Empty, Fields, Note, Pill, Seg, Skeleton, agoText, errorText } from '../theme/ui';
import { useStarmap } from '../state/StarmapProvider';

type Section = 'card' | 'traits' | 'emotions' | 'persons' | 'injection';

const FUNNEL_LABEL: Record<string, string> = {
  'emotion:candidate': '候选',
  'emotion:object_ok': '有对象',
  'emotion:appraised': '已评估',
  'emotion:anchor_hit': '命中标签',
  'emotion:intensity_ok': '强度合格',
  'emotion:committed': '已落库',
};

/** 人格卡正文按「## 标题」切块渲染：正文用<p>/<div>，不把 markdown 记号露给人看。 */
function CardBody({ text }: { text: string }) {
  const cleaned = text.replace(/<!--[\s\S]*?-->/g, '').trim();
  const parts = cleaned.split(/\n## /);
  const intro = parts[0] ?? '';
  const secs = parts.slice(1).map((raw) => {
    const idx = raw.indexOf('\n');
    return {
      title: (idx === -1 ? raw : raw.slice(0, idx)).trim(),
      body: idx === -1 ? '' : raw.slice(idx + 1).trim(),
    };
  });
  const lines = (body: string) =>
    body
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l, i) =>
        l.startsWith('- ') ? (
          <div key={i} className="st-cardli">
            {l.slice(2)}
          </div>
        ) : (
          <p key={i} className="st-cardp">
            {l}
          </p>
        ),
      );
  return (
    <div className="st-cardsections">
      {intro.trim() ? <div className="st-cardintro">{intro.trim()}</div> : null}
      {secs.map((s) => (
        <section key={s.title} className="st-cardsec">
          <div className="st-cardsec-title">{s.title}</div>
          {lines(s.body)}
        </section>
      ))}
    </div>
  );
}

export default function SoulStation() {
  const sm = useStarmap();
  const auth = useAuthStore((s) => s.auth);
  const userId = auth && typeof auth === 'object' ? auth.user_id : undefined;
  const [section, setSection] = useState<Section>('card');
  const [card, setCard] = useState<SoulCardPayload | null>(null);
  const [versions, setVersions] = useState<SoulVersionsPayload | null>(null);
  const [traits, setTraits] = useState<SoulTraitStatePayload | null>(null);
  const [emotions, setEmotions] = useState<SoulEmotionRow[]>([]);
  const [funnel, setFunnel] = useState<Record<string, number> | null>(null);
  const [persons, setPersons] = useState<SoulPersonRow[]>([]);
  const [detail, setDetail] = useState<SoulPersonDetailPayload | null>(null);
  const [stats, setStats] = useState<SoulInjectionStatsPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const query = useMemo(
    () => ({ teamId: sm.teamId ?? '', userId, agentId: sm.activeAgentId ?? undefined }),
    [sm.teamId, userId, sm.activeAgentId],
  );

  useEffect(() => {
    if (!sm.teamId) return;
    let alive = true;
    setLoading(true);
    setErr(null);
    const settle = <T,>(p: Promise<T>, fb: T, tag: string) =>
      p.catch((e: unknown) => {
        console.warn('[soul]', tag, e instanceof Error ? e.message : e);
        return fb;
      });
    void Promise.all([
      settle(fetchSoulCard(query), null, 'card'),
      settle(fetchSoulVersions({ teamId: query.teamId, agentId: query.agentId, snapshotLimit: 30 }), null, 'versions'),
      settle(fetchSoulTraitState(query), null, 'traits'),
      settle(fetchSoulEmotions({ ...query, limit: 100 }), null, 'emotions'),
      settle(fetchSoulPersons(query), null, 'persons'),
      settle(fetchSoulInjectionStats({ ...query, hours: 72 }), null, 'stats'),
    ]).then(([c, v, t, emo, ps, st]) => {
      if (!alive) return;
      setCard(c);
      setVersions(v);
      setTraits(t);
      if (emo) {
        setEmotions(emo.rows ?? []);
        setFunnel((emo.funnel as unknown as Record<string, number>) ?? null);
      }
      setPersons(ps?.persons ?? []);
      setStats(st);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [query, sm.teamId]);

  const openPerson = async (key: string) => {
    if (!sm.teamId) return;
    try {
      setDetail(await fetchSoulPerson({ ...query, key }));
    } catch (e: unknown) {
      setErr(errorText(e));
    }
  };

  return (
    <div className="st-body">
      <div className="st-main">
        <div className="st-toolbar">
          <Seg<Section>
            value={section}
            onChange={setSection}
            options={[
              { value: 'card', label: '人格卡' },
              { value: 'traits', label: '特质' },
              { value: 'emotions', label: '情绪' },
              { value: 'persons', label: '人物关系' },
              { value: 'injection', label: '注入' },
            ]}
          />
          <div className="st-toolbar-right">
            <span className="sm-dim2">
              {card ? `卡 v${card.version} · ${card.chars} 字 · ${card.hash.slice(0, 8)}` : '未加载'}
            </span>
          </div>
        </div>

        {err ? <Note tone="warn">{err}</Note> : null}
        {loading ? <Skeleton rows={10} height={14} /> : null}

        {!loading && section === 'card' ? (
          card ? (
            <div className="st-cardwrap">
              {card.labels.length ? (
                <div className="st-chips">
                  {card.labels.map((l) => (
                    <span key={l.label} className="st-chip" title={l.gloss}>
                      {l.label} {l.act.toFixed(1)}
                    </span>
                  ))}
                </div>
              ) : null}
              {card.warnings.length ? (
                <Note tone="warn">{card.warnings.join(' · ')}</Note>
              ) : null}
              <CardBody text={card.text} />
            </div>
          ) : (
            <Empty text="没有拿到人格卡" hint="检查团队/智能体是否已绑定，或 Core 的 soul 读面是否可用。" />
          )
        ) : null}

        {!loading && section === 'traits' ? (
          traits && traits.traits.length ? (
            <div className="st-traits">
              <div className="sm-dim2">
                {traits.updatedAt ? `状态落库 ${agoText(traits.updatedAt)}` : '还没有任何状态行'}
              </div>
              {traits.traits.map((t) => (
                <div className="st-trait" key={t.label}>
                  <span className="st-trait-label">{t.label}</span>
                  <span className="st-trait-bar">
                    <i style={{ width: `${Math.max(2, Math.min(100, t.nowWeight * 100))}%` }} />
                  </span>
                  <span className="st-trait-num">
                    {t.seedWeight.toFixed(2)} → {t.nowWeight.toFixed(2)}
                  </span>
                  {t.drifted ? <Pill tone="warn">漂移</Pill> : null}
                </div>
              ))}
            </div>
          ) : (
            <Empty text="还没有特质状态" hint="六轴状态由维护 tick 产出，先产生对话。" />
          )
        ) : null}

        {!loading && section === 'emotions' ? (
          <>
            {funnel ? (
              <div className="st-funnel">
                {Object.entries(FUNNEL_LABEL).map(([code, label]) => (
                  <span key={code} className="st-funnel-cell">
                    <b>{funnel[code] ?? 0}</b>
                    <span className="sm-dim2">{label}</span>
                  </span>
                ))}
              </div>
            ) : (
              <Note>上游没有返回漏斗六档，这里不伪造数字。</Note>
            )}
            {emotions.length === 0 ? (
              <Empty text="还没有情绪行" hint="情绪由事件评估产出。" />
            ) : (
              <div className="st-cards">
                {emotions.map((e, i) => (
                  <div className="st-emocard" key={`${e.at ?? ''}-${i}`}>
                    <div className="st-emocard-head">
                      <span className="st-emocard-label">{e.label ?? '未标注'}</span>
                      <span className="sm-dim2">强度 {(e.decayedIntensity ?? e.intensity ?? 0).toFixed(2)}</span>
                      <span className="sm-dim2">{agoText(e.at)}</span>
                    </div>
                    <div className="st-emocard-body">{e.object ?? '（无对象）'}</div>
                    <div className="st-emocard-meta">
                      <span className="sm-dim2">效价 {(e.valence ?? 0).toFixed(2)}</span>
                      <span className="sm-dim2">唤醒 {(e.arousal ?? 0).toFixed(2)}</span>
                      <span className="sm-dim2">归因 {e.agency ?? '不明'}</span>
                      {e.objectPerson ? <Pill>{e.objectPerson}</Pill> : null}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : null}

        {!loading && section === 'persons' ? (
          persons.length === 0 ? (
            <Empty text="还没有登记的人物" hint="人物从对话里的名字识别出来。" />
          ) : (
            <div className="rowlist">
              {persons.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  className={`rowitem ${detail?.person.key === p.key ? 'on' : ''}`}
                  onClick={() => void openPerson(p.key)}
                >
                  <span className="rowitem-main">
                    <span className="rowitem-zh">{p.displayName || p.key}</span>
                    <span className="sm-dim2">
                      字段 {p.fieldCount} · 关系 {p.relationCount} · {p.platform}
                    </span>
                  </span>
                  <span className="sm-dim2">{agoText(p.updatedAt)}</span>
                </button>
              ))}
            </div>
          )
        ) : null}

        {!loading && section === 'injection' ? (
          stats ? (
            <>
              <div className="stat-row">
                <div className="stat-cell">
                  <div className="sm-label">窗口内注入轮数</div>
                  <div className="st-big">{stats.rows}</div>
                </div>
                <div className="stat-cell">
                  <div className="sm-label">最近注入</div>
                  <div className="st-big-sm">{agoText(stats.lastAt)}</div>
                </div>
                <div className="stat-cell">
                  <div className="sm-label">卡 / 每轮段</div>
                  <div className="st-big-sm">
                    {stats.lastCard ? `v${stats.lastCard.version} · ${stats.lastCard.chars} 字` : '—'}
                    {' / '}
                    {stats.lastVolatile ? `${stats.lastVolatile.chars} 字` : '—'}
                  </div>
                </div>
              </div>
              <Fields
                items={[
                  { k: '失败（http/超时/空/解析）', v: stats.failReasons ? `${stats.failReasons.http_status} / ${stats.failReasons.timeout} / ${stats.failReasons.empty} / ${stats.failReasons.parse}` : '窗口内无失败' },
                  { k: '服务端只渲染未回报', v: String(stats.serverRenderOnly) },
                  { k: '对账（匹配/字符不符）', v: `${stats.pairs.matched} / ${stats.pairs.charMismatch}` },
                ]}
              />
              {stats.note ? <Note tone="warn">journal 关闭：{stats.note}</Note> : null}
            </>
          ) : (
            <Empty text="没有注入统计" hint="宿主插件未上报时这里会是空的。" />
          )
        ) : null}
      </div>

      <aside className="st-side sm-scroll">
        <Card2 title="卡状态" en="CARD">
          {card ? (
            <Fields
              items={[
                { k: '版本', v: String(card.version) },
                { k: '字符数', v: String(card.chars) },
                { k: 'hash', v: card.hash.slice(0, 12) },
                { k: '未落版改动', v: card.dirty ? '有' : '无' },
                { k: '种子卡', v: card.seeded ? '是' : '否' },
              ]}
            />
          ) : (
            <Empty text="未取到卡" />
          )}
        </Card2>

        <Card2 title="版本链" en="VERSIONS" right={<span className="sm-dim2">{versions?.versions.length ?? 0}</span>}>
          {!versions || versions.versions.length === 0 ? (
            <Empty text="没有快照" />
          ) : (
            <div className="st-versions sm-scroll">
              {versions.versions.map((v) => (
                <div className="st-version" key={`${v.at}-${v.hash}`}>
                  <div className="st-version-head">
                    <span className="sm-mono">{v.version != null ? `v${v.version}` : v.hash.slice(0, 8)}</span>
                    <span className="sm-dim2">{agoText(v.at)}</span>
                  </div>
                  <div className="sm-dim2">{v.trigger}{v.reasonCode ? ` · ${v.reasonCode}` : ''}</div>
                  {v.reasonDetail ? <div className="st-version-detail">{v.reasonDetail}</div> : null}
                </div>
              ))}
            </div>
          )}
        </Card2>

        {detail ? (
          <Card2
            title="人物档案"
            en="PROFILE"
            right={
              <button type="button" className="sm-link" onClick={() => setDetail(null)}>
                关闭
              </button>
            }
          >
            <div className="st-person-name">{detail.person.displayName || detail.person.key}</div>
            {detail.person.aliases.length ? (
              <div className="sm-dim2">别名：{detail.person.aliases.join('、')}</div>
            ) : null}
            {detail.fields.length === 0 ? (
              <Empty text="还没有提炼字段" hint="字段来自对话原话，人没说过就不会有。" />
            ) : (
              detail.fields.map((f) => (
                <div className="st-field" key={f.field}>
                  <div className="st-field-head">
                    <span className="st-field-label">{f.label}</span>
                    {f.stale ? <Pill tone="warn">过期</Pill> : null}
                  </div>
                  <div className="st-field-text">{f.text}</div>
                  {f.evidence?.[0] ? (
                    <div className="st-field-evidence">「{f.evidence[0].quote}」</div>
                  ) : null}
                </div>
              ))
            )}
            {detail.relations.length ? (
              <div className="st-relations">
                <div className="sm-label">关系</div>
                {detail.relations.map((r) => (
                  <div className="st-relation" key={r.relId}>
                    <span>{r.pred}</span>
                    <span className="sm-dim2">
                      {r.direction === 'in' ? '←' : r.direction === 'mutual' ? '↔' : '→'}{' '}
                      {r.objName ?? r.counterpartKey ?? '（未登记）'}
                    </span>
                    <div className="st-relation-quote">{r.quote}</div>
                  </div>
                ))}
              </div>
            ) : null}
          </Card2>
        ) : null}
      </aside>
    </div>
  );
}
