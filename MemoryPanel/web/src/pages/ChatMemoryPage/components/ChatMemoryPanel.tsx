/**
 * ChatMemoryPanel — 原子能力 · 记忆。
 *
 * 本文件只保留渲染与组装；状态/数据逻辑在 useChatMemory，常量与工具在 memory-utils。
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Segment, Select } from 'tea-component';
import { tea } from '@/lib/tea-bridge';
import { chatMemoryApi } from '@/lib/teamApi';
import { type ScopeTab } from '../constants/types';
import { buildMemoryHealthView, healthRingTone, type MemoryHealthView } from '../utils/health-utils';

import { BlockDetail } from './BlockDetail';
import { ImportBlockDialog } from './ImportBlockDialog';
import { AllocateMemoryDialog } from './AllocateMemoryDialog';
import { AssetPageHeader } from '@/components/asset/AssetPageHeader';
import { AssetSplitLayout } from '@/components/asset/AssetSplitLayout';
import {
  AssetListPanel,
  AssetItemBadges,
  AssetItemTime,
} from '@/components/asset/AssetListPanel';
import { UserBadge } from '@/components/asset/UserBadge';
import { useChatMemory } from '../hooks/useChatMemory';
import '../styles/chat-memory-panel.css';

/**
 * MemoryHealthBar —— 顶部健康细条（DS-PANEL-UI-WIKI-SOURCE-001 §2.3，Task 3；
 * U-C1 增强：覆盖率迷你进度环 + degraded 黄条悬浮详情，DS-PANEL-UI-VISUAL-001 §2 S5）。
 *
 * 数据：BFF /chat-memory/health → 网关 GET /health 的 memory 子对象（T15）。
 * ok 态：`迷你进度环(81%) | 嵌入 ok`，环色随阈值 <70 红 / 70-90 黄 / >90 绿；
 * degraded：黄条 +「向量召回降级（FTS 兜底中）」+ title 悬浮降级起始时间。
 * （把 T15 的降级可见性从注入块延伸到 UI）。获取失败静默降级为未知态细条
 * （状态条不阻断主功能，但如实显示"未知"而非假装正常）。
 */

/** 进度环周长（r=15）：2πr ≈ 94.25 */
const HEALTH_RING_CIRCUMFERENCE = 2 * Math.PI * 15;

/** 覆盖率迷你进度环（36px 弧形，U-C1）：弧长=覆盖率，色由 healthRingTone 档位决定。 */
function MemoryHealthRing({ pct, coverageText, coverageLabel }: {
  pct: number;
  coverageText: string;
  coverageLabel: string;
}) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <svg
      className="_memory-health-ring"
      width="36"
      height="36"
      viewBox="0 0 36 36"
      role="img"
      aria-label={coverageLabel}
    >
      <title>{coverageLabel}</title>
      <circle className="_memory-health-ring-track" cx="18" cy="18" r="15" fill="none" strokeWidth="3.5" />
      <circle
        className={`_memory-health-ring-fill _memory-health-ring-fill--${healthRingTone(clamped)}`}
        cx="18"
        cy="18"
        r="15"
        fill="none"
        strokeWidth="3.5"
        strokeLinecap="round"
        strokeDasharray={HEALTH_RING_CIRCUMFERENCE}
        strokeDashoffset={HEALTH_RING_CIRCUMFERENCE * (1 - clamped / 100)}
        transform="rotate(-90 18 18)"
      />
      <text className="_memory-health-ring-text" x="18" y="18" textAnchor="middle" dominantBaseline="central">
        {coverageText}
      </text>
    </svg>
  );
}

/** degradedSince ISO 时间 → 本地时间文案（非法/缺失时原样返回或空串，不造数据）。 */
function formatDegradedSince(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function MemoryHealthBar() {
  const { t } = useTranslation();
  const [view, setView] = useState<MemoryHealthView>(() =>
    buildMemoryHealthView(null),
  );

  useEffect(() => {
    let cancelled = false;
    chatMemoryApi
      .health()
      .then((res) => {
        if (!cancelled) setView(buildMemoryHealthView(res?.memory));
      })
      .catch(() => {
        // 状态条属于旁路信息：失败不弹错，如实落到"未知"态
        if (!cancelled) setView(buildMemoryHealthView(null));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!view.hasData) {
    return <div className="_memory-health-bar _memory-health-bar--unknown">{t('memory.health.unknown')}</div>;
  }
  const degradedTitle = view.degraded
    ? `${t('memory.health.degradedBanner')}${
        formatDegradedSince(view.degradedSince) ? ` · ${formatDegradedSince(view.degradedSince)}` : ''
      }`
    : undefined;
  return (
    <div
      className={`_memory-health-bar${view.degraded ? ' _memory-health-bar--degraded' : ''}`}
      title={degradedTitle}
    >
      <MemoryHealthRing
        pct={view.coveragePct}
        coverageText={view.coverageText}
        coverageLabel={t('memory.health.coverage', { pct: view.coverageText })}
      />
      <span className="_memory-health-sep">|</span>
      <span>{t(view.embeddingOk ? 'memory.health.embeddingOk' : 'memory.health.embeddingBad')}</span>
      {view.degraded && (
        <span className="_memory-health-banner">{t('memory.health.degradedBanner')}</span>
      )}
    </div>
  );
}

export default function ChatMemoryPanel(
  props: {
    currentUser?: string;
    activeTeamId?: string | null;
  } = {},
) {
  const { t } = useTranslation();
  const store = useChatMemory(props);

  const {
    // context
    activeTeam,
    activeTeamId,
    currentUserId,
    ownedTeamAgents,
    scopeTabLabels,
    // state
    blocks,
    blocksLoading,
    selectedId,
    setSelectedId,
    layer,
    setLayer,
    layerLoading,
    layerItemLoadingId,
    l0MoreLoading,
    timeRange,
    setTimeRange,
    rangeTooLarge,
    showImport,
    setShowImport,
    showAllocate,
    setShowAllocate,
    scopeTab,
    setScopeTab,
    agentFilter,
    setAgentFilter,
    // computed
    selected,
    layerPage,
    pageSize,
    windowTotal,
    filtered,
    // handlers
    fetchBlocks,
    handleLayerPageChange,
    handleL0LoadMore,
    handleLayerItemLoad,
    handleSaveLayerItem,
    searchLayer,
    handleDeleteBlock,
    handleImport,
    handleToggleScope,
    // helpers
    agentLabel,
    allocatableAgents,
    isSelfChatMemory,
  } = store;

  return (
    <div className="_asset-memory-page">
      <MemoryHealthBar />
      <AssetPageHeader
        title={t('memory.title')}
        subtitle={
          activeTeam
            ? t('memory.subtitle.team', { name: activeTeam.name, count: blocks.length })
            : t('memory.subtitle.global', { count: blocks.length })
        }
        scope={
          <Segment
            value={scopeTab}
            onChange={(v) => setScopeTab(v as ScopeTab)}
            options={(['team', 'fixed'] as ScopeTab[]).map((tab) => ({
              value: tab,
              text: scopeTabLabels[tab],
            }))}
          />
        }
        agent={
          scopeTab === 'fixed' ? (
            <Select
              appearance="button"
              matchButtonWidth
              value={agentFilter}
              onChange={setAgentFilter}
              disabled={ownedTeamAgents.length === 0}
              placeholder={t('memory.noAgent')}
              options={ownedTeamAgents.map((agent) => ({
                value: agent.agent_id,
                text: `${agent.name}（${agent.agent_id}）`,
              }))}
            />
          ) : undefined
        }
        actions={
          <>
            {(() => {
              const isPrivateAndNotOwner =
                !!selected &&
                selected.scope === 'private' &&
                selected.uploaded_by_user_id !== currentUserId;
              const disabled = !selected || isPrivateAndNotOwner;
              const tooltip = !selected
                ? t('memory.allocate.disabled')
                : isPrivateAndNotOwner
                  ? t('memory.allocate.privateDisabled')
                  : undefined;
              return (
                <Button onClick={() => setShowAllocate(true)} disabled={disabled} tooltip={tooltip}>
                  {t('memory.allocateToAgent')}
                </Button>
              );
            })()}
            <Button
              type="primary"
              onClick={() => setShowImport(true)}
              disabled={ownedTeamAgents.length === 0}
              tooltip={
                ownedTeamAgents.length === 0 ? t('memory.import.tooltip.noAgent') : undefined
              }
              data-guide="import-memory"
            >
              {t('memory.import')}
            </Button>
          </>
        }
      />

      <AssetSplitLayout
        storageKey="memory:assetSplitWidth"
        sidebar={
            <AssetListPanel
              title={t('memory.blockList')}
              count={t('memory.blockCount', { filtered: filtered.length, total: blocks.length })}
              loading={blocksLoading}
              items={filtered}
              selectedId={selectedId}
              getItemId={(b) => b.id}
              onSelect={(b) => setSelectedId(b.id)}
              isItemDisabled={(b) =>
                scopeTab === 'fixed' &&
                b.scope === 'private' &&
                b.uploaded_by_user_id !== currentUserId
              }
              emptyText={t('memory.empty.filtered')}
              renderItem={(b) => {
                const isRevoked =
                  scopeTab === 'fixed' &&
                  b.scope === 'private' &&
                  b.uploaded_by_user_id !== currentUserId;
                const isOwner = b.uploaded_by_user_id === currentUserId;
                const canToggleScope = scopeTab === 'fixed' && isOwner && !!b.scope;
                const canUnbind = scopeTab === 'fixed' && !isSelfChatMemory(b);
                const l0Count = b.layer_counts?.L0_messages ?? 0;
                return (
                  <div className="_memory-card">
                    {/* 第 1 行：标题（左） + 蓝色计数徽章（右） */}
                    <div className="_memory-card-header">
                      <span className="_memory-card-title" title={b.title}>
                        {b.title}
                        {isRevoked && (
                          <span className="_memory-badge _memory-badge--warning">
                            {t('memory.list.revoked')}
                          </span>
                        )}
                      </span>
                      {l0Count > 0 && <span className="_memory-card-count">{l0Count}</span>}
                    </div>

                    {/* 第 2 行：资产真实 id，等宽灰色 */}
                    <div className="_memory-card-id" title={b.id}>{b.id}</div>

                    {/* 第 3 行：用户名（左） + 时间 / 解绑（右）
                        复用通用 AssetItemBadges + AssetItemTime，与 Skills 页结构一致 */}
                    <AssetItemBadges>
                      {b.uploaded_by_user_id && (
                        <UserBadge
                          userId={b.uploaded_by_user_id}
                          isCurrentUser={isOwner}
                          youText={t('common.you')}
                        />
                      )}
                      {canUnbind ? (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteBlock(b.id);
                          }}
                          title={t('memory.unbind.tooltip')}
                          className="_memory-card-unbind"
                        >
                          {t('memory.unbind')}
                        </button>
                      ) : (
                        <AssetItemTime>
                          {new Date(b.updated_at_ms).toLocaleString()}
                        </AssetItemTime>
                      )}
                    </AssetItemBadges>

                    {/* 第 4 行：共享/私密切换（仅 owner 可见） */}
                    {canToggleScope && (
                      <div
                        className="_memory-card-scope"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Segment
                          value={b.scope === 'team' ? 'team' : 'private'}
                          onChange={(v) => handleToggleScope(b, v as 'team' | 'private')}
                          options={[
                            { value: 'team', text: t('memoryPersonal.shared') },
                            { value: 'private', text: t('memoryPersonal.private') },
                          ]}
                        />
                      </div>
                    )}
                  </div>
                );
              }}
            />
          }
          detail={
            !selected ? (
              <div className="_memory-detail-empty-card">{t('memory.detail.empty')}</div>
            ) : (
              <BlockDetail
                block={selected}
                layer={layer}
                onLayerChange={setLayer}
                agentLabel={agentLabel}
                layerPage={layerPage}
                layerPageSize={pageSize}
                layerTotal={windowTotal}
                layerLoading={layerLoading}
                onLayerPageChange={handleLayerPageChange}
                onLayerItemLoad={handleLayerItemLoad}
                layerItemLoadingId={layerItemLoadingId}
                onL0LoadMore={handleL0LoadMore}
                l0MoreLoading={l0MoreLoading}
                timeRange={timeRange}
                onTimeRangeChange={setTimeRange}
                rangeTooLarge={rangeTooLarge}
                canEdit={selected.uploaded_by_user_id === currentUserId}
                onSaveLayerItem={handleSaveLayerItem}
                onSearchLayer={searchLayer}
              />
            )
          }
      />

      {showImport && (
        <ImportBlockDialog
          onClose={() => setShowImport(false)}
          onImported={handleImport}
          agents={ownedTeamAgents.map((a) => ({ agent_id: a.agent_id, name: a.name }))}
          defaultAgentId={scopeTab === 'fixed' && agentFilter ? agentFilter : ''}
        />
      )}

      {showAllocate && selected && (
        <AllocateMemoryDialog
          memoryTitle={selected.title}
          agents={allocatableAgents(selected)}
          memorySource="team"
          onClose={() => setShowAllocate(false)}
          onAllocated={async (agentId) => {
            try {
              await chatMemoryApi.allocate(activeTeamId!, selected.id, agentId);
              tea.notify.success(t('memory.notify.allocated'));
              setShowAllocate(false);
              fetchBlocks();
            } catch (e: any) {
              tea.notify.error(e?.message || t('memory.notify.allocateFailed'));
            }
          }}
        />
      )}
    </div>
  );
}
