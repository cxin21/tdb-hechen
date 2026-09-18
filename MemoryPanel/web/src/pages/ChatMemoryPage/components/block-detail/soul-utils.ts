/**
 * soul-utils —— BlockDetail 灵魂区纯函数（U-A1，DS-PANEL-UI-VISUAL-001 §2 S2）。
 *
 * 数据源：L1 条目出参顶层 soul 8 字段（occurred_at / valid_start / valid_end /
 * certainty / source / valence / arousal / significance，P2a/R4 已在生产）+
 * metadata（coreRefs / recall_count / last_recalled_at，C1/896ee5d 透传）。
 *
 * 零 import（照 anchor-utils 先例，可被根 vitest node 环境直接单测；
 * 不引 moment —— 根 package.json 无该依赖，web 侧与 vitest 共用本文件）。
 * 宽松校验：损坏/缺失一律空态，不造假值（宁缺毋滥）。
 */

/** L1 条目的宽松输入形状（只列 soul 区消费的键；值类型未知，逐项校验）。 */
export interface SoulInput {
  occurred_at?: unknown;
  valid_start?: unknown;
  valid_end?: unknown;
  certainty?: unknown;
  source?: unknown;
  valence?: unknown;
  arousal?: unknown;
  significance?: unknown;
  metadata?: {
    coreRefs?: unknown;
    personRefs?: unknown;
    identityRefs?: unknown;
    recall_count?: unknown;
    last_recalled_at?: unknown;
  } | null;
}

export type ValencePolarity = 'negative' | 'neutral' | 'positive';
export type CertaintyKind = 'observed' | 'inferred';

/** 灵魂区视图模型（SoulSection 的唯一入参；批 2 图详情卡复用）。 */
export interface SoulView {
  /** 任一灵魂字段在场即为 true（含 metadata 解析产物）。 */
  hasSoul: boolean;
  /** ⏱ 发生时刻（原始 ISO 存 title，展示用 occurredText）。 */
  occurredAt?: string;
  occurredText: string | null;
  validStart?: string;
  validEnd?: string;
  /** 有效期展示：起点 ~ 终点；只有起点时不含 ~。 */
  validityText: string | null;
  /** 🎈 valence 原值（-1..1）与双色条位置（0..100，负红左/正绿右）。 */
  valence: number | null;
  valencePct: number | null;
  valencePolarity: ValencePolarity | null;
  /** 强度 / 重要性进度条（0..100）。 */
  arousalPct: number | null;
  significancePct: number | null;
  /** [实见/推断] 徽章：certainty 原值 + 归一 kind + 展示 label。 */
  certainty?: string;
  certaintyKind: CertaintyKind | null;
  certaintyLabel: string | null;
  source?: string;
  /** 🎯 价值锚 label 数组（损坏/缺失 → []）。 */
  coreRefs: string[];
  /** 👥 人物锚 label 数组（S2 chips 扩展，U3；损坏/缺失 → []）。 */
  personRefs: string[];
  /** 🧠 身份事实切片数组（identityRefs；损坏/缺失 → []）。 */
  identityRefs: string[];
  /** 🔥 回忆计数 + 上次回忆时间。 */
  recallCount: number | null;
  lastRecalledAt?: string;
  lastRecalledText: string | null;
}

/** 有穷数字校验：非 number / 非有限 → null（不造假值）。 */
function finiteOf(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** valence（-1..1）→ 双色条位置 0..100；越界 clamp；无效 → null。 */
export function valencePercent(v: unknown): number | null {
  const n = finiteOf(v);
  if (n === null) return null;
  return Math.max(0, Math.min(100, ((n + 1) / 2) * 100));
}

/** valence 极性：负/零/正；无效 → null。 */
export function valencePolarityOf(v: unknown): ValencePolarity | null {
  const n = finiteOf(v);
  if (n === null) return null;
  if (n < 0) return 'negative';
  if (n > 0) return 'positive';
  return 'neutral';
}

/** 0..1 强度 → 0..100 进度条；越界 clamp；无效 → null。 */
export function ratio01Percent(v: unknown): number | null {
  const n = finiteOf(v);
  if (n === null) return null;
  return Math.max(0, Math.min(100, n * 100));
}

/** ISO 时间 → 本地 `YYYY-MM-DD HH:mm`；不可解析 → null。 */
export function formatSoulTime(v: unknown): string | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  const t = Date.parse(v);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 提取价值锚 label 数组；缺失/损坏 → []。与 anchor-utils.coreRefsOf 同规（此处零 import 自含）。 */
function coreRefsOf(m: SoulInput['metadata']): string[] {
  return refsOf(m?.coreRefs);
}

/** S2（U3）：refs 数组宽松提取泛化——coreRefs/personRefs/identityRefs 同一校验单点。 */
function refsOf(refs: unknown): string[] {
  if (!Array.isArray(refs)) return [];
  return refs.filter((r): r is string => typeof r === 'string' && r.length > 0);
}

/** 提取回忆计数；缺失/非有限数 → null。 */
function recallCountOf(m: SoulInput['metadata']): number | null {
  const n = finiteOf(m?.recall_count);
  return n;
}

/** certainty 归一：inferred → 推断；其余非空值 → 实见（observed）；空值 → null。 */
function certaintyOf(v: unknown): {
  certainty?: string;
  kind: CertaintyKind | null;
  label: string | null;
} {
  if (typeof v !== 'string' || !v) return { kind: null, label: null };
  if (v === 'inferred') return { certainty: v, kind: 'inferred', label: '推断' };
  return { certainty: v, kind: 'observed', label: '实见' };
}

/**
 * L1 条目 → 灵魂区视图模型。
 * hasSoul = 任一 soul 字段有效在场（含 metadata 产物）——组件据此决定渲染与否，
 * 语义与既有 AtomicHead 灵魂段门控一致（并扩展 arousal/significance/source/有效期）。
 */
export function buildSoulView(item?: SoulInput | null): SoulView {
  const occurredAt = typeof item?.occurred_at === 'string' && item.occurred_at ? item.occurred_at : undefined;
  const validStart = typeof item?.valid_start === 'string' && item.valid_start ? item.valid_start : undefined;
  const validEnd = typeof item?.valid_end === 'string' && item.valid_end ? item.valid_end : undefined;
  const source = typeof item?.source === 'string' && item.source ? item.source : undefined;
  const certainty = certaintyOf(item?.certainty);
  const valence = finiteOf(item?.valence);
  const valencePct = valencePercent(item?.valence);
  const arousalPct = ratio01Percent(item?.arousal);
  const significancePct = ratio01Percent(item?.significance);
  const coreRefs = coreRefsOf(item?.metadata);
  const personRefs = refsOf(item?.metadata?.personRefs);
  const identityRefs = refsOf(item?.metadata?.identityRefs);
  const recallCount = recallCountOf(item?.metadata);
  const lastRecalledAt =
    typeof item?.metadata?.last_recalled_at === 'string' && item.metadata.last_recalled_at
      ? item.metadata.last_recalled_at
      : undefined;
  const occurredText = formatSoulTime(occurredAt);
  const startText = formatSoulTime(validStart);
  const endText = formatSoulTime(validEnd);
  const validityText =
    startText && endText ? `${startText} ~ ${endText}` : startText ?? endText;

  const hasSoul =
    !!occurredAt ||
    !!validStart ||
    !!validEnd ||
    certainty.kind !== null ||
    !!source ||
    valence !== null ||
    arousalPct !== null ||
    significancePct !== null ||
    coreRefs.length > 0 ||
    personRefs.length > 0 ||
    identityRefs.length > 0 ||
    recallCount !== null;

  return {
    hasSoul,
    occurredAt,
    occurredText,
    validStart,
    validEnd,
    validityText,
    valence,
    valencePct,
    valencePolarity: valencePolarityOf(item?.valence),
    arousalPct,
    significancePct,
    certainty: certainty.certainty,
    certaintyKind: certainty.kind,
    certaintyLabel: certainty.label,
    source,
    coreRefs,
    personRefs,
    identityRefs,
    recallCount,
    lastRecalledAt,
    lastRecalledText: formatSoulTime(lastRecalledAt),
  };
}

/** 卡片摘要视图（U-A2 S1：记忆卡片增强；批 2 图详情卡复用）。 */
export interface SoulCardView {
  hasCard: boolean;
  /** 价值锚 chips（卡片最多展示 3 个）与总数（超出以 +N 提示）。 */
  coreRefs: string[];
  coreRefCount: number;
  /** valence 带符号文本（+0.8 / -0.3 / 0.0）；无效 → null。 */
  valenceText: string | null;
  valencePolarity: ValencePolarity | null;
  /** 🔥 回忆火苗文本（t 前缀由组件拼）；无 → null。 */
  recallText: string | null;
  /** ⚡ importance 文本（0.90 形式）；无效 → null。 */
  significanceText: string | null;
}

/** 卡片可展示的 coreRefs 上限（超出部分以 +N 提示，不静默吞掉）。 */
const CARD_CORE_REF_LIMIT = 3;

/**
 * L1 条目 → 卡片摘要视图（S1 记忆卡片增强）。
 * 与 buildSoulView 同一套宽松校验；差异只在展示形式（文本化 + chips 截断）。
 */
export function buildSoulCardView(item?: SoulInput | null): SoulCardView {
  const view = buildSoulView(item);
  const recallText =
    view.recallCount !== null ? `回忆 ${view.recallCount} 次` : null;
  const significanceText =
    view.significancePct !== null
      ? ((view.significancePct ?? 0) / 100).toFixed(2)
      : null;
  const valenceText =
    view.valence !== null
      ? `${(view.valence ?? 0) > 0 ? '+' : ''}${(view.valence ?? 0).toFixed(1)}`
      : null;
  return {
    hasCard: view.hasSoul,
    coreRefs: view.coreRefs.slice(0, CARD_CORE_REF_LIMIT),
    coreRefCount: view.coreRefs.length,
    valenceText,
    valencePolarity: view.valencePolarity,
    recallText,
    significanceText,
  };
}
