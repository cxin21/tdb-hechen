/**
 * chatMemoryAutoAdopt —— #100 auto_adopt 审计三件套公共模块（#101 抽取）。
 *
 * 抽取自 PendingSection.tsx 与 SoulPendingRail.tsx 的逐位重复实现（#100 审计视图，
 * 引入于 4ae1b79）。双份代码已实证改一漏一（#100 评审发现 Soul 页快照漏显示反证/
 * 查重把关线），故收敛于此，两页面统一消费。
 *
 * 语义（勿改，改即 UI 行为变化）：
 *   - AutoAdoptAudit：attrs_json.auto_adopt 快照形状（decidePendingCoreAuto 落账）；
 *   - autoAdoptOf：宽松解析——state 非 auto_adopted → null 不显示徽标；
 *     state=auto_adopted 时永远非 null：auto_adopt 为对象 → 返回快照；
 *     无字段/坏 JSON/数组/标量 → {} 仍显示徽标与回滚，快照字段走缺省占位；
 *   - isActionablePendingRow：include_decided 拉取后客户端过滤，只留
 *     待决（state 缺省/pending）+ auto_adopted 两类可操作行；
 *     rejected/adopted/expired 终局行审计语义已闭合，不再打扰裁决队列。
 */
// 直接从 api 模块导入（teamApi.ts 指引：新代码按需引用，减少打包体积——Standards 评审 #101 minor）
import type { PendingItem } from '@/lib/api/chat-memory';

/** #100：auto_adopt 审计快照（attrs_json.auto_adopt；decidePendingCoreAuto 落账形状） */
export interface AutoAdoptAudit {
  adopted_at?: string;
  prev_slot_content?: string;
  prev_slot_version?: number;
  prev_slot_existed?: boolean;
  post_slot_version?: number;
  gate?: {
    votes?: number;
    spanHours?: number;
    contradictionThreshold?: number;
    dupThreshold?: number;
  };
}

/** #100：宽松解析 auto_adopt 审计（state 非 auto_adopted → null 不显示徽标；state=auto_adopted 时永远非 null——auto_adopt 非对象时返 {}，仍显示徽标与回滚，快照字段走缺省占位） */
export function autoAdoptOf(p: PendingItem): AutoAdoptAudit | null {
  if (p.state !== 'auto_adopted') return null;
  try {
    const a = p.attrs_json ? (JSON.parse(p.attrs_json) as Record<string, unknown>) : null;
    const audit = a?.auto_adopt;
    if (audit && typeof audit === 'object' && !Array.isArray(audit)) return audit as AutoAdoptAudit;
  } catch {
    /* 坏 JSON → 无快照体，仍显示徽标与回滚 */
  }
  return {};
}

/** #100 审计视图：include_decided 拉取后客户端过滤，只留 待决 + auto_adopted 两类可操作行 */
export function isActionablePendingRow(p: PendingItem): boolean {
  return p.state === undefined || p.state === 'pending' || p.state === 'auto_adopted';
}

/** #103：终局行 state 白名单之外的统一终局判定——auto_adopted 虽可回滚（人转审计员），但已是终局，不可再批量裁决 */
const FINAL_STATES = new Set(['auto_adopted', 'rejected', 'adopted', 'expired']);

/**
 * #103：批量操作勾选谓词——只有待决行可进勾选。
 *
 * #103 bug：auto_adopted 行可见可回滚（#100），但行复选框未禁用，勾选后点「批量采纳」
 * 打到已终局行被内核 404，批量整体报错。终局行（含 auto_adopted）一律不可批量勾选；
 * 单条「回滚」按钮路径不受影响（批量入口只在全选/行勾选，回滚走 onDecide 直调）。
 */
export function isBatchSelectablePendingRow(p: PendingItem): boolean {
  return !FINAL_STATES.has(p.state ?? 'pending');
}

/** #103：全选/批量可选行集合——从当前列表里滤出待决行（全选跳过终局行） */
export function batchSelectablePendingRows(items: PendingItem[]): PendingItem[] {
  return items.filter(isBatchSelectablePendingRow);
}

/**
 * #103：勾选集清洗——剔除已变终局的勾选 id（保持原顺序）。
 *
 * 场景：行在勾选时是待决，refresh 拉回时已被 auto-adopt 门/其他端置为终局；
 * 不清洗的话陈旧勾选会混进批量请求，再撞内核 404。batchDecide 前与 refresh 后都应过一遍。
 */
export function pruneSelectionToSelectable(selected: string[], items: PendingItem[]): string[] {
  const ok = new Set(batchSelectablePendingRows(items).map((q) => q.pending_id));
  return selected.filter((id) => ok.has(id));
}
