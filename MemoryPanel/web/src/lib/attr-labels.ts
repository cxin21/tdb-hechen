/**
 * attr-labels —— 记忆属性字段译名的**单一事实源**（任务 C，2026-11-04 定案）。
 *
 * 为什么集中：同一字段原本在属性表、灵魂区徽章、记忆图详情里各写一套中文，
 * 措辞必然漂移（同一列实测出现过「重要性 / 重要程度 / 显著」三套叫法，
 * significance 与 importance 被读成同一件事）。译名只在这里登记，
 * 展示侧一律 `attrLabel(key)`；未登记键原样回退（不抛、不吞、不造伪译名）。
 *
 * 红线：**译名只影响展示**。复制 JSON / 落库 / 透传体里的字段名恒为原始字段名
 * （AttributesSection.handleCopy 直接读 item.*，不经过本表）。
 */

/** 原始字段名 → 中文标签。键必须与内核出参字段名逐字一致（含下划线）。 */
export const ATTR_LABELS: Readonly<Record<string, string>> = {
  importance: '重要度(1-10)',
  significance: '显著性(0-1)',
  valence: '情感效价',
  arousal: '唤醒度',
  certainty: '确定性',
  sensitivity: '敏感度',
  occurred_at: '事件时刻',
  valid_start: '生效起',
  valid_end: '生效止',
  source_message_ids: '原话溯源',
};

/**
 * 取字段的中文标签。
 *
 * 未登记的键**回退为原键本身**：新字段先能看见（面板不因译名缺失而吞行），
 * 需要中文时再回来登记——而不是抛错或渲染成空标签。
 */
export function attrLabel(key: string): string {
  return ATTR_LABELS[key] ?? key;
}
