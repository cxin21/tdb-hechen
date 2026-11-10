/**
 * V6-批次二：注入徽章派生纯函数（单一源）。
 * 与 /v3/recall 注入行（formatMemoryLine）同构——所见即注入。
 * 阈值与内核 auto-recall.ts 完全一致：arousal≥0.7 / recallCount≥3 / identityRefs 非空 /
 * evolution 存在 / valid_start 非空；宁缺毋滥（零命中返回空数组）。
 * 依据：badge=静态指示、颜色+图标+文字三通道（Eleken/Smart Interface Design Patterns）。
 * F1（2026-11-07）：价值锚整表删除，锚注入预览/首要锚选取/创建人徽标三个导出随面板下线删除。
 */
import type { ChatMemoryLayerItem } from '../../../lib/api/chat-memory';

export interface AttributeBadge {
  key: string;
  labelKey: string;
  cls: string;
  icon: string;
  tooltip: string;
  values?: Record<string, unknown>;
}

/** 由记忆条目派生注入徽章组（顺序与内核 soul[] 固定序一致）。 */
export function deriveAttributeBadges(item: ChatMemoryLayerItem): AttributeBadge[] {
  const meta = (item.metadata ?? {}) as Record<string, unknown>;
  const out: AttributeBadge[] = [];
  const refs = meta.identityRefs;
  if (Array.isArray(refs) && refs.length > 0) {
    const first = typeof refs[0] === 'string' ? refs[0] : '';
    out.push({
      key: 'core',
      labelKey: 'memory.badges.core',
      cls: 'core',
      icon: '🧩',
      tooltip: `identityRefs×${refs.length}（身份事实支撑）：${first.slice(0, 40)}`,
    });
  }
  const rc = meta.recall_count;
  if (typeof rc === 'number' && Number.isFinite(rc) && rc >= 3) {
    out.push({
      key: 'verify',
      labelKey: 'memory.badges.verify',
      cls: 'verify',
      icon: '🔁',
      tooltip: `recall_count = ${rc}（≥3 显示）`,
      values: { n: rc },
    });
  }
  if (typeof item.arousal === 'number' && Number.isFinite(item.arousal) && item.arousal >= 0.7) {
    out.push({
      key: 'strong',
      labelKey: 'memory.badges.strong',
      cls: 'strong',
      icon: '⚡',
      tooltip: `arousal = ${item.arousal}（≥0.7 显示）`,
    });
  }
  if (meta.evolution != null) {
    const evo = meta.evolution as { from?: unknown };
    const n = Array.isArray(evo?.from) ? evo.from.length : 0;
    out.push({
      key: 'evo',
      labelKey: 'memory.badges.evo',
      cls: 'evo',
      icon: '🧪',
      tooltip: n > 0 ? `evolution 精炼结论（from ${n} 条源记忆）` : 'evolution 精炼结论',
    });
  }
  if (typeof item.valid_start === 'string' && item.valid_start !== '') {
    out.push({
      key: 'since',
      labelKey: 'memory.badges.since',
      cls: 'since',
      icon: '🗓',
      tooltip: `valid_start = ${item.valid_start}`,
      values: { date: item.valid_start.slice(0, 10) },
    });
  }
  // P1-T8（bi-temporal 补口）：已过期徽章——valid_end 非空、可解析且 ≤ now。
  // P0（task-10）：此前后注释/tooltip 说「两路召回均排除」，与内核效期策略矛盾——
  // 内核 recall/validity-policy.ts:57 是派生三态 off|hard|soft：
  //   hard = 硬过滤（钩子路/工具路都排除）；soft = 降权保留并沉底（:105 softValidityMultiplier、
  //   :205 工具路 soft 对齐）；off = 不判效期。
  // 面板无从得知当前部署档位，故 tooltip 只陈述两种模式的分支，不对效果打包票。
  if (
    typeof item.valid_end === 'string' &&
    item.valid_end !== '' &&
    Number.isFinite(Date.parse(item.valid_end)) &&
    Date.parse(item.valid_end) <= Date.now()
  ) {
    out.push({
      key: 'invalidated',
      labelKey: 'memory.badges.invalidated',
      cls: 'invalidated',
      icon: '⛔',
      tooltip: `valid_end = ${item.valid_end}（已过期：soft 模式降权保留，硬失效模式才排除）`,
    });
  }
  return out;
}
