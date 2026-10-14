/**
 * anchor-desc.ts — 锚点 description 写入口 sanitizer 单一源（P0-1A，issue #1，2026-10-13）。
 *
 * 问题：sanitizeDescription 原居 gateway/pending-adopt-merge.ts——core/lifecycle 的
 * auto-growth 采纳端（anchor-growth.ts）按引用方向（core→core 合法，core→gateway 非法）
 * 无法复用，导致 LLM 自生长采纳时 attrs_json 落 "{}"、rationale 丢弃（issue #1 根因）。
 * 本文件把 sanitizer 搬进 core/hooks（soul-assembler/episode-gate 同族），gateway 改为
 * re-export 保持公共 API 不变。
 *
 * 同步规则（pending-adopt-merge.ts 2026-10-04 灵魂注入质量轮，何晨令）：
 * 60 字窗口内含句末标点（。！？；）→ 截到最后句末标点；窗口内无句末标点：
 * 尾悬空（以，、, 结尾=写入口截断实锤特征）→ 置空（宁缺毋滥不入半句），
 * 完整短语（尾非悬空）→ 原样保留。
 */
import { isDanglingTail } from "./soul-assembler.js";
import { looksLikeEpisode } from "./episode-gate.js";

export function sanitizeAnchorDescription(raw: string, maxChars: number): string {
  const full = String(raw ?? "").trim();
  if (!full) return "";
  const truncated = [...full].length > maxChars;
  const s = [...full].slice(0, maxChars).join("");
  const cut = Math.max(s.lastIndexOf("。"), s.lastIndexOf("！"), s.lastIndexOf("？"), s.lastIndexOf("；"));
  if (cut >= 0) return s.slice(0, cut + 1); // 有句末标点 → 截到最后句末标点
  if (truncated) return ""; // 超长截断且窗口内无句末标点 = 半句实锤 → 置空
  return isDanglingTail(s) ? "" : s; // v18-d 单一源：仅尾悬空标点[，、,]→ 置空（长度判据已删，判据见 isDanglingTail 注释）；完整短语原样保留
}

/**
 * 采纳端便捷口：sanitize + episode 双门后非空才回 attrs（空 = attrs_json 不写
 * description 字段，渲染端宁缺毋滥跳过——与 coerceCoreValueAnchor 的 desc 置空语义一致）。
 * episode 门（R2 同款）：LLM rationale/description 若为具体事件叙述（commit hash/HTTP/
 * 日期等硬特征）→ 置空不落库（锚保留；coerce 的整锚拒门针对用户显式提案，此处宽一档）。
 */
export function anchorDescriptionAttr(raw: string | undefined | null, maxChars = 60): { description: string } | undefined {
  const description = sanitizeAnchorDescription(String(raw ?? ""), maxChars);
  if (!description || looksLikeEpisode(description)) return undefined;
  return { description };
}

/**
 * Standards 终审 #4（dup 消解，2026-10-13）：读既有锚 attrs_json 的 description
 * （非空字符串才有效）。auto-growth theme/person 重采纳守卫共用——prior 锚已有
 * 非空 description 时不允许 LLM 侧重写（attrs=undefined 不碰语义）。
 */
export function existingDescription(attrsJson: string | null | undefined): string | undefined {
  if (!attrsJson || attrsJson === "{}") return undefined;
  try {
    const parsed = JSON.parse(attrsJson) as { description?: unknown } | null;
    const d = parsed?.description;
    return typeof d === "string" && d.trim() ? d : undefined;
  } catch {
    return undefined; // 坏行 JSON：按无描述处理（走补写路径）
  }
}

// ── #20 T13（issue #20，2026-10-14 何晨拍板）：desc 内容合同 v2 ──────────────────
// 定位裁决：价值锚=软取向轴（经四消费点间接生效），非硬规则（规则层=strict_rule 槽，
// 人工全量裁决全有或全无；ADR docs/adr/0002）。锚描述随之从「定义句」升级为
// 「情境短语+行为取向」句式——描述的是"在什么情境下倾向于怎么做"，不是"X 是什么"。

/** desc 内容合同 v2（单一源：三处 prompt + 脚本预筛 + 面板提示共同引用）。 */
export const DESC_CONTRACT_V2 = {
  maxChars: 60,
  /** 句式合同：一句话 = 情境短语 + 行为取向。 */
  rule: "一句完整陈述（不超过 60 字，以句号结尾）=「情境短语 + 行为取向」：写清在什么情境下倾向于怎么做（如「宁可…不…」「遇…先…」「…时优先…」「…而非…」）。",
  /** 禁写清单。 */
  bans: ["纯定义句（如「X 很重要」「X 是 Y」）", "事件叙述（日期/编号/HTTP 码等，episode 门同源）"],
  /** 好例（prompt/面板共用）。 */
  goodExample: "涉及不可再生数据时，宁可慢一步验证，不做不可逆操作。",
} as const;

/** prompt 片段（单一源拼接，DISCOVER/PERSON/CHARACTER 三处引用不重复定义）。 */
export function descContractPromptLine(): string {
  return `描述写作合同：${DESC_CONTRACT_V2.rule}禁止${DESC_CONTRACT_V2.bans.join("；")}。好例：「${DESC_CONTRACT_V2.goodExample}」写不出合格一句就省略/给空串，宁缺毋滥。`;
}

/** 取向动词/结构特征（确定性预筛：命中任一即视为带行为取向）。 */
const DESC_V2_ORIENTATION_RE = /宁可|宁不|宁缺|优先|避[免开]|慎[重行]?|不[得要应可]?(做|改|删|动|写|发|碰)|先[^。；]{0,8}再|倾向|而非|而不是|遇[^。；]{0,10}先/;
/** 定义句特征（确定性预筛：命中即不合格——描述"是什么/很重要"而非"怎么做"）。 */
const DESC_V2_DEFINITION_RE = /(很|非常|十[分分]|极其|特别)重要|重要[性的。]|的(原则|底线|标准|要求)[。；]?$|^.{0,8}是[^。]*。?$|^[^。；]{1,6}(优先|为先|第一)[。]?$/;

/**
 * 确定性预筛（#20 T13）：desc 是否符合合同 v2（sanitize + episode 门 + 取向特征 +
 * 非定义句）。用于脚本存量审计与 LLM 重述的确定性守卫；预筛失败仅提示不阻塞
 * 人工输入（#20 拍板：启发式预筛，LLM 复核只在预筛失败时提示）。
 */
export function passesDescContractV2(raw: string): boolean {
  const s = sanitizeAnchorDescription(String(raw ?? ""), DESC_CONTRACT_V2.maxChars);
  if (!s || looksLikeEpisode(s)) return false;
  return DESC_V2_ORIENTATION_RE.test(s) && !DESC_V2_DEFINITION_RE.test(s);
}
