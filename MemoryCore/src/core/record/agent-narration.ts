/**
 * A3-2（2026-11-02）：agent 自述标注（config-first，缺省关闭）。
 *
 * 病灶（docs/research/2026-11-02-memory-layering-extraction-optimization.md §P2）：
 * 32.1%（945/2946）的存活 L1 行主语是"AI/我/我在/我的"，即模型在把 **AI 自己的职责/承诺/
 * 工作风格**写成记忆，去污染 persona/instruction 层。语义参考 prompts/l1-extraction.ts 的
 * AGENT_ACT_BLOCK：主语是"我 / I"，谓语描述 AI 自身的动作。
 *
 * F5（task-7，2026-11-02）：主语扩到三类第三人称自称 —— AI / 助手 / 模型。修前只读实测：
 * 全库 3913 行里 537 行以「AI」开头，本模块命中 0；metrics 侧另一套正则在同批数据上给出
 * 5.9% 而本模块 9.6%、交集仅 17 行 —— 两处口径分裂，统一到本模块。
 *
 * A4（2026-11-03）：误判收口。判定从"句中出现动作词"收紧为**句法关系**：
 *  - 第三人称：动作词必须落在**谓语位置**；动作词后紧接「(了|过)?的」是定语
 *    （「助手已完成的事项列表」「AI 已确认的合同清单」）→ 不算自述；
 *  - 第一人称：必须有**自指证据**（语境里只有 AI 会用第一人称承诺/自报工作），
 *    「我明天提交周报」「我的笔记里写满了待办」是用户叙事 → 不算自述；
 *  - 新增 reconcileAgentNarrationMetadata：dedup 合并会改写落库文本
 *    （l1-writer `merged_content ?? memory.content`），写侧须按**最终 content** 复判标签。
 *
 * A5（2026-11-03，Lead 追加契约）：第一人称补**完成体**证据。A4 的自指证据表不含完成体，
 * 把本仓 agent 报告的标准句式（「我完成了 A3 提取校准并跑了全量门禁」「我核验了生产库…」）
 * 判成 false，selfNarrationRate 系统性低估（实测 26.4%→19.4%）。现分三档：
 *  ① 自指证据（作为 AI / 我负责 / 我长期 / 我在和…做 / 我承诺）→ true；
 *  ② 我 + 完成体（已/了/过，可带结果补语）+ 执行类动作 → true；
 *  ③ 我 + 无完成体的计划/叙事（明天、要、将）或「我的 NP」（领属）→ false。
 * 「我把…」按动作词表区分：`我把 L0…定谳为…` true，`我把钥匙放在抽屉里` false。
 *
 * 纪律：
 * - 只在 cfg.extraction.actorTagging === true 时写 metadata.actor="agent"；
 * - 关闭时返回**原对象**（同一引用），绝不新增/改写任何字段 —— 与今天的字节形态一致；
 * - 判定是启发式（宁缺毋滥）：主语 + 同句 agent 动作词；"用户…"开头的陈述先排除；
 *   第三人称主语与动作词之间只许出现状语形状，"模型配置…/助手脚本…/AI 供应商…" 不命中；
 * - 非法输入（空串/空白/undefined）一律 false，不抛错。
 */

/** 与 config.ts 的 extraction.actorTagging 同形（只读这一位，不引整个配置类型）。 */
export interface AgentNarrationConfig {
  extraction?: { actorTagging?: boolean };
}

/** 句子切分：句号/分号/感叹/问号/换行（冒号不切，避免把"执行红线：…"切断）。 */
const CLAUSE_SPLIT = /[。；;！!？?\n]/;

/** 句首第一人称主语：我（不含"我们"——那是团队而非 agent 自述）/本人 / I（I'm, I've, I'll）。 */
const FIRST_PERSON_START = /^(?:我(?!们)|本人|I\b|I['\u2019](?:m|ve|ll|d)\b)/;

/** 英文第一人称句：英文里 `I` 只能是自指，但动作词仍要过 agent 动作表（见 AGENT_ACTION）。 */
const ENGLISH_FIRST_PERSON = /^I\b/;

/** 第一人称的承诺/职责/风格类谓语（谓语本身即自指证据，无需再看句内动作词）。 */
const FIRST_PERSON_COMMIT_VERB = "承诺|保证|约定|负责|承担|遵守|坚持|执行|遵循|维护|保持|习惯|汇报|确保";

/**
 * A4：第一人称的**自指证据**（三种形状，均要求同句有 agent 动作词）：
 *  ① 我 +（可选频率副词）+ 承诺/职责类谓语：`我负责维护…`、`我长期承担…`；
 *  ② 我 + 时体/结构标记：`我在对话中承诺…`、`我已经跑完全量门`、`我把…定谳为…`、
 *     `我于 2026-10-14 完成…`、`我将…`；
 *  ③ 我/本人 + 身份：`我作为 AI`、`身为助手`。
 * 反例（必须 false）：`我明天提交周报`（明天不在标记里）、`我的笔记里…`（我的不成证）。
 */
const FIRST_PERSON_EVIDENCE = new RegExp(
  "^(?:我(?!们)|本人)(?:" +
    [
      "(?:长期|始终|一直|一贯|平时|通常|总是|往往|从|从不|从未|也|都|只|仅)?\\s*(?:" + FIRST_PERSON_COMMIT_VERB + ")",
      // A5 契约 c：`要/将/会` 是**计划**标记，不是自指证据（`我明天要提交周报` 必须 false）；
      // 过去/完成类标记（已/已经/刚刚/刚/曾/先后）与句式证据（在|把|于|作为|身为）保留。
      "(?:在|正在|已|已经|刚刚|刚|曾|先后|把|于|作为|身为)",
    ].join("|") +
    ")",
);

/** `我` + `的` = 领属短语（`我的笔记里写满了待办`），不是自指证据，优先排除。 */
const FIRST_PERSON_POSSESSIVE = /^我(?!们)的/;

/** A4：句首自报身份（`作为 AI，我…`）——自指证据，配合句内 agent 动作词。 */
const AS_AGENT_SELF = /^(?:作为|身为)\s*(?:一个\s*)?(?:AI|助手|模型|智能体)(?![A-Za-z])/;

/**
 * 第三人称 agent 主语：AI / 助手 / 模型。
 * AI(?![A-Za-z]) 防 "AIGC/AIops" 之类专名；中文主语由后续形状判定把关。
 */
const THIRD_PERSON_SUBJECT = /^(?:AI(?![A-Za-z])|助手|模型)/;

/**
 * 第三人称主语与动作词之间允许的"状语形状"：空白 / 纯数字（日期、时间、任务号）/
 * 限定副词 / 有界方位短语（在…中|时|后|前|期间）/ 标点。
 * 其它任何汉字都算复合名词延续（模型配置 / 助手脚本 / AI 供应商）→ 不命中。
 */
const THIRD_PERSON_GAP = new RegExp(
  "^(?:" +
    [
      "\\s+",
      "\\d[\\d\\-:./]*",
      "在[^，,。；;！!？?]{1,16}?(?:中|时|后|前|期间)",
      "已经|已|刚刚|刚|将|要|会|正在|于|随后|随即|同时|先|再|又|亦|曾|本周|本轮|当日|今天|昨日|前日|在",
      "[，,、:：]",
    ].join("|") +
    ")*",
);

/** agent 动作词（执行类 + 职责/风格类），第一人称与第三人称共用同一张表。 */
const ACTION_WORDS =
  "承诺|保证|负责|承担|执行|遵守|坚持|保持|习惯|汇报|推送|提醒|维护|记录|检查|复核|核对|监控|跟进|输出|整理|拒绝|完成|核验|跑|读|改|写|部署|提交|重启|验证|评审|确认|决定|修复|抽取|蒸馏|校准|排查|上线|回滚|落库|拉取|比对|收口|定档|定谳|定案|定论|使用|发现|查明|调试|推断|提出|安排|计划|评估|交付|处置|协调|判断|写入|落盘";

/** 同句 agent 动作词（句中任意位置；含职责/风格类名词与英文词干）。 */
const AGENT_ACTION = new RegExp(
  ACTION_WORDS +
    "|红线|原则|风格|职责|工作方式|长期|始终|一直|通常|约定|\\b(?:always|usually|promise[sd]?|promising|commit(?:ted|s)?|responsib\\w*|maintain\\w*|ensure[sd]?|remind\\w*|report\\w*|follow\\w*)\\b",
  "i",
);

/** 主语（+状语）之后必须**紧跟**动作词：只做前缀判定，避免"是一个缩写"里的"写"误命中。 */
const ACTION_START = new RegExp("^(?:" + ACTION_WORDS + ")");

/**
 * A4：动作词后紧接「(了|过)?的」= 定语结构（"已完成的事项列表"），动作词不是谓语。
 * 注意：不能放宽成"第一个 了|过 之前出现 的"——`助手已完成的事项列表` 根本没有「了」。
 */
const ATTRIBUTIVE_AFTER_ACTION = /^\s*(?:了|过)?\s*的/;

/**
 * A5（2026-11-03，Lead 追加契约）：第一人称**完成体**证据。
 * 本仓 agent 报告的标准句式是「我 +（已|了|过）+ 执行类动词 + 产物宾语」，
 * 完成体本身就是"我做过某事"的证据，但**必须**同句有执行类动作词（否则纯结构噪音也命中）：
 *  ① 执行类动作 +（≤3 字结果补语）+ 了/过：`完成了`、`核验了`、`读完了`、`跑过`；
 *  ② 已/已经/刚刚/刚 +（≤10 字）+ 执行类动作：`已经跑完全量门`。
 * 已知误报带（诚实边界）：用户也会说「我昨天提交了周报」——完成体 + 执行类动作在中文里
 * 天然同形。本仓取"宁可多标 agent"的方向（真自述掉出统计的代价高于少量用户叙事被标），
 * 生产读数需知这一档存在；要再收紧只能靠动作词表或宾语类型，不再加结构规则。
 */
const FIRST_PERSON_COMPLETION_VERB = new RegExp("(?:" + ACTION_WORDS + ")[^。；;！!？?\\n]{0,3}(?:了|过)");
const FIRST_PERSON_COMPLETION_ADVERB = new RegExp("(?:已|已经|刚刚|刚)[^。；;！!？?\\n]{0,10}(?:" + ACTION_WORDS + ")");

/**
 * A6（2026-11-03，Lead 拍板）：三族「自指证据」，任一命中即 true，且都带语义约束——
 * 比 A5 完成体更安全（完成体只看时体，用户同样会说「我昨天提交了周报」）。
 *
 *  ① 身份自报：`我是|本人是` +（≤20 字）+ 身份名词（助手/AI/agent/智能体/模型/机器人）。
 *     - 窗口内出现第三人称指示词（他/她/您/用户/客户/对方/某人/他人）= 指称别人 → 不成证；
 *     - 没有身份名词的人类自述天然不命中：`我是用友的产品经理`、`我是 2026-10 入职的`；
 *     - 身份名词后 4 字内不许是 产品/经理/工程师/团队/岗位/职位/总监/专员/同事，
 *       防人类自述职业 `我是 AI 产品经理` 被误判（宁缺毋滥）。
 *  ② 风格准则：`我按|依|凭|照|遵循|奉行|以` + 任意宾语（引号书名号也算）。
 *     - 同句出现第三人称指示词（他/她/您/用户/客户/对方/某人/他人）= 转述他人建议 → false，
 *       例 `我按照他的建议改了口径`（该判定先于完成体，否则会被「改了口径」翻成 true）；
 *     - `我以` 排除 以为/以便/以及/以免 这类虚词。
 *  ③ 取证动作：`我用|通过|借助|靠` +（≤20 字）+ 证据动词白名单；
 *     或直陈式 `我（核查|复核|审阅|取证|复测）(后)…（指出|证明|确认|判定|定谳|比对）`。
 *     - 白名单 = 证明|核实|确认|取证|复测|判定|定谳|定案|比对|对拍|核查|复核|审阅；
 *     - `我用微信发给客户了` 没有证据动词 → false（「用」本身不是证据）。
 *  三族都不触碰 A5 边界：领属 `我的 NP`、无完成体计划句（明天/要/将/会）、`我把钥匙…` 仍 false。
 */
const FIRST_PERSON_IDENTITY =
  /^(?:我|本人)是(?![^，。；;！!？?]{0,20}(?:他|她|您|用户|客户|对方|某人|他人))(?:[^，。；;！!？?]){0,20}?(?:助手|智能体|机器人|模型|agent|AI)(?![A-Za-z])(?![^，。；;！!？?]{0,4}(?:产品|经理|工程师|团队|岗位|职位|总监|专员|同事))/i;

/** A6 ② 风格准则；`我以` 需排除 以为/以便/以及/以免。 */
const FIRST_PERSON_STYLE = /^我(?:按|依|凭|照|遵循|奉行|以(?!为|便|及|免))/;

/** 第三人称指示词：出现在风格准则句里表示「转述别人」而非自述。 */
const THIRD_PARTY_MENTION = /他|她|您|用户|客户|对方|某人|他人/;

/** A6 ③ 证据动词白名单（核查/复核/审阅按 Lead 口径纳入）。 */
const EVIDENCE_VERBS = "证明|核实|确认|取证|复测|判定|定谳|定案|比对|对拍|核查|复核|审阅";
const FIRST_PERSON_EVIDENCE_ACTION = new RegExp(
  "^我(?:用|通过|借助|靠)[^。；;！!？?\\\\n]{0,20}(?:" + EVIDENCE_VERBS + ")",
);
const FIRST_PERSON_EVIDENCE_REPORT = new RegExp(
  "^我(?:已)?(?:" +
    EVIDENCE_VERBS +
    ")(?:后|之后|过|了)?[^。；;！!？?\\\\n]{0,20}(?:指出|证明|确认|判定|定谳|比对|对拍|核实|复测|报告)",
);

/** 句首是"用户/客户/The user"的陈述：那是对用户的描述，不是 AI 自述。 */
const USER_SUBJECT_START = /^(?:用户|客户|the user\b|users?\b)/i;

/** 第一人称句：自指证据 + 同句 agent 动作词（英文 I 视为自指，动作词仍须命中）。 */
function isFirstPersonNarration(clause: string): boolean {
  if (ENGLISH_FIRST_PERSON.test(clause)) return AGENT_ACTION.test(clause);
  // A5：`我的 NP` 是领属，不是自指（`我的笔记里写满了待办` 不能靠完成体规则翻成 true）。
  if (FIRST_PERSON_POSSESSIVE.test(clause)) return false;
  // A6 ① 身份自报（`我是…助手`）——人类不会这样指称自己。
  if (FIRST_PERSON_IDENTITY.test(clause)) return true;
  // A6 ② 风格准则：转述第三方建议不算自指；必须**先于**完成体拦截，
  // 否则 `我按照他的建议改了口径` 会因「改了口径」的完成体形态被误判 true。
  if (FIRST_PERSON_STYLE.test(clause)) return !THIRD_PARTY_MENTION.test(clause);
  // A6 ③ 取证动作（`我用反向探针证明…` / `我核查后指出…`）。
  if (FIRST_PERSON_EVIDENCE_ACTION.test(clause) || FIRST_PERSON_EVIDENCE_REPORT.test(clause)) return true;
  if (FIRST_PERSON_EVIDENCE.test(clause) && AGENT_ACTION.test(clause)) return true;
  // A5：完成体 + 执行类动作（`我完成了…` / `我核验了…` / `我已经跑完…`）。
  return FIRST_PERSON_COMPLETION_VERB.test(clause) || FIRST_PERSON_COMPLETION_ADVERB.test(clause);
}

/**
 * 该条记忆是否为"AI 以第一/第三人称自述自己的行为/职责/承诺"。
 * 空串/空白/非字符串 → false。
 */
export function isAgentNarration(content: string): boolean {
  if (typeof content !== "string") return false;
  const text = content.trim();
  if (!text) return false;
  // "用户让我…" 这类整体是用户侧事实：先按句排除，但允许后句有 agent 自述。
  for (const rawClause of text.split(CLAUSE_SPLIT)) {
    const clause = rawClause.trim();
    if (!clause) continue;
    if (USER_SUBJECT_START.test(clause)) continue;
    // `作为 AI，我…`：自报身份 + agent 动作（逗号不切句，必须整句看）。
    if (AS_AGENT_SELF.test(clause)) {
      if (AGENT_ACTION.test(clause)) return true;
      continue;
    }
    if (FIRST_PERSON_START.test(clause)) {
      if (isFirstPersonNarration(clause)) return true;
      continue;
    }
    const third = THIRD_PERSON_SUBJECT.exec(clause);
    if (!third) continue;
    const rest = clause.slice(third[0].length);
    const gap = THIRD_PERSON_GAP.exec(rest)?.[0] ?? "";
    const afterGap = rest.slice(gap.length).replace(/^\s+/, "");
    if (!afterGap) continue;
    const action = ACTION_START.exec(afterGap);
    if (!action) continue;
    // A4：动作词落在定语位置（`已完成的事项列表`）→ 本句不是谓语自述。
    if (ATTRIBUTIVE_AFTER_ACTION.test(afterGap.slice(action[0].length))) continue;
    if (AGENT_ACTION.test(clause)) return true;
  }
  return false;
}

/**
 * 开关开 + 命中 → 返回带 metadata.actor="agent" 的**新对象**（保留原有 metadata 键）；
 * 关闭 / 未命中 → 返回原对象（逐位不变，调用方可按引用比较）。
 */
export function annotateAgentNarration<T extends { content: string; metadata?: Record<string, unknown> }>(
  memory: T,
  cfg?: unknown,
): T {
  if (!memory || typeof memory !== "object") return memory;
  const enabled = (cfg as AgentNarrationConfig | undefined)?.extraction?.actorTagging === true;
  if (!enabled) return memory;
  if (!isAgentNarration(memory.content)) return memory;
  return { ...memory, metadata: { ...(memory.metadata ?? {}), actor: "agent" } };
}

/**
 * A4（2026-11-03）：按**最终落库文本**复判标签。
 *
 * 为什么需要：`annotateAgentNarration` 基于抽取出的 `mem.content` 打标，但 dedup 的
 * merge/update 决策会用 LLM 给的 `merged_content` 改写落库文本（l1-writer:
 * `finalContent = decision.merged_content ?? memory.content`），metadata 原样透传。
 * 于是标签可能停在"改写前"的文本上——双向错标：自述→非自述仍带标签（读侧误杀），
 * 非自述→自述漏标（读侧漏过）。写侧在 writeMemory 前用最终 content 复判一次即可收敛。
 *
 * 语义（缺省逐位不变）：
 *  - 开关关 → 恒等返回原 metadata（同一引用，零 I/O、零分配）；
 *  - 命中 → 补 `actor="agent"`（已标则原引用）；
 *  - 未命中且原标签是 agent → **移除**该键（剩下的键也空则返回 undefined，
 *    与"从未标注"同形）；非 agent 标签（user/assistant…）不动——不归本开关管。
 */
export function reconcileAgentNarrationMetadata(
  content: string,
  metadata: Record<string, unknown> | undefined,
  cfg?: unknown,
): Record<string, unknown> | undefined {
  const enabled = (cfg as AgentNarrationConfig | undefined)?.extraction?.actorTagging === true;
  if (!enabled) return metadata;
  const tagged = metadata?.actor === "agent";
  if (isAgentNarration(content)) {
    if (tagged) return metadata;
    return { ...(metadata ?? {}), actor: "agent" };
  }
  if (!tagged) return metadata;
  const rest: Record<string, unknown> = { ...(metadata ?? {}) };
  delete rest.actor;
  return Object.keys(rest).length > 0 ? rest : undefined;
}
