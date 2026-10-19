/**
 * #67（R3 身份叙事层，2026-10-19）：identity / self_identity 两槽确定性叙事组装器（A 案）。
 *
 * 权威设计：docs/research/2026-10-19-r3-identity-narrative-layer-design.md（= GitHub
 * issue #67 票面）。A 案确定性叙事组装：模板常量 + 事实句逐字保留——无 LLM、无随机、
 * 无时钟；同输入 ⇒ 同输出字节（双跑逐字节一致的纯函数）。
 *
 * Park 2411.10109 口径修正：条目存储 + 叙事渲染**并存**——本模块是渲染侧派生
 * （derived view），不取代条目、永不回写存储；identity slots 存储合同（identity-discovery
 * 提案门 / 单槽合并 version++）维持现状；strict_rule 与价值锚不参与叙事化。
 *
 * 真实性守门三闸（全部可测试）：
 * - 生成闸：输出断言 ⊆ 模板常量 ∪ slots 原文子串——事实行只做 trim（删字符保子串性），
 *   组装后由 verifyNarrativeProvenance 独立复验；违例返回 null（调用方退回条目渲染）。
 * - 写入闸：纯函数、零副作用、零 IO——结构上保证叙事单向 slots→渲染，永不回写存储。
 * - 预算闸：budgetChars 之内按渲染序整句（事实行）累积，超预算句连同其后全部整体
 *   drop（尾丢，不截半句——与 applyAnchorBudget 整锚尾丢同哲学）；保留句逐字。
 *
 * 单一源：MemoryCore 全部消费点共用本函数（soul-assembler 会话头辅路 / gateway
 * core-memory read 的 system 主路，渲染双路同源）；MemoryProxy 经
 * /v3/core-memory/read format=narrative API 透传消费叙事文本，不复制组装逻辑
 * （两包无跨包依赖，禁双份实现）。
 *
 * 消毒说明：core_memory 写入路径单点消毒（v2-router handleCoreMemoryWrite
 * escapeXmlTags，P2-T11 咽喉位）已保证落库内容无裸 XML 边界；读端（含本渲染器）
 * 逐字直出即安全，不二次消毒（二次转义反而破坏「原文子串」溯源不变量）。
 */

/** 叙事模板指纹：模板/文案任何变更必须一次性更新本常量（ADR-0003 §5 批次纪律：
 *  渲染字节变更=一次显式声明的跳变），并随消费点同步进 soulPrefixCache cacheKey 的
 *  nv 段（soul-assembler.ts）。同 sv + 同 nv ⇒ 同叙事字节。 */
export const NARRATIVE_TEMPLATE_VERSION = "nv-2026-10-19-1";

/** 叙事形态合成槽名：/v3/core-memory/read format=narrative 把两身份槽折叠成的一条
 *  叙事槽的 slot 标识（proxy 注入端按既有 <slot> 通用循环原样渲染，零叙事逻辑复刻）。 */
export const IDENTITY_NARRATIVE_SLOT = "identity_narrative";

// 模板常量（组标签与 soul-assembler dual 路径 labelFor 同词汇：我是谁/我心中的他）。
const NARR_HEAD = "以下事实由你和团队共同写就：";
const NARR_SELF_LABEL = "- 我是谁：";
const NARR_USER_LABEL = "- 我心中的他：";
const NARR_FACT_SEP = "；";
const NARR_TAIL = "这些由你和团队共同确认，请把它们当作当下相处的事实。";

export interface IdentityNarrativeSlot {
  slot: string;
  content: string;
}

export interface IdentityNarrativeOptions {
  /** 叙事段事实总字符预算（整句 drop 粒度，只计事实字符；缺省 900）。
   *  soul 路传 budgetSelfChars+budgetIdentityChars 之和（叙事替代两行，预算合并）。 */
  budgetChars?: number;
}

/** 事实行提取：按行（事实）边界切分、trim（删字符保子串性）、滤空——与 truncateByLines /
 *  renderStrictRuleSectionLines 的行级事实边界同哲学（D-1：截断按行不截半句）。 */
function factsOf(content: string): string[] {
  return String(content ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

/** 预算闸：整句（事实行）按渲染序累积，首个超限句连同其后全部 drop（尾丢，确定性）。 */
function budgetFacts(facts: ReadonlyArray<string>, budget: number): string[] {
  const kept: string[] = [];
  let used = 0;
  for (const f of facts) {
    if (used + f.length > budget) break;
    kept.push(f);
    used += f.length;
  }
  return kept;
}

/**
 * 确定性叙事组装：identity / self_identity 两槽 → 叙事文本（纯函数，无副作用）。
 * 渲染序不变量：self_identity（我是谁）先于 identity（我心中的他），与 soul-assembler
 * dual 排序一致；同槽多行内容按声明序逐行成句，组内以全角分号连接（分隔符是模板材料）。
 * 预算按渲染序共享（self 先消费，余量给 identity）。无身份内容 → null（宁缺毋滥，
 * 调用方退回条目渲染）；生成闸违例 → null（同退回）。
 */
export function renderIdentityNarrative(
  slots: ReadonlyArray<IdentityNarrativeSlot>,
  opts?: IdentityNarrativeOptions,
): string | null {
  const budget = opts?.budgetChars ?? 900;
  const selfAll = slots.filter((s) => s.slot === "self_identity").flatMap((s) => factsOf(s.content));
  const selfFacts = budgetFacts(selfAll, budget);
  const used = selfFacts.reduce((n, f) => n + f.length, 0);
  const userFacts = budgetFacts(
    slots.filter((s) => s.slot === "identity").flatMap((s) => factsOf(s.content)),
    Math.max(0, budget - used),
  );
  if (selfFacts.length === 0 && userFacts.length === 0) return null;
  const lines: string[] = [NARR_HEAD];
  if (selfFacts.length > 0) lines.push(NARR_SELF_LABEL + selfFacts.join(NARR_FACT_SEP));
  if (userFacts.length > 0) lines.push(NARR_USER_LABEL + userFacts.join(NARR_FACT_SEP));
  lines.push(NARR_TAIL);
  const narr = lines.join("\n");
  // 生成闸（真实性守门一）：独立复验叙事输出 ⊆ 模板常量 ∪ slots 原文子串；
  // 违例整段丢弃 → null（调用方退回条目渲染）。
  return verifyNarrativeProvenance(narr, slots) ? narr : null;
}

/**
 * 生成闸单一源（导出供测试独立断言）：叙事每一行必须逐字等于模板常量，或等于
 * 组标签 + 若干「slots 原文行（trim 后）」按模板分隔符的连接。独立于组装路径重建
 * 期望串做字节比对——组装逻辑未来若混入插值/随机/外部材料，本门即红。
 */
export function verifyNarrativeProvenance(
  narrative: string,
  slots: ReadonlyArray<IdentityNarrativeSlot>,
): boolean {
  const factSet = new Set(
    slots
      .filter((s) => s.slot === "self_identity" || s.slot === "identity")
      .flatMap((s) => factsOf(s.content)),
  );
  for (const line of narrative.split("\n")) {
    if (line === NARR_HEAD || line === NARR_TAIL) continue;
    const isSelf = line.startsWith(NARR_SELF_LABEL);
    const isUser = !isSelf && line.startsWith(NARR_USER_LABEL);
    if (!isSelf && !isUser) return false;
    const body = line.slice(isSelf ? NARR_SELF_LABEL.length : NARR_USER_LABEL.length);
    // 多句行按分隔符切开后逐段回查原文集合（组内无句 = 空段 = 违例）。
    for (const seg of body.split(NARR_FACT_SEP)) {
      if (!factSet.has(seg)) return false;
    }
  }
  return true;
}
