/**
 * 场景块治理纯函数（Task GOV-2，spec DS-SCENE-GOV-001 §4.1/§4.2）。
 *
 * 纪律：纯函数零 IO、零 config 依赖——供 Task GOV-3 SceneGovernor 消费。
 * 码点计数口径：Array.from（surrogate 安全），与 truncateConclusionContent 同族；
 * META 头定义与 scene-format.ts 一致（-----META-START----- ... -----META-END-----，
 * 计数排除 META 头及其后空行）。本文件不修改任何既有模块，META 标记本地重定义。
 */
import { truncateConclusionContent } from "../hooks/recall-layered.js";

const META_START = "-----META-START-----";
const META_END = "-----META-END-----";

/**
 * 拆分 META 头与正文：META 头 = META_START 起至 META_END 止（含）；
 * 正文 = 其后剥掉空行/行首空白的部分。无成对 META 标记时全文视为正文。
 */
function splitMetaHeader(raw: string): { header: string; body: string } {
  const startIdx = raw.indexOf(META_START);
  const endIdx = raw.indexOf(META_END);
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const cut = endIdx + META_END.length;
    const header = raw.slice(0, cut);
    // 排除 META 头之后的空行（含行内空白），正文从首个非空白字符起算
    const body = raw.slice(cut).replace(/^(?:[\t ]*\r?\n)+/, "").replace(/^[\t ]+/, "");
    return { header, body };
  }
  return { header: "", body: raw };
}

/**
 * 块正文码点计数（排除 META 头及其后空行）。码点计数非字节数（spec §4.2）。
 */
export function countBlockChars(raw: string): number {
  if (typeof raw !== "string") return 0;
  return Array.from(splitMetaHeader(raw).body).length;
}

/**
 * 超限判定：正文码点数 > maxBlockChars 才触发治理（恰等于上限 = 放行）。
 */
export function needsGovernance(raw: string, maxBlockChars: number): boolean {
  return countBlockChars(raw) > maxBlockChars;
}

/**
 * 蒸馏 prompt 构造（spec §4.1 选择策略「不可重构性优先」逐条内嵌）：
 * ① 未闭合事项（待确认/矛盾点）最高优先——L1 原文找不到的推理状态，丢失不可逆；
 * ② 演变轨迹——偏好/观念变化的浓缩，同属不可重构；
 * ③ 时近性——近期（滚动窗口内）决策结论；
 * ④ 已闭合叙事——压缩为一句索引级结论，原文可查 L1 故可弃。
 * 输出要求：含 META 头（created 保留原值 / updated 当前时间 / summary 30-40 词重写 /
 * heat 保留原值）、总长 ≤ maxBlockChars、保持既有章节结构。
 */
export function buildDistillPrompts(
  blockContent: string,
  maxBlockChars: number,
): { systemPrompt: string; userPrompt: string } {
  const systemPrompt = [
    "你是 L2 场景块蒸馏编辑器。输入一个超出上限的场景块（含 META 头），请将其蒸馏重写为一个更精炼的完整场景块。",
    "",
    `总长硬约束：产出（含 META 头）不得超过 ${maxBlockChars} 字符（按 Unicode 码点计数，非字节数）。`,
    "",
    "保留优先级（不可重构性优先，从高到低逐条执行，冲突时高优先级胜出）：",
    `1. 未闭合事项（待确认 / 矛盾点）：最高优先，必须完整保留——这些是 L1 原文里找不到的推理状态，丢失不可逆。`,
    `2. 演变轨迹：偏好 / 观念变化的浓缩必须保留，同属不可重构。`,
    `3. 时近性：近期决策结论（滚动窗口内）优先保留。`,
    `4. 已闭合叙事：压缩为一句索引级结论即可，原文可查 L1 故可弃。`,
    "",
    "输出格式要求：",
    `- 必须包含完整 META 头（${META_START} ... ${META_END}）：created 保留原值；updated 写当前时间；summary 按 30-40 词重写；heat 保留原值。`,
    `- 保持既有章节结构（原块的章节框架原样保留，仅在章节内蒸馏精炼），不要发明新章节。`,
    `- 只输出蒸馏后的场景块全文，不要任何解释或代码围栏。`,
  ].join("\n");

  const userPrompt = [
    `以下场景块正文已超过 ${maxBlockChars} 字符上限，请按系统指令的保留优先级蒸馏重写，产出总长（含 META 头）≤ ${maxBlockChars} 字符的完整场景块：`,
    "",
    "<original_block>",
    blockContent,
    "</original_block>",
  ].join("\n");

  return { systemPrompt, userPrompt };
}

/**
 * 硬截断兜底（spec §4.2 ④）：蒸馏产出仍超限或含 U+FFFD 时使用。
 * META 头完整原样保留；正文复用 truncateConclusionContent（码点安全，surrogate 不劈半，
 * 标注计入预算）截断，使总长（含 META 头）≤ hardCapChars。
 * 零 U+FFFD 无条件承诺（N2）：截断本身码点安全不产生坏字符，但会透传输入残留的
 * U+FFFD（蒸馏产出夹坏字 → validate 拒收 → 走本兜底的路径），故产物统一剥离。
 */
export function hardCapFallback(raw: string, hardCapChars: number): string {
  const { header, body } = splitMetaHeader(raw);
  const totalBudget = Math.floor(hardCapChars);
  if (header === "") {
    return truncateConclusionContent(raw, totalBudget).replaceAll("\uFFFD", "");
  }
  const headerChars = Array.from(header).length + 2; // +2 = META 头后的 "\n\n" 分隔符计入预算
  const bodyBudget = totalBudget - headerChars;
  // 预算不足以容纳 META 头本身（退化配置）：正文清空保 META 完整
  const capped = bodyBudget > 0 ? truncateConclusionContent(body, bodyBudget) : "";
  return `${header}\n\n${capped}`.replaceAll("\uFFFD", "");
}

/**
 * META 头码点数（不含头后的 "\n\n" 分隔符；无成对 META 标记时返回 0）。
 * 供 Task GOV-3 governor 在 hardCapFallback 产出前判定「META 头本身 ≥ hardCapChars」
 * （即 bodyBudget ≤ 0，兜底只会产出 META-only 文件）的巨型 META 降级路径（review N1）。
 */
export function metaChars(raw: string): number {
  if (typeof raw !== "string") return 0;
  const { header } = splitMetaHeader(raw);
  return header === "" ? 0 : Array.from(header).length;
}

/**
 * 蒸馏产出验收（写回前四条件全过才放行）：总长（含 META）≤ maxBlockChars、
 * 有成对 META 头、正文非空、零 U+FFFD 坏字符（spec §4.2 ④「仍超限或含 U+FFFD →
 * 硬截兜底」的后半条件）。任一不过 → 由调用方转入 hardCapFallback 兜底。
 */
export function validateDistilled(out: string, maxBlockChars: number): boolean {
  if (typeof out !== "string") return false;
  const { header, body } = splitMetaHeader(out);
  const hasMeta = header.includes(META_START) && header.includes(META_END);
  const bodyNonEmpty = Array.from(body).length > 0;
  const withinLimit = Array.from(out).length <= maxBlockChars;
  const noBadChar = !out.includes("\uFFFD");
  return hasMeta && bodyNonEmpty && withinLimit && noBadChar;
}
