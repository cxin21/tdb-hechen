/**
 * starmap/stations/SoulStation.tsx — 人格恒星云。
 *
 * 版式：星图是背景（Stage.field），所有 UI 浮在上层 —— 与云页同一套规则（DESIGN.md 布局段）。
 * 中心一颗人格恒星，外面四圈：人格九块（结构）→ 六轴特质（状态）→ 人物档案（关系）→ L3 记忆（养料）。
 *
 * 数据全部只读，接口沿用 chat-memory-soul / chat-memory（不改协议、不伪造数字：
 * 取不到就出 Note，不给 0 假象）。五个旧面（人格卡 / 特质 / 情绪 / 人物 / 注入）与版本链
 * 收进「完整视图」弹窗，原信息一条不少。
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
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
import { chatMemoryApi, type ChatMemoryLayerItem } from '@/lib/api/chat-memory';
/* 身份区三态判定（叙事生效 / 条目形态 / 空）是内核语义（ADR-0005 单一源在内核），
 * Panel 侧只有这一份纯函数 —— 复用而不是照抄第二遍，避免门关/降级判定漂移。 */
import { narrativePreviewOf, type CoreSlotRow } from '@/pages/ChatMemoryPage/components/identity-utils';
import { useAuthStore } from '@/stores/auth';
import {
  Dialog,
  Empty,
  KvList,
  Legend,
  MetricRow,
  Note,
  Row,
  Seg,
  Skeleton,
  StarDetail,
  Stage,
  Surface,
  Tag,
} from '../kit';
import PersonaCanvas, {
  type PersonaEdge,
  type PersonaKind,
  type PersonaStar,
} from '../scene/PersonaCanvas';
import { cacheKey, fetchMemoryLayer, useResource } from '../cache';
import { agoText } from '../theme/ui';
import { useStarmap } from '../state/StarmapProvider';

type Section = 'card' | 'traits' | 'emotions' | 'persons' | 'feeling' | 'identity' | 'injection';
type Group = 'all' | 'block' | 'trait' | 'person' | 'core';

const FUNNEL_LABEL: Record<string, string> = {
  'emotion:candidate': '候选',
  'emotion:object_ok': '有对象',
  'emotion:appraised': '已评估',
  'emotion:anchor_hit': '命中标签',
  'emotion:intensity_ok': '强度合格',
  'emotion:committed': '已落库',
};

const GROUP_LABEL: Record<Group, string> = {
  all: '全部星点',
  block: '人格九块',
  trait: '六轴特质',
  person: '人物档案',
  core: '记忆养料',
};

const SECTION_LABEL: Record<Section, string> = {
  card: '人格卡',
  traits: '特质',
  emotions: '情绪',
  persons: '人物',
  feeling: '感受',
  identity: '身份',
  injection: '注入',
};

/** 基调三态：措辞只描述「近况」，不做情绪诊断，也不给「正常/异常」的价值判断。 */
const MOOD_LABEL: Record<'positive' | 'neutral' | 'strained', string> = {
  positive: '近期基调偏正面',
  neutral: '近期基调平稳',
  strained: '近期基调偏紧绷',
};

const MOOD_TONE: Record<'positive' | 'neutral' | 'strained', 'ok' | 'ink' | 'warn'> = {
  positive: 'ok',
  neutral: 'ink',
  strained: 'warn',
};

/** 把人格卡全文按「## / ### 标题」切成 标题→正文，用来给九块星点提供正文。 */
function splitCard(text: string): Array<{ title: string; body: string }> {
  const cleaned = text.replace(/<!--[\s\S]*?-->/g, '').trim();
  const out: Array<{ title: string; body: string }> = [];
  let cur: { title: string; body: string[] } | null = null;
  for (const raw of cleaned.split('\n')) {
    const line = raw.trimEnd();
    const m = /^(#{2,3})\s+(.*)$/.exec(line);
    if (m) {
      if (cur) out.push({ title: cur.title, body: cur.body.join('\n').trim() });
      cur = { title: m[2].trim(), body: [] };
    } else if (cur) {
      cur.body.push(line);
    }
  }
  if (cur) out.push({ title: cur.title, body: cur.body.join('\n').trim() });
  return out;
}

/** 卡正文渲染：段落与「- 」列表项，不把 markdown 记号露给人看。 */
function CardBody({ text }: { text: string }) {
  const cleaned = text.replace(/<!--[\s\S]*?-->/g, '').trim();
  const parts = cleaned.split(/\n## /);
  const intro = parts[0] ?? '';
  const secs = parts.slice(1).map((raw) => {
    const idx = raw.indexOf('\n');
    return { title: (idx === -1 ? raw : raw.slice(0, idx)).trim(), body: idx === -1 ? '' : raw.slice(idx + 1).trim() };
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

/** 身份单槽：条目原文逐行；超过 12 行或 600 字折起来（折叠≠丢失）。 */
function IdentitySlot({ title, hint, lines }: { title: string; hint: string; lines: string[] }) {
  if (lines.length === 0) {
    return (
      <div className="stk-fold">
        <div className="stk-fold-head">{title} · 0 条</div>
        <Empty title="这一槽是空的" hint={hint} />
      </div>
    );
  }
  const full = lines.join('\n');
  const collapsible = lines.length > 12 || full.length > 600;
  const list = (
    <div className="stk-list">
      {lines.map((l, i) => (
        <div key={i} className="stk-snippet">
          {l.replace(/^-\s*/, '')}
        </div>
      ))}
    </div>
  );
  return (
    <div className="stk-fold">
      <div className="stk-fold-head">
        {title} · {lines.length} 条 <span className="stk-hint-inline">{hint}</span>
      </div>
      {collapsible ? (
        <details>
          <summary className="stk-hint-inline">展开全文（共 {full.length} 字）</summary>
          {list}
        </details>
      ) : (
        list
      )}
    </div>
  );
}

export default function SoulStation() {
  const sm = useStarmap();
  const nav = useNavigate();
  const auth = useAuthStore((s) => s.auth);
  const userId = auth && typeof auth === 'object' ? auth.user_id : undefined;

  const [card, setCard] = useState<SoulCardPayload | null>(null);
  const [versions, setVersions] = useState<SoulVersionsPayload | null>(null);
  const [traits, setTraits] = useState<SoulTraitStatePayload | null>(null);
  const [emotions, setEmotions] = useState<SoulEmotionRow[]>([]);
  const [funnel, setFunnel] = useState<Record<string, number> | null>(null);
  const [persons, setPersons] = useState<SoulPersonRow[]>([]);
  const [cores, setCores] = useState<ChatMemoryLayerItem[]>([]);
  const [stats, setStats] = useState<SoulInjectionStatsPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [sel, setSel] = useState<string>('persona:root');
  const [group, setGroup] = useState<Group>('all');
  const [dialog, setDialog] = useState<Section | 'versions' | null>(null);
  const [section, setSection] = useState<Section>('card');

  const query = useMemo(
    () => ({ teamId: sm.teamId ?? '', userId, agentId: sm.activeAgentId ?? undefined }),
    [sm.teamId, userId, sm.activeAgentId],
  );

  /* 选中人物星点才拉档案（重请求，不在首屏打）：走缓存，同一个人再点回来不重打 */
  const personKey = sel.startsWith('person:') ? sel.slice('person:'.length) : null;
  const personRes = useResource<SoulPersonDetailPayload>({
    key: personKey ? cacheKey('persona.person', query.agentId, personKey) : null,
    fetcher: () => fetchSoulPerson({ ...query, key: personKey ?? '' }),
    ttl: 60_000,
    lane: 'soul',
    tags: [`persona:agent:${query.agentId ?? ''}`],
    enabled: Boolean(sm.teamId && personKey),
  });

  /* 感受（近期情绪基调）与身份双槽都挂在**记忆块**上：块没选中就没有数据面，不伪造空值。 */
  const blockId = sm.activeBlockId ?? null;
  const moodRes = useResource({
    key: blockId ? cacheKey('persona.feeling', query.agentId, blockId) : null,
    fetcher: () => chatMemoryApi.moodRead(blockId as string),
    ttl: 60_000,
    lane: 'soul',
    tags: [`persona:agent:${query.agentId ?? ''}`],
    enabled: Boolean(sm.teamId && blockId),
  });
  const identityRes = useResource({
    key: blockId ? cacheKey('persona.identity', query.agentId, blockId) : null,
    fetcher: () => chatMemoryApi.identityRead(blockId as string, { format: 'narrative' }),
    ttl: 60_000,
    lane: 'soul',
    tags: [`persona:agent:${query.agentId ?? ''}`],
    enabled: Boolean(sm.teamId && blockId),
  });
  const mood = moodRes.data?.mood ?? null;
  const identity = useMemo(
    () => narrativePreviewOf((identityRes.data?.slots ?? null) as CoreSlotRow[] | null),
    [identityRes.data],
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
      sm.activeBlockId
        ? settle(
            fetchMemoryLayer({ blockId: sm.activeBlockId, layer: 'L3', limit: 24, offset: 0 }).then((r) => {
              if (r.error && !r.data) throw r.error;
              return r.data!;
            }),
            null,
            'cores',
          )
        : Promise.resolve(null),
    ]).then(([c, v, t, emo, ps, st, coresRes]) => {
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
      setCores(coresRes?.items ?? []);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [query, sm.teamId, sm.activeBlockId]);

  const sections = useMemo(() => splitCard(card?.text ?? ''), [card]);

  const blockStars = useMemo<PersonaStar[]>(() => {
    if (card?.blocks?.length) {
      return card.blocks.map((b) => ({
        id: `block:${b.id}`,
        kind: 'block' as PersonaKind,
        label: b.title,
        weight: b.chars,
        lit: b.chars > 0,
      }));
    }
    /* 旧上游不带 blocks 时按来源行降级：星点照画，标记为「无正文」而不是编一个字数 */
    return Object.keys(card?.sources ?? {}).map((k) => ({
      id: `block:${k}`,
      kind: 'block' as PersonaKind,
      label: k,
      weight: 0,
      lit: false,
    }));
  }, [card]);

  const stars = useMemo<PersonaStar[]>(() => {
    const out: PersonaStar[] = [
      { id: 'persona:root', kind: 'persona', label: '人格恒星', weight: card?.chars ?? 0, lit: Boolean(card) },
    ];
    if (group === 'all' || group === 'block') out.push(...blockStars);
    if (group === 'all' || group === 'trait') {
      for (const t of traits?.traits ?? []) {
        out.push({ id: `trait:${t.label}`, kind: 'trait', label: t.label, weight: t.nowWeight, lit: t.nowWeight > 0 });
      }
    }
    if (group === 'all' || group === 'person') {
      for (const p of persons) {
        out.push({
          id: `person:${p.key}`,
          kind: 'person',
          label: p.displayName || p.key,
          weight: p.fieldCount,
          lit: p.fieldCount > 0,
        });
      }
    }
    if (group === 'all' || group === 'core') {
      for (const c of cores) {
        out.push({
          id: `core:${c.id}`,
          kind: 'core',
          label: c.title || c.id.slice(0, 8),
          weight: c.significance ?? 0.3,
          lit: true,
        });
      }
    }
    return out;
  }, [card, blockStars, traits, persons, cores, group]);

  const edges = useMemo<PersonaEdge[]>(() => {
    const out: PersonaEdge[] = [];
    for (const s of stars) {
      if (s.kind === 'block') out.push({ source: 'persona:root', target: s.id, kind: 'compose' });
      else if (s.kind === 'trait') out.push({ source: 'persona:root', target: s.id, kind: 'state' });
      else if (s.kind === 'person') out.push({ source: s.id, target: 'persona:root', kind: 'archive' });
      else if (s.kind === 'core') out.push({ source: s.id, target: 'persona:root', kind: 'feed' });
    }
    return out;
  }, [stars]);

  const related = useMemo(() => {
    const out: Array<{ id: string; label: string; kind: string }> = [];
    for (const e of edges) {
      const other = e.source === sel ? e.target : e.target === sel ? e.source : null;
      if (!other) continue;
      const s = stars.find((x) => x.id === other);
      if (s) out.push({ id: s.id, label: s.label, kind: s.kind });
    }
    return out.slice(0, 12);
  }, [edges, stars, sel]);

  const blockBody = (id: string): string | null => {
    const label = blockStars.find((b) => b.id === id)?.label;
    if (!label) return null;
    const hit = sections.find((s) => s.title === label);
    return hit?.body ?? null;
  };

  const personaSummary = (
    <StarDetail
      title={card ? `人格卡 v${card.version}` : '人格恒星'}
      subtitle={
        card
          ? `${card.chars} 字 · ${card.hash.slice(0, 8)}${card.dirty ? ' · 有未落版改动' : ''}`
          : '没有拿到人格卡'
      }
      kv={[
        { k: '九块', v: card?.blocks?.length ?? Object.keys(card?.sources ?? {}).length },
        { k: '特质', v: traits?.traits.length ?? 0 },
        { k: '人物', v: persons.length },
        { k: '养料', v: cores.length },
        { k: '注入', v: stats ? `${stats.rows} 轮 / 72h` : '—' },
      ]}
      relationsTitle="组成与状态"
      relations={related.map((r) => ({
        label: r.label,
        meta: GROUP_LABEL[(r.kind as Group) ?? 'all'] ?? r.kind,
        onClick: () => setSel(r.id),
      }))}
      body={card?.text ?? null}
      bodyLabel="人格卡全文"
      actions={
        <button type="button" className="stk-btn" onClick={() => setDialog('card')}>
          完整视图
        </button>
      }
    />
  );

  const selected = (() => {
    if (sel === 'persona:root') return personaSummary;
    const star = stars.find((s) => s.id === sel);
    if (!star) return personaSummary;
    const rels = related.map((r) => ({
      label: r.label,
      meta: GROUP_LABEL[(r.kind as Group) ?? 'all'] ?? r.kind,
      onClick: () => setSel(r.id),
    }));
    if (star.kind === 'block') {
      const b = card?.blocks?.find((x) => `block:${x.id}` === sel);
      return (
        <StarDetail
          title={star.label}
          subtitle={b ? `${b.chars} 字 · 来源 ${b.source}` : '旧上游不带九块元数据'}
          kv={[
            { k: '字数', v: b?.chars ?? '—' },
            { k: '来源', v: b?.source ?? '—' },
            { k: '置信', v: b?.confidence ?? '—' },
            { k: '证据', v: b?.evidenceIds.length ?? '—' },
          ]}
          relations={rels}
          relationsTitle="同一颗人格上的其它星"
          body={blockBody(sel)}
          bodyLabel="这一块的正文"
        />
      );
    }
    if (star.kind === 'trait') {
      const t = traits?.traits.find((x) => `trait:${x.label}` === sel);
      return (
        <StarDetail
          title={star.label}
          subtitle={t?.drifted ? '已漂移（当前权重偏离种子）' : '未漂移'}
          kv={[
            { k: '种子', v: t ? t.seedWeight.toFixed(2) : '—' },
            { k: '当前', v: t ? t.nowWeight.toFixed(2) : '—' },
            { k: '落库', v: traits?.updatedAt ? agoText(traits.updatedAt) : '—' },
          ]}
          relations={rels}
          relationsTitle="关联星点"
          actions={
            <button type="button" className="stk-btn" onClick={() => setDialog('traits')}>
              六轴全览
            </button>
          }
        />
      );
    }
    if (star.kind === 'person') {
      const p = persons.find((x) => `person:${x.key}` === sel);
      const d = personRes.data && `person:${personRes.data.person.key}` === sel ? personRes.data : null;
      return (
        <StarDetail
          title={star.label}
          subtitle={d ? `别名 ${d.person.aliases.join('、') || '无'}` : p ? `字段 ${p.fieldCount} · 关系 ${p.relationCount}` : '人物档案'}
          kv={[
            { k: '平台', v: p?.platform ?? '—' },
            { k: '字段', v: p?.fieldCount ?? '—' },
            { k: '关系', v: p?.relationCount ?? '—' },
            { k: '更新', v: p ? agoText(p.updatedAt) : '—' },
          ]}
          relations={[
            ...(d?.relations ?? []).map((r) => ({
              label: `${r.pred} ${r.direction === 'in' ? '←' : r.direction === 'mutual' ? '↔' : '→'} ${r.objName ?? r.counterpartKey ?? '（未登记）'}`,
              meta: '关系',
            })),
            ...rels,
          ]}
          relationsTitle="关系与关联星点"
          body={d?.fields.map((f) => `${f.label}：${f.text}`).join('\n') ?? null}
          bodyLabel="档案字段"
          actions={
            <button type="button" className="stk-btn" onClick={() => setDialog('persons')}>
              人物全览
            </button>
          }
        />
      );
    }
    const core = cores.find((c) => `core:${c.id}` === sel);
    return (
      <StarDetail
        title={star.label}
        subtitle={core ? `L3 核心记忆 · ${agoText(core.created_at)}` : 'L3 核心记忆'}
        kv={[
          { k: '显著', v: core?.significance != null ? core.significance.toFixed(2) : '—' },
          { k: '确定性', v: core?.certainty ?? '—' },
          { k: '键', v: core?.id.slice(0, 10) ?? '—', mono: true },
        ]}
        relations={rels}
        relationsTitle="关联星点"
        body={core?.body ?? null}
        bodyLabel="这条核心记忆"
      />
    );
  })();

  /* 计数永远按「不筛选的全集」算，否则选中某一组后其它组会显示 0 */
  const counts: Record<Group, number> = {
    all: 1 + blockStars.length + (traits?.traits.length ?? 0) + persons.length + cores.length,
    block: blockStars.length,
    trait: traits?.traits.length ?? 0,
    person: persons.length,
    core: cores.length,
  };

  return (
    <div className="starmap-root">
      <Stage
        field={
          <div className="cloud-field">
            <PersonaCanvas stars={stars} edges={edges} selectedId={sel} onPick={(id) => setSel(id ?? 'persona:root')} />
          </div>
        }
        top={
          <div className="cloud-top">
            <span className="cloud-top-name">人格恒星云</span>
            <span className="cloud-top-meta">
              {card ? `v${card.version} · ${card.chars} 字` : '未加载'}
              {sm.activeAgentId ? ` · ${sm.activeAgentId}` : ''}
            </span>
            <button
              type="button"
              className="stk-btn"
              data-testid="back-to-overview"
              onClick={() => nav('/')}
            >
              返回全景
            </button>
          </div>
        }
        center={
          loading ? (
            <Note stamp="正在取人格卡">人格卡、特质、人物与养料一起拉</Note>
          ) : err ? (
            <Note tone="warn">{err}</Note>
          ) : !card ? (
            <Note tone="warn" stamp="没有拿到人格卡">
              检查团队与 agent 是否已绑定，或 Core 的 soul 读面是否可用
            </Note>
          ) : (
            <span className="stk-hint">点星看详情 · 拖拽旋转 · 滚轮缩放</span>
          )
        }
        left={
          <Surface dense as="aside" title="人格云 · 构成">
            <Seg<Group>
              value={group}
              size="sm"
              onChange={setGroup}
              options={[
                { value: 'all', label: '全部', count: counts.all },
                { value: 'block', label: '九块', count: counts.block },
                { value: 'trait', label: '特质', count: counts.trait },
                { value: 'person', label: '人物', count: counts.person },
                { value: 'core', label: '养料', count: counts.core },
              ]}
            />
            <div className="stk-rows">
              {(['block', 'trait', 'person', 'core'] as Group[]).map((g) => (
                <Row
                  key={g}
                  leading={<span className={group === g ? 'stk-dot stk-dot--ok' : 'stk-dot'} />}
                  label={GROUP_LABEL[g]}
                  meta={counts[g]}
                  active={group === g}
                  onClick={() => setGroup(group === g ? 'all' : g)}
                />
              ))}
            </div>
            {card?.warnings.length ? <Note tone="warn">{card.warnings.join(' · ')}</Note> : null}
            <KvList
              items={[
                { k: '卡版本', v: card ? `v${card.version}` : '—' },
                { k: '字符数', v: card?.chars ?? '—' },
                { k: 'hash', v: card?.hash.slice(0, 10) ?? '—', mono: true },
                { k: '未落版', v: card ? (card.dirty ? '有' : '无') : '—' },
                { k: '种子卡', v: card ? (card.seeded ? '是' : '否') : '—' },
              ]}
            />
            <div className="cloud-actions">
              <button type="button" className="stk-btn" onClick={() => setDialog('card')}>
                完整视图
              </button>
              <button type="button" className="stk-btn is-ghost" onClick={() => setDialog('versions')}>
                版本链 · {versions?.versions.length ?? 0}
              </button>
            </div>
          </Surface>
        }
        right={
          <Surface dense as="aside" title="星点详情">
            {loading ? <Skeleton rows={6} /> : selected}
          </Surface>
        }
        bottom={
          <Legend
            items={[
              { tone: 'l3', label: '人格九块' },
              { tone: 'l1', label: '六轴特质' },
              { tone: 'l2', label: '人物档案' },
              { tone: 'warn', label: 'L3 记忆 · 养料' },
            ]}
            note="暗＝这一块没有正文 / 没有证据；连线只画真实关系（组成 · 状态 · 档案 · 提炼）"
          />
        }
      />

      {dialog ? (
        <Dialog
          title={dialog === 'versions' ? '人格卡版本链' : '人格完整视图'}
          description={
            dialog === 'versions'
              ? `最近 ${versions?.versions.length ?? 0} 个快照：谁在什么时候改了哪一块`
              : '星图是入口，这里是原文与全量清单'
          }
          width={760}
          onClose={() => setDialog(null)}
        >
          {dialog === 'versions' ? (
            <div className="stk-rows">
              {!versions || versions.versions.length === 0 ? (
                <Empty title="没有快照" hint="卡还没落过版时这里是空的。" />
              ) : (
                versions.versions.map((v) => (
                  <Row
                    key={`${v.at}-${v.hash}`}
                    label={v.version != null ? `v${v.version}` : v.hash.slice(0, 8)}
                    meta={`${agoText(v.at)} · ${v.trigger}${v.reasonCode ? ` · ${v.reasonCode}` : ''}`}
                    title={v.reasonDetail ?? undefined}
                  />
                ))
              )}
            </div>
          ) : (
            <>
              <Seg<Section>
                value={section}
                onChange={setSection}
                options={(Object.keys(SECTION_LABEL) as Section[]).map((k) => ({ value: k, label: SECTION_LABEL[k] }))}
              />
              <div className="soul-full">
                {section === 'card' ? (
                  card ? (
                    <>
                      {card.labels.length ? (
                        <div className="stk-rows">
                          {card.labels.map((l) => (
                            <Row key={l.label} label={l.label} meta={l.act.toFixed(1)} title={l.gloss} />
                          ))}
                        </div>
                      ) : null}
                      <CardBody text={card.text} />
                    </>
                  ) : (
                    <Empty title="没有拿到人格卡" hint="检查团队 / agent 绑定与 Core 读面。" />
                  )
                ) : null}

                {section === 'traits' ? (
                  traits && traits.traits.length ? (
                    <div className="stk-rows">
                      {traits.traits.map((t) => (
                        <Row
                          key={t.label}
                          label={t.label}
                          meta={`${t.seedWeight.toFixed(2)} → ${t.nowWeight.toFixed(2)}`}
                          trailing={t.drifted ? <Tag tone="warn">漂移</Tag> : undefined}
                        />
                      ))}
                    </div>
                  ) : (
                    <Empty title="还没有特质状态" hint="六轴状态由维护 tick 产出，先产生对话。" />
                  )
                ) : null}

                {section === 'emotions' ? (
                  <>
                    {funnel ? (
                      <MetricRow
                        items={Object.entries(FUNNEL_LABEL).map(([code, label]) => ({
                          k: label,
                          v: funnel[code] ?? 0,
                        }))}
                      />
                    ) : (
                      <Note>上游没有返回漏斗六档，这里不伪造数字。</Note>
                    )}
                    {emotions.length === 0 ? (
                      <Empty title="还没有情绪行" hint="情绪由事件评估产出。" />
                    ) : (
                      <div className="stk-rows">
                        {emotions.map((e, i) => (
                          <Row
                            key={`${e.at ?? ''}-${i}`}
                            label={e.label ?? '未标注'}
                            meta={`强度 ${(e.decayedIntensity ?? e.intensity ?? 0).toFixed(2)} · 效价 ${(e.valence ?? 0).toFixed(2)} · ${agoText(e.at)}`}
                            title={e.object ?? '（无对象）'}
                          />
                        ))}
                      </div>
                    )}
                  </>
                ) : null}

                {section === 'persons' ? (
                  persons.length === 0 ? (
                    <Empty title="还没有登记的人物" hint="人物从对话里的名字识别出来。" />
                  ) : (
                    <div className="stk-rows">
                      {persons.map((p) => (
                        <Row
                          key={p.key}
                          label={p.displayName || p.key}
                          meta={`字段 ${p.fieldCount} · 关系 ${p.relationCount} · ${p.platform}`}
                          active={sel === `person:${p.key}`}
                          onClick={() => {
                            setSel(`person:${p.key}`);
                            setDialog(null);
                          }}
                        />
                      ))}
                    </div>
                  )
                ) : null}

                {section === 'feeling' ? (
                  !blockId ? (
                    <Empty
                      title="没有选中记忆块"
                      hint="情绪基调与身份区都按记忆块读 —— 先在左栏或聚合页选一个块。"
                    />
                  ) : moodRes.error && !moodRes.data ? (
                    <Note tone="warn">情绪基调读取失败：{moodRes.error.message}</Note>
                  ) : !mood?.tier ? (
                    <>
                      <Empty
                        title="近期没有可判定的基调"
                        hint="样本不足时内核返回 tier=null，这里不补 0、也不给「中性」假象。"
                      />
                      {moodRes.data ? (
                        <KvList
                          items={[
                            { k: '开关', v: mood?.enabled === false ? '关闭' : '开启' },
                            { k: '样本', v: mood?.sampleCount ?? 0 },
                          ]}
                        />
                      ) : null}
                    </>
                  ) : (
                    <>
                      <MetricRow
                        items={[
                          { k: MOOD_LABEL[mood.tier], v: mood.sampleCount, unit: '条经历', tone: MOOD_TONE[mood.tier] },
                        ]}
                      />
                      <KvList
                        items={[
                          { k: '窗口', v: '近 ' + (mood.windowHours ?? 72) + ' 小时' },
                          { k: '采样上限', v: (mood.maxSamples ?? '—') + ' 条' },
                          {
                            k: '判定门槛',
                            v:
                              '正面 ≥ ' + (mood.posThreshold ?? 0.15) +
                              ' · 负面 ≤ ' + (mood.negThreshold ?? -0.15) +
                              ' · 最少 ' + (mood.minSamples ?? 5) + ' 条',
                          },
                          { k: '半衰期', v: (mood.halfLifeHours ?? 48) + ' 小时' },
                          { k: '口径', v: '按时间衰减加权后的效价聚合，只作基调提示，不改任何记忆' },
                        ]}
                      />
                    </>
                  )
                ) : null}

                {section === 'identity' ? (
                  !blockId ? (
                    <Empty
                      title="没有选中记忆块"
                      hint="身份双槽存在记忆块的核心区里 —— 先选一个块。"
                    />
                  ) : identityRes.error && !identityRes.data ? (
                    <Note tone="warn">身份区读取失败：{identityRes.error.message}</Note>
                  ) : identity.state === 'empty' ? (
                    <Empty
                      title="内核没有返回身份内容"
                      hint="两槽都空时整段不渲染 —— 这里不画空卡冒充「有」。"
                    />
                  ) : identity.state === 'active' && identity.narrative ? (
                    <>
                      <Note>
                        叙事生效：身份两槽已被内核合成一段叙事（源 {identity.narrative.source ?? '—'} ·{' '}
                        {identity.narrative.version != null ? 'v' + identity.narrative.version : '无版本号'}）。
                        条目原文不再单独下发。
                      </Note>
                      <pre className="stk-pre">{identity.narrative.content}</pre>
                    </>
                  ) : (
                    <>
                      <Note>条目形态：身份门关闭或叙事降级时内核返回两槽原文，逐条展示（降级不静默）。</Note>
                      <IdentitySlot title="我是谁" hint="agent 自我 · self_identity" lines={identity.entries.self} />
                      <IdentitySlot title="我心中的他" hint="用户身份 · identity" lines={identity.entries.user} />
                    </>
                  )
                ) : null}

                {section === 'injection' ? (
                  stats ? (
                    <>
                      <MetricRow
                        items={[
                          { k: '窗口内注入轮数', v: stats.rows },
                          { k: '最近注入', v: agoText(stats.lastAt) },
                        ]}
                      />
                      <KvList
                        items={[
                          {
                            k: '卡 / 每轮段',
                            v: `${stats.lastCard ? `v${stats.lastCard.version} · ${stats.lastCard.chars} 字` : '—'} / ${stats.lastVolatile ? `${stats.lastVolatile.chars} 字` : '—'}`,
                          },
                          {
                            k: '失败',
                            v: stats.failReasons
                              ? `http ${stats.failReasons.http_status} · 超时 ${stats.failReasons.timeout} · 空 ${stats.failReasons.empty} · 解析 ${stats.failReasons.parse} · 段未注入 ${stats.failReasons.section_install_failed ?? 0}`
                              : '窗口内无失败',
                          },
                          { k: '只渲染未回报', v: String(stats.serverRenderOnly) },
                          { k: '对账', v: `匹配 ${stats.pairs.matched} · 字符不符 ${stats.pairs.charMismatch}` },
                        ]}
                      />
                      {stats.note ? <Note tone="warn">journal 关闭：{stats.note}</Note> : null}
                    </>
                  ) : (
                    <Empty title="没有注入统计" hint="宿主插件未上报时这里会是空的。" />
                  )
                ) : null}
              </div>
            </>
          )}
        </Dialog>
      ) : null}
    </div>
  );
}