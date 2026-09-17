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
  // D6 密度语义裁决（2026-09-15，REG-REMAINING-001）：**绝对证据+饱和**取代密度归一。
  // 密度公式（e/S）的语料增长稀释实证：SDD e=101 在 S=189 时 w=0.567，S=1200 时同一
  // 证据贬值至 0.342（-45%，重要性无真实变化）。锚权重的语义 = 主题对本 agent 的
  // 绝对支持强度 → 语料规模退出公式。E_REF=50 为"充分确立"饱和点（e≥50 → 0.8 封顶，
  // 防巨锚锁死；挤出压力仍由 retirement/演化路径承担）。
  void sampleSize; // D6 后语料规模不再参与（签名保留兼容调用方）
  if (!Number.isFinite(evidenceCount) || evidenceCount <= 0) return 0.3;
  const E_REF = 50;
  const raw = (3 + (5 * Math.min(evidenceCount, E_REF)) / E_REF) / 10;
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
/** P2：LLM 原始输出 → JSON 数组（围栏剥离 + 消毒共用单源）；无数组 → null。 */
export function extractJsonArray(raw: string): unknown[] | null {
  let cleaned = (raw ?? "").trim();
  if (!cleaned) return null;
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }
  const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
  if (!arrayMatch) return null;
  try {
    const parsed = JSON.parse(sanitizeJsonForParse(arrayMatch[0])) as unknown;
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function parseProposalsJson(raw: string): RawProposal[] {
  const parsed = extractJsonArray(raw ?? "");
  if (!parsed) return [];
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


// ════════════════════════════════════════════════════════════════════
// P2（DS-SOUL-MEMORY-002 §2.6/§5 F11/F12）：人物证据口径单一源
// ════════════════════════════════════════════════════════════════════

/**
 * F11（人物证据口径）：personEv = |{ r : content 包含 label 或任一 alias }|。
 * 纯包含口径（spec verbatim）；已知宽口径弱点（人名短词误命中）在 F19 登记缓解
 * （提案质量门 + maxPerPass + QUOTA 分池），实证后再收紧。
 */
export function personEvCount(label: string, aliases: string[], corpus: string[]): number {
  const names = [label, ...aliases].map((s) => String(s ?? "").trim()).filter((s) => s.length > 0);
  if (names.length === 0) return 0;
  let n = 0;
  for (const r of corpus) {
    const content = String(r ?? "");
    if (names.some((nm) => content.includes(nm))) n++;
  }
  return n;
}

/** F12：证据 valence 均值符号化——≥+0.2→1（趋近），≤-0.2→-1（回避），否则 0（中性）。 */
export function personValenceSymbol(mean: number): 1 | 0 | -1 {
  if (mean >= 0.2) return 1;
  if (mean <= -0.2) return -1;
  return 0;
}

/** F12：命中（personEv 同款）行 valence 均值；无有效 valence 行 → null（走 C2 derive 钩子）。 */
export function personEvidenceMeanValence(
  label: string,
  aliases: string[],
  corpusRows: Array<{ content: string; valence?: number | null }>,
): number | null {
  const names = [label, ...aliases].map((s) => String(s ?? "").trim()).filter((s) => s.length > 0);
  if (names.length === 0) return null;
  const vals: number[] = [];
  for (const r of corpusRows) {
    const content = String(r?.content ?? "");
    if (!names.some((nm) => content.includes(nm))) continue;
    const v = r?.valence;
    if (typeof v === "number" && Number.isFinite(v)) vals.push(v);
  }
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/** P2：人物提案形状（LLM 只提议；采纳走 anchor-growth 护栏）。 */
export interface PersonProposal { label: string; role: string; aliases: string[] }

export const PERSON_ROLES = ["家人", "同事", "朋友", "其他"] as const;

/**
 * 人物提案解析护栏：label 非空必取；role 白名单外归"其他"；aliases 规范化
 * （string 数组 / trim / 去空 / 去重 / 去同 label）；非法输入 → []（宁缺毋滥）。
 */
export function parsePersonProposals(raw: string): PersonProposal[] {
  const parsed = extractJsonArray(raw ?? "");
  if (!parsed) return [];
  const out: PersonProposal[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const label = typeof rec.label === "string" ? rec.label.trim() : "";
    if (!label) continue;
    const roleRaw = typeof rec.role === "string" ? rec.role.trim() : "";
    const role = (PERSON_ROLES as readonly string[]).includes(roleRaw) ? roleRaw : "其他";
    const aliasesRaw = Array.isArray(rec.aliases) ? rec.aliases : [];
    const aliases: string[] = [];
    for (const a of aliasesRaw) {
      if (typeof a !== "string") continue;
      const t = a.trim();
      if (!t || t === label || aliases.includes(t)) continue;
      aliases.push(t);
    }
    out.push({ label, role, aliases });
  }
  return out;
}

/**
 * P2 人物发现 SYSTEM prompt（与 DISCOVER_SYSTEM_PROMPT 平行的单源；双池同 worker 分叉调用）。
 * 硬约束：行为可证（语料中反复出现的真实人物）/宁缺毋滥（从不在语料中的人物禁止提案）/
 * 禁状态陈述（人物锚是关系层不是事件）/JSON 数组输出。
 */
export const PERSON_DISCOVER_SYSTEM_PROMPT = [
  "你是记忆系统中 agent 的\"人物关系发现器\"。从给定的记忆样本中，找出在该 agent 的经历中反复出现的真实人物（家人/同事/朋友等），并刻画 agent 与该人物的关系。",
  "",
  "硬约束（违反任一条即整条无效）：",
  "1. 行为可证：只提案在记忆样本中实际反复出现（出现或被提及）的人物，必须能在语料中找到多处证据；从不在语料中出现的人物、你推测可能存在的人物，一律禁止提案。",
  "2. 宁缺毋滥：没有把握就不提案；宁可不输出，也不虚构或凑数。",
  "3. 人物锚是稳定的关系层，不是事件：禁止把单一事件、状态、项目阶段包装成人物。",
  "4. role 只能取：家人 / 同事 / 朋友 / 其他；aliases 填用户对该人物的实际称呼变体（昵称/简称），没有则空数组。",
  "5. 既有名单中已存在的人物（label 或任一 alias 命中）不得重复提案。",
  "",
  "输出：只输出一个 JSON 数组，每项 {\"label\": 人物名, \"role\": 角色, \"aliases\": [昵称...]}；无合格人物时输出 []。不要输出任何其他文字。",
].join("\n");

/** P2 人物发现 user prompt：样本 + 既有名单（label 与 alias 同列，防重提）。 */
export function buildPersonDiscoverPrompt(sampleContents: string[], existingLabelsAndAliases: string[]): string {
  const sampleBlock = sampleContents.map((c, i) => `${i + 1}. ${c}`).join("\n");
  const existingBlock = existingLabelsAndAliases.length > 0
    ? existingLabelsAndAliases.map((l) => `- ${l}`).join("\n")
    : "（空）";
  return [
    "以下是该 agent 的记忆样本（每条一行）：",
    sampleBlock,
    "",
    "以下人物已在人物锚名单中（label 或昵称命中即不得重复提案）：",
    existingBlock,
    "",
    "请按系统规则，从样本中找出反复出现的真实人物并输出 JSON 数组。",
  ].join("\n");
}