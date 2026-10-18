/**
 * #60（S22，2026-10-18）：反思回写产物契约（ADR0003 gap G2 · D8 确定性校验层 + D6 真实性边界）。
 *
 * 动机：#27 反思回写（LLM 提议 → 确定性门）此前只校验安全（slot 白名单/去原文/证据），
 * 不校验产物形态 —— 身份叙事缺「第一人称/禁伪造当下体验/价值锚对齐」三约束。
 * 本模块把契约做成确定性机械校验（D8：LLM 仅可提议，门永远确定性），并在
 * reflection.soulProposals.cardContract.enabled=true 时接入提案链（config-first，
 * 缺省 off=逐位现状）。契约同时以 REFLECTION_CARD_CONTRACT_PROMPT 提示 LLM 按规范产出。
 *
 * 合同：
 *   - validateIdentityNarrative：非空 / ≤200 字（码点）/ 第一人称「我」/ 禁伪造当下
 *     体验（FORBID_CURRENT_EXPERIENCE_RE，时间词+感受词邻接才命中，防「我当时感到」
 *     与否定式误伤）；
 *   - 价值锚引用：锚集从 core_value 行「label：desc」行提取（labelsFromCoreValueRows，
 *     只认 core_value 槽、全角冒号分隔、无分隔行跳过、输入序去重）；叙事至少引用
 *     一个锚（extractValueAnchorRefs 子串命中，validLabels 输入序去重）；
 *   - 降级：锚集 undefined/空 = 跳过锚校验（anchorRefs=[]）——锚数据缺失不阻塞合法叙事。
 */

/** 产物契约提示（cardContract on 时附加进反思 prompt；点名三大硬约束）。 */
export const REFLECTION_CARD_CONTRACT_PROMPT = [
  "【产物契约（身份叙事结论）】",
  "- 第一人称叙事：以「我」为主语描述可从证据推出的稳定取向或习惯，不做他人转述。",
  "- 真实性边界：禁止伪造当下体验——不得出现「我现在/此刻/当下 感到/觉得/感觉/情绪」类表述（当下状态只由 soul-feeling 通道呈现）。",
  "- 价值锚引用：叙事至少引用一个既有价值锚（core_value 的 label），让身份叙事与价值体系对齐。",
  "- 宁缺毋滥：证据不足以支撑上述契约时，宁可不产出该条身份叙事。",
].join("\n");

/** D6（不伪造第一人称体验）机械执行：时间词（可带「的」）与感受词邻接才命中
 *  （防「我当时感到」/否定式「我现在不感到」误伤）。 */
export const FORBID_CURRENT_EXPERIENCE_RE = /我(现在|此刻|当下)(的)?(感到|觉得|感觉|情绪)/;

/** 身份叙事长度上限（码点；与 REFLECTION_PROPOSAL_MAX_CHARS 同刻度）。 */
export const REFLECTION_NARRATIVE_MAX_CHARS = 200;

export type NarrativeValidation = { ok: true } | { ok: false; reason: string };

export function validateIdentityNarrative(content: unknown): NarrativeValidation {
  const text = String(content ?? "").trim();
  if (text.length === 0) return { ok: false, reason: "empty-content" };
  if ([...text].length > REFLECTION_NARRATIVE_MAX_CHARS) return { ok: false, reason: "content-too-long" };
  if (!text.includes("我")) return { ok: false, reason: "not-first-person" };
  const hit = FORBID_CURRENT_EXPERIENCE_RE.exec(text);
  if (hit) return { ok: false, reason: "fabricated-current-experience:" + hit[0] };
  return { ok: true };
}

/**
 * 锚集提取：只认 core_value 槽，逐行取「label：desc」行首段（全角冒号——生产
 * core_value 行格式实证）；无分隔行/空 label 跳过；跨行跨槽去重保首现（输入序）。
 */
export function labelsFromCoreValueRows(rows: ReadonlyArray<{ slot?: unknown; content?: unknown }>): string[] {
  const out: string[] = [];
  for (const row of rows ?? []) {
    if (!row || row.slot !== "core_value") continue;
    const content = typeof row.content === "string" ? row.content : "";
    for (const line of content.split("\n")) {
      const t = line.trim();
      if (t.length === 0) continue;
      const idx = t.indexOf("：");
      if (idx <= 0) continue;
      const label = t.slice(0, idx).trim();
      if (label.length === 0) continue;
      if (!out.includes(label)) out.push(label);
    }
  }
  return out;
}

/** 引用提取：子串命中，输出按 validLabels 输入序去重（零命中 → []）。 */
export function extractValueAnchorRefs(content: unknown, validLabels: ReadonlyArray<unknown>): string[] {
  const text = String(content ?? "");
  const out: string[] = [];
  for (const label of validLabels ?? []) {
    if (typeof label !== "string" || label.length === 0) continue;
    if (text.includes(label) && !out.includes(label)) out.push(label);
  }
  return out;
}

export type ReflectionCardContractResult =
  | { ok: true; anchorRefs: string[] }
  | { ok: false; reason: string };

/**
 * 契约门：叙事机械门（D6+第一人称）→ 锚引用门（锚集空/undefined 降级跳过）。
 * 通过时 anchorRefs = 命中的锚 label（契约 on 时恒并入 attrs.anchor_refs，
 * 空数组也带键 —— 采纳侧可区分「锚集缺失降级」与「未接线」）。
 */
export function validateReflectionCardContract(input: {
  content: unknown;
  validAnchorLabels?: ReadonlyArray<unknown>;
}): ReflectionCardContractResult {
  const narrative = validateIdentityNarrative(input?.content);
  if (!narrative.ok) return { ok: false, reason: narrative.reason };
  const labels = input?.validAnchorLabels;
  if (!Array.isArray(labels) || labels.length === 0) return { ok: true, anchorRefs: [] };
  const anchorRefs = extractValueAnchorRefs(input.content, labels);
  if (anchorRefs.length === 0) return { ok: false, reason: "no-anchor-ref" };
  return { ok: true, anchorRefs };
}
