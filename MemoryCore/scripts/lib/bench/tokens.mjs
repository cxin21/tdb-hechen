/**
 * token 计量（issue #139 第4项）。
 *
 * 背景：bench 的抽取/生成/判分只累加 provider 返回的 usage；本机实际走的内网中转
 * 部分档位**不返回 usage**（facts-cache 里全是 usage:{prompt:0,completion:0}），
 * 于是 bench-gates 门禁3 只能在缓存档 SKIP（「无可测 token 证据」），预算恒不可测。
 *
 * 契约：
 *  - 真 usage（provider 报了）优先，reported=true；
 *  - provider 没报（缺失或全 0）→ 启发式估算，reported=false，并标注 method；
 *  - 估算只用于「有没有超预算」的量级判断，不冒充计费事实（报告里注明 estimated）。
 *
 * 估算口径 heuristic-v1（保守、确定性）：
 *  - CJK（含中文标点/假名/谚文）每字符 1 token；
 *  - 其余字符每 3.6 字符 1 token（英文常见 ≈1 token/4 字符，取略保守值）；
 *  - 每条消息加 4 token 结构性开销（role/分隔符）。
 */

export const TOKEN_ESTIMATOR_VERSION = "heuristic-v1";

const CJK_RE = /[\u2e80-\u9fff\u3040-\u30ff\uac00-\ud7af\uff00-\uffef\u3000-\u303f]/;

/** 单段文本的 token 估算。空文本 0。 */
export function estimateTokens(text) {
  const s = String(text ?? "");
  if (!s) return 0;
  let cjk = 0;
  for (const ch of s) if (CJK_RE.test(ch)) cjk++;
  const rest = s.length - cjk;
  return cjk + Math.ceil(rest / 3.6);
}

/**
 * 归一化 usage：provider 报了就用，没报（undefined/null/全 0）返回估算值 + estimated 标记。
 * @param {{prompt_tokens?:number, completion_tokens?:number}|null|undefined} usage
 * @param {{promptText?:string, completionText?:string}} [fallback]
 * @returns {{prompt:number, completion:number, reported:boolean, estimated:boolean, method?:string}}
 */
export function normalizeUsage(usage, fallback = {}) {
  const prompt = Number(usage?.prompt_tokens ?? usage?.prompt ?? 0) || 0;
  const completion = Number(usage?.completion_tokens ?? usage?.completion ?? 0) || 0;
  if (prompt > 0 || completion > 0) {
    return { prompt, completion, reported: true, estimated: false };
  }
  const hasFallbackText = Boolean(fallback.promptText || fallback.completionText);
  if (!hasFallbackText) {
    return { prompt: 0, completion: 0, reported: false, estimated: false };
  }
  return {
    prompt: estimateTokens(fallback.promptText),
    completion: estimateTokens(fallback.completionText),
    reported: false,
    estimated: true,
    method: TOKEN_ESTIMATOR_VERSION,
  };
}

/** 把 messages 数组摊平成一段可估算文本（含每条 4 token 的结构开销）。 */
export function messagesToPromptText(messages) {
  const parts = [];
  let overhead = 0;
  for (const m of messages ?? []) {
    parts.push(String(m?.content ?? ""));
    overhead += 4;
  }
  return { text: parts.join("\n"), overhead };
}

/** 估算 messages 的 prompt token（含结构开销）。 */
export function estimateMessagesTokens(messages) {
  const { text, overhead } = messagesToPromptText(messages);
  return estimateTokens(text) + overhead;
}

/** 累加器：把一次 normalizeUsage 结果累进总量（bench 报告统计用）。 */
/**
 * 按消息数组估算 usage（prompt 含每条消息的结构开销）。
 * normalizeUsage 只管「有没有真值」，含结构开销的 prompt 口径在这里——调用方不必再手写补丁。
 */
export function estimateMessagesUsage(messages, completionText) {
  return {
    prompt: estimateMessagesTokens(messages),
    completion: completionText === undefined ? 0 : estimateTokens(completionText),
    reported: false,
    estimated: true,
    method: TOKEN_ESTIMATOR_VERSION,
  };
}

export function addUsage(total, u) {
  if (!total || !u) return total;
  total.prompt += u.prompt ?? 0;
  total.completion += u.completion ?? 0;
  if (u.reported) total.reportedCalls = (total.reportedCalls ?? 0) + 1;
  else if (u.estimated) total.estimatedCalls = (total.estimatedCalls ?? 0) + 1;
  return total;
}

/** 空累加器。 */
export function emptyUsageTotal() {
  return { prompt: 0, completion: 0, reportedCalls: 0, estimatedCalls: 0 };
}
