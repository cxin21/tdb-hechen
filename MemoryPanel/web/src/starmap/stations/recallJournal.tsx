/**
 * starmap/stations/recallJournal.tsx — 回放日志（旧 ChatMemoryPage「回放日志」页签的新壳版）。
 *
 * 旧页 `pages/ChatMemoryPage/components/RecallJournalView.tsx` 一份没搬：那份是 tea-component +
 * `recall-journal.css` 的独立版式，且自己管着 agent 下拉与分页。这里只保留同一份语义：
 *   - 数据源不变（BFF `chat-memory/recall-journal` 直读日志文件，分页倒序 + 租户过滤）；
 *   - 三口径过滤（召回 / 跳过 / 全部）连条数一起显示 —— skip 行 query 恒空，混在一起全是空卡；
 *   - skip 行标题退到 rawQuery 首行，正文给 skipReason + memoryLines + 注入块原文；
 *   - 分页走 kit `Pager`，取数走 cache 层（1→2→1 不重打，换 agent 换 key）。
 *
 * 不伪造：上游没给的字段一律不渲染；没有团队 / 没有 agent 时明说缺哪一样。
 */
import { useEffect, useState } from 'react';
import type { RecallJournalEntry } from '@/lib/api/chat-memory';
import { Empty, KvList, Note, Pager, Row, Seg, Skeleton, Surface, Tag } from '../kit';
import { fetchRecallJournal, useApiResource } from '../cache';

const PAGE_SIZE = 20;

type Filter = 'recall' | 'skipped' | 'all';

const FILTER_LABEL: Record<Filter, string> = {
  recall: '召回',
  skipped: '跳过',
  all: '全部',
};

function skipTitle(e: RecallJournalEntry): string {
  const raw = (e.rawQuery ?? '').split('\n')[0]?.trim() ?? '';
  if (!raw) return '（跳过，未带原文）';
  return raw.length > 80 ? `${raw.slice(0, 80)}…` : raw;
}

function atText(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString('zh-CN', { hour12: false });
}

function metaOf(e: RecallJournalEntry): string {
  const parts: string[] = [atText(e.ts)];
  if (e.strategy) parts.push(e.strategy);
  if (e.layered) parts.push('分层');
  if (e.sessionReused) parts.push('复用会话');
  if (e.conclusionCount > 0 || e.experienceCount > 0) {
    parts.push(`结论 ${e.conclusionCount} · 经验 ${e.experienceCount}`);
  }
  return parts.join(' · ');
}

export interface RecallJournalPanelProps {
  teamId: string;
  agentId: string;
}

export default function RecallJournalPanel({ teamId, agentId }: RecallJournalPanelProps) {
  const [filter, setFilter] = useState<Filter>('recall');
  const [page, setPage] = useState(1);
  const [picked, setPicked] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    setPage(1);
    setPicked(null);
  }, [teamId, agentId, filter]);

  const key = teamId && agentId
    ? `${teamId}|${agentId}|${filter}|${PAGE_SIZE}|${page}|${nonce}`
    : null;

  // 同样不能套 useResource：fetchRecallJournal 内部已经排过一次泳道（read）。
  // 每个外层都会白占一个 read 槽位，四个这样的面板同时挂载就把槽位扣满、内层永久排队。
  const res = useApiResource({
    key: key ? `memory.journal.${key}` : null,
    run: (o) =>
      fetchRecallJournal(
        { teamId, agentId, page, pageSize: PAGE_SIZE, filter },
        { force: o.force },
      ),
    enabled: Boolean(key),
  });

  const items = res.data?.items ?? [];
  const counts = res.data?.counts ?? { all: 0, recall: 0, skipped: 0 };
  const total = res.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const detail = items.find((e, i) => (e.ts ?? String(i)) === picked) ?? null;

  if (!teamId) {
    return (
      <Note tone="warn">
        没有选中团队：回放日志按团队隔离，先在上方选一个团队。
      </Note>
    );
  }
  if (!agentId) {
    return (
      <Note tone="warn">
        没有选中智能体：回放日志按 agent 隔离，先在上方选一个智能体。
      </Note>
    );
  }

  return (
    <div className="stk-stack">
      <div className="stk-row-actions">
        <Seg<Filter>
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'recall', label: FILTER_LABEL.recall, count: counts.recall },
            { value: 'skipped', label: FILTER_LABEL.skipped, count: counts.skipped },
            { value: 'all', label: FILTER_LABEL.all, count: counts.all },
          ]}
        />
        <span className="stk-meta">共 {total.toLocaleString('zh-CN')} 条</span>
        <button
          type="button"
          className="stk-btn is-ghost is-sm"
          onClick={() => setNonce((n) => n + 1)}
          disabled={res.loading}
        >
          刷新
        </button>
      </div>

      {res.error && !res.data ? (
        <Note tone="warn">日志读取失败：{res.error.message}</Note>
      ) : null}
      {res.stale && res.data ? <Note tone="warn">数据未刷新（上方读失败，显示的是上一次结果）。</Note> : null}

      {res.loading && !res.data ? (
        <Skeleton rows={6} />
      ) : items.length === 0 ? (
        <Empty
          title="这一口径下没有日志"
          hint={
            filter === 'skipped'
              ? '没有跳过行说明近期每一次召回都真的取到了记忆。'
              : '内核还没往这个 agent 写日志，或日志已被轮转。'
          }
        />
      ) : (
        <div className="stk-rows">
          {items.map((e, i) => {
            const id = e.ts ?? String(i);
            return (
              <Row
                key={`${id}-${i}`}
                label={e.skipReason ? skipTitle(e) : e.query || '（空查询）'}
                meta={metaOf(e)}
                active={picked === id}
                onClick={() => setPicked(picked === id ? null : id)}
                trailing={
                  e.skipReason ? (
                    <Tag tone="warn">跳过</Tag>
                  ) : (
                    <Tag tone="l3">召回</Tag>
                  )
                }
              />
            );
          })}
        </div>
      )}

      <Pager
        page={page}
        pages={pages}
        total={total}
        pageSize={PAGE_SIZE}
        unit="条"
        loading={res.loading}
        onChange={setPage}
      />

      {detail ? (
        <Surface dense title="本轮详情">
          <KvList
            items={[
              { k: '时间', v: atText(detail.ts) },
              { k: '查询', v: detail.query || '—' },
              { k: '策略', v: detail.strategy || '—' },
              { k: '分层', v: detail.layered ? '是' : '否' },
              { k: '会话复用', v: detail.sessionReused ? '是' : '否' },
              { k: '结论 / 经验', v: `${detail.conclusionCount} / ${detail.experienceCount}` },
              {
                k: '检索耗时',
                v: detail.searchTiming
                  ? `fts ${detail.searchTiming.ftsMs}ms（${detail.searchTiming.ftsHits} 命中）· 向量 ${detail.searchTiming.embeddingMs}ms（${detail.searchTiming.embeddingHits} 命中）`
                  : '—',
              },
              { k: '会话键', v: detail.sessionKey ?? '—', mono: true },
            ]}
          />
          {detail.skipReason ? (
            <Note tone="warn">跳过原因：{detail.skipReason}</Note>
          ) : null}
          {detail.rawQuery && detail.skipReason ? (
            <pre className="stk-pre">{detail.rawQuery}</pre>
          ) : null}
          {detail.memoryLines && detail.memoryLines.length > 0 ? (
            <>
              <div className="stk-fold-head">召回记忆行 · {detail.memoryLines.length}</div>
              <div className="stk-list">
                {detail.memoryLines.map((l, i) => (
                  <div key={i} className="stk-snippet">
                    {l}
                  </div>
                ))}
              </div>
            </>
          ) : null}
          {detail.block ? (
            <details className="stk-fold">
              <summary className="stk-fold-head">本轮注入的人格段 · {detail.block.length} 字</summary>
              <pre className="stk-pre">{detail.block}</pre>
            </details>
          ) : null}
        </Surface>
      ) : null}
    </div>
  );
}