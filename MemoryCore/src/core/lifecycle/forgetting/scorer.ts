/**
 * I 遗忘 · 打分：`significance × priority × decay(age)` → 高价值保留、低分且超期归档（软删）。
 * 纯逻辑、可单测、阈值配置化（memory.forgetting）。归档优先于删除（宁漏勿多）。
 */
import type { MemoryRecord } from "../../record/l1-writer.js";
import { salienceBoostWithRefs } from "../feeling/appraisal.js";

export interface ForgettingConfig {
  enabled: boolean;
  /** 时间衰减 λ（越大忘得越快）。保守默认，宁漏不多忘 */
  lambda: number;
  /** GROW-EVO P3（§3.1）：闪光灯记忆调制 k——effectiveλ = λ×(1-k×arousal)。
   *  缺省 0 = 逐位现状；生产 0.3。config 解析层 clamp [0, 0.9]（防 λ→0/负）。 */
  arousalRetention: number;
  /** 归档分数阈值：低于此值且 age 超 minAgeDays 才归档 */
  lowThreshold: number;
  /** 至少经过多少天才可归档（防刚写就归档） */
  minAgeDays: number;
  /** 单次最多归档条数（护栏） */
  maxPerRun: number;
}

export const DEFAULT_FORGETTING_CONFIG: ForgettingConfig = {
  enabled: true,
  lambda: 0.01,
  arousalRetention: 0,
  lowThreshold: 0.12,
  minAgeDays: 30,
  maxPerRun: 100,
};

function priorityOf(m: MemoryRecord): number {
  // -1 = 全局死规则（绝不归档）；0..100 正常
  if (m.priority === -1) return 1.0; // 视为最高，不归档
  if (typeof m.priority === "number" && m.priority >= 0) return Math.min(m.priority / 100, 1);
  return 0.5;
}

function significanceOf(m: MemoryRecord): number {
  // 审计修复 A2：soul 字段存于 MemoryRecord 顶层（l1-writer P2a/P0），
  // 之前只读 metadata.significance → 恒 0.5，显著性×时间衰减形同虚设。
  // 现在顶层优先，metadata 兼容兜底。
  const top = m as unknown as { significance?: number; valence?: number };
  if (typeof top.significance === "number") return Math.min(Math.max(top.significance, 0), 1);
  if (typeof top.valence === "number") return Math.min(Math.abs(top.valence), 1);
  const meta = m.metadata && typeof m.metadata === "object" ? (m.metadata as Record<string, unknown>) : {};
  const s = meta.significance;
  if (typeof s === "number") return Math.min(Math.max(s, 0), 1);
  const v = meta.valence;
  if (typeof v === "number") return Math.min(Math.abs(v), 1);
  return 0.5;
}

/**
 * 重巩固（reconsolidation）抗遗忘加成（H 设计§4）：被回忆过的记忆更难被遗忘。
 * recallCountBoost = min(recall_count, 5) * 0.02（每次回忆 +2%，封顶 +10%——宁缺勿滥，
 * 不会把一条本该忘的记忆硬顶回保留区，只是让"常被用到的"在临界线上活下来）。
 */
export function recallCountBoost(m: MemoryRecord): number {
  const meta = m.metadata && typeof m.metadata === "object" ? (m.metadata as Record<string, unknown>) : {};
  const c = meta.recall_count;
  if (typeof c !== "number" || c <= 0) return 0;
  return Math.min(c, 5) * 0.02;
}

/** GROW-EVO P3（§3.1）：arousal 双源读取（顶层优先、metadata 兜底、clamp [0,1]）——significanceOf 同款。 */
function arousalOf(m: MemoryRecord): number {
  const top = m as unknown as { arousal?: number };
  if (typeof top.arousal === "number") return Math.min(Math.max(top.arousal, 0), 1);
  const meta = m.metadata && typeof m.metadata === "object" ? (m.metadata as Record<string, unknown>) : {};
  const a = meta.arousal;
  if (typeof a === "number") return Math.min(Math.max(a, 0), 1);
  return 0;
}

/** 时间衰减（天） */
export function decay(ageDays: number, lambda: number): number {
  if (ageDays <= 0) return 1;
  return Math.exp(-lambda * ageDays);
}

function ageDaysOf(m: MemoryRecord & { timestamp_start?: string; occurred_at?: string; created_time?: string }, now = Date.now()): number {
  // v4#5 验证轮修复（2026-09-16 深夜，session-h 实锤）：遗忘年龄 = **记忆系统年龄**
  // （createdAt/created_time 起），非事件年龄。此前沿用 A2 的 occurred_at 优先链——
  // P2a 溯源落地后，occurred_at 越精确指向过去的事件，刚出生的记忆 decay 越低、越快
  // 被归档（occurred_at=2025-06 的新记忆出生 4 分钟被 forgetting tick 归档），两个
  // 子系统互相对抗、时间旅行召回失灵。语义边界：occurred_at 描述"事件多老"（检索的
  // 时间相关性维度），衰减输入是"记忆多老"（Ebbinghaus：自记忆形成起算）。
  // 无系统时间的旧形状回退旧链（A2 语义保持，逐位现状）。
  const sys = (m as unknown as { createdAt?: string }).createdAt || (m as unknown as { created_time?: string }).created_time;
  if (typeof sys === "string" && sys) {
    const ts = new Date(sys).getTime();
    if (!Number.isNaN(ts)) return Math.max(0, (now - ts) / 86_400_000);
  }
  // 审计修复 A2（时间锚同源）：顶层 occurred_at 是 P2a 权威字段，优先于 metadata/timestamps。
  const top = m as unknown as { occurred_at?: string };
  const meta = m.metadata && typeof m.metadata === "object" ? (m.metadata as Record<string, unknown>) : {};
  const t = top.occurred_at
    ?? meta.activity_start_time
    ?? meta.occurred_at
    ?? m.timestamps?.[0]
    ?? (m as { timestamp_start?: string }).timestamp_start;
  if (typeof t === "string" && t) {
    const ts = new Date(t).getTime();
    if (!Number.isNaN(ts)) return Math.max(0, (now - ts) / 86_400_000);
  }
  return 0;
}

export function scoreFor(m: MemoryRecord, cfg: ForgettingConfig = DEFAULT_FORGETTING_CONFIG, now = Date.now()): number {
  // GROW-EVO P3（§3.1）：闪光灯调制——effectiveλ = λ×(1-k×arousal)，高唤醒衰减更慢。
  // k 缺省 0 → 恒等（逐位现状）；双 0.9 上限防 λ→0/负（clamp 在 config 解析层，此处再防）。
  const effectiveLambda = cfg.lambda * (1 - Math.min(0.9, cfg.arousalRetention) * arousalOf(m));
  return Math.min(1, significanceOf(m) * priorityOf(m) * decay(ageDaysOf(m, now), effectiveLambda) + recallCountBoost(m));
}

export type ForgetAction = "keep" | "archive";

/** 判定一条记忆是否该归档（低分且超期；全局规则/高价值/新记忆不清）。 */
export function classify(m: MemoryRecord, cfg: ForgettingConfig = DEFAULT_FORGETTING_CONFIG, now = Date.now()): ForgetAction {
  if (m.priority === -1) return "keep"; // 全局死规则
  const age = ageDaysOf(m, now);
  if (age < cfg.minAgeDays) return "keep";
  return scoreFor(m, cfg, now) < cfg.lowThreshold ? "archive" : "keep";
}

/**
 * 审计修复 B1/C：classify 的"价值参照"版——把 core_values 的命中作为显著性 boost
 * 参与遗忘判定（feeling §3：价值命中 → 更难被遗忘）。values 为空/未启用时零影响，
 * 行为退化为 classify（宁缺毋滥；boost 只会让分数更高 → 更倾向 keep，不会多删）。
 */
export function classifyWithValues(
  m: MemoryRecord,
  values: Array<{ id: string; label: string; weight: number }>,
  cfg: ForgettingConfig = DEFAULT_FORGETTING_CONFIG,
  now = Date.now(),
  appraisalCfg?: import("../feeling/appraisal.js").AppraisalConfig,
): ForgetAction {
  if (m.priority === -1) return "keep";
  const age = ageDaysOf(m, now);
  if (age < cfg.minAgeDays) return "keep";
  const base = scoreFor(m, cfg, now);
  // C1（spec §2.2 遗忘层，B5 缓解）：salienceBoost 改 coreRefs 优先——
  // metadata.coreRefs ∩ 当前 fired values 命中 → boost；子串匹配降为
  // coreRefs 缺失时的兜底（appraisal.salienceBoostWithRefs 内部判定）。
  const boost = salienceBoostWithRefs(m as { content?: string; metadata?: unknown }, values, appraisalCfg);
  return base + boost < cfg.lowThreshold ? "archive" : "keep";
}

/** 分批吐出待归档记录 id（护栏 + 数量上限）。record_id 兜底运行时行形状（L1RecordRow）。 */
export function pickArchiveCandidates(
  memories: Array<MemoryRecord & { record_id?: string }>,
  cfg: ForgettingConfig = DEFAULT_FORGETTING_CONFIG,
  now = Date.now(),
): string[] {
  const ids: string[] = [];
  for (const m of memories) {
    if (classify(m, cfg, now) === "archive") ids.push(m.id ?? m.record_id ?? "");
    if (cfg.maxPerRun > 0 && ids.length >= cfg.maxPerRun) break;
  }
  return ids.filter(Boolean);
}