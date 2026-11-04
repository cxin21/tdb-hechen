/**
 * 灵魂版本链视图模型（task-3）：把 BFF 出参变成可直接渲染的行。
 *
 * 设计要点（与后端契约一一对应，见 MemoryPanel/src/panel/http/routes/chat-memory-soul.ts）：
 *   1. **旧快照降级**：版本号/父子链/结构化原因都是后端可选字段。生产库（2026-11-04）
 *      soul_snapshots 尚未执行幂等 ALTER，首屏 1619 行全是 { at, hash, trigger:'render' }。
 *      缺字段 → legacy=true + 「旧快照」徽标，**绝不补造递增序号**（编版本号等于伪造审计事实）。
 *   2. **未知原因原样**：trigger 是历史自由文本（'render'），受控枚举外一律原样展示并标
 *      reasonIsKnown=false，不做「大概等于某原因」的猜测。
 *   3. **新→旧倒序**：审计首屏要先看最近一次变更。
 *   4. 入参宽容：null / 形状异常不抛错，退化为空链（前向兼容，页面不会白屏）。
 */
import type {
  SoulVersionEntry,
  SoulVersionsPayload,
} from '../../lib/api/chat-memory-soul';

/**
 * 受控变更原因 → 中文标签（只读镜像）。
 * 权威定义：MemoryCore/src/core/hooks/soul-versioning.ts:13 SOUL_CHANGE_REASONS。
 * 改那边必须同步这里；这里只做展示映射，不参与任何判定。
 */
export const SOUL_REASON_LABELS: Record<string, string> = {
  'first-version': '首版落地',
  'identity-discovery': '身份发现',
  'core-values': '核心价值观变更',
  promise: '承诺变更',
  state: '状态变更',
  slots: '槽位调整',
  layout: '版式调整',
};

/** 旧快照（无版本列）时的徽标文案。 */
const LEGACY_BADGE = '旧快照';
const UNKNOWN_REASON = '未记录原因';

export interface SoulVersionRowView {
  /** React list key（hash+ts，稳定且唯一） */
  key: string;
  at: string;
  /** 本地化到分钟的时间文案，解析失败为 '' */
  timeText: string;
  /** 无 version 字段 = 旧快照 */
  legacy: boolean;
  /** 'v2'（有版本号）或 ''（旧快照） */
  versionText: string;
  /** '旧快照' 徽标或 '' */
  versionBadge: string;
  /** 完整哈希（title 悬浮/复制用） */
  hash: string;
  /** 短哈希（前 8 位） */
  hashText: string;
  /** 中文原因；受控枚举外原样；无 trigger 为「未记录原因」 */
  reasonText: string;
  /** reasonText 是否来自受控枚举（false = 原样展示的未知值） */
  reasonIsKnown: boolean;
  reasonDetailText: string;
  /** 上一版 hash 短形式，缺失为 '' */
  parentHashText: string;
  /** '+1 / -0 / ~2'，无 slotDiff 为 '' */
  slotDiffText: string;
  /** slot diff 摘要原文，缺失为 '' */
  slotSummary: string;
  /** '+3 / -1'，无 lineDiff 为 '' */
  lineDiffText: string;
}

export interface SoulVersionView {
  /** 新→旧 */
  rows: SoulVersionRowView[];
  notes: string[];
  /** 空链文案；有行时为 null */
  emptyText: string | null;
  /** 有行且全部是旧快照 */
  legacyOnly: boolean;
  /** legacyOnly 时的解释（含「版本号」字样，说明为何看不到版本链）；否则 null */
  legacyHint: string | null;
  /** notes 含 snapshot-* / rendered-truncated 等降级信号 */
  degraded: boolean;
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** ISO → 'YYYY-MM-DD HH:mm'（本地时区）；非法输入返回 ''。 */
export function formatSoulVersionTime(iso: string): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const d = new Date(t);
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** 短哈希：取前 8 位（旧库本来就是 8 字符，原样返回）。 */
export function formatSoulHash(hash: string): string {
  return typeof hash === 'string' ? hash.slice(0, 8) : '';
}

function buildRow(raw: unknown, index: number): SoulVersionRowView | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Partial<SoulVersionEntry>;
  const at = asString(e.at);
  const hash = asString(e.hash);
  const trigger = asString(e.trigger);

  const version = asNumber(e.version);
  const legacy = version === undefined || version <= 0;

  const reasonCode = asString(e.reasonCode);
  const knownLabel = reasonCode ? SOUL_REASON_LABELS[reasonCode] : undefined;
  const reasonText = knownLabel ?? (trigger || UNKNOWN_REASON);

  const slot = e.slotDiff as { added?: unknown; removed?: unknown; changed?: unknown; summary?: unknown } | undefined;
  const line = e.lineDiff as { added?: unknown; removed?: unknown } | undefined;

  return {
    key: `${hash || 'nohash'}@${at || String(index)}`,
    at,
    timeText: formatSoulVersionTime(at),
    legacy,
    versionText: legacy ? '' : `v${version}`,
    versionBadge: legacy ? LEGACY_BADGE : '',
    hash,
    hashText: formatSoulHash(hash),
    reasonText,
    reasonIsKnown: knownLabel !== undefined,
    reasonDetailText: asString(e.reasonDetail),
    parentHashText: typeof e.parentHash === 'string' ? formatSoulHash(e.parentHash) : '',
    slotDiffText: slot
      ? `+${asNumber(slot.added) ?? 0} / -${asNumber(slot.removed) ?? 0} / ~${asNumber(slot.changed) ?? 0}`
      : '',
    slotSummary: slot ? asString(slot.summary) : '',
    lineDiffText: line
      ? `+${asNumber(line.added) ?? 0} / -${asNumber(line.removed) ?? 0}`
      : '',
  };
}

/** 时间倒序（Date.parse 失败的按最旧处理），同刻保持入参相对顺序。 */
function sortNewestFirst(rows: SoulVersionRowView[]): SoulVersionRowView[] {
  const ts = (r: SoulVersionRowView) => {
    const t = Date.parse(r.at);
    return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
  };
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => (ts(b.row) - ts(a.row)) || (a.i - b.i))
    .map((x) => x.row);
}

/** BFF 出参（或任意残破形状）→ 视图模型。 */
export function buildSoulVersionView(payload: unknown): SoulVersionView {
  const p = (payload ?? {}) as Partial<SoulVersionsPayload>;
  const rawList = Array.isArray(p.versions) ? (p.versions as unknown[]) : [];
  const rows: SoulVersionRowView[] = [];
  rawList.forEach((raw, i) => {
    const row = buildRow(raw, i);
    if (row) rows.push(row);
  });
  const sorted = sortNewestFirst(rows);

  const notes = Array.isArray(p.notes) ? p.notes.filter((n): n is string => typeof n === 'string' && n.length > 0) : [];
  const degraded = notes.some((n) => n.startsWith('snapshot-') || n.startsWith('rendered-truncated'));
  const legacyOnly = sorted.length > 0 && sorted.every((r) => r.legacy);

  return {
    rows: sorted,
    notes,
    emptyText: sorted.length === 0 ? '暂无灵魂快照：内核还未写入首版人设（或该 tenant 轴下无记录）' : null,
    legacyOnly,
    legacyHint: legacyOnly
      ? '当前内核快照表尚未升级：以下为旧快照，版本号 / 父子链 / 变更原因不可用。这不代表人设没有变化，只是没有留痕。'
      : null,
    degraded,
  };
}
