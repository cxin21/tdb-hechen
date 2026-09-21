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
import { Button, Dropdown, Input, Select } from 'tea-component';
import { readAuth } from '@/components/LoginGate';
import { useAgents, useTeams } from '@/services';
import { tea, confirmThenRun } from '@/lib/tea-bridge';
import { chatMemoryApi, type ValueAnchor, type ValueProposal } from '@/lib/teamApi';
import './chat-memory-anchors.css';
import { IdentitySection } from './IdentitySection';
import { PendingSection } from './PendingSection';

/** P2（U2）：锚类型徽标（person 人物 / theme 主题双节点）；旧网关缺省 → null 不显示（前向兼容） */
function nodeTypeBadge(nodeType: ValueAnchor['node_type']): { label: string; cls: string } | null {
  if (nodeType === 'person') return { label: '人物', cls: 'person' };
  if (nodeType === 'theme') return { label: '主题', cls: 'theme' };
  if (nodeType === 'character') return { label: '品格', cls: 'character' };
  return null;
}

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
  variant = 'panel',
  onSave,
  onValenceChange,
  onPin,
  onRetire,
  onDelete,
  onViewRelated,
}: {
  anchor: ValueAnchor;
  /** UI 2.1（2026-09-21）：'panel'=四 text 按钮逐位现状；'soul'=kebab 收纳（SoulPage 消费）。 */
  variant?: 'panel' | 'soul';
  onSave: (valueId: string, patch: { label: string; weight: number; attrs?: { role?: string; aliases?: string[] } }) => Promise<void>;
  onValenceChange: (anchor: ValueAnchor, valence: number) => Promise<void>;
  onPin: (anchor: ValueAnchor, pinned: boolean) => Promise<void>;
  onRetire: (anchor: ValueAnchor) => Promise<void>;
  onDelete: (anchor: ValueAnchor) => void;
  onViewRelated: (anchor: ValueAnchor) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(anchor.label);
  const [weightText, setWeightText] = useState(String(anchor.weight));
  // U2（spec §6.5）：人物锚 attrs 行内编辑初值（attrs_json 宽松解析；theme 锚不渲染）
  const isPerson = anchor.node_type === 'person';
  const parsedAttrs: { role?: string; aliases?: string[] } = (() => {
    try {
      const p = anchor.attrs_json ? (JSON.parse(anchor.attrs_json) as { role?: string; aliases?: string[] }) : {};
      return { role: typeof p.role === 'string' ? p.role : undefined, aliases: Array.isArray(p.aliases) ? p.aliases : [] };
    } catch {
      return {};
    }
  })();
  const [roleText, setRoleText] = useState(parsedAttrs.role ?? '');
  const [aliasesText, setAliasesText] = useState((parsedAttrs.aliases ?? []).join('、'));
  const parsedWeight = parseFloat(weightText);
  const dirty =
    editing &&
    (label.trim() !== anchor.label ||
      !Number.isFinite(parsedWeight) ||
      clampWeight(parsedWeight) !== anchor.weight ||
      (isPerson && roleText.trim() !== (parsedAttrs.role ?? '')) ||
      (isPerson && aliasesText.trim() !== (parsedAttrs.aliases ?? []).join('、')));
  const badge = valenceBadge(anchor.valence);
  const origin = originBadge(anchor.origin);
  const nodeBadge = nodeTypeBadge(anchor.node_type);
  const isPinned = anchor.pinned === 1;

  async function save() {
    if (!dirty) return;
    // U2：person 行编辑保存带 attrs（显式传入才更新；theme 锚不传）
    const attrs = isPerson
      ? {
          ...(roleText.trim() ? { role: roleText.trim() } : {}),
          ...(aliasesText.trim()
            ? { aliases: aliasesText.split(/[,、]/).map((s) => s.trim()).filter((s) => s.length > 0) }
            : {}),
        }
      : undefined;
    await onSave(anchor.value_id, {
      label: label.trim(),
      weight: clampWeight(parsedWeight),
      ...(attrs !== undefined ? { attrs } : {}),
    });
    setEditing(false);
  }

  return (
    <div className="_va-row">
      <span className={`_va-badge _va-badge--${badge.cls}`}>{t(badge.key)}</span>
      {nodeBadge && <span className={`_va-nodetype _va-nodetype--${nodeBadge.cls}`}>{nodeBadge.label}</span>}
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
          {isPerson && (
            <>
              <Input
                className="_va-input-role"
                value={roleText}
                onChange={setRoleText}
                placeholder="角色（如 家人/导师）"
              />
              <Input
                className="_va-input-aliases"
                value={aliasesText}
                onChange={setAliasesText}
                placeholder="别名（顿号/逗号分隔）"
              />
            </>
          )}
          <Button type="primary" disabled={!dirty} onClick={() => void save()}>
            {t('memory.anchors.save')}
          </Button>
          <Button
            type="weak"
            onClick={() => {
              setLabel(anchor.label);
              setWeightText(String(anchor.weight));
              setRoleText(parsedAttrs.role ?? '');
              setAliasesText((parsedAttrs.aliases ?? []).join('、'));
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
          {isPerson && (
            <Button type="text" onClick={() => void onViewRelated(anchor)}>
              🔍 关联记忆
            </Button>
          )}
          {variant === 'soul' ? (
            <Dropdown
              appearance="pure"
              button={<button type="button" className="_va-kebab" title="更多操作">⋯</button>}
            >
              {(close: () => void) => (
                <div className="_va-kebab-menu" role="menu">
                  <button type="button" role="menuitem" onClick={() => { close(); setEditing(true); }}>
                    {t('memory.anchors.edit')}
                  </button>
                  <button type="button" role="menuitem" onClick={() => { close(); void onPin(anchor, !isPinned); }}>
                    {isPinned ? t('memory.anchors.unpin') : t('memory.anchors.pin')}
                  </button>
                  <button type="button" role="menuitem" onClick={() => { close(); void onRetire(anchor); }}>
                    {t('memory.anchors.retire')}
                  </button>
                  <button type="button" role="menuitem" className="_va-kebab-danger" onClick={() => { close(); onDelete(anchor); }}>
                    {t('memory.anchors.delete')}
                  </button>
                </div>
              )}
            </Dropdown>
          ) : (
            <>
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
        </>
      )}
    </div>
  );
}

export default function ValueAnchorsPanel(props: { blockIdOverride?: string; hideIdentityPending?: boolean; variant?: 'panel' | 'soul' } = {}) {
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
  // UI 2.1 soul 变体：三池 Tab 活跃池
  const [pool, setPool] = useState<'theme' | 'person' | 'character'>('theme');
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

  // UI 2.0（拍板③）：SoulPage 页级选择器可注入 blockIdOverride（隐藏内置选择器语义由页级承担）；
  // 缺省逐位现状（ChatMemoryPage 挂载不变）。UI 2.1（2026-09-21）：variant='soul' 启用三池 Tab 行列表
  // + kebab 收纳（仅 SoulPage 消费；'panel' 缺省逐位现状）。
  const soulMode = props.variant === 'soul';
  const blockId = props.blockIdOverride ?? (activeTeamId && agentId ? `chat_memory-${activeTeamId}-${agentId}` : '');

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

  async function handleSave(valueId: string, patch: { label: string; weight: number; attrs?: { role?: string; aliases?: string[] } }) {
    if (!blockId) return;
    try {
      await chatMemoryApi.valuesUpsert(blockId, { value_id: valueId, ...patch });
      tea.notify.success(t('memory.notify.anchorSaved'));
      await load();
    } catch (e) {
      tea.notify.error(e instanceof Error ? e.message : t('memory.notify.anchorSaveFailed'));
    }
  }

  // U4（spec §6.5）：人物锚"查看关联记忆"——aliases 维度并入反查（label + 每个 alias
  // 各查一次 L1，按 record_id 去重计数；S6 人物查询场景的反查交互复用，零新端点）。
  async function handleViewRelated(anchor: ValueAnchor) {
    if (!blockId) return;
    const aliases: string[] = (() => {
      try {
        const p = anchor.attrs_json ? (JSON.parse(anchor.attrs_json) as { aliases?: string[] }) : {};
        return Array.isArray(p.aliases) ? p.aliases : [];
      } catch {
        return [];
      }
    })();
    const queries = [anchor.label, ...aliases];
    try {
      const all = await Promise.all(queries.map((q) => chatMemoryApi.searchLayer(blockId, 'L1', q, 30)));
      const seen = new Set<string>();
      for (const r of all) {
        for (const item of r.items ?? []) {
          const refs = [
            ...((item.metadata as { coreRefs?: unknown })?.coreRefs ?? []),
            ...((item.metadata as { personRefs?: unknown[] })?.personRefs ?? []),
          ].map(String);
          if (queries.some((q) => refs.includes(q))) seen.add(String(item.id ?? item.record_id ?? ''));
        }
      }
      tea.notify.info(t('memory.notify.relatedCount', { count: seen.size, label: anchor.label }));
    } catch {
      tea.notify.error(t('memory.notify.relatedFailed'));
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
      {/* UI 2.0（拍板③）：SoulPage 以 blockIdOverride+hideIdentityPending 复用本面板时，身份/裁决由页级渲染避免重复 */}
      {!props.hideIdentityPending && (
        <>
          <IdentitySection blockId={blockId} />

          <PendingSection blockId={blockId} />
        </>
      )}

      {loading ? (
        <div className="_va-empty">{t('memory.detail.loading')}</div>
      ) : values.length === 0 ? (
        <div className="_va-empty">{t('memory.anchors.empty')}</div>
      ) : (
        <>
        {/* U7（T-C 回归修复 2026-09-19）：分池配额迷你显示（F15 三池；上限与 yaml anchorDiscovery 对齐）+ U6 sensitivity 预留徽章位 */}
        {soulMode ? (
          <div className="_va-vtab" role="tablist" aria-label="价值锚三池切换">
            {([['theme', '主题', 15], ['person', '人物', 8], ['character', '品格', 8]] as const).map(([key, label, cap]) => {
              const n = values.filter((v) => (v.node_type ?? 'theme') === key).length;
              return (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={pool === key}
                  className={`_va-vtab-pill${pool === key ? ' _va-vtab-pill--active' : ''}`}
                  onClick={() => setPool(key)}
                >
                  {label} <span className="_va-vtab-count">{n}/{cap}</span>
                </button>
              );
            })}
            <span className="_va-quota-item _va-quota-sensitivity">敏感度（待拍板）</span>
          </div>
        ) : (
          <div className="_va-quota">
            <span className="_va-quota-item">主题 {values.filter((v) => (v.node_type ?? 'theme') === 'theme').length}/15</span>
            <span className="_va-quota-item">人物 {values.filter((v) => v.node_type === 'person').length}/8</span>
            <span className="_va-quota-item">品格 {values.filter((v) => v.node_type === 'character').length}/8</span>
            <span className="_va-quota-item _va-quota-sensitivity">敏感度（待拍板）</span>
          </div>
        )}
        <div className="_va-list">
          {values.filter((v) => !soulMode || (v.node_type ?? 'theme') === pool).map((v) => (
            <ValueRow
              key={v.value_id}
              anchor={v}
              variant={props.variant ?? 'panel'}
              onSave={handleSave}
              onValenceChange={handleValenceChange}
              onPin={handlePin}
              onRetire={handleRetire}
              onDelete={handleDelete}
              onViewRelated={handleViewRelated}
            />
          ))}
        </div>
        </>
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
