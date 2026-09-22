import type { ChatMemoryLayerItem } from '@/lib/api/chat-memory';

/**
 * mapLayerItem —— 分层条目 → UI 列表条目的纯映射（原 memory-utils 内联函数抽出）。
 *
 * F-T4-1（2026-09-22）：原映射只透传 13 字段，把 BFF 层已带出的 D-0 七列
 * （scene_name/priority/session×2/timestamp×3）+ task/team/user/agent/version +
 * sensitivity（D-3）在 L1 列表路丢弃——内核出参/BFF 透传全在场而属性表 0 列
 * （用户看不到=没做）。修复=透传列补齐；缺失字段 undefined 保持（宁缺毋滥）。
 * 纯函数、零运行时 import（仅 type），可被根 vitest（node 环境）直测。
 */
export function mapLayerItem(i: ChatMemoryLayerItem) {
  return {
    id: i.id,
    title: i.title,
    body: i.body,
    refs: i.refs,
    tags: i.tags,
    created_at: i.created_at,
    // 灵魂记忆字段透传（时空网格 / 记忆图 UI）
    occurred_at: i.occurred_at,
    valid_start: i.valid_start,
    valid_end: i.valid_end,
    certainty: i.certainty,
    source: i.source,
    valence: i.valence,
    arousal: i.arousal,
    significance: i.significance,
    // Phase 2（UI 2.0 拍板③）+ D-0（2026-09-21）：属性全景透传（F-T4-1 补齐）
    task_id: i.task_id,
    team_id: i.team_id,
    user_id: i.user_id,
    agent_id: i.agent_id,
    version: i.version,
    // D-0：七列透传（scene_name/priority/session×2/timestamp×3）
    scene_name: i.scene_name,
    priority: i.priority,
    session_key: i.session_key,
    session_id: i.session_id,
    timestamp_str: i.timestamp_str,
    timestamp_start: i.timestamp_start,
    timestamp_end: i.timestamp_end,
    // D-3：敏感性枚举透传
    sensitivity: i.sensitivity,
    // L1 metadata 透传（价值锚 coreRefs / 回忆统计 recall_count）
    metadata: i.metadata,
  };
}
