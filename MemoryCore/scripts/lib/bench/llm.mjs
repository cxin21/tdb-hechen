/**
 * 基准 harness 的 LLM 调用层（生成 + 判分）。
 *
 * 凭据只经 scripts/lib/read-llm-credential.ts（ADR-0006 唯一读取器）解析：
 * override > yaml > env(deprecated)；三字段不齐 → fail-fast，绝不静默降级。
 * 本模块不打印 apiKey，报告里只记 apiKeySource。
 */

import { isRetriableHttpError, withRateLimitRetry } from "./retry.mjs";

/** 生成/判分层的短退避刻度（800ms/1600ms）——与抽取的 5s/15s/30s 长退避不同：
 *  这里是单点调用，长等只会把整档拖慢，而抽取是并发批量、429 来自端点级 Token Plan。 */
const LLM_RETRY_DELAYS_MS = [800, 1600];

/** 从凭据建一个最小 chat 客户端。 */
export function makeLlm(cred) {
  if (!cred) throw new Error("LLM 凭据缺失（baseUrl/apiKey/model 未配齐）");
  const base = String(cred.baseUrl).replace(/\/+$/, "");
  const url = base.endsWith("/chat/completions") ? base : base + "/chat/completions";
  const timeoutMs = cred.timeoutMs && cred.timeoutMs > 0 ? cred.timeoutMs : 120_000;
  const maxTokens = cred.maxTokens && cred.maxTokens > 0 ? cred.maxTokens : 2048;

  async function call({ messages, json = false, temperature = 0, maxTokens: mt, retry = true }) {
    const body = {
      model: cred.model,
      messages,
      temperature,
      ...(json ? { response_format: { type: "json_object" } } : {}),
    };
    // max_tokens=0 语义=不限制（reasoning 模型），此时不传该字段
    if (mt ?? maxTokens) body.max_tokens = mt ?? maxTokens;

    const attemptOnce = async () => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + cred.apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      if (!res.ok) {
        const err = new Error(`LLM HTTP ${res.status}: ${text.slice(0, 300)}`);
        err.status = res.status;
        throw err;
      }
      const j = JSON.parse(text);
      const content = j?.choices?.[0]?.message?.content ?? "";
      return { content: String(content), usage: j?.usage };
    };

    // 重试所有权：抽取/蒸馏/验收门禁（facts.mjs / conclusions.mjs / fact-extract-gate.mjs）
    // 自己拥有 5s/15s/30s 的长退避，这里传 retry:false 只做单次尝试——否则内层 0.8s/1.6s
    // 套在外层 4 次里会出现「单批最多 12 次 HTTP、最坏 sleep≈157s」的双层叠加（Spec 评审）。
    // 其余单点调用（生成/判分）仍由本层重试，重试收敛到 retry.mjs 单一源（#139 第1项）。
    // 历史实现的 4xx（除 429）判定写在 try 内，抛出的错误会被 catch 吞掉并重试——状态码
    // 判定形同虚设；这里挂 e.status 交给统一判定，非 429 的 4xx 首次即抛。
    if (retry === false) return attemptOnce();
    return withRateLimitRetry(attemptOnce, {
      attempts: 3,
      delays: LLM_RETRY_DELAYS_MS,
      // 4xx（除 429）不重试；网络层失败（无状态码 / 限流文案）由 isRetriableHttpError 兜底。
      // 超时不重试：AbortSignal.timeout 的 120s × 3 次会在单点上挂死 6 分钟，整档卡住。
      isRetryable: (e) => {
        if (e?.name === "TimeoutError" || e?.name === "AbortError") return false;
        return isRetriableHttpError(e);
      },
    });
  }

  /** 纯文本回答。 */
  async function text(messages, opts = {}) {
    const r = await call({ messages, ...opts });
    return r.content.trim();
  }

  /** JSON 宽松解析：原文 → 围栏内 → 首个花括号块；全失败返回 null。 */
  function parseJsonLoose(raw) {
    const text = String(raw || "").trim();
    const candidates = [text];
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) candidates.push(fence[1].trim());
    const brace = text.match(/\{[\s\S]*\}/);
    if (brace) candidates.push(brace[0]);
    for (const c of candidates) {
      try {
        return JSON.parse(c);
      } catch {
        /* 下一个候选 */
      }
    }
    return null;
  }

  /**
   * JSON 解析修复重试（#146 度量有效性）：判分器偶发返回非 JSON（实测同一档里 1–5 题，
   * 占 90 题的 1.1–5.6pp），旧实现把它记成 correct=false —— 判分噪声直接混进 A/B 差值。
   * 这里对「解析失败」重问，最多 3 次；仍失败才返回 null（调用方按 judge-parse-failed 记账）。
   * 重问只补一句格式约束，不改判定口径，故不构成提示词漂移。
   */
  const JSON_REPAIR_NUDGE = Object.freeze({
    role: "user",
    content: "上一次输出无法解析为 JSON。请只输出一个 JSON 对象，不要任何解释、不要 Markdown 代码围栏。",
  });

  /** JSON 回答 + usage（token 计量；调用方需计费证据时用）。 */
  async function jsonWithUsage(messages, opts = {}) {
    let usage = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const msgs = attempt === 0 ? messages : [...messages, JSON_REPAIR_NUDGE];
      const r = await call({ messages: msgs, json: true, ...opts });
      usage = r.usage ?? usage;
      const parsed = parseJsonLoose(r.content);
      if (parsed !== null) return { data: parsed, usage };
    }
    return { data: null, usage };
  }

  /** JSON 回答：容忍 ```json 围栏与前后噪声；解析失败重问（最多 3 次）后返回 null。 */
  async function json(messages, opts = {}) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const msgs = attempt === 0 ? messages : [...messages, JSON_REPAIR_NUDGE];
      const r = await call({ messages: msgs, json: true, ...opts });
      const parsed = parseJsonLoose(r.content);
      if (parsed !== null) return parsed;
    }
    return null;
  }

  return { text, json, jsonWithUsage, info: { model: cred.model, baseUrlHost: safeHost(cred.baseUrl), apiKeySource: cred.apiKeySource } };
}

function safeHost(u) {
  try {
    return new URL(u).host;
  } catch {
    return "(invalid)";
  }
}

// ── 提示词 ──────────────────────────────────────────────────────────────────

/** 判分/生成提示版本（B0 校尺：report.config.judgePromptVersion 记录，防提示词漂移无痕）。 */
export const PROMPT_VERSION = "lme-v2";

/** 生成提示：只给召回块 + 问题 + 提问日期；要求证据不足时明说，不猜。 */
export function buildAnswerPrompt({ question, block, questionDate, datasetName }) {
  const lines = [
    "你是一个长期记忆助手。下面是系统从历史对话记忆中检索到的片段（按相关度排序，时间戳为说话时刻）。",
    "只依据这些片段回答。片段不足以回答时，直接说明「根据已有记忆无法确定」，不要编造。",
    "",
    "【检索到的记忆】",
    block && block.trim() ? block.trim() : "（无检索结果）",
    "",
    `【提问日期】${questionDate || "未提供"}`,
    `【问题】${question}`,
  ];
  if (datasetName === "locomo") {
    lines.push("", "注意：对话发生在多人之间，回答时指明是谁，并尽量给出具体时间。");
  } else {
    lines.push("", "注意：涉及时间的问题请给出具体日期/时长；记忆若有更新，以最新一次为准。");
  }
  lines.push("", "直接回答问题本身，简洁。");
  return lines.join("\n");
}

/**
 * 币值提示版本（#146 算法重判实验）。
 *
 * 动机：深池 90 题里 27/36 个错题是**拒答**（"记忆只到某日，无法确定现在"），而
 * 事实级失效/值级遮蔽这条线是在"少给证据"，方向与最大损失相反。这一版不动检索、
 * 不动存储，只把读侧的**币值判定**从"日期不匹配 ⇒ 不敢答"改成"无后续更新 ⇒ 最新
 * 记录即当前值"，用来隔离"币值口径"本身的增益。
 */
export const ANSWER_PROMPT_CURRENCY_VERSION = "prod-block-v2-currency";

/**
 * 币值口径的答案提示：与 buildAnswerPrompt 同结构，只替换尾部约束段。
 * 三条规则针对实测失败模式：
 *  1. 提问日期晚于记录日期 ≠ 信息失效（a2f3aa27 / 1cea1afa 同型拒答）；
 *  2. 没有更晚记录时，最新一次就是当前值（LME knowledge-update 的 gold 口径）；
 *  3. 只有「记忆里完全没有相关线索」才拒答；有旧值也必须给出，并注明是最后已知。
 */
export function buildAnswerPromptCurrency({ question, block, questionDate, datasetName }) {
  const lines = [
    "你是一个长期记忆助手。下面是系统从历史对话记忆中检索到的片段（按相关度排序，时间戳为说话时刻）。",
    "只依据这些片段回答。片段不足以回答时，直接说明「根据已有记忆无法确定」，不要编造。",
    "",
    "【检索到的记忆】",
    block && block.trim() ? block.trim() : "（无检索结果）",
    "",
    `【提问日期】${questionDate || "未提供"}`,
    `【问题】${question}`,
    "",
    "【币值判定规则（重要）】",
    "1. 提问日期晚于某条记忆的时间戳，**不代表**该记忆失效：记忆是零散的对话片段，不是连续同步。",
    "2. 若某个属性有多条互相矛盾的记录，以**时间最晚的那条**为当前值；没有更晚记录时，它就是当前状态。",
    "3. 只有当记忆里**完全没有**与该问题相关的内容时才拒答；有相关记录（哪怕是较早的）就必须给出答案，并注明该记录的时间。",
    "",
    "直接回答问题本身，简洁；若答案来自较早记录，用一句话说明「最后已知于 <时间>」。",
  ];
  if (datasetName === "locomo") {
    lines.push("", "注意：对话发生在多人之间，回答时指明是谁，并尽量给出具体时间。");
  }
  return lines.join("\n");
}

/** 偏好题口径的答案提示版本（#146 算法重判实验 E5）。 */
export const ANSWER_PROMPT_PREF_VERSION = "prod-block-v2-pref";

/**
 * 可组合的答案提示（#146 算法重判：把读侧策略拆成可独立开关的两条口径，便于逐因子归因）。
 *
 *  currency   —— 币值判定：提问日期晚于记录日期不代表失效；无更晚记录时最新记录即当前值；
 *                仅"完全没有相关线索"才拒答，有旧值也必须答并标注时间。
 *  preference —— 偏好题口径：建议类问题的答案本来就在用户既有偏好里，先复述偏好再给建议，
 *                不因"记忆没直接给答案"拒答。
 */
export function buildAnswerPromptTuned({ question, block, questionDate, datasetName, currency = false, preference = false }) {
  const lines = [
    "你是一个长期记忆助手。下面是系统从历史对话记忆中检索到的片段（按相关度排序，时间戳为说话时刻）。",
    "只依据这些片段回答。片段不足以回答时，直接说明「根据已有记忆无法确定」，不要编造。",
    "",
    "【检索到的记忆】",
    block && block.trim() ? block.trim() : "（无检索结果）",
    "",
    `【提问日期】${questionDate || "未提供"}`,
    `【问题】${question}`,
  ];
  if (currency) {
    lines.push(
      "",
      "【币值判定规则（重要）】",
      "1. 提问日期晚于某条记忆的时间戳，不代表该记忆失效：记忆是零散的对话片段，不是连续同步。",
      "2. 若某个属性有多条互相矛盾的记录，以时间最晚的那条为当前值；没有更晚记录时，它就是当前状态。",
      "3. 只有当记忆里完全没有与该问题相关的内容时才拒答；有相关记录（哪怕是较早的）就必须给出答案，并注明该记录的时间。",
    );
  }
  if (preference) {
    lines.push(
      "",
      "【建议类问题口径（重要）】",
      "1. 当问题是在征求建议、意见或推荐（tips / ideas / suggestions / 值得吗）时，答案来自用户已经表达过的偏好、习惯与既往选择。",
      "2. 先明确复述相关的既有偏好（做过什么、喜欢什么、正在坚持什么），再据此给出建议；不要只给泛泛建议。",
      "3. 只要记忆里有用户的偏好线索，就不要拒答——偏好题的正确答案就是「顺着用户既有偏好给建议」。",
    );
  }
  if (datasetName === "locomo") {
    lines.push("", "注意：对话发生在多人之间，回答时指明是谁，并尽量给出具体时间。");
  } else {
    lines.push("", "注意：涉及时间的问题请给出具体日期/时长；记忆若有更新，以最新一次为准。");
  }
  lines.push("", "直接回答问题本身，简洁。");
  return lines.join("\n");
}


/** 证据编排版答案提示（#146 后续实验 Y 臂）：不改检索、不改口径，只重构注入块的组织方式。 */
export const ANSWER_PROMPT_MARSHAL_VERSION = "prod-block-v2-marshal";

/**
 * 把注入块按「日期 → 条数」重新编排，并在块头给一行证据清点。
 *
 * 动机（§24.6 的读数）：k=10 之后仍有 14/24 个错题是「gold 会话全在块里但答不成」，
 * 其中 9 个还是拒答——块是平铺的一长串 turn 行，跨会话聚合题要在几十行里自己找两处事实。
 * 编排版只做三件事：把同一天的行聚在一起、在块头写清查点、要求先整理再作答。
 * 不删行、不做摘要，避免「少给证据」再次诱发拒答。
 */
export function marshalBlock(block) {
  const raw = String(block || "");
  const lines = raw.split("\n");
  const dated = [];
  const rest = [];
  for (const line of lines) {
    const m = line.match(/^\s*-\s*\[[^\]]*\]\s*\[(\d{4}-\d{2}-\d{2})/);
    if (m) dated.push({ date: m[1], line });
    else rest.push(line);
  }
  if (dated.length === 0) return raw;
  const byDate = new Map();
  for (const d of dated) {
    if (!byDate.has(d.date)) byDate.set(d.date, []);
    byDate.get(d.date).push(d.line);
  }
  const dates = [...byDate.keys()].sort();
  const counts = dates.map((d) => d.slice(5) + "×" + byDate.get(d).length).join("、");
  const out = [];
  const head = rest.filter((l) => l.trim()).join("\n").trim();
  if (head) out.push(head, "");
  out.push(`【证据清点】共 ${dated.length} 条相关记忆，覆盖 ${dates.length} 个日期（${counts}）；最早 ${dates[0]}，最晚 ${dates[dates.length - 1]}。`);
  out.push("");
  for (const d of dates) {
    out.push(`### ${d}（${byDate.get(d).length} 条）`);
    out.push(...byDate.get(d));
    out.push("");
  }
  return out.join("\n").trim();
}

/** 编排版提示：编排块 + 可选口径（currency/preference）与「先整理再答」要求。 */
export function buildAnswerPromptMarshalled({ question, block, questionDate, datasetName, currency = false, preference = false }) {
  const body = buildAnswerPromptTuned({ question, block: marshalBlock(block), questionDate, datasetName, currency, preference });
  const rule = [
    "",
    "【作答步骤（重要）】",
    "1. 先按日期把与问题相关的关键事实整理成 1–3 行笔记（每条写明日期与事实），不要直接下结论；",
    "2. 同一事实在多处出现只算一次；不同日期给出不同值时，按币值规则取最晚那条；",
    "3. 需要跨多条记忆聚合（相加、相减、求差、求倍数）时，把参与计算的每条事实与数值都写出来再算，算完检查单位与口径；",
    "4. 最后另起一行以「答：」给出结论。",
  ].join("\n");
  return body.replace(/\n\n直接回答问题本身，简洁。\s*$/, "") + "\n" + rule;
}

/** B1（bench/recall-opt）答案侧提示版本。 */
export const ANSWER_PROMPT_VERSION = "answer-v3-b1";

/** 证据时间戳提取：内容前缀 `[YYYY-MM-DD HH:mm]`（turnContent 打包格式）；无前缀排最后。 */
function tsOf(content) {
  const m = /^\[(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)\]/.exec(String(content || ""));
  return m ? `${m[1]} ${m[2] ?? "00:00"}` : "9999-99-99 99:99";
}

/**
 * B1 时间戳打包：证据按时间先后重排（非分数序），最相关避开正中位置（LME 官方做法；
 * 2307.03172 §4 位置效应 >20%）。编号 [i] 供 CoN 引用。同分数序的近重复折叠仍由生产侧
 * foldNearDuplicates 负责，这里只重排。
 */
export function buildEvidenceBlock(hits, { maxChars = 14000 } = {}) {
  const list = (hits || []).map((h, idx) => ({ h, idx }));
  list.sort((a, b) => tsOf(a.h.content).localeCompare(tsOf(b.h.content)) || a.idx - b.idx);
  const lines = [];
  let used = 0;
  for (let i = 0; i < list.length; i++) {
    const c = String(list[i].h?.content ?? "").replace(/\s+/g, " ").trim();
    if (!c) continue;
    const line = `[${i + 1}] ${c}`;
    if (used + line.length > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join("\n");
}

/**
 * B1 生成提示：英文指令（修正 19/20 中文答英文题）+ CoN（先写 2-4 条带 [i] 引用的证据笔记再作答）
 * + 明确拒答出口 NOT_ENOUGH_INFO（judge 按 lme-v2 规则3 记 refused）。证据不足时允许只写拒答说明。
 */
export function buildAnswerPromptV3({ question, evidence, questionDate, datasetName }) {
  const lines = [
    "You are a long-term memory assistant. Answer the question using ONLY the numbered evidence below.",
    "",
    "Evidence (chronological order; timestamps are when each message was said):",
    evidence && evidence.trim() ? evidence.trim() : "(no evidence retrieved)",
    "",
    `Date when the question was asked: ${questionDate || "unknown"}`,
    `Question: ${question}`,
    "",
    "Instructions:",
    "1. First write 2-4 short evidence notes, one per line, each citing sources like [1][3]. If the evidence is insufficient, write a single note saying so.",
    "2. Then write your final answer on the last line in this exact format:",
    "   Answer: <the answer, in the SAME LANGUAGE the question uses>",
    "3. If the evidence does not contain the answer, output exactly:",
    "   Answer: NOT_ENOUGH_INFO",
  ];
  if (datasetName === "locomo") {
    lines.push("4. The conversations involve multiple speakers; name who said what when possible.");
  } else {
    lines.push("4. For time-related questions give a concrete date/duration; if memory was updated, the latest state wins.");
  }
  return lines.join("\n");
}

/** 取「Answer: 」末次出现的行作为最终答案；没有则原文兜底（judge 兼容自由格式）。 */
export function extractFinalAnswer(text) {
  const s = String(text ?? "");
  const idx = s.lastIndexOf("Answer:");
  if (idx < 0) return s.trim();
  return s.slice(idx + "Answer:".length).trim();
}

const TYPE_HINT = {
  "single-session-user": "事实应与标准答案一致（用户说过的信息）。",
  "single-session-assistant": "事实应与标准答案一致（助手此前给出过的信息）。",
  "single-session-preference": "只要回答体现/符合用户偏好即可，措辞可不同。",
  "multi-session": "需要跨会话聚合多个信息点，聚合结果应符合标准答案。",
  "temporal-reasoning": "允许日期/时长有 ±1 天（或 1 个单位）的误差；超出则算错。",
  "knowledge-update": "以最新状态为准：回答与标准答案一致即算对，即使提到旧值也不扣分。",
  "multi-hop": "回答需包含标准答案中的关键事实，允许表述不同。",
  temporal: "时间关系（先后/间隔）应与标准答案一致，允许 ±1 天（或 1 个单位）误差。",
  "open-domain": "关键事实应与标准答案一致。",
  "single-hop": "关键事实应与标准答案一致。",
  adversarial: "该问题在对话中无答案（对抗题）：只有明确指出无法从对话得知/不臆造才算对。",
};

/** 判分提示：严格二元判定（对齐 LongMemEval / LoCoMo 的 LLM-judge 口径）。 */
export function buildJudgePrompt({ question, gold, answer, questionType, datasetName }) {
  const hint = TYPE_HINT[questionType] || "关键事实应与标准答案一致。";
  return [
    "你是严格的评测员。判断【模型回答】相对【标准答案】是否正确。",
    "",
    `数据集：${datasetName}`,
    `题型：${questionType}`,
    `判定口径：${hint}`,
    "",
    `【问题】${question}`,
    `【标准答案】${gold}`,
    `【模型回答】${answer}`,
    "",
    "规则：",
    "1) 只要事实/语义与标准答案等价即算 correct=true，不要求措辞一致；",
    "2) 模型回答包含标准答案之外的正确细节不扣分，但若与标准答案矛盾则 correct=false；",
    "3) 模型回答回避、含糊、或声称无法确定（而标准答案给出了答案）→ correct=false 且 refused=true；",
    "4) 空虚/无关/复述问题 → correct=false（不算拒答，refused=false）。",
    "",
    '只输出 JSON：{"correct": true|false, "refused": true|false, "reason": "一句话理由"}',
  ].join("\n");
}
