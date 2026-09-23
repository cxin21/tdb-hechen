/**
 * RecallJournalView —— 召回日志视图 v2（用户拍板「太丑太乱」重设计，2026-09-23）。
 * 重设计要点：
 * ① query 升为卡片主标题（大字号、截断+title 悬浮全文）
 * ② meta 精简为紧凑副标题（策略 + 复用标记 + 记忆行计数；去掉 FTS/向量耗时——技术噪声）
 * ③ 灵魂块用 <details> 原生折叠 + 内嵌 monospace，视觉上有边框色区分
 * ④ 召回行改为逐条编号卡片行（不是 <ul> 顿号平铺），每条自带左侧色条
 * ⑤ 卡片间距加大、卡片阴影提升可读性
 * 数据源 = BFF /chat-memory/recall-journal 直读日志文件（分页倒序+租户过滤，零改内核）。
 * 隐私红线：日志含用户输入原文（敏感面），仅登录身份可见（ACL 在 BFF 层），不提供导出。
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Select } from 'tea-component';
import { readAuth } from '@/components/LoginGate';
import { useAgents, useTeams } from '@/services';
import { chatMemoryApi, type RecallJournalEntry } from '@/lib/api/chat-memory';
import './recall-journal.css';

const PAGE_SIZE = 20;

function formatEntryTime(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString();
}

/** 精简 meta 摘要：一行文字，不逐条 badge */
function metaSummary(e: RecallJournalEntry, t: (k: string, o?: Record<string, unknown>) => string): string {
  const parts: string[] = [];
  if (e.strategy) parts.push(e.strategy);
  if (e.layered) parts.push(t('memory.journal.layered'));
  if (e.sessionReused) parts.push(t('memory.journal.sessionReused'));
  const cc = typeof e.conclusionCount === 'number' ? e.conclusionCount : 0;
  const ec = typeof e.experienceCount === 'number' ? e.experienceCount : 0;
  if (cc > 0 || ec > 0) parts.push(`${t('memory.journal.conclusion', { count: cc })}·${t('memory.journal.experience', { count: ec })}`);
  return parts.join(' · ');
}

export default function RecallJournalView() {
  const { t } = useTranslation();
  const auth = readAuth();
  const { activeTeamId } = useTeams();
  const { agents: teamAgents } = useAgents(activeTeamId);
  const ownedTeamAgents = teamAgents.filter(
    (a) => a.owner_user_id === auth?.user_id,
  );

  const [agentId, setAgentId] = useState<string>('');
  useEffect(() => {
    if (ownedTeamAgents.length === 0) {
      setAgentId('');
      return;
    }
    if (!agentId || !ownedTeamAgents.some((a) => a.agent_id === agentId)) {
      setAgentId(ownedTeamAgents[0].agent_id);
    }
  }, [ownedTeamAgents, agentId]);

  const [page, setPage] = useState(1);
  const [entries, setEntries] = useState<RecallJournalEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [expandedIdx, setExpandedIdx] = useState<Set<number>>(new Set());

  const fetchPage = useCallback(
    async (p: number) => {
      if (!activeTeamId || !agentId) {
        setEntries([]);
        setTotal(0);
        setHasMore(false);
        setError('');
        return;
      }
      setLoading(true);
      setError('');
      try {
        const res = await chatMemoryApi.recallJournal(activeTeamId, agentId, p, PAGE_SIZE);
        setEntries(res.items ?? []);
        setTotal(res.total ?? 0);
        setHasMore(!!res.has_more);
      } catch (e) {
        setEntries([]);
        setTotal(0);
        setHasMore(false);
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [activeTeamId, agentId],
  );

  useEffect(() => {
    setPage(1);
  }, [activeTeamId, agentId]);
  useEffect(() => {
    void fetchPage(page);
  }, [fetchPage, page]);

  const toggleExpand = (idx: number) => {
    setExpandedIdx((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  if (!activeTeamId) {
    return (
      <div className="_rj-page">
        <div className="_rj-empty">{t('memory.journal.noTeam')}</div>
      </div>
    );
  }

  return (
    <div className="_rj-page">
      {/* 工具栏 */}
      <div className="_rj-toolbar">
        <Select
          appearance="button"
          matchButtonWidth
          value={agentId}
          onChange={setAgentId}
          disabled={ownedTeamAgents.length === 0}
          placeholder={t('memory.noAgent')}
          options={ownedTeamAgents.map((a) => ({
            value: a.agent_id,
            text: `${a.name}（${a.agent_id}）`,
          }))}
        />
        <Button onClick={() => void fetchPage(page)} disabled={loading}>
          {t('memory.journal.refresh')}
        </Button>
        <span className="_rj-total">{t('memory.journal.total', { total })}</span>
      </div>

      {/* 状态区 */}
      {error ? (
        <div className="_rj-empty _rj-empty--error">
          {t('memory.journal.loadFailed')}：{error}
        </div>
      ) : loading && entries.length === 0 ? (
        <div className="_rj-empty">{t('memory.journal.loading')}</div>
      ) : entries.length === 0 ? (
        <div className="_rj-empty">{t('memory.journal.empty')}</div>
      ) : (
        <div className="_rj-list">
          {entries.map((e, idx) => {
            const isOpen = expandedIdx.has(idx);
            const meta = metaSummary(e, t);
            const lines = Array.isArray(e.memoryLines) ? e.memoryLines : [];
            return (
              <div className="_rj-card" key={`${e.ts}|${idx}`}>
                {/* 主标题 = query */}
                <div
                  className="_rj-query-title"
                  title={e.query}
                  onClick={() => toggleExpand(idx)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(ev) => { if (ev.key === 'Enter') toggleExpand(idx); }}
                >
                  <span className="_rj-query-text">{e.query}</span>
                  <span className="_rj-toggle-icon">{isOpen ? '▾' : '▸'}</span>
                </div>
                {/* 副标题 = 时间 + 精简 meta */}
                <div className="_rj-sub">
                  <span className="_rj-time">{formatEntryTime(e.ts)}</span>
                  {meta && <span className="_rj-meta-sep">·</span>}
                  {meta && <span className="_rj-meta">{meta}</span>}
                  {lines.length > 0 && (
                    <span className="_rj-line-count">{lines.length} 条记忆</span>
                  )}
                </div>
                {/* 展开区：灵魂块 + 召回行 */}
                {isOpen && (
                  <div className="_rj-expand">
                    {e.block ? (
                      <details className="_rj-soul" open>
                        <summary className="_rj-soul-summary">
                          {t('memory.journal.soulBlock')}
                        </summary>
                        <pre className="_rj-soul-pre">{e.block}</pre>
                      </details>
                    ) : null}
                    {lines.length > 0 ? (
                      <div className="_rj-lines">
                        <div className="_rj-lines-label">
                          {t('memory.journal.memoryLines')}（{lines.length}）
                        </div>
                        {lines.map((line, li) => (
                          <div className="_rj-mem-row" key={li}>
                            <span className="_rj-mem-num">{li + 1}</span>
                            <span className="_rj-mem-text">{line}</span>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* 分页 */}
      <div className="_rj-footer">
        <Button disabled={loading || page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
          {t('memory.journal.prev')}
        </Button>
        <span className="_rj-page-indicator">
          {page} / {Math.max(1, Math.ceil(total / PAGE_SIZE))}
        </span>
        <Button disabled={loading || !hasMore} onClick={() => setPage((p) => p + 1)}>
          {t('memory.journal.next')}
        </Button>
      </div>
    </div>
  );
}
