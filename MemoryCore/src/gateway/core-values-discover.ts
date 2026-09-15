/**
 * core-values-discover —— 价值锚发现（Task DISC，提议制）纯函数集。
 *
 * 设计裁决（task-disc-report §0 推理验证先行）：
 *   - LLM 报的 evidenceCount 一律不采信，按 label 关键词在样本语料实际命中数重算；
 *   - weight 公式纯函数：min(0.8, max(0.3, 0.3 + 0.5 * evidenceCount / sampleSize))；
 *   - 去重：已有锚 label（trim+lowercase 归一化）不再提 + 提案内部去重；
 *   - 宁缺毋滥：证据 < 3 不提、解析失败/无提议 → 空数组；
 *   - 本模块只含确定性纯函数（无 LLM、无 IO），handler 编排在 v2-router.ts。
 */
import { sanitizeJsonForParse } from "../utils/sanitize.js";
import type { L1RecordRow } from "../core/store/types.js";

/** 样本硬上限（prompt 预算：50 条 × 截断 200 字）。 */
export const DISCOVER_SAMPLE_CAP = 50;
/** 单条样本内容截断长度。 */
export const DISCOVER_TRUNCATE_CHARS = 200;
/** 宁缺毋滥：证据少于该数不提。 */
export const DISCOVER_MIN_EVIDENCE = 3;
/** 高 significance 门槛（metadata.significance，缺省退 priority）。 */
export const DISCOVER_HIGH_SIG_THRESHOLD = 0.8;
/**
 * 推理模型输出预算覆写：ark-code-latest 的 thinking 占输出预算，
 * config 默认 4096 → 8192 仍被思考耗尽（finishReason=length、text 空——
 * 2026-09-15 DEBUG-GROW 插桩实锤）→ 本路由覆写 16384。
 * （runner 链：params.maxTokens ?? config.maxTokens ?? 4096，llm-runner.ts:286）
 */
// GROW-EVO P2.1（用户裁定 2026-09-15）：不再控制 maxTokens 与超时——发现调用传
// timeoutMs: 0 / maxTokens: 0（llm-runner 0 = 不限制语义），推理模型 thinking 不设上限。
// （历史：4096 → 8192 → 16384 均被 thinking 耗尽或撞超时——调参追不上，故解除控制。）

// ── weight 公式（纯函数）────────────────────────────────────────

/**
 * 证据密度 → 建议权重，clamp [0.3, 0.8]。
 * 数学上等于 0.3 + 0.5 * e / s；实现写成 (3 + 5*e/s) / 10：
 * 5*e/s 与 3 的加法在常见整除样本（如 e=3, s=4 → 6.75/10）下落在可精确
 * 表示的中间值上，规避 0.3+0.375 → 0.6750000000000001 类浮点表示误差。
 * sampleSize <= 0 / 非有穷 → 守卫返回下限 0.3（流程不可达：无语料必无提案）。
 */
export function suggestAnchorWeight(evidenceCount: number, sampleSize: number): number {
  if (!Number.isFinite(evidenceCount) || !Number.isFinite(sampleSize) || sampleSize <= 0) return 0.3;
  const raw = (3 + (5 * evidenceCount) / sampleSize) / 10;
  return Math.min(0.8, Math.max(0.3, raw));
}

// ── 证据重算（灵魂：LLM 报数不可信）─────────────────────────────

/** label 关键词切分：空白与标点/符号分隔；纯 CJK label（无分隔符）= 单 token 整串包含判定。 */
function labelTokens(label: string): string[] {
  const normalized = label.trim().toLowerCase();
  if (!normalized) return [];
  const tokens = normalized.split(/[\s\p{P}\p{S}]+/u).filter((t) => t.length > 0);
  return tokens.length > 0 ? tokens : [normalized];
}

/**
 * 按 label 关键词在样本语料中的实际命中数重算证据条数。
 * 命中判定：一条样本命中 ⟺ label 的每个 token 都出现在该样本内容中（lowercase 包含）。
 * 与 appraisal 的 content.includes(label) 同口径（CJK 子串包含即语义命中）。
 */
export function recountEvidence(label: string, corpus: string[]): number {
  const tokens = labelTokens(label);
  if (tokens.length === 0) return 0;
  let hits = 0;
  for (const item of corpus) {
    const text = (item ?? "").toLowerCase();
    if (tokens.every((t) => text.includes(t))) hits++;
  }
  return hits;
}

// ── 宽松 JSON 解析（仿 parseBatchResult / parseCoreRefs 宁缺毋滥）─

export interface RawProposal {
  label: string;
  rationale: string;
}

/**
 * 解析 LLM 输出的提案 JSON 数组，丢弃不可用项（宁缺毋滥）：
 *   - code-fence 包裹剥离；无数组 / JSON.parse 失败 → []（不抛错）；
 *   - 非对象项 / label 非非空字符串丢弃；
 *   - LLM 报的 evidenceCount 不采信不透传（在重算处覆盖）。
 */
export function parseProposalsJson(raw: string): RawProposal[] {
  let cleaned = (raw ?? "").trim();
  if (!cleaned) return [];
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }
  const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
  if (!arrayMatch) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(sanitizeJsonForParse(arrayMatch[0])) as unknown;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: RawProposal[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const label = typeof (item as Record<string, unknown>).label === "string" ? ((item as Record<string, unknown>).label as string).trim() : "";
    if (!label) continue;
    const rationale = typeof (item as Record<string, unknown>).rationale === "string" ? ((item as Record<string, unknown>).rationale as string).trim() : "";
    out.push({ label, rationale });
  }
  return out;
}

// ── 去重 ────────────────────────────────────────────────────────

/** label 归一化：trim + lowercase（与 normalizeValueId 的 slug 化不同，这里只做比对归一）。 */
function normalizeLabel(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * 去重：已有锚 label 归一化命中 → 丢弃（已有锚不再提）；提案内部归一化重复只留先出现者。
 */
export function dedupProposals(candidates: RawProposal[], existingLabels: string[]): RawProposal[] {
  const existing = new Set(existingLabels.map(normalizeLabel).filter((s) => s.length > 0));
  const seen = new Set<string>();
  const out: RawProposal[] = [];
  for (const c of candidates) {
    const key = normalizeLabel(c.label);
    if (!key || existing.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

// ── 样本选取（高 significance 优先 + 最近补齐 + 硬上限 cap）──────

function significanceOf(row: L1RecordRow): number {
  try {
    const m = JSON.parse(row.metadata_json || "{}") as { significance?: unknown };
    if (typeof m?.significance === "number" && Number.isFinite(m.significance)) return m.significance;
  } catch {
    // metadata 非法 → 退 priority
  }
  return typeof row.priority === "number" && Number.isFinite(row.priority) ? row.priority : 0;
}

function byUpdatedDesc(a: L1RecordRow, b: L1RecordRow): number {
  return String(b.updated_time ?? "").localeCompare(String(a.updated_time ?? ""));
}

/**
 * 样本选取口径（task-disc-report §0.1 拍板）：
 *   高 significance（≥ 0.8，metadata.significance 缺省退 priority）优先、其内按
 *   updated_time 倒序；其余按 updated_time 倒序补齐；硬上限 cap（50）。
 *   单一批次同时满足「近 50 条」与「高 significance 条」，prompt 预算恒 ≤ 50×200 字。
 */
export function selectSampleRows(rows: L1RecordRow[], cap: number): L1RecordRow[] {
  if (!cap || cap <= 0 || !Array.isArray(rows) || rows.length === 0) return [];
  const sorted = [...rows].sort(byUpdatedDesc);
  const high = sorted.filter((r) => significanceOf(r) >= DISCOVER_HIGH_SIG_THRESHOLD);
  const rest = sorted.filter((r) => significanceOf(r) < DISCOVER_HIGH_SIG_THRESHOLD);
  return [...high, ...rest].slice(0, cap);
}

// ── prompt 形状 ─────────────────────────────────────────────────

/** systemPrompt：角色 + 硬约束（宁缺毋滥 / 只提议 / 只输出 JSON）。 */
export const DISCOVER_SYSTEM_PROMPT = [
  "你是团队记忆的价值锚（core_values）提炼顾问。你只提议，不落库：你的输出只是候选提案，采纳与否由人决定。",
  "硬约束：",
  "1. 只提炼样本记忆中反复出现、值得长期作为团队价值参照系的主题；一次性任务、具体事件不提。",
  "2. 已有锚清单中的主题不得重复提议（去重）。",
  "3. 宁缺毋滥：估计支撑证据少于 3 条记忆的主题不要提。",
  "4. label 必须是样本记忆中反复出现的**原文短语**（逐字摘自样本内容，≤12 字）——",
  "   采纳前系统会按 label 在语料中做逐字包含计数来验证证据；抽象概括词（如'部署管理'）",
  "   在语料中没有字面命中，会被判为证据不足而拒绝。宁可提出朴素的原文短语，不要抽象概括。",
  "5. 只输出一个 JSON 数组，不要输出任何其它文字：[{\"label\":\"…\",\"rationale\":\"…\",\"evidenceCount\":N}]，无提议输出 []。",
].join("\n");

/**
 * user prompt：截断样本语料（每条 ≤ 200 字）+ 已有锚清单 + 输出格式指令。
 */
export function buildDiscoverPrompt(sampleContents: string[], existingLabels: string[]): string {
  const lines: string[] = [];
  lines.push(`以下是本租户的 ${sampleContents.length} 条记忆样本（每条已截断到 ${DISCOVER_TRUNCATE_CHARS} 字）：`);
  lines.push("");
  sampleContents.forEach((content, i) => {
    const truncated = (content ?? "").length > DISCOVER_TRUNCATE_CHARS
      ? (content ?? "").slice(0, DISCOVER_TRUNCATE_CHARS) + "…"
      : (content ?? "");
    lines.push(`[${i + 1}] ${truncated}`);
  });
  lines.push("");
  if (existingLabels.length > 0) {
    lines.push("已有价值锚（这些主题不得重复提议，去重）：");
    for (const l of existingLabels) lines.push(`- ${l}`);
  } else {
    lines.push("已有价值锚：无。");
  }
  lines.push("");
  lines.push("任务：从上述记忆样本中提炼反复出现、值得作为价值锚的主题（与已有锚去重）。");
  lines.push(`只提证据充分的主题：支撑证据（命中的记忆条数）少于 ${DISCOVER_MIN_EVIDENCE} 条的不要提。`);
  lines.push("只输出 JSON 数组：[{\"label\":\"主题名\",\"rationale\":\"为什么值得作为价值锚\",\"evidenceCount\":估计证据条数}]，无提议输出 []。");
  return lines.join("\n");
}
