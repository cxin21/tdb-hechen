/**
 * V6-批次二（2026-09-23 用户拍板「做」）：注入徽章派生 + 锚注入形态纯函数（单一源）。
 * 与 /v3/recall 注入行（formatMemoryLine）/soul-assembler 锚行同构——所见即注入。
 * 阈值与内核 auto-recall.ts 完全一致：arousal≥0.7 / recallCount≥3 / identityRefs 非空 /
 * evolution 存在 / valid_start 非空；宁缺毋滥（零命中返回空数组）。
 * 依据：badge=静态指示、颜色+图标+文字三通道（Eleken/Smart Interface Design Patterns）。
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
      key: 'core', labelKey: 'memory.badges.core', cls: 'core', icon: '🧩',
      tooltip: `identityRefs×${refs.length}（身份事实支撑）：${first.slice(0, 40)}`,
    });
  }
  const rc = meta.recall_count;
  if (typeof rc === 'number' && Number.isFinite(rc) && rc >= 3) {
    out.push({
      key: 'verify', labelKey: 'memory.badges.verify', cls: 'verify', icon: '🔁',
      tooltip: `recall_count = ${rc}（≥3 显示）`, values: { n: rc },
    });
  }
  if (typeof item.arousal === 'number' && Number.isFinite(item.arousal) && item.arousal >= 0.7) {
    out.push({
      key: 'strong', labelKey: 'memory.badges.strong', cls: 'strong', icon: '⚡',
      tooltip: `arousal = ${item.arousal}（≥0.7 显示）`,
    });
  }
  if (meta.evolution != null) {
    const evo = meta.evolution as { from?: unknown };
    const n = Array.isArray(evo?.from) ? evo.from.length : 0;
    out.push({
      key: 'evo', labelKey: 'memory.badges.evo', cls: 'evo', icon: '🧪',
      tooltip: n > 0 ? `evolution 精炼结论（from ${n} 条源记忆）` : 'evolution 精炼结论',
    });
  }
  if (typeof item.valid_start === 'string' && item.valid_start !== '') {
    out.push({
      key: 'since', labelKey: 'memory.badges.since', cls: 'since', icon: '🗓',
      tooltip: `valid_start = ${item.valid_start}`, values: { date: item.valid_start.slice(0, 10) },
    });
  }
  return out;
}

/** weight 显示值（两位小数去尾零：0.8→"0.8"、0.33→"0.33"——与 soul-assembler weightLabel 同构）。 */
export function weightLabel(w: number): string {
  return w.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function valenceDir(v: number | null | undefined): string {
  if (v === 1) return '趋近';
  if (v === -1) return '审慎';
  if (v === 0) return '中性';
  return '';
}

/** 锚注入形态预览：`label(方向·w0.8)：描述`——与 soul-assembler 价值锚行逐字同构。 */
export function anchorInjectPreview(
  a: { label: string; weight?: number; valence?: number | null; attrs_json?: string },
): string | null {
  const dir = valenceDir(a.valence);
  const wSeg = typeof a.weight === 'number' && Number.isFinite(a.weight) && a.weight > 0
    ? `${dir ? '·' : ''}w${weightLabel(a.weight)}`
    : '';
  let desc = '';
  try {
    const p = a.attrs_json && a.attrs_json !== '{}' ? (JSON.parse(a.attrs_json) as { description?: unknown }) : null;
    if (p && typeof p.description === 'string' && p.description.trim() !== '') desc = p.description.trim();
  } catch { /* 损坏 attrs_json 宁缺毋滥 */ }
  const head = dir || wSeg ? `(${dir}${wSeg})` : '';
  if (!head && !desc) return null;
  return `${a.label}${head}${desc ? `：${desc}` : ''}`;
}

/** 感受段首要锚（方案B：组内 weight 最高选取，与渲染序解耦；描述 ≤30 字；无描述→null）。 */
export function pickPrimeAnchor(
  rows: Array<{ label: string; value_id?: string; weight?: number; attrs_json?: string }>,
): { label: string; desc: string } | null {
  const group = rows.filter((r) => typeof r.weight === 'number' && r.weight > 0);
  // V7 F-U2：并列 weight 时 value_id 次级键定序（与内核 topDescSeg 同键；输入序不承载语义）
  const top = group.sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0) || String(a.value_id ?? a.label).localeCompare(String(b.value_id ?? b.label)))[0];
  if (!top) return null;
  let desc = '';
  try {
    const p = top.attrs_json && top.attrs_json !== '{}' ? (JSON.parse(top.attrs_json) as { description?: unknown }) : null;
    if (p && typeof p.description === 'string') desc = p.description.trim();
  } catch { /* 宁缺毋滥 */ }
  if (!desc) return null;
  return { label: top.label, desc: desc.slice(0, 30) };
}
