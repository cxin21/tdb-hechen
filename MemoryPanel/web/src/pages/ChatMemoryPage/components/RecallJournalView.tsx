/**
 * RecallJournalView —— 召回日志视图（任务5 D-8 拍板定案，2026-09-22）。
 * 每轮一卡：时间 + query 原文 + meta 徽标（策略/分层/会话复用/结论/经历/检索耗时）
 * + 灵魂注入块折叠 + 召回记忆行列表。
 * 数据源 = BFF /chat-memory/recall-journal 直读日志文件（分页倒序+租户过滤，零改内核）。
 * 隐私红线：日志含用户输入原文（敏感面），仅登录身份可见（ACL 在 BFF 层），不提供导出。
 * 防御性渲染：可选字段（block/searchTiming 等）缺失/非法一律不渲染，宁缺毋滥。
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Select } from 'tea-component';
import { readAuth } from '@/components/LoginGate';
import { useAgents, useTeams } from '@/services';
import { chatMemoryApi, type RecallJournalEntry } from '@/lib/api/chat-memory';
import './recall-journal.css';

/** 每页条数（轮），与服务端 clamp [1,100] 对齐 */
const PAGE_SIZE = 20;

function formatEntryTime(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString();
}

export default function RecallJournalView() {
  const { t } = useTranslation();
  const auth = readAuth();
  const { activeTeamId } = useTeams();
  const { agents: teamAgents } = useAgents(activeTeamId);
  const ownedTeamAgents = teamAgents.filter(
    (a) => a.owner_user_id === auth?.user_id,
  );

  // 缺省选中首个 owner agent（与 useChatMemory 的 agentFilter 逻辑同款）
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
        // 失败不造数据：清空 + 诚实错误文案（宁缺毋滥）
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

  // 切租户回第一页；页码变化即取数
  useEffect(() => {
    setPage(1);
  }, [activeTeamId, agentId]);
  useEffect(() => {
    void fetchPage(page);
  }, [fetchPage, page]);

  const agentLabel = (id: string) => {
    const a = ownedTeamAgents.find((x) => x.agent_id === id);
    return a ? `${a.name}（${a.agent_id}）` : id;
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
          {entries.map((e, i) => (
            <div className="_rj-card" key={`${e.ts}|${i}`}>
              <div className="_rj-card-head">
                <span className="_rj-time">{formatEntryTime(e.ts)}</span>
                <span className="_rj-query" title={e.query}>
                  {e.query}
                </span>
              </div>
              <div className="_rj-badges">
                {e.strategy ? (
                  <span className="_rj-badge">
                    {t('memory.journal.strategy')}：{e.strategy}
                  </span>
                ) : null}
                {e.layered ? (
                  <span className="_rj-badge">{t('memory.journal.layered')}</span>
                ) : null}
                {e.sessionReused ? (
                  <span className="_rj-badge _rj-badge--warn">
                    {t('memory.journal.sessionReused')}
                  </span>
                ) : null}
                {typeof e.conclusionCount === 'number' && e.conclusionCount > 0 ? (
                  <span className="_rj-badge">
                    {t('memory.journal.conclusion', { count: e.conclusionCount })}
                  </span>
                ) : null}
                {typeof e.experienceCount === 'number' && e.experienceCount > 0 ? (
                  <span className="_rj-badge">
                    {t('memory.journal.experience', { count: e.experienceCount })}
                  </span>
                ) : null}
                {e.searchTiming ? (
                  <span className="_rj-badge _rj-badge--muted">
                    {t('memory.journal.timing', {
                      fts: e.searchTiming.ftsMs ?? 0,
                      ftsHits: e.searchTiming.ftsHits ?? 0,
                      emb: e.searchTiming.embeddingMs ?? 0,
                      embHits: e.searchTiming.embeddingHits ?? 0,
                    })}
                  </span>
                ) : null}
              </div>
              {e.block ? (
                <details className="_rj-soul">
                  <summary>{t('memory.journal.soulBlock')}</summary>
                  <pre className="_rj-soul-pre">{e.block}</pre>
                </details>
              ) : null}
              {Array.isArray(e.memoryLines) && e.memoryLines.length > 0 ? (
                <div className="_rj-lines">
                  <div className="_rj-lines-title">
                    {t('memory.journal.memoryLines')}（{e.memoryLines.length}）
                  </div>
                  <ul>
                    {e.memoryLines.map((line, li) => (
                      <li className="_rj-line" key={li}>
                        {line}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}

      <div className="_rj-footer">
        <Button disabled={loading || page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
          {t('memory.journal.prev')}
        </Button>
        <span className="_rj-page-no">{page}</span>
        <Button disabled={loading || !hasMore} onClick={() => setPage((p) => p + 1)}>
          {t('memory.journal.next')}
        </Button>
        {agentId ? <span className="_rj-tenant">{agentLabel(agentId)}</span> : null}
      </div>
    </div>
  );
}
