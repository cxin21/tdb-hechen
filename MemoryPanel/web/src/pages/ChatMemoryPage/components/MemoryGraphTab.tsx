/**
 * MemoryGraphTab —— 记忆页「图谱」页签（T3 重排 2026-11-07）。
 *
 * 背景：待裁决队列与价值锚编辑面板退场后，记忆页只剩「块列表 / 回放日志」两档，而记忆图
 * 原先埋在「选中块 → L1 → 切图谱」两级之下（BlockDetail 内的 `_memory-view-toggle`）——
 * 页级没有任何图谱入口。本组件把同一份图升为一级页签：块选择器 + 只读记忆图。
 *
 * 数据零新端点（与 BlockDetail 内嵌图谱同源）：
 *   - 块列表 = team-assets ∪ 自有 agent 的 agent-fixed（与 ChatMemoryPanel 的 fixed 口径一致，
 *     不新增块级查询参数）；
 *   - 图数据 = layer(blockId, 'L1', 200, 0) → mapLayerItem，节点/边由 MemoryGraphView 自取。
 * 空态/加载/失败各有文案（看不到=没做，也不假装"暂无数据"）。
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Select } from 'tea-component';
import { useAgents, useTeams } from '@/services';
import { readAuth } from '@/components/LoginGate';
import { chatMemoryApi, type ChatMemoryBlock } from '@/lib/teamApi';
import { mapLayerItem } from '../utils/memory-utils';
import type { AtomicItem } from '../constants/types';
import { MemoryGraphView } from './MemoryGraphView';
import '../styles/chat-memory-panel.css';

/** 图内节点上限（MemoryGraphView 侧再 slice(0,60) 控布局成本，此处只决定请求页大小） */
const L1_PAGE_SIZE = 200;

export default function MemoryGraphTab() {
  const { t } = useTranslation();
  const { activeTeamId } = useTeams();
  const auth = readAuth();
  const currentUserId = auth?.user_id ?? '';
  const { agents } = useAgents(activeTeamId);
  const ownedAgentIds = useMemo(
    () => agents.filter((a) => a.owner_user_id === currentUserId).map((a) => a.agent_id),
    [agents, currentUserId],
  );
  // 依赖用稳定字符串键：ownedAgentIds 每次渲染都是新数组，直接进 deps 会反复请求。
  const ownedKey = ownedAgentIds.join(',');

  const [blocks, setBlocks] = useState<ChatMemoryBlock[]>([]);
  const [blockId, setBlockId] = useState('');
  const [blocksLoading, setBlocksLoading] = useState(false);
  const [items, setItems] = useState<AtomicItem[]>([]);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  // ① 块列表：团队资产 + 自有 agent 固定资产（去重保序）
  useEffect(() => {
    let alive = true;
    if (!activeTeamId) {
      setBlocks([]);
      setBlockId('');
      setBlocksLoading(false);
      return;
    }
    setBlocksLoading(true);
    setFailed(false);
    const run = async () => {
      const merged: ChatMemoryBlock[] = [];
      const seen = new Set<string>();
      const push = (list: ChatMemoryBlock[] | undefined) => {
        for (const b of list ?? []) {
          if (!b?.id || seen.has(b.id)) continue;
          seen.add(b.id);
          merged.push(b);
        }
      };
      try {
        const team = await chatMemoryApi.teamAssets(activeTeamId);
        push(team.items);
      } catch {
        // 团队资产读不到不阻断自有 agent 的记忆块
      }
      for (const agentId of ownedAgentIds) {
        try {
          const own = await chatMemoryApi.agentFixed(agentId);
          push(own.items);
        } catch {
          // 单个 agent 失败跳过，其余照常展示
        }
      }
      if (!alive) return;
      setBlocks(merged);
      setBlockId((prev) => (prev && seen.has(prev) ? prev : (merged[0]?.id ?? '')));
      setBlocksLoading(false);
    };
    void run();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 以 ownedKey 代表 ownedAgentIds
  }, [activeTeamId, ownedKey]);

  // ② 选中块的 L1 行 → 图节点（与 BlockDetail 同一映射函数，无口径分叉）
  useEffect(() => {
    let alive = true;
    if (!blockId) {
      setItems([]);
      return;
    }
    setItemsLoading(true);
    setFailed(false);
    chatMemoryApi
      .layer(blockId, 'L1', L1_PAGE_SIZE, 0)
      .then((d) => {
        if (alive) setItems((d.items ?? []).map(mapLayerItem));
      })
      .catch(() => {
        if (alive) setFailed(true);
      })
      .finally(() => {
        if (alive) setItemsLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [blockId]);

  const current = blocks.find((b) => b.id === blockId);

  return (
    <div className="_memory-graph-tab">
      <div className="_memory-graph-tab-head">
        <span className="_memory-graph-tab-title">{t('memory.graph.title')}</span>
        {blocks.length > 0 && (
          <Select
            appearance="button"
            matchButtonWidth
            value={blockId}
            onChange={setBlockId}
            options={blocks.map((b) => ({ value: b.id, text: b.title || b.id }))}
          />
        )}
        {/* 图只画前 60 个节点（MemoryGraphView 内部上限），这里如实标注总量 */}
        {current && !itemsLoading && !failed && items.length > 0 && (
          <span className="_memory-graph-tab-count">
            {t('memory.graph.l1Count', { count: items.length })}
          </span>
        )}
      </div>

      {blocksLoading || itemsLoading ? (
        <div className="_memory-graph-tab-state">{t('memory.detail.loading')}</div>
      ) : blocks.length === 0 ? (
        <div className="_memory-graph-tab-state">{t('memory.graph.noBlock')}</div>
      ) : failed ? (
        <div className="_memory-graph-tab-state">{t('memory.graph.loadFailed')}</div>
      ) : items.length === 0 ? (
        <div className="_memory-graph-tab-state">{t('memory.graph.empty')}</div>
      ) : (
        <div className="_memory-graph-tab-canvas">
          <MemoryGraphView blockId={blockId} items={items} />
        </div>
      )}
    </div>
  );
}
