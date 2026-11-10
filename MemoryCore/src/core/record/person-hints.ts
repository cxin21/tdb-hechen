/**
 * 人名线索的确定性校验（2026-11-09，人物档案 spec §17）。
 *
 * 背景：运行时没有名字生产者——`soul_person.display_name` 恒为空串，只有 platform_id。
 * 于是让人格提炼看清「这句话里提到了谁」这件事交给抽取模型，但**名字必须能被语料证实**：
 * 模型给出的每个名字都要在源消息原文里逐字出现，否则丢弃。这条校验是防幻觉的唯一硬防线，
 * 不能被提示词措辞替代——提示词会漂移，原文不会。
 */

/** 角色词：这些词说的是「谁在什么位置」，不是「谁」。 */
export const PERSON_ROLE_TOKENS: ReadonlySet<string> = new Set([
  "user",
  "assistant",
  "system",
  "agent",
  "bot",
  "tool",
  "self",
  "human",
  "用户",
  "助手",
  "助理",
  "客服",
  "系统",
  "机器人",
  "对方",
  "客户",
  "同事",
  "领导",
  "老板",
  "团队",
  "大家",
  "所有人",
]);

/** 指代词：名字位置出现这些词说明模型在偷懒（或原文就是这样），不能当人名。 */
const PRONOUN_TOKENS: ReadonlySet<string> = new Set([
  "他",
  "她",
  "它",
  "你",
  "我",
  "我们",
  "他们",
  "她们",
  "你们",
  "这个",
  "那个",
  "这些",
  "那些",
  "这",
  "那",
  "自己",
  "本人",
  "上述",
  "前者",
  "后者",
]);

/** 名字长度上限（码点）。中文姓名一般 2–4 字，留到 24 是给「某某项目组的某某」这类称呼余量。 */
export const MAX_PERSON_NAME_CHARS = 24;

/** 一次最多接受几个人名，防模型把整段对话里所有人都塞进一条记忆。 */
export const MAX_MENTIONED_PER_MEMORY = 6;

const WRAPPER = /^[\s「」『』"'“”‘’（）()【】\[\]<>《》]+|[\s「」『』"'“”‘’（）()【】\[\]<>《》]+$/gu;

/**
 * 把模型给的原始值收成候选名：剥包裹符号与空白。
 * 只做形状归一，不做大小写折叠——写进档案的名字要保留原样。
 */
export function normalizePersonNameCandidate(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.replace(WRAPPER, "").trim();
  if (name === "") return null;
  if ([...name].length > MAX_PERSON_NAME_CHARS) return null;
  const lower = name.toLowerCase();
  if (PERSON_ROLE_TOKENS.has(lower) || PRONOUN_TOKENS.has(name)) return null;
  // 纯标点/纯数字不是人名（数字可能是工号，但不是称呼）。
  if (!/[\p{L}]/u.test(name)) return null;
  return name;
}

/** 该名字是否被源文本证实（逐字出现；全角半角差异不算证实——那说明模型在改写）。 */
function provenBySource(name: string, sourceText: string): boolean {
  if (sourceText === "") return false;
  return sourceText.includes(name);
}

/**
 * 自述式称呼的固定模式：只认「他把自己叫什么」这一种句式。
 *
 * 为什么要从 content 反抽：提示词要求模型在原文有人名时输出 `speaker_name`，
 * 90 天回放实测 71 条 L1 里 **0 条** 输出——模型宁可在 content 里写「用户名叫何晨」，
 * 也不多给一个键。结果就是 platform 行永远没有 display_name（面板按名索隐看不见人）。
 *
 * 这里抽出来的只是**候选**：它来自模型改写过的 content，本身不算证据，
 * 必须再被这条记忆的 L0 原话逐字证实（`sanitizePersonHints` 的 `provenBySource`）才留。
 * 所以这条兜底既不会让模型编名字，也不会让它漏掉真说过名字的句子。
 */
const SELF_NAME_PATTERNS: ReadonlyArray<RegExp> = [
  /(?:名字|姓名)(?:叫|是|为)\s*([\u4e00-\u9fa5·]{2,8})/gu,
  /(?:名叫|叫做|叫作)\s*([\u4e00-\u9fa5·]{2,8})/gu,
  /(?:自称|署名)\s*(?:是|为|叫)?\s*([\u4e00-\u9fa5·]{2,8})/gu,
  /(?:我|本人)(?:叫|名叫)\s*([\u4e00-\u9fa5·]{2,8})/gu,
  /(?:叫我|喊我|称呼我(?:为|作)?)\s*([\u4e00-\u9fa5·]{2,8})/gu,
];

/** 从一条 L1 的 content 里抽「自称」候选（未证实，交给调用方过原文门）。 */
export function nameCandidatesFromContent(content: string): string[] {
  const text = typeof content === "string" ? content : "";
  if (text === "") return [];
  const out: string[] = [];
  for (const re of SELF_NAME_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null = re.exec(text);
    while (m !== null) {
      const name = normalizePersonNameCandidate(m[1] ?? "");
      if (name !== null && !out.includes(name)) out.push(name);
      m = re.exec(text);
    }
  }
  return out;
}

export interface SanitizedPersonHints {
  /** 说话人自己的名字（可能缺省）。 */
  speakerName?: string;
  /** 被提到的其他人名（去重、保序、已封顶）。 */
  mentioned?: string[];
  /** 被丢弃的候选数（模型给了但不合法/不被原文证实）。 */
  dropped: number;
}

/**
 * 校验模型给的 `metadata.speaker_name` / `metadata.mentioned`。
 *
 * @param metadata 模型返回的 metadata 对象（可为 undefined）
 * @param sourceText 该条记忆的源消息原文拼接（`source_message_ids` 对应文本 + 记忆 content）
 * @param opts.speakerSourceText 说话人名字的专用证据面：只含 user 侧原话。
 *   不给时退回 `sourceText`（降级路径）。理由见下方 speaker_name 分支注释。
 */
export function sanitizePersonHints(
  metadata: Record<string, unknown> | undefined,
  sourceText: string,
  opts?: { speakerSourceText?: string },
): SanitizedPersonHints {
  if (!metadata) return { dropped: 0 };
  let dropped = 0;
  // 说话人＝跟我对话的那位用户。名字必须在**用户自己说的话**里出现才算数：
  // 只用全量原文会放过只出现在 assistant 侧的名字——实测模型把 AI 自己的名字
  // （「砚舟」）填进 speaker_name，因为记忆里写着「用户与 AI（砚舟）确认…」，
  // 那个名字确实在原文里，却不是说话人的名字。user 侧为空时退回全量（降级）。
  const speakerText = opts?.speakerSourceText ?? sourceText;
  const speakerEvidence = speakerText.trim() === "" ? sourceText : speakerText;

  const speakerRaw = metadata.speaker_name;
  let speakerName: string | undefined;
  if (speakerRaw !== undefined && speakerRaw !== null) {
    const name = normalizePersonNameCandidate(speakerRaw);
    if (name && provenBySource(name, speakerEvidence)) speakerName = name;
    else dropped += 1;
  }

  const mentionedRaw = metadata.mentioned;
  const mentioned: string[] = [];
  if (Array.isArray(mentionedRaw)) {
    const seen = new Set<string>();
    for (const item of mentionedRaw) {
      const name = normalizePersonNameCandidate(item);
      if (!name || !provenBySource(name, sourceText)) {
        dropped += 1;
        continue;
      }
      if (name === speakerName) continue; // 说话人自己不算「被提到」
      if (seen.has(name)) continue;
      seen.add(name);
      if (mentioned.length < MAX_MENTIONED_PER_MEMORY) mentioned.push(name);
    }
  } else if (mentionedRaw !== undefined && mentionedRaw !== null) {
    dropped += 1;
  }

  return {
    ...(speakerName ? { speakerName } : {}),
    ...(mentioned.length > 0 ? { mentioned } : {}),
    dropped,
  };
}
