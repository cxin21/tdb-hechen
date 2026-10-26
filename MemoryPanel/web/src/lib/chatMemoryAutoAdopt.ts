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
  gate?: { votes?: number; spanHours?: number; contradictionThreshold?: number; dupThreshold?: number };
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
