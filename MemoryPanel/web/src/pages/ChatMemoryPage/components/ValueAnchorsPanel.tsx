/**
 * ValueAnchorsPanel —— 价值锚编辑面板（Task 5，DS-PANEL-UI-WIKI-SOURCE-001 §2.4）。
 *
 * 列出当前 agent（= 一块记忆 = 租户 (team, agent, owner)）的价值锚：
 *   - 列表：label / weight / valence 方向徽标（+1 推进 / -1 审慎 / null 未判定；
 *     0 = 中性，store 合法值，brief 三态外如实补充）
 *   - GROW：来源徽标（种子/手工/自生长）+ 钉住图标 + [钉住/取消钉住] [退休]
 *   - GROW：退休区折叠段（state='retired'，[恢复][钉住]）；vetoed 任何读面不可见
 *   - GROW：自动采纳（自生长）新锚入列表时 tea.notify 提示
 *   - 行内编辑：label / weight（走 S1 upsert，显式不带 valence → 冲突不触碰原方向）
 *   - valence 三态下拉微调：显式 ±1 走 S1 微调路径（后端 clamp -1|0|1，微调优先，
 *     upsert 带 valence 不触发 LLM 重判钩子）；「未判定」不可直接写回（S1 无 NULL
 *     写法）——提示用「重新总结方向」重置后重判
 *   - 「重新总结方向」按钮（C2 derive）：后端 apply-after-success，只判 NULL 行，
 *     永不覆盖用户微调（`valence IS NULL` 守卫，MemoryCore v2-router 契约）
 *   - 「🔍发现价值锚」按钮（Task DISC，提议制）：LLM 阅读语料样本蒸馏候选提案，
 *     「发现建议」区展示（label/rationale/证据数/建议权重）；采纳 = 走既有 upsert
 *     （weight=建议权重，valence 落 NULL 由 LLM 自动判）→ 刷新；忽略 = 本地移除。
 *     K1 信任边界：LLM 只提议不落库，持久化必须经人点「采纳」。
 *   - 删除（确认框，S1 delete = GROW 软删除永久否决 veto；不再自动重提）+ 新增
 *
 * 挂载：ChatMemoryPage 顶部 Segment「记忆 / 价值锚」切换（页级导航惯例）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Input, Select } from 'tea-component';
import { readAuth } from '@/components/LoginGate';
import { useAgents, useTeams } from '@/services';
import { tea, confirmThenRun } from '@/lib/tea-bridge';
import { chatMemoryApi, type ValueAnchor, type ValueProposal } from '@/lib/teamApi';
import './chat-memory-anchors.css';
import { IdentitySection } from './IdentitySection';

/** valence → 方向徽标视图（0 = 中性：store 合法值，brief 三态外如实展示） */
function valenceBadge(v: number | null): { key: string; cls: string } {
  if (v === 1) return { key: 'memory.anchors.valence.positive', cls: 'positive' };
  if (v === -1) return { key: 'memory.anchors.valence.negative', cls: 'negative' };
  if (v === 0) return { key: 'memory.anchors.valence.neutral', cls: 'neutral' };
  return { key: 'memory.anchors.valence.unjudged', cls: 'unjudged' };
}

/** GROW 来源徽标（旧网关无 origin 字段 → null 不显示，前向兼容） */
function originBadge(origin: ValueAnchor['origin']): { key: string; cls: string } | null {
  if (origin === 'seed') return { key: 'memory.anchors.origin.seed', cls: 'seed' };
  if (origin === 'manual') return { key: 'memory.anchors.origin.manual', cls: 'manual' };
  if (origin === 'auto') return { key: 'memory.anchors.origin.auto', cls: 'auto' };
  return null;
}

function clampWeight(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/** 单行：来源徽标 + 钉住图标 + label/weight 行内编辑 + valence 微调 + 钉住/退休/删除。 */
function ValueRow({
  anchor,
  onSave,
  onValenceChange,
  onPin,
  onRetire,
  onDelete,
}: {
  anchor: ValueAnchor;
  onSave: (valueId: string, patch: { label: string; weight: number }) => Promise<void>;
  onValenceChange: (anchor: ValueAnchor, valence: number) => Promise<void>;
  onPin: (anchor: ValueAnchor, pinned: boolean) => Promise<void>;
  onRetire: (anchor: ValueAnchor) => Promise<void>;
  onDelete: (anchor: ValueAnchor) => void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(anchor.label);
  const [weightText, setWeightText] = useState(String(anchor.weight));
  const parsedWeight = parseFloat(weightText);
  const dirty =
    editing &&
    (label.trim() !== anchor.label ||
      !Number.isFinite(parsedWeight) ||
      clampWeight(parsedWeight) !== anchor.weight);
  const badge = valenceBadge(anchor.valence);
  const origin = originBadge(anchor.origin);
  const isPinned = anchor.pinned === 1;

  async function save() {
    if (!dirty) return;
    await onSave(anchor.value_id, { label: label.trim(), weight: clampWeight(parsedWeight) });
    setEditing(false);
  }

  return (
    <div className="_va-row">
      <span className={`_va-badge _va-badge--${badge.cls}`}>{t(badge.key)}</span>
      {origin && <span className={`_va-origin _va-origin--${origin.cls}`}>{t(origin.key)}</span>}
      {isPinned && (
        <span className="_va-pin-icon" title={t('memory.anchors.pinned')}>
          📌
        </span>
      )}
      {editing ? (
        <>
          <Input
            className="_va-input-label"
            value={label}
            onChange={setLabel}
            placeholder={t('memory.anchors.label')}
          />
          <Input
            className="_va-input-weight"
            value={weightText}
            onChange={setWeightText}
            placeholder={t('memory.anchors.weight')}
          />
          <Button type="primary" disabled={!dirty} onClick={() => void save()}>
            {t('memory.anchors.save')}
          </Button>
          <Button
            type="weak"
            onClick={() => {
              setLabel(anchor.label);
              setWeightText(String(anchor.weight));
              setEditing(false);
            }}
          >
            {t('memory.anchors.cancel')}
          </Button>
        </>
      ) : (
        <>
          <span className="_va-label" title={anchor.value_id}>
            {anchor.label}
          </span>
          {/* weight 进度条（U-B2 修法逐字：weight 进度条 0..1）+ 数值 */}
          <span className="_va-weight" title={`权重 ${anchor.weight.toFixed(2)}`}>
            <span className="_va-weight-track" aria-hidden>
              <span className="_va-weight-fill" style={{ width: `${clampWeight(anchor.weight) * 100}%` }} />
            </span>
            {anchor.weight.toFixed(2)}
          </span>
          <Select
            className="_va-valence-select"
            appearance="button"
            matchButtonWidth
            value={anchor.valence === 1 || anchor.valence === -1 ? String(anchor.valence) : 'undecided'}
            onChange={(v) => {
              if (v === '1' || v === '-1') {
                void onValenceChange(anchor, Number(v));
              } else if (anchor.valence != null) {
                // S1 无 NULL 写法：恢复「未判定」需经 C2 derive 重置后重判
                tea.notify.info(t('memory.anchors.undecidedHint'));
              }
            }}
            options={[
              { value: '1', text: t('memory.anchors.valence.positive') },
              { value: '-1', text: t('memory.anchors.valence.negative') },
              { value: 'undecided', text: t('memory.anchors.valence.unjudged') },
            ]}
          />
          <Button type="text" onClick={() => setEditing(true)}>
            {t('memory.anchors.edit')}
          </Button>
          <Button type="text" onClick={() => void onPin(anchor, !isPinned)}>
            {isPinned ? t('memory.anchors.unpin') : t('memory.anchors.pin')}
          </Button>
          <Button type="text" onClick={() => void onRetire(anchor)}>
            {t('memory.anchors.retire')}
          </Button>
          <Button type="text" className="_va-delete" onClick={() => onDelete(anchor)}>
            {t('memory.anchors.delete')}
          </Button>
        </>
      )}
    </div>
  );
}

export default function ValueAnchorsPanel() {
  const { t } = useTranslation();
  const auth = readAuth();
  const currentUserId = auth?.user_id ?? '';
  const { activeTeamId } = useTeams();
  const { agents } = useAgents(activeTeamId);
  const ownedAgents = useMemo(
    () => agents.filter((a) => a.owner_user_id === currentUserId),
    [agents, currentUserId],
  );
  const [agentId, setAgentId] = useState('');
  const [values, setValues] = useState<ValueAnchor[]>([]);
  // GROW 退休区（state='retired'；includeRetired 读面取回，vetoed 任何读面不可见）
  const [retired, setRetired] = useState<ValueAnchor[]>([]);
  const [showRetired, setShowRetired] = useState(false);
  const [loading, setLoading] = useState(false);
  const [deriving, setDeriving] = useState(false);
  // 发现建议（Task DISC，提议制）：LLM 提案只存在于前端状态，采纳/忽略后才消失
  const [proposals, setProposals] = useState<ValueProposal[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [adoptingLabel, setAdoptingLabel] = useState('');
  // 新增行
  const [newLabel, setNewLabel] = useState('');
  // GROW 自生长可视化：已知自生长锚 id 集（null = 尚未首载，首载不通知存量）
  const knownAutoIds = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (ownedAgents.length === 0) {
      setAgentId('');
      return;
    }
    if (!agentId || !ownedAgents.some((a) => a.agent_id === agentId)) {
      setAgentId(ownedAgents[0].agent_id);
    }
  }, [ownedAgents, agentId]);

  const blockId = activeTeamId && agentId ? `chat_memory-${activeTeamId}-${agentId}` : '';

  const load = useCallback(async () => {
    if (!blockId) {
      setValues([]);
      setRetired([]);
      return;
    }
    setLoading(true);
    try {
      // GROW：includeRetired 读面（active + retired；vetoed 后端排除）
      const res = await chatMemoryApi.valuesList(blockId, { includeRetired: true });
      const rows = res.values ?? [];
      setValues(rows.filter((r) => r.state !== 'retired'));
      setRetired(rows.filter((r) => r.state === 'retired'));
      // 自生长可视化：与上一次已知集 diff，新出现的自生长锚 → notify（首载静默）
      const autoRows = rows.filter((r) => r.origin === 'auto');
      if (knownAutoIds.current !== null) {
        const fresh = autoRows.filter((r) => !knownAutoIds.current!.has(r.value_id));
        if (fresh.length > 0) {
          tea.notify.info(t('memory.notify.anchorAutoGrown', { labels: fresh.map((r) => r.label).join('、') }));
        }
      }
      knownAutoIds.current = new Set(autoRows.map((r) => r.value_id));
    } catch (e) {
      tea.notify.error(e instanceof Error ? e.message : t('memory.notify.anchorLoadFailed'));
      setValues([]);
      setRetired([]);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockId]);

  useEffect(() => {
    void load();
  }, [load]);

  // 切换 agent（blockId 变化）时清空上一租户的提案（提案仅是前端会话状态，不落库）
  useEffect(() => {
    setProposals([]);
  }, [blockId]);

  async function handleSave(valueId: string, patch: { label: string; weight: number }) {
    if (!blockId) return;
    try {
      await chatMemoryApi.valuesUpsert(blockId, { value_id: valueId, ...patch });
      tea.notify.success(t('memory.notify.anchorSaved'));
      await load();
    } catch (e) {
      tea.notify.error(e instanceof Error ? e.message : t('memory.notify.anchorSaveFailed'));
    }
  }

  async function handleValenceChange(anchor: ValueAnchor, valence: number) {
    if (!blockId) return;
    try {
      // 微调：显式携带 valence（label/weight 用当前已存值，避免覆盖未保存草稿语义）
      await chatMemoryApi.valuesUpsert(blockId, {
        value_id: anchor.value_id,
        label: anchor.label,
        weight: anchor.weight,
        valence,
      });
      tea.notify.success(t('memory.notify.anchorSaved'));
      await load();
    } catch (e) {
      tea.notify.error(e instanceof Error ? e.message : t('memory.notify.anchorSaveFailed'));
    }
  }

  function handleDelete(anchor: ValueAnchor) {
    void confirmThenRun(
      {
        // GROW：删除 = 软删除永久否决（veto），不再自动重提——文案如实告知语义变更
        message: t('memory.anchors.confirmDelete', { label: anchor.label }),
        okText: t('memory.anchors.delete'),
      },
      async () => {
        if (!blockId) return;
        await chatMemoryApi.valuesDelete(blockId, anchor.value_id);
        tea.notify.success(t('memory.notify.anchorVetoed'));
        await load();
      },
      (e) => tea.notify.error((e as Error)?.message || t('memory.notify.anchorDeleteFailed')),
    );
  }

  /** GROW（钉住/取消钉住）：pinned=1 永不被自生长挤出。 */
  async function handlePin(anchor: ValueAnchor, pinned: boolean) {
    if (!blockId) return;
    try {
      await chatMemoryApi.valuesPin(blockId, anchor.value_id, pinned);
      tea.notify.success(t('memory.notify.anchorSaved'));
      await load();
    } catch (e) {
      tea.notify.error(e instanceof Error ? e.message : t('memory.notify.anchorPinFailed'));
    }
  }

  /** GROW（手动退休）：可逆（退休区[恢复]）。 */
  async function handleRetire(anchor: ValueAnchor) {
    if (!blockId) return;
    try {
      await chatMemoryApi.valuesRetire(blockId, anchor.value_id);
      tea.notify.success(t('memory.notify.anchorRetired'));
      await load();
    } catch (e) {
      tea.notify.error(e instanceof Error ? e.message : t('memory.notify.anchorRetireFailed'));
    }
  }

  /** GROW（恢复）：retired → active。 */
  async function handleRestore(anchor: ValueAnchor) {
    if (!blockId) return;
    try {
      await chatMemoryApi.valuesRestore(blockId, anchor.value_id);
      tea.notify.success(t('memory.notify.anchorRestored'));
      await load();
    } catch (e) {
      tea.notify.error(e instanceof Error ? e.message : t('memory.notify.anchorRestoreFailed'));
    }
  }

  async function handleAdd() {
    const label = newLabel.trim();
    if (!label || !blockId) return;
    try {
      // 新增：plain upsert（不带 valence → 落 NULL 待 LLM 判；不触发微调路径）
      await chatMemoryApi.valuesUpsert(blockId, { value_id: label, label, weight: 0.5 });
      setNewLabel('');
      tea.notify.success(t('memory.notify.anchorSaved'));
      await load();
    } catch (e) {
      tea.notify.error(e instanceof Error ? e.message : t('memory.notify.anchorSaveFailed'));
    }
  }

  async function handleDerive() {
    if (!blockId || deriving) return;
    setDeriving(true);
    try {
      const res = await chatMemoryApi.valuesDerive(blockId);
      tea.notify.success(
        t('memory.anchors.deriveDone', { derived: res.derived ?? 0, skipped: res.skipped ?? 0 }),
      );
      await load();
    } catch (e) {
      tea.notify.error(e instanceof Error ? e.message : t('memory.notify.anchorDeriveFailed'));
    } finally {
      setDeriving(false);
    }
  }

  /** Task DISC：LLM 蒸馏提案（提议制——只提议不落库，K1 信任边界）。 */
  async function handleDiscover() {
    if (!blockId || discovering) return;
    setDiscovering(true);
    try {
      const res = await chatMemoryApi.valuesDiscover(blockId);
      const list = res.proposals ?? [];
      setProposals(list);
      if (list.length === 0) {
        // 宁缺毋滥：无提议如实提示，不造
        tea.notify.info(t('memory.anchors.discoverEmpty'));
      } else {
        tea.notify.success(t('memory.anchors.discoverDone', { count: list.length }));
      }
    } catch (e) {
      tea.notify.error(e instanceof Error ? e.message : t('memory.notify.anchorDiscoverFailed'));
    } finally {
      setDiscovering(false);
    }
  }

  /** 采纳 = 走既有 upsert（weight=建议权重；valence 落 NULL 待 LLM 自动判）→ 刷新。 */
  async function handleAdopt(p: ValueProposal) {
    if (!blockId || adoptingLabel) return;
    setAdoptingLabel(p.label);
    try {
      await chatMemoryApi.valuesUpsert(blockId, {
        value_id: p.label,
        label: p.label,
        weight: clampWeight(p.suggestedWeight),
      });
      tea.notify.success(t('memory.notify.anchorSaved'));
      setProposals((prev) => prev.filter((x) => x.label !== p.label));
      await load();
    } catch (e) {
      tea.notify.error(e instanceof Error ? e.message : t('memory.notify.anchorAdoptFailed'));
    } finally {
      setAdoptingLabel('');
    }
  }

  /** 忽略 = 本地移除（不落库，提案本来就不在库中）。 */
  function handleIgnore(p: ValueProposal) {
    setProposals((prev) => prev.filter((x) => x.label !== p.label));
  }

  return (
    <div className="_va-panel">
      <div className="_va-header">
        <Select
          appearance="button"
          matchButtonWidth
          value={agentId}
          onChange={setAgentId}
          disabled={ownedAgents.length === 0}
          placeholder={t('memory.noAgent')}
          options={ownedAgents.map((a) => ({ value: a.agent_id, text: `${a.name}（${a.agent_id}）` }))}
        />
        <div className="_va-header-actions">
          <Button
            type="primary"
            onClick={() => void handleDiscover()}
            loading={discovering}
            disabled={!blockId}
          >
            {t('memory.anchors.discover')}
          </Button>
          <Button type="primary" onClick={() => void handleDerive()} loading={deriving} disabled={!blockId}>
            {t('memory.anchors.derive')}
          </Button>
        </div>
      </div>

      {/* DS-SOUL-MEMORY-002 P1（U1）：agent 身份区（只读；宁缺毋滥——双槽空/读失败整段不渲染） */}
      <IdentitySection blockId={blockId} />

      {loading ? (
        <div className="_va-empty">{t('memory.detail.loading')}</div>
      ) : values.length === 0 ? (
        <div className="_va-empty">{t('memory.anchors.empty')}</div>
      ) : (
        <div className="_va-list">
          {values.map((v) => (
            <ValueRow
              key={v.value_id}
              anchor={v}
              onSave={handleSave}
              onValenceChange={handleValenceChange}
              onPin={handlePin}
              onRetire={handleRetire}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}

      {/* GROW 退休区折叠段：retired 列表 + [恢复][钉住]；空时不渲染 */}
      {retired.length > 0 && (
        <div className="_va-retired">
          <button type="button" className="_va-retired-toggle" onClick={() => setShowRetired((s) => !s)}>
            {showRetired ? '▾' : '▸'} {t('memory.anchors.retiredSection', { count: retired.length })}
          </button>
          {showRetired && (
            <div className="_va-list">
              {retired.map((v) => (
                <div key={v.value_id} className="_va-row _va-retired-row">
                  {v.pinned === 1 && (
                    <span className="_va-pin-icon" title={t('memory.anchors.pinned')}>
                      📌
                    </span>
                  )}
                  <span className="_va-label" title={v.value_id}>
                    {v.label}
                  </span>
                  <span className="_va-retired-tag">{t('memory.anchors.retiredTag')}</span>
                  <Button type="text" onClick={() => void handleRestore(v)}>
                    {t('memory.anchors.restore')}
                  </Button>
                  <Button type="text" onClick={() => void handlePin(v, true)}>
                    {t('memory.anchors.pin')}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {proposals.length > 0 && (
        <div className="_va-proposals">
          <div className="_va-proposals-title">{t('memory.anchors.proposals')}</div>
          <div className="_va-list">
            {proposals.map((p) => (
              <div key={p.label} className="_va-row _va-proposal">
                <span className="_va-label" title={p.rationale}>
                  {p.label}
                </span>
                <span className="_va-proposal-rationale" title={p.rationale}>
                  {p.rationale}
                </span>
                <span className="_va-weight">
                  {t('memory.anchors.proposalMeta', {
                    evidence: p.evidenceCount,
                    weight: clampWeight(p.suggestedWeight).toFixed(2),
                  })}
                </span>
                <Button
                  type="primary"
                  loading={adoptingLabel === p.label}
                  disabled={!!adoptingLabel}
                  onClick={() => void handleAdopt(p)}
                >
                  {t('memory.anchors.adopt')}
                </Button>
                <Button type="text" onClick={() => handleIgnore(p)}>
                  {t('memory.anchors.ignore')}
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="_va-add">
        <Input
          className="_va-add-input"
          value={newLabel}
          onChange={setNewLabel}
          placeholder={t('memory.anchors.addPlaceholder')}
          disabled={!blockId}
        />
        <Button type="primary" disabled={!newLabel.trim() || !blockId} onClick={() => void handleAdd()}>
          {t('memory.anchors.add')}
        </Button>
      </div>
    </div>
  );
}
