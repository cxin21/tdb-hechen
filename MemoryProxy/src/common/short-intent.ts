/**
 * #88 · 短消息三分判据（纯函数，无 IO）——2026-10-22 定案（#88 票面参数终表）。
 *
 * 三不变量之短消息本体：一条消息是否需要独立召回 = 双维
 * （是否改变记忆需求 × 是否有检索区分度）；长度只是弱代理
 * （「继续」不改需求，但「换北京」3 字高区分度）。
 *
 * S1 延续/确认类：词表命中 → "continuation"——不独立召回，意图=last-known（去重闸
 *    裁决新鲜度）；无 last-known → 记 intent-missing + INTENT-MISSING 哨兵，零 POST。
 * S2 可检索短新意图：非词表且（实义残差 ≥ T_real=2 或含 ASCII/数字实体）→ "retrievable"
 *    ——正常 hybrid 召回（结果侧 R71 双门 bm25 预地板 + rerank 语义门兜底噪声）。
 * S3 纯指令短消息：实义残差 < 2 且无 ASCII/数字实体 → "command"——不召回（检索区分度
 *    ≈0=纯噪声）；做 last-known 焦点切换（清除）+ 记 short-command + 哨兵。
 *
 * 判序从严（S1 词表 → S3 纯指令 → 默认放行 S2）、默认放行、不全拦（宁漏勿杀）。
 */

/** S1 延续/确认词表（归一化后精确匹配；初版内置，生产 L0 短消息 top 频次校准待观察窗反馈）。 */
export const CONTINUATION_WORDS: ReadonlySet<string> = new Set([
  "继续", "好的", "好", "嗯", "好嘞", "好哒", "行", "可以", "对", "是",
  "收到", "明白", "没问题", "就这样", "同上", "next", "go", "ok",
]);

/** 尾部标点（半角 + 全角；归一化时逐字剥除直到非标点）。 */
const TRAILING_PUNCT_RE = /[!?,.;:'"~`)\]}>+*|，。！？；：、）】」』…—·]+$/u;

/**
 * 归一化：全角 ASCII 区转半角 + 小写 + 去首尾空白与尾标点 + 叠字折叠（相邻同字折叠为一）。
 * 「嗯嗯→嗯」落进词表；跨字词（如「可以」）不受影响。
 */
export function normalizeIntentText(text: string): string {
  // 全角（\uFF01-\uFF5E）→ 半角（平移 0xFEE0）
  let s = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) as number;
    s += code >= 0xff01 && code <= 0xff5e ? String.fromCharCode(code - 0xfee0) : ch;
  }
  s = s.toLowerCase().trim();
  while (s.length > 0 && TRAILING_PUNCT_RE.test(s)) {
    s = s.replace(TRAILING_PUNCT_RE, "").trimEnd();
  }
  // 叠字折叠：相邻同字折叠为一
  let out = "";
  let prev = "";
  for (const ch of s) {
    if (ch !== prev) out += ch;
    prev = ch;
  }
  return out;
}

export type ShortIntentKind = "continuation" | "retrievable" | "command";

/** 实义残差：去掉空白/标点/符号后的字符数（定案 T_real=2 的分母）。 */
function residualCharsOf(normalized: string): number {
  return normalized.replace(/[\s\p{P}\p{S}]/gu, "").length;
}

/** 实义残差（导出仅供记账/日志观测；入参必须已归一化）。 */
export function residualChars(normalized: string): number {
  return residualCharsOf(normalized);
}

/**
 * 三分判据（入参必须已归一化；判序从严）：
 *   S1 词表命中 → "continuation"；
 *   S3 残差 < 2 且无 ASCII/数字实体 → "command"（含空串/纯标点）；
 *   其余 → "retrievable"（含单 ASCII 字符——按定案字面归 S2，宁召回勿杀，
 *   噪声由结果侧双门兜底）。
 */
export function classifyShortIntent(normalized: string): ShortIntentKind {
  if (normalized.length > 0 && CONTINUATION_WORDS.has(normalized)) return "continuation";
  const residual = residualCharsOf(normalized);
  const hasAsciiEntity = /[a-z0-9]/.test(normalized);
  if (residual < 2 && !hasAsciiEntity) return "command";
  return "retrievable";
}
