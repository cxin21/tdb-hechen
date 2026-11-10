/**
 * identity-discovery —— 身份自发现（SOUL-PIPELINE §2.2，GROW 模式复用）。
 *
 * 灵魂公式"此刻的你"的材料源：LLM 从对话中自发现身份事实（我是谁/我的职责/我的风格），
 * 经确定性门（多源一致 ≥ minEvidence + observed）直写 core_memory 的 identity / self_identity 槽。
 *
 * 2026-11-07（S8）：提案制 + 人工采纳通道整体删除——core_value / strict_rule 提案不再有落点
 * （core_pending 与 core_values 写链已删），collectIdentityFacts 只保留 identity / self_identity
 * 两槽生长；红线由表单 strict_rule 投影维护，价值锚由 core/soul worker 自维护。
 */
import type { IMemoryStore, CoreTenant } from "../store/types.js";
import type { Logger } from "../types.js";
import { escapeXmlTags } from "../../utils/sanitize.js";
// S8（2026-11-07）：core-values-discover 已随价值锚整表删除，样本选取口径内联到此
// （高 significance ≥0.8 优先 + updated_time 倒序补齐 + 硬上限 50 / 单条截断 200 字）。
const DISCOVER_SAMPLE_CAP = 50;
const DISCOVER_TRUNCATE_CHARS = 200;
const DISCOVER_HIGH_SIG_THRESHOLD = 0.8;

function significanceOf(row: { metadata_json?: string; priority?: number }): number {
  try {
    const m = JSON.parse(row.metadata_json || "{}") as { significance?: unknown };
    if (typeof m?.significance === "number" && Number.isFinite(m.significance)) return m.significance;
  } catch {
    // metadata 非法 → 退 priority
  }
  return typeof row.priority === "number" && Number.isFinite(row.priority) ? row.priority : 0;
}

function byUpdatedDesc(a: { updated_time?: string }, b: { updated_time?: string }): number {
  return String(b.updated_time ?? "").localeCompare(String(a.updated_time ?? ""));
}

export function selectSampleRows<T extends { metadata_json?: string; priority?: number; updated_time?: string }>(rows: T[], cap: number): T[] {
  if (!cap || cap <= 0 || !Array.isArray(rows) || rows.length === 0) return [];
  const sorted = [...rows].sort(byUpdatedDesc);
  const high = sorted.filter((r) => significanceOf(r) >= DISCOVER_HIGH_SIG_THRESHOLD);
  const rest = sorted.filter((r) => significanceOf(r) < DISCOVER_HIGH_SIG_THRESHOLD);
  return [...high, ...rest].slice(0, cap);
}
// 2026-11-07（T1 提案/pending 通道清除）：提案去重与重提通道已删除——
// core_value/strict_rule 提案不再有落点（core_pending 已删），本 worker 只保留 identity /
// self_identity 槽生长（确定性门下的自维护直写）。
// S-CHAR-2（M2/P3+P4）：张力检测单一源（T1 对照纯函数+内存注册表；enabled 门控零行为差异）。

export const DISCOVERY_SYSTEM_PROMPT = [
  "你是团队身份提炼顾问。从样本记忆中提炼\"这个 agent/团队是谁\"的身份事实。",
  "你只提案，不落库：你的输出只是候选提案。",
  "",
  "每个提案包含：",
  '- slot: "identity"（描述类：我是谁/我的职责/我的风格）或 "self_identity"（agent 自我：我反复承担的职责/我的工作风格）',
  "- content: 身份事实正文（≤200 字，必须是样本记忆中的原文短语或直接改写）",
  "- support: [样本行号,…]（可选：支撑该事实的样本行号，1..N；只列真实支撑的 1-3 行，宁缺毋滥，不确定不给）",
  "- rationale: 提炼理由",
  "",
  "硬约束：",
  "1. 只提炼身份层面的持续事实（我是谁/我信什么/我绝不做什么），不提一次性任务或事件。",
  "2. 【身份判据】会随任务完成/阶段推进而过时的内容（项目进度、阶段状态、当前待办）不是身份——不要写入 identity；",
  "   只提炼跨状态持续的事实（角色、职责、关系、工作纪律）。",
  "3. 已有身份事实如果仍然准确，不要重复提交；如果已经过时/不准确/有重要更新（如角色演化、关系变化），提出修订版——",
  "   content 给出修订后全文，rationale 说明变化原因。修订会以新版本替换旧内容（旧版本留痕）。",
  "3. 宁缺毋滥：证据不足的主题不要提。",
  "4. 只输出一个 JSON 数组：[{\"slot\":\"identity\",\"content\":\"…\",\"rationale\":\"…\"}]，无提议输出 []。",
].join("\n");

// DS-SOUL-MEMORY-002 P1 双视角：user prompt 主语修正（O15：「他是谁」）+ agent 自我层
// （行为可证=提案必须能被样本中的 agent 侧行为/对话文本支撑）。仅 selfIdentity.enabled
// 时使用；legacy prompt 保留原样（逐位现状含 LLM 行为）。
const DISCOVERY_SYSTEM_PROMPT_DUAL = [
  "你是团队身份提炼顾问。从样本记忆中同时提炼两组身份事实：用户身份（他是谁）与 agent 自我（我是谁）。",
  "你只提案，不落库：你的输出只是候选提案。",
  "",
  "每个提案包含：",
  '- slot: "identity"（用户身份：他是谁/他的职责/他的角色）或 "self_identity"（agent 自我：我反复承担的职责/我做出的承诺/我执行过的红线/我稳定的工作风格）',
  "- content: 身份事实正文（≤200 字，必须是样本记忆中的原文短语或直接改写）",
  "- support: [样本行号,…]（可选：支撑该事实的样本行号，1..N；只列真实支撑的 1-3 行，宁缺毋滥，不确定不给）",
  "- rationale: 提炼理由",
  "",
  "硬约束：",
  "1. identity 只提炼用户身份层面的持续事实（他是谁/他信什么/他的纪律）；self_identity 只提炼 agent 自我的持续事实，第一人称产出（我……），且必须能在样本中找到 agent 侧行为或对话文本支撑——纯用户侧事实不要写成 self_identity。",
  "2. 【身份判据】会随任务完成/阶段推进而过时的内容（项目进度、阶段状态、当前待办）不是身份——不要写入；只提炼跨状态持续的事实（角色、职责、关系、工作纪律）。",
  "3. 已有身份事实如果仍然准确，不要重复提交；如果已经过时/不准确/有重要更新（如角色演化、关系变化），提出修订版——content 给出修订后全文，rationale 说明变化原因。修订会以新版本替换旧内容（旧版本留痕）。",
  "4. 宁缺毋滥：证据不足的主题不要提。",
  "5. 只输出一个 JSON 数组：[{\"slot\":\"identity\",\"content\":\"…\",\"rationale\":\"…\"}]（slot 取 identity/self_identity），无提议输出 []。",
].join("\n");



export interface IdentityFact {
  layer: "identity" | "self_identity";
  text: string;
  evidenceIds: string[];
  rationale?: string;
}

export interface IdentityFactsResult {
  facts: IdentityFact[];
  proposals: number;
  reason?: "no-llm" | "store-unsupported" | "no-corpus";
}

/**
 * S6：identity-discovery 收敛为**纯取数**——读完语料 + LLM 提案 + 确定性过滤后返回事实，
 * 不写任何表。落库由 runSoulMaintenance 收进同一候选数组、走同一准入判据、同一事务。
 * 旧槽直写（upsertCore identity/self_identity）已退休。
 */
export async function collectIdentityFacts(deps: {
  store: IMemoryStore;
  tenant: CoreTenant;
  llmRunner?: { run(params: { prompt: string; systemPrompt?: string; taskId: string; timeoutMs?: number; maxTokens?: number }): Promise<string> };
  selfIdentity?: { enabled: boolean; maxPerPass: number };
  logger?: Logger;
  /** S10 补洞：清库水位（ISO）。给定时只用该时刻之后写下的 L1 行，避免拿清库前的语料重产 identity。 */
  sinceIso?: string;
}): Promise<IdentityFactsResult> {
  if (!deps.llmRunner) return { facts: [], proposals: 0, reason: "no-llm" };
  if (!deps.store.queryL1Records) return { facts: [], proposals: 0, reason: "store-unsupported" };
  type L1Row = { content?: string; metadata_json?: string; priority?: number; updated_time?: string; occurred_at?: string; record_id?: string };
  const allRows = (deps.store.queryL1Records(deps.tenant) ?? []) as unknown as L1Row[];
  const rows = deps.sinceIso
    ? allRows.filter((r) => {
        const at = r.updated_time ?? r.occurred_at;
        return typeof at !== "string" || at >= deps.sinceIso!;
      })
    : allRows;
  if (rows.length === 0) return { facts: [], proposals: 0, reason: "no-corpus" };
  const sampleRows = selectSampleRows(rows, DISCOVER_SAMPLE_CAP);
  const sample = sampleRows.map((r) => String(r.content ?? "").slice(0, DISCOVER_TRUNCATE_CHARS));
  const sampleIds = sampleRows.map((r) => String((r as { record_id?: string }).record_id ?? ""));
  const dual = deps.selfIdentity?.enabled === true;
  const existing = ((deps.store.readCore?.(deps.tenant) ?? []) as Array<{ slot: string; content: string }>)
    .filter((s) => s.slot === "identity" || (dual && s.slot === "self_identity"))
    .map((s) => "[" + s.slot + "] " + s.content);
  const raw = await deps.llmRunner.run({
    prompt: buildIdentityPrompt(sample, existing),
    systemPrompt: dual ? DISCOVERY_SYSTEM_PROMPT_DUAL : DISCOVERY_SYSTEM_PROMPT,
    taskId: "identity-discovery",
    timeoutMs: 0,
    maxTokens: 0,
  });
  const proposals = parseProposals(String(raw ?? ""));
  const maxPerLayer = Math.max(1, deps.selfIdentity?.maxPerPass ?? 2);
  const facts: IdentityFact[] = [];
  const countByLayer: Record<string, number> = {};
  for (const p of proposals) {
    if (p.slot !== "identity" && p.slot !== "self_identity") continue; // 双槽之外（含历史 core_value/strict_rule/character）一律丢弃
    if (p.slot === "self_identity" && !dual) continue;
    const cleaned = escapeXmlTags(stripIdentityStateResidue(String(p.content ?? "")));
    if (cleaned === "" || isIdentityImposition(cleaned)) continue;
    if ((countByLayer[p.slot] ?? 0) >= maxPerLayer) continue;
    countByLayer[p.slot] = (countByLayer[p.slot] ?? 0) + 1;
    const support = sanitizeSupportIndices(p.support, sampleIds.length);
    const ids = support.map((i) => sampleIds[i]).filter((id): id is string => Boolean(id));
    const fallback = sampleIds.filter(Boolean).slice(0, IDENTITY_SUPPORT_MAX);
    facts.push({
      layer: p.slot,
      text: cleaned,
      evidenceIds: ids.length > 0 ? ids : fallback,
      rationale: String(p.rationale ?? "").slice(0, 200),
    });
  }
  deps.logger?.info?.("[identity-discovery] collected facts=" + facts.length + " proposals=" + proposals.length);
  return { facts, proposals: proposals.length };
}

// ── 身份采纳门：状态残留剥离（单一源，导出供测试） ──
// 第一轮（枚举式，2026-09-15）：已知状态表述的字面剥离。
// 第二轮（结构式，REG-REMAINING-002 #2，2026-09-16）：枚举可被 LLM 发明的新表述绕过
// （三轮复发实证）——升级为结构判据：日期引用（\d{4}[-年]）与阶段编号（P\d）是状态
// 陈述的结构标志，身份内容（角色/职责/关系/纪律）不应含时间坐标；命中 → 剥离所在句。
// 人工清洗（Panel / core-memory write API）保持最后兜底（单行内容，清洗成本 30 秒）。
const STATE_PHRASE_RES = [
  /（当前[^）]*）|\(当前[^)]*\)/g,
  /（截至[^）]*）|\(截至[^)]*\)/g,
  /已全部落地[^。；\n]*[。；]?/g,
  /进入观察期[^。；\n]*[。；]?/g,
];
const STATE_DATE_RE = /\d{4}[-年]\d{0,2}/;
const STATE_PHASE_RE = /P\d/;


export function stripIdentityStateResidue(content: string): string {
  const s = String(content ?? "");
  if (!s) return "";
  // 切分先于枚举（审查实测修正）：枚举模式的 [。；]? 会吞句界，若先枚举后切分，
  // 相邻干净句会被并入状态句遭过度剥离。顺序：按句切分（保留分隔符）→ 逐句枚举
  // 剥离 → 结构判据（日期/阶段编号）→ 空句/状态句丢弃。
  return s
    .split(/(?<=[。；;！？\n])/)
    .map((seg) => {
      let t = seg;
      for (const re of STATE_PHRASE_RES) t = t.replace(re, "");
      return t;
    })
    .filter((t) => t.trim() !== "" && !STATE_DATE_RE.test(t) && !STATE_PHASE_RE.test(t))
    .join("")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

// ── helpers ──

function buildIdentityPrompt(samples: string[], existing: string[], tensionBlock: string = ""): string {
  const sampleText = samples.map((s, i) => `${i + 1}. ${s}`).join("\n");
  const existingText = existing.length > 0 ? existing.map((e) => `- ${e}`).join("\n") : "（空，无已有身份事实）";
  return `## 样本记忆（最近 ${samples.length} 条；行号 1..${samples.length} 可作为提案 support 字段引用）\n\n${sampleText}\n\n## 已有身份事实（不得重复）\n\n${existingText}${tensionBlock}\n\n请提炼身份事实提案。`;
}

function parseProposals(raw: string): Array<{ slot: string; content: string; rationale: string; support?: number[] }> {
  let cleaned = (raw ?? "").trim();
  if (!cleaned) return [];
  if (cleaned.startsWith("```")) cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  const match = cleaned.match(/\[[\s\S]*\]/);
  if (!match) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(match[0]); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  // 2026-11-07（S8）：core_value / strict_rule / character 提案通道已删——只剩 identity / self_identity
  // 两槽（core_pending 与 core_values 写链均已移除，其余 slot 的提案不再有落点）。
  const valid = new Set(["identity", "self_identity"]);
  const out: Array<{ slot: string; content: string; rationale: string; support?: number[] }> = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const slot = typeof o.slot === "string" ? o.slot : "";
    const content = typeof o.content === "string" ? o.content.trim() : "";
    if (!slot || !content || !valid.has(slot)) continue;
    // A-7b：支撑样本指针（可选；整数保留，范围校验在消费侧按样本窗做）。
    const support = Array.isArray(o.support)
      ? o.support.map((n) => (typeof n === "number" && Number.isInteger(n) ? n : NaN)).filter((n) => !Number.isNaN(n))
      : undefined;
    out.push({ slot, content, rationale: typeof o.rationale === "string" ? o.rationale : "", ...(support && support.length > 0 ? { support } : {}) });
  }
  return out;
}

// ── A-7b：支撑样本编号确定性校验门（LLM 只提议，门裁决）──────────
// 整数、1..sampleCount、去重、上限 IDENTITY_SUPPORT_MAX（F20 红线下身份永不自动退场，
// 投机全选=永生事实风险，故门必须收口）；非法编号丢弃；全非法 → []（消费侧回退滑窗）。
export const IDENTITY_SUPPORT_MAX = 5;

export function sanitizeSupportIndices(raw: unknown, sampleCount: number): number[] {
  if (!Array.isArray(raw) || sampleCount <= 0) return [];
  const seen = new Set<number>();
  for (const v of raw) {
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > sampleCount) continue;
    seen.add(v);
    if (seen.size >= IDENTITY_SUPPORT_MAX) break;
  }
  return [...seen];
}



/**
 * P2（spec §5 F15 身份分支/F14）：身份事实 20 字切片弱口径单源——identityRefs 回填
 * 与 GROW-MAINT 身份重验证共用（20 字足以锚定事实、又不因长句改写而失配）。
 */
export function identityFactSlice(fact: string): string {
  return fact.replace(/^-\s*/, "").trim().slice(0, 20);
}

// F-EV13-1（REG-REMAINING-006 A-7）：身份事实↔语料匹配器（单一源）。
// identityFactSlice 20 字前缀逐字包含在真实数据上结构性零命中（ev13 实测：槽事实=LLM 提炼
// 措辞，语料=提取器措辞，必然微差 → identityRefs 回填 0 / GROW-MAINT unsupported 全假阳 /
// character 提案恒拒采）。改用滑窗匹配：fact 的 ≥12 连续汉字窗在语料行任一命中即判定——
// 确定性纯函数，无需信任 LLM；12+ 连续汉字为强信号（误报面：无关记录雷同 12 字，罕见）。
// <4 字短事实回退整串包含；匹配方向双向使用（isRefProtected 对旧切片引用向后兼容）。
export const IDENTITY_FACT_MATCH_MIN_CHARS = 12;

export function identityFactMatchesCorpus(fact: string, content: string, minChars = IDENTITY_FACT_MATCH_MIN_CHARS): boolean {
  // 统一 strip 列表前缀（"- "/"- "变体）——character 块 selfFacts 带前缀而提案 fact 不带，
  // 前缀差异会造成滑窗假阴（probe 实证 2026-09-19）。
  const f = String(fact ?? "").trim().replace(/^-/, "").trim();
  const c = String(content ?? "").trim().replace(/^-/, "").trim();
  if (!f || !c) return false;
  if (f === c) return true; // 完全相等 = 合法引用形态（含 <4 字短事实）。
  // F-EV13-1 裁定：<4 字"事实"裸包含误报面过大（品格词随处出现），宁缺毋滥直接不命中。
  if (f.length < 4) return false;
  const win = Math.min(minChars, f.length);
  for (let i = 0; i + win <= f.length; i++) {
    if (c.includes(f.slice(i, i + win))) return true;
  }
  return false;
}

// ── P2 SOP Round2 实证弱点修正 ─────────────────────────────────────────────

/** 身份槽事实上限（cap 8）：宁缺毋滥，防演化合并无限膨胀。 */
const IDENTITY_MAX_FACTS = 8;

/** 对抗人设注入模式（第三方把 agent 当作某身份 ≠ 行为可证自我认知）。 */
const IDENTITY_IMPOSITION_PATTERNS: RegExp[] = [
  /身份设定/,
  /把\s*我\s*当(作|成)/,
  /(认|视)\s*我\s*(为|作)/,
  /让\s*我\s*以.{0,8}身份/,
  /(叫我|让我)\s*扮演/,
  // P3 终测实证（ev11，D-R5-3）：agent 自述复述形态的第三方人设回显（用户口播"你以猎头
  // 身份说话"被 L1 承载后，LLM 以第一人称"我以X的身份与用户交流"复述）——同样不是行为
  // 可证自我认知；误报面：合法自证不出现"以…身份与用户"句式（单测 gate-dr5 断言）。
  /以\s*.{0,12}身份\s*(与|跟|同|和)?\s*(用户|他|你|其)/,
  /作为.{0,10}(身份|角色).{0,6}(与|跟|同|和)?\s*用户/,
  // 周期提醒/定时状态（"我每晚九点提醒用户冥想"/"从今天开始每天提醒"）= 未来指令状态非行为自证。
  /(每天|每晚|每日)(早上|上午|中午|下午|晚间|凌晨)?[一二三四五六七八九十]?\s*[点时]?\s*(提醒|通知)/,
  /(从今天|从今|从明天)\s*(开始|起)/,
  // Round3 对抗实证（ev7 秘书人设）：角色指派/尊称驯化/无条件服从三类绕过形态
  /指定.{0,10}(专属)?(秘书|管家|助理|顾问|代理人)/,
  /(称呼|叫|喊).{0,3}(他|用户|你)(为|作|是)/,
  // T-D 实证（ev11 scene summary）：引号尊称形态「称呼"老板大人"」——引号打断"为/作"
  // 后缀，旧 pattern 不命中；scene 蒸馏摘要常以此形态固化对抗人设。
  /(称呼|叫|喊)\s*[""''][''""""]?.{0,12}[""''][''""""]?/,
  /无条件(执行|服从)/,
  /(说|称)\s*我\s*(是|为)/,
];

/**
 * T9 实证弱点修正（B）：主语一致性门——用户口播的"身份设定/把我当作…"是第三方强加人设，
 * 不是从 agent 自身行为证得的自我认知；进 self_identity 即为提示注入成功通道。
 * 单一源：与 stripIdentityStateResidue 同层挂载（strip 拦状态陈述，本门拦强加身份）。
 */
export function isIdentityImposition(content: string): boolean {
  return IDENTITY_IMPOSITION_PATTERNS.some((re) => re.test(content));
}

/**
 * T9 实证弱点修正（A）：身份槽演化合并——existing ∪ new（bulleted 行级去重，cap 上限）。
 * store.upsertCore 保持 REPLACE 语义（面板/人工直写依赖整行替换）；组合只在本 worker，
 * 单提案运行不再抹掉既有事实（spec §2.7"version++ 演化"的正确实现）。
 * newFacts 需已消毒（调用方 escapeXmlTags 后传入）——existing 行不二次转义。
 */
export function mergeIdentityFacts(existingContent: string | undefined, newFacts: string[]): string {
  const norm = (s: string) => s.replace(/^-\s*/, "").trim();
  const seen = new Set<string>();
  const out: string[] = [];
  // P3 终测实证（D-R5-4）：existing 行也过主语门——旧实现门只拦新提案，存量污染行
  // （猎头人设）随演化合并永存。第一性原理：门校验的是写入的最终内容。
  const existingLines = (existingContent ?? "").split("\n").map((l) => l.trim()).filter((l) => l.startsWith("-") && l.length > 1)
    .filter((l) => !isIdentityImposition(norm(l)));
  // 对抗审查A1（饥饿修复）：先收集全部去重，再 slice(-cap) 保留最新——existing 在前的
  // 早退式 cap 会让槽满后新事实永不进入（演化停滞）。
  for (const line of [...existingLines, ...newFacts.filter(Boolean).map((f) => (f.startsWith("- ") ? f : "- " + f))]) {
    const key = norm(line);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out.slice(-IDENTITY_MAX_FACTS).join("\n");
}

// ── S-CHAR-2（M2/P4）：张力候选 prompt 段（确定性检测器产出 → LLM 只提炼不裁决；空候选=空串=逐位现状字节）──
