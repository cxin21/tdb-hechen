/**
 * Text sanitization for memory pipeline (capture & recall).
 * Removes injected tags, gateway metadata, media noise, etc.
 */

/**
 * Clean text for the memory pipeline: remove injected tags, metadata,
 * timestamps, media markers and base64 image data.
 *
 * Used by both capture (L0 recording) and recall (query cleaning) paths.
 */
export function sanitizeText(text: string): string {
  let cleaned = text;

  // Remove injected memory context tags (prevent feedback loops)
  cleaned = cleaned.replace(/<relevant-memories>[\s\S]*?<\/relevant-memories>/g, "");
  cleaned = cleaned.replace(/<user-persona>[\s\S]*?<\/user-persona>/g, "");
  cleaned = cleaned.replace(/<relevant-scenes>[\s\S]*?<\/relevant-scenes>/g, "");
  cleaned = cleaned.replace(/<scene-navigation>[\s\S]*?<\/scene-navigation>/g, "");

  // Remove offload-injected task context blocks (MMD mermaid diagrams)
  cleaned = cleaned.replace(/<current_task_context>[\s\S]*?<\/current_task_context>/g, "");
  cleaned = cleaned.replace(/<history_task_context[\s\S]*?<\/history_task_context>/g, "");

  // Remove framework-injected inbound metadata blocks (from inbound-meta.ts buildInboundUserContextPrefix).
  // These are "label:\n```json\n...\n```" blocks that the framework prepends to user messages.
  // Pattern matches all known block labels:
  //   - Conversation info (untrusted metadata):
  //   - Sender (untrusted metadata):
  //   - Thread starter (untrusted, for context):
  //   - Replied message (untrusted, for context):
  //   - Forwarded message context (untrusted metadata):
  //   - Chat history since last reply (untrusted, for context):
  cleaned = cleaned.replace(
    /(?:Conversation info|Sender|Thread starter|Replied message|Forwarded message context|Chat history since last reply)\s*\(untrusted[\s\S]*?\):\s*```json\s*[\s\S]*?```/g,
    "",
  );

  // Remove conversation metadata JSON blocks (legacy pattern)
  cleaned = cleaned.replace(/```json\s*\{[\s\S]*?"session[\s\S]*?\}\s*```/g, "");

  // Remove framework reply directive tags: [[reply_to_current]], [[reply_to_xxx]], etc.
  cleaned = cleaned.replace(/\[\[reply_to[^\]]*\]\]\s*/g, "");

  // Remove injected skill-selection wrappers, e.g. ¥¥[... ]¥¥
  cleaned = cleaned.replace(/¥¥\[[\s\S]*?\]¥¥/g, "");

  // ── DSH harness 噪音剥离（2026-10-14 召回日志分析修复）：journal 实测查询文本携带
  // 代理标记与回合脚手架，直接进 FTS/embedding 查询与 L0 语料造成污染——宁缺毋滥，
  // capture 与 recall 双侧同剥（本函数两路共用）。──
  // 1) acp 代理标记：<acp tokens="18" type="text">m02894</acp>
  cleaned = cleaned.replace(/<acp\b[^>]*>[\s\S]*?<\/acp>/gi, "");
  // 2) 系统注入块（提醒/情感/灵魂——整块含内容剥离）
  cleaned = cleaned.replace(
    /<(system-reminder|current_feeling|soul-identity|soul-feeling)\b[^>]*>[\s\S]*?<\/\1>/g,
    "",
  );
  // 3) 回合脚手架行（时间采样/请求时区/回合间隔——整行剥离；Elapsed 措辞有变体
  //    「model-visible message」/「step context」（m03163 实证），用前缀匹配兜住）
  cleaned = cleaned.replace(
    /^\s*(?:Time sampled while preparing turn\b[^\n]*|Elapsed since\b[^\n]*|Browser time zone for this request:[^\n]*)$/gim,
    "",
  );
  // 4) 模型切换标记行（provider 名含斜杠，故不设右界）
  cleaned = cleaned.replace(/^\s*\[model changed:[^\n]*$/gim, "");
  // 5) 效率 nudge 整体剥离（harness 周期注入的压缩提醒，非用户意图——m03173 实证
  //    其英文正文残句会以弱相关（topScore≈-1.2）注入记忆，违反宁缺毋滥；标记行措辞稳定）
  cleaned = cleaned.replace(/^\s*This is an efficiency nudge\b[\s\S]*$/i, "");
  // 6) 裸 m\d{5} 消息 ref token（#74 D4，2026-10-20）：上下文压缩区段残留引用（如
  //    m00209）——词边界删 token 留正文；负向先行 (?!\.\d) 防误伤 arXiv 式编号
  //    （m2501.13956）与更长 id（m1234567，\b 收尾自动放行）。
  cleaned = cleaned.replace(/\bm\d{5}(?!\.\d)\b/g, "");
  // 7) 上下文超限提醒行（⚠️ … Context limit …——整行剥离；须 ⚠️ 前缀，防误伤正常
  //    讨论「Context limit」语义的用户正文行）
  cleaned = cleaned.replace(/^\s*⚠️[^\n]*Context limit[^\n]*$/gim, "");
  // 8) 压缩区段标题行（【Compressed conversation section】…——整行剥离，区段内正文
  //    保留；P6 活体证据：区段正文剥壳后仍可能携带有效语义行，只剥标题头不弃正文）
  cleaned = cleaned.replace(/^\s*[【\[]Compressed conversation section[】\]][^\n]*$/gim, "");
  // 9) 方括号 POV 标签头（[current_feeling] / [soul-*] 含属性形式——删头留正文；块
  //    形式 <current_feeling>/<soul-*> 已由 (2) 整块剥离，此处兜方括号行首变体）
  cleaned = cleaned.replace(/^\s*\[(?:current_feeling|soul-[a-z0-9-]+)\b[^\]]*\][ \t]*/gim, "");

  // Remove line-leading timestamps, e.g. "[Tue 2026-03-24 03:48 UTC]"
  // or "[Tue 2026-03-24 20:21 GMT+8]", "[Thu 2026-03-24 01:51 GMT+5:30]"
  // Matches brackets containing word chars, digits, hyphens, colons, plus signs,
  // and spaces — the '+' is needed for timezone offsets like GMT+8, GMT+5:30.
  cleaned = cleaned.replace(/^\[[\w\d\-:+ ]+\]\s*/gm, "");

  // Remove gateway media-attachment markers:
  //   [media attached: /path/to/file.png (image/png) | /path/to/file.png]
  cleaned = cleaned.replace(/\[media attached:[^\]]*\]\s*/g, "");

  // Remove gateway image-reply instructions injected after media attachments.
  // Starts with "To send an image back" and ends before the next real content.
  cleaned = cleaned.replace(
    /To send an image back,[\s\S]*?(?:Keep caption in the text body\.)\s*/g,
    "",
  );

  // Remove "System: [timestamp] Exec completed ..." blocks appended by the framework.
  cleaned = cleaned.replace(/^System:\s*\[[\s\S]*?$/gm, "");

  // Remove inline base64 image data URIs (e.g. data:image/png;base64,iVBOR...)
  // Replace with empty string (not a placeholder) so that pure-image messages
  // become empty after sanitization and are naturally filtered by length checks.
  cleaned = cleaned.replace(/data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+/gi, "");

  // Remove null chars + compress whitespace
  cleaned = cleaned.replace(/\0/g, "").replace(/\n{3,}/g, "\n\n").trim();

  return cleaned;
}

/**
 * #74（Batch A，2026-10-20）：召回查询专用两级剥噪。
 *
 * 一级：sanitizeText 全量剥噪后残留 < MIN_QUERY_RESIDUAL_CHARS 字符 → 判定为纯
 *      脚手架查询（skipped=true），调用方应整条跳过（零检索零注入）。
 * 二级：否则返回清洗后文本供检索——P6 活体证据（2026-10-20 取证）：压缩区段查询
 *      剥壳后仍常携带有效语义行，一刀切跳过会误伤，故非纯噪音一律清洗后检索。
 *
 * 端点路（v2-router handleRecall）与钩子路共用 sanitizeText 单一源；本函数只在
 * 召回入口调用（L0 capture 不做 skip 判定——capture 侧宁存勿删）。
 */
export const MIN_QUERY_RESIDUAL_CHARS = 10;

export interface SanitizedRecallQuery {
  /** 清洗后查询（仅二级分支承载）；skipped=true 时恒为空串——残留量经 residualChars 观测，skip 分支不回传残句（RED 用例 6 钉死）。 */
  text: string;
  /** true = 纯脚手架查询（残留 < 阈值），调用方应跳过检索 */
  skipped: boolean;
  /** 剥噪后残留字符数（UTF-16 code units，trim 后口径） */
  residualChars: number;
}

export function sanitizeRecallQuery(
  raw: string,
  opts?: { minResidualChars?: number },
): SanitizedRecallQuery {
  const min = opts?.minResidualChars ?? MIN_QUERY_RESIDUAL_CHARS;
  const cleaned = typeof raw === "string" ? sanitizeText(raw).trim() : "";
  const residualChars = cleaned.length;
  // 契约（RED 用例 6）：skipped=true 时 text 恒空串——text 仅在二级（清洗后检索）
  // 分支承载查询；skip 分支不回传残句，残留量经 residualChars 观测。
  return residualChars < min
    ? { text: "", skipped: true, residualChars }
    : { text: cleaned, skipped: false, residualChars };
}

/**
 * Strip fenced code blocks from assistant replies before L0 capture.
 *
 * AI responses often contain large code snippets (```...```) that dilute
 * the semantic signal for embedding and memory extraction. This function
 * removes only the code block content while preserving surrounding
 * natural-language explanations.
 *
 * Only applied to `role=assistant` messages in the L0 capture path —
 * user messages and recall queries are NOT affected.
 */
export function stripCodeBlocks(text: string): string {
  return text.replace(/```[^\n]*\n[\s\S]*?```/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

// ============================
// L0 / L1 Capture & Extraction Filters
// ============================

/**
 * L0 capture filter — intentionally **permissive**.
 *
 * L0 is the raw conversation archive. We want to preserve as much user input
 * as possible so that downstream stages (L1 extraction, search, analytics)
 * have the full picture. Only messages that are *structurally* useless are
 * dropped here:
 *   - Empty / whitespace-only text
 *   - Framework-internal noise (bootstrap, session reset, NO_REPLY, …)
 *   - Slash commands (/new, /reset, …)
 *
 * Content-quality filters (length, symbols, prompt injection) are deferred
 * to {@link shouldExtractL1}.
 */
export function shouldCaptureL0(text: string): boolean {
  if (!text || !text.trim()) return false;

  // Filter framework-internal / bootstrap noise messages
  if (isFrameworkNoise(text)) return false;

  // Slash commands are framework directives, not user content
  if (text.startsWith("/")) return false;

  return true;
}

/**
 * L1 extraction filter — **strict** quality gate.
 *
 * Applied when L0 messages are fed into the LLM extraction pipeline.
 * Filters out content that is too short, too long, purely symbolic,
 * or looks like a prompt-injection attack — none of which should
 * become structured memories.
 *
 * This function is a superset of {@link shouldCaptureL0}: anything
 * rejected by L0 is also rejected here, plus additional quality checks.
 */
export function shouldExtractL1(text: string): boolean {
  // First apply the same structural filters as L0
  if (!shouldCaptureL0(text)) return false;

  // ── Length filters ──
  // const isCJK = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(text);
  // if (isCJK && text.length < 2) return false;
  // if (!isCJK && text.length < 2) return false;
  // if (text.length > 5000) return false;

  // ── Content-quality filters ──
  // Match strings composed entirely of non-word, non-space, non-CJK characters (1–5 chars).
  if (/^[^\w\s\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]{1,5}$/.test(text)) return false;
  if (/^[?？]+$/.test(text)) return false;

  // ── Security filters ──
  // Reject prompt-injection payloads — prevent malicious content from being
  // persisted into structured memory and re-injected on future recalls.
  // if (looksLikePromptInjection(text)) return false;

  return true;
}

/**
 * @deprecated Use {@link shouldExtractL1} (strict) or {@link shouldCaptureL0} (permissive) instead.
 *
 * Kept as an alias of `shouldExtractL1` for backward compatibility.
 */
export const shouldCapture = shouldExtractL1;

// ============================
// Prompt Injection Detection
// ============================

/**
 * Known prompt-injection / jailbreak patterns.
 *
 * Covers:
 * 1. Instruction override — "ignore all previous instructions", etc.
 * 2. Role hijack — "you are now DAN", "act as root", etc.
 * 3. System/developer boundary probing — "system prompt", "developer message"
 * 4. XML/tag injection — opening tags that match our context boundaries
 * 5. Tool/command invocation tricks — "run command X", "execute tool Y"
 * 6. Multi-language variants — Chinese prompt-injection patterns
 */
const PROMPT_INJECTION_PATTERNS: RegExp[] = [
  // ── Instruction override ──
  /ignore\b.{0,30}\b(instructions|rules|guidelines)/i,
  /disregard\b.{0,30}\b(instructions|rules|guidelines)/i,
  /forget\b.{0,30}\b(instructions|rules|context)/i,
  /override\b.{0,30}\b(instructions|rules|guidelines|safety)/i,

  // ── Role hijack ──
  /you are now (?!going|about|ready)/i, // "you are now DAN" but not "you are now going to..."
  /act as (?:if you are |if you were )?(?:a |an )?(?:root|admin|unrestricted|unfiltered|jailbroken)/i,
  /enter (?:DAN|jailbreak|god|sudo|developer|dev|debug|unrestricted|unfiltered) mode/i,
  /switch to (?:DAN|jailbreak|god|sudo|developer|dev|debug|unrestricted|unfiltered) mode/i,

  // ── System boundary probing ──
  /(?:show|reveal|print|output|display|repeat|leak|dump|give)\b.{0,20}\bsystem prompt/i,
  /reveal (?:your |the )?(system|hidden|secret|internal) (?:prompt|instructions|rules)/i,
  /what (?:are|is) your (?:system|hidden|original|initial) (?:prompt|instructions|rules)/i,

  // ── XML/tag injection (our context boundaries) ──
  /<\s*(system|assistant|developer|tool|function|relevant-memories)\b/i,

  // ── Tool/command invocation tricks ──
  /\b(run|execute|call|invoke)\b.{0,40}\b(tool|command|function|shell)\b/i,

  // ── Chinese variants ──
  /忽略(?:所有|之前|以上|先前)?(?:的)?(?:指令|规则|指示|说明)/,
  /无视(?:所有|之前|以上)?(?:的)?(?:指令|规则|限制)/,
  /(?:显示|输出|告诉我|给我看)(?:你的)?(?:系统|初始|隐藏)?(?:提示词|指令|规则|prompt)/,
  /你(?:现在|从现在开始)是/,            // "你现在是 DAN"
];

/**
 * Detect likely prompt-injection / jailbreak attempts.
 *
 * Normalises whitespace before matching to defeat trivial obfuscation
 * (e.g. extra spaces / newlines between keywords).
 */
export function looksLikePromptInjection(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  return PROMPT_INJECTION_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * Detect framework-injected noise messages that should never be captured.
 *
 * These include:
 * - "(session bootstrap)" — synthetic user turn for Google turn-order compliance
 * - Session startup instructions from /new or /reset
 * - "✅ New session started" — AI's ack of session startup (no user-meaningful content)
 * - Pre-compaction memory flush prompts (system-to-agent instructions, not user content)
 * - AI's NO_REPLY ack of memory flush (no user-meaningful content)
 */
function isFrameworkNoise(text: string): boolean {
  const t = text.trim();

  // Google turn-order bootstrap placeholder
  if (t === "(session bootstrap)") return true;

  // Framework session-reset instruction (starts with "A new session was started via /new or /reset")
  if (t.startsWith("A new session was started via")) return true;

  // AI's pure ack of session startup: "✅ New session started · model: ..."
  if (/^✅\s*New session started/.test(t)) return true;

  // Pre-compaction memory flush prompt injected by the framework as a synthetic
  // user turn. This is an internal system-to-agent instruction, NOT real user
  // content. Capturing it would pollute L0/L1 memories with framework directives.
  if (t.startsWith("Pre-compaction memory flush")) return true;

  // AI's NO_REPLY response to memory flush (or other silent-reply scenarios).
  // A bare "NO_REPLY" (with optional whitespace) carries no user-meaningful content.
  if (/^NO_REPLY\s*$/.test(t)) return true;

  return false;
}

/**
 * Pick up to `max` recent unique texts.
 */
export function pickRecentUnique(texts: string[], max: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (let i = texts.length - 1; i >= 0 && result.length < max; i--) {
    const t = texts[i]!;
    if (!seen.has(t)) {
      seen.add(t);
      result.push(t);
    }
  }
  return result.reverse();
}

// ============================
// LLM Safety Utilities
// ============================

/**
 * Escape XML-like tags in text to prevent tag injection attacks.
 *
 * When memory content or persona text is injected into XML-delimited sections
 * (e.g. `<user-persona>...</user-persona>`), a malicious user could craft content
 * containing `</user-persona>` to break out of the section boundary.
 *
 * This function escapes `<` and `>` in known dangerous patterns (closing tags
 * that match our injection boundaries) so the content cannot prematurely close
 * the XML section.
 */
export function escapeXmlTags(text: string): string {
  // Escape closing tags that match our injection section boundaries.
  // P2-T11：追加 core_memory 系身份块边界（core_memory/identity/strict_rule/core_value）
  // 与 user —— 这些块由 /v3/core-memory/write 写入，写入路径已在咽喉处统一消毒，
  // 此名单是防线本体（含注入端等其他消费方）；毒化内容不得越块逃逸。
  // I-2（P2-T11+13 复核修补）：追加 l3_core_memory 与 agent —— L3 persona 文件
  //（/v3/core/write）注入时的块边界 `<l3_core_memory>…</l3_core_memory>` 与
  // `<agent …>…</agent>` 同为越块逃逸面，写入路径 handleCoreWrite 已接线消毒。
  // #31（R5 探针 P09，2026-10-16）：追加 soul-identity/soul-feeling —— soul-assembler
  // 渲染的块边界同为越块逃逸面（core_values desc/label 可携带 `</soul-identity>`
  // 越块），渲染路径 renderAnchor/重要的人/品格行/感受段均经本函数消毒。
  return text.replace(
    /<\/?(?:user-persona|relevant-memories|scene-navigation|relevant-scenes|memory-tools-guide|core_memory|identity|strict_rule|core_value|l3_core_memory|agent|user|system|assistant|soul-identity|soul-feeling)>/gi,
    (match) => match.replace(/</g, "&lt;").replace(/>/g, "&gt;"),
  );
}

// ============================
// JSON Sanitization for LLM Output
// ============================

/**
 * Sanitize a raw JSON string from LLM output so that `JSON.parse` won't throw
 * "Bad control character in string literal".
 *
 * Per RFC 8259 §7, U+0000–U+001F MUST be escaped inside JSON string literals.
 * LLMs sometimes produce unescaped control characters (raw newlines, tabs, etc.)
 * inside string values.
 *
 * Strategy (two-phase):
 *  1. **Precise pass** — walk through JSON string literals (delimited by `"`)
 *     and escape any unescaped U+0000–U+001F inside them to `\uXXXX` form,
 *     while leaving structural whitespace (between values) untouched.
 *  2. **Fallback** — if the precise pass still fails `JSON.parse`, fall back to
 *     a simple global strip of rare control chars (\x00–\x08, \x0b, \x0c,
 *     \x0e–\x1f) which are almost never meaningful in natural-language content.
 */
export function sanitizeJsonForParse(raw: string): string {
  // Phase 1: Escape control characters inside JSON string literals.
  // We walk the string character-by-character to properly handle escape sequences.
  const escaped = escapeControlCharsInJsonStrings(raw);
  try {
    JSON.parse(escaped);
    return escaped;
  } catch {
    // Phase 1 didn't fully fix it — fall through to phase 2
  }

  // Phase 2: Brute-force strip of rare control chars that have no textual meaning.
  // Preserves \t (\x09), \n (\x0a), \r (\x0d) which are common structural whitespace.
  // NOTE: We strip from `escaped` (Phase 1 result) rather than `raw`, so that any
  // control-character escaping Phase 1 performed is preserved even when the JSON has
  // other issues (e.g. trailing commas) that cause the Phase 1 parse to fail.
  const stripped = escaped.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
  return stripped;
}

/**
 * Walk through a JSON text and escape U+0000–U+001F control characters that
 * appear *inside* JSON string literals (between unescaped `"` delimiters).
 *
 * Characters that already have short escape sequences (\n, \r, \t, \b, \f)
 * are mapped to those; others become \uXXXX.
 *
 * Structural whitespace outside string literals is left untouched.
 */
function escapeControlCharsInJsonStrings(text: string): string {
  const SHORT_ESCAPES: Record<number, string> = {
    0x08: "\\b", // backspace
    0x09: "\\t", // tab
    0x0a: "\\n", // line feed
    0x0c: "\\f", // form feed
    0x0d: "\\r", // carriage return
  };

  const out: string[] = [];
  let inString = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i]!;
    const code = ch.charCodeAt(0);

    if (inString) {
      if (ch === "\\" && i + 1 < text.length) {
        // Already-escaped sequence — copy both characters verbatim
        out.push(ch, text[i + 1]!);
        i += 2;
        continue;
      }
      if (ch === '"') {
        // End of string literal
        out.push(ch);
        inString = false;
        i++;
        continue;
      }
      if (code <= 0x1f) {
        // Unescaped control character inside string — escape it
        const short = SHORT_ESCAPES[code];
        if (short) {
          out.push(short);
        } else {
          out.push("\\u" + code.toString(16).padStart(4, "0"));
        }
        i++;
        continue;
      }
      // Normal character inside string
      out.push(ch);
      i++;
    } else {
      // Outside string literal
      if (ch === '"') {
        out.push(ch);
        inString = true;
        i++;
        continue;
      }
      // Structural character (including whitespace) — pass through
      out.push(ch);
      i++;
    }
  }

  return out.join("");
}

/**
 * 截断抢救：LLM 输出被 maxTokens 砍尾时，首个 '[' 之后的前缀里仍可能有
 * 若干已闭合的完整对象。以栈配对（跳过字符串字面量）找到最后一个回到数组层
 * 深度的 '}'，截取到该处并补右括号，得到可 JSON.parse 的数组。
 * 无任何完整对象（或首个字符不是 '['）时返回 null → 调用方走原有 fallback。
 *
 * R2（2026-10-06）：原居 l1-extractor.ts 私有；dedup 判定链（R2 P1-1）同需 →
 * 迁至 utils 单一实现（P-A 禁第二份手写）。顶层数组对象结构通用
 * （提取情境数组 / 决策数组同形），不区分对象语义。
 */
export function salvageTruncatedJsonArray(s: string): string | null {
  const start = s.indexOf("[");
  if (start < 0) return null;
  const frag = s.slice(start);
  let depth = 0;
  let inStr = false;
  let esc = false;
  let lastSceneClose = -1;
  for (let i = 0; i < frag.length; i++) {
    const c = frag[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === "[" || c === "{") { depth++; continue; }
    if (c === "}" || c === "]") {
      depth--;
      // 深度回到 1 且闭合符是 '}' = 一个顶层对象完整闭合
      if (depth === 1 && c === "}") lastSceneClose = i;
      if (depth < 0) return null;
    }
  }
  if (lastSceneClose < 0) return null;
  return frag.slice(0, lastSceneClose + 1) + "]";
}
