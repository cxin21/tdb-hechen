import type { ChatMemoryLayerItem, ChatMemoryLayerMetadata } from '@/lib/teamApi';
export type { ScopeTab } from '@/lib/asset-common';

export type MemoryLayer = 'L0' | 'L1' | 'L2' | 'L3';

export type LayerTone = 'default' | 'brand' | 'success' | 'warning';

export interface LayerMeta {
  id: MemoryLayer;
  label: string;
  short: string;
  desc: string;
  tone: LayerTone;
}

export interface AtomicItem {
  id: string;
  title: string;
  body: string;
  refs?: string[];
  tags?: string[];
  /** 条目创建/记录时间（ISO8601），仅展示，不参与排序 */
  created_at?: string;
  // 灵魂记忆字段（时空网格 / 记忆图 UI）
  occurred_at?: string;
  valid_start?: string;
  valid_end?: string;
  certainty?: string;
  source?: string;
  valence?: number;
  arousal?: number;
  significance?: number;
  /** L1 行 metadata（价值锚 coreRefs / 回忆统计 recall_count）；缺省 = 上游未返回 */
  metadata?: ChatMemoryLayerMetadata;
}

export interface MemoryBlock {
  id: string;
  title: string;
  summary?: string;
  tags: string[];
  updated_at_ms: number;
  agent_id?: string;
  uploaded_by_user_id: string;
  scope?: 'team' | 'private';
  layer_counts: { L0_messages: number; L1: number; L2: number; L3: number };
  bound_agent_count?: number;
  layers: {
    L0: ChatMemoryLayerItem[];
    L1: AtomicItem[];
    L2: AtomicItem[];
    L3: AtomicItem[];
  };
  layerCounts: Partial<Record<MemoryLayer, number>>;
  /** L0 在当前时间筛选下是否已加载到最早（「加载更早」无新增数据时置位，用于隐藏入口） */
  l0Ended?: boolean;
}

export interface AgentOption {
  agent_id: string;
  name: string;
}
