/**
 * 基准 harness 的 LLM 调用层（生成 + 判分）。
 *
 * 凭据只经 scripts/lib/read-llm-credential.ts（ADR-0006 唯一读取器）解析：
 * override > yaml > env(deprecated)；三字段不齐 → fail-fast，绝不静默降级。
 * 本模块不打印 apiKey，报告里只记 apiKeySource。
 */

/** 从凭据建一个最小 chat 客户端。 */
export function makeLlm(cred) {
  if (!cred) throw new Error("LLM 凭据缺失（baseUrl/apiKey/model 未配齐）");
  const base = String(cred.baseUrl).replace(/\/+$/, "");
  const url = base.endsWith("/chat/completions") ? base : base + "/chat/completions";
  const timeoutMs = cred.timeoutMs && cred.timeoutMs > 0 ? cred.timeoutMs : 120_000;
  const maxTokens = cred.maxTokens && cred.maxTokens > 0 ? cred.maxTokens : 2048;

  async function call({ messages, json = false, temperature = 0, maxTokens: mt }) {
    const body = {
      model: cred.model,
      messages,
      temperature,
      ...(json ? { response_format: { type: "json_object" } } : {}),
    };
    // max_tokens=0 语义=不限制（reasoning 模型），此时不传该字段
    if (mt ?? maxTokens) body.max_tokens = mt ?? maxTokens;

    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer " + cred.apiKey },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const text = await res.text();
        if (!res.ok) {
          // 4xx（除 429）不重试
          if (res.status !== 429 && res.status < 500) {
            throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 300)}`);
          }
          lastErr = new Error(`LLM HTTP ${res.status}: ${text.slice(0, 200)}`);
        } else {
          const j = JSON.parse(text);
          const content = j?.choices?.[0]?.message?.content ?? "";
          return { content: String(content), usage: j?.usage };
        }
      } catch (e) {
        lastErr = e;
      }
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
    throw lastErr ?? new Error("LLM 调用失败");
  }

  /** 纯文本回答。 */
  async function text(messages, opts = {}) {
    const r = await call({ messages, ...opts });
    return r.content.trim();
  }

  /** JSON 回答：容忍 ```json 围栏与前后噪声；解析失败返回 null（调用方决定降级）。 */
  async function json(messages, opts = {}) {
    const r = await call({ messages, json: true, ...opts });
    const raw = r.content.trim();
    const candidates = [raw];
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) candidates.push(fence[1].trim());
    const brace = raw.match(/\{[\s\S]*\}/);
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

  return { text, json, info: { model: cred.model, baseUrlHost: safeHost(cred.baseUrl), apiKeySource: cred.apiKeySource } };
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
