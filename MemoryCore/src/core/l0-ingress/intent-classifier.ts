import { isClaudeCodeInternalPrompt, isDshRuntimeContextSnapshot } from "./user-query-extractor.js";

/**
 * #83 入口单点定源：对 handler 收到的 messages 数组做一次性分类，
 * 产出 turnIntent（本轮真实用户意图）与逐条 classification，随流传递供
 * 召回选择器与 L0 捕获共用（替代「各自按内容反推」的双提取器漂移）。
 *
 * 分层过滤（第一性原理+过滤兼容，m00047 拍板）：
 *   ①结构信号（'<'-前缀协议标签） ②行首头规则 ③内容级剥噪（共存信息不整条丢）
 *   ④残差兜底（剥后残差为空才判噪声） ⑤大小写/重复语义规则。
 * 枚举：real=真实用户意图 artifact=用户粘贴工件 echo=助手侧内容回流
 *       scaffold=harness 注入物 dup=重复内容 unknown=未分类（宁漏勿杀，保留观测）
 */

export type InboundClassification =
  | "real"
  | "artifact"
  | "echo"
  | "scaffold"
  | "dup"
  | "unknown";

export interface ClassifiedMessage {
  /** 在原始 messages 数组中的下标（非 user 角色的下标被跳过） */
  index: number;
  classification: InboundClassification;
  /** 清洗后的文本；scaffold 恒空串 */
  text: string;
  /** 原始消息文本（未经清洗；#83 L0 全量写入「宁漏勿杀」用） */
  raw: string;
}

export interface TurnContext {
  /** classified 中最后一条 real（turn 起步时=真实提问；mid-turn 步跳过脚手架后仍是它） */
  turnIntent: { index: number; text: string } | null;
  classified: ClassifiedMessage[];
}

/** 已知协议标签：头部协议块整块剥离（变体 P 枚举）；块后残差走正常管线（共存不整条丢，m00047/#83 生产实证），未知标签走内容级剥噪兜底 */
const KNOWN_PROTOCOL_TAGS = new Set([
  "system-reminder", "system_reminder", "current_feeling", "tdai_recalled_wiki",
  "relevant-memories", "relevant_memories", "task-notification", "task_notification",
  "EXTREMELY_IMPORTANT", "acp", "current_task_context", "soul-event", "soul_event",
  "knowledge", "available_skills", "question_answer", "user_info", "additional_data",
  "session", "persisted-output", "persisted_output", "tool_use_error", "tool-use-error",
  "tool_result", "tool-result",
  // P3（2026-10-22 journal 实锚）：<goal_round> 块曾整条判 artifact——harness 注入物非用户粘贴工件
  "goal_round",
]);

/** 行首头规则：整条消息以这些形态开头=注入物（精确短语，防裸 ⚠️ 误杀用户贴的报错） */
const SCAFFOLD_HEAD_PREFIXES = [
  "Current runtime context.",
  "[Compressed conversation section]",
  "The approval policy changed from",
  "Time sampled while preparing",
  "Elapsed since the",
  "Browser time zone for this request",
  "This is an efficiency nudge",
  "⚠️ Context limit",
  "[model changed:",
  // harness 后台通知头（2026-10-21 19:01 生产实锚：子代理失败通知含 CJK 引文，
  // 占比门被引文推过 0.10 → 误判 real 并成为 recall query，qLen=157 hybrid 污染行）
  "Background subagent",
  "Background job",
  "background job",
];

/** L0 重放形态：首行 [user] 后跟换行 */
const REPLAY_RE = /^\s*\[user\]\s*\n/;

/** 行级 drop：legacy 2c 工具回显 + core 剥噪同源的采样行 */
const LINE_DROP_PATTERNS = [
  /^\s*The file .+ has been (updated|created) successfully.*$/i,
  /^\s*File created successfully at:/i,
  /^\s*File .+ has been (updated|created)/i,
  /^\s*\(Bash completed with no output\)\s*$/,
  /^\s{0,6}\d+\t/,
  /^\s*Time sampled while preparing/,
  /^\s*Elapsed since the (preceding|last)/,
  /^\s*Browser time zone for this request/,
  /^\s*\[model changed:/,
];

/** 行首锚定击杀：只杀以这些短语开头的行（保护用户引用 nudge 文本的场景） */
const HEAD_LINE_KILLS = [
  "This is an efficiency nudge",
  "[Compressed conversation section]",
  "⚠️ Context limit",
];

/** generic XML 块（含未知根标签，如用户粘贴的 xml/jsx 工件） */
const XML_BLOCK_RE = /<([a-zA-Z_][a-zA-Z0-9_.-]*)((?:[^<>"']|"[^"]*"|'[^']*')*?)>([\s\S]*?)<\/\1\s*>/g;
/** 块剥离后的残留孤立标签 */
const LONE_TAG_RE = /<\/?[a-zA-Z_][\w.-]*(?:\s[^<>]*)?\/?>/g;
/** <user_query> 显式用户输入块 */
const USER_QUERY_RE = /<user_query>([\s\S]*?)<\/user_query>/gi;
/** frontmatter 元数据块（legacy 2d 同源） */
const FRONTMATTER_RE =
  /(?:^|\n)---\s*\n(?:[a-z_][a-z0-9_]*:\s*.*\n)*?(?:name|description|metadata|node_type|originSessionId):[\s\S]*?\n---\s*(?:\n|$)/gi;

/** CJK 及全角区（全角起始并入 real 信号——fixture 教训） */
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/;
const CJK_RE_G = /[\u3400-\u4dbf\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g;
/**
 * CJK 占比门（#83 golden replay 真实库定案）：小写碎片行（助手摘要误归因）实测占比
 * 0.003–0.036，真人内容实测 ≥0.331（探针消息 0.909 / 排查结论 0.331），9 倍分离带；
 * T=0.10 两侧各留 ~2.8 倍边距。占比 <T 的零星 CJK 不构成 real 信号。
 */
const CJK_RATIO_GATE = 0.1;

function cjkRatio(s: string): number {
  const compact = s.replace(/\s+/g, "");
  return compact.length ? (s.match(CJK_RE_G) || []).length / compact.length : 0;
}

/** 句末问号（规则⑥）：问号后允许尾随引号与空白 */
const QUESTION_TAIL_RE = /[?？][」』"']*\s*$/;

/** 尾行 CJK 信号（规则⑦）：最后一非空行的 CJK 占比 ≥ 门 */
function tailCjkSignal(s: string): boolean {
  const lines = s.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (!t) continue;
    return cjkRatio(t) >= CJK_RATIO_GATE;
  }
  return false;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const p = part as Record<string, unknown>;
          if (typeof p.text === "string") return p.text;
          if (typeof p.content === "string") return p.content;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function lineIndexOf(s: string, needle: string): number {
  if (s.startsWith(needle)) return 0;
  const i = s.indexOf("\n" + needle);
  return i < 0 ? -1 : i + 1;
}

/** 头部已知协议块剥离：连续剥 `<tag …>…</tag>`（含自闭合），返回块后残差。
 *  已知标签无闭合=无法安全取残差 → 返回空串（整条按注入物处理，绝不泄 CJK）。
 *  闭合容差 </+TAG>（P1 修复 2026-10-22：畸形 <//acp> 闭合曾吞掉其后真实提问）。 */
function stripLeadingProtocolBlocks(s: string): string {
  let t = s;
  for (;;) {
    const open = t.match(/^<([a-zA-Z_][a-zA-Z0-9_.-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/);
    if (!open || !KNOWN_PROTOCOL_TAGS.has(open[1])) break;
    if (open[2].trimEnd().endsWith("/")) {
      t = t.slice(open[0].length).replace(/^\s+/, "");
      continue;
    }
    const rest = t.slice(open[0].length);
    const close = rest.match(new RegExp(`</+\\s*${open[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*>`));
    if (!close || close.index === undefined) return "";
    t = rest.slice(close.index + close[0].length).replace(/^\s+/, "");
  }
  return t;
}

/** 内容级剥噪：剥离协议块与工具回显，保留用户键入文本（残差兜底的输入） */
function stripInboundNoise(raw: string): string {
  let s = raw.replace(XML_BLOCK_RE, "").replace(LONE_TAG_RE, "");
  for (const head of HEAD_LINE_KILLS) {
    const i = lineIndexOf(s, head);
    if (i >= 0) s = s.slice(0, i);
  }
  s = s
    .split("\n")
    .filter((line) => !LINE_DROP_PATTERNS.some((re) => re.test(line)))
    .join("\n");
  s = s.replace(FRONTMATTER_RE, "\n");
  s = s
    .split("\n")
    .filter((line) => !line.includes("会话初始化"))
    .join("\n");
  return s.replace(/\n{3,}/g, "\n\n").trim();
}

function classifyOne(
  index: number,
  raw: string,
  seenReal: Set<string>,
  recordRaw?: string,
): ClassifiedMessage {
  // raw 用闭包参（规则①递归剥标签时外层传原始文本）：ClassifiedMessage.raw = 原始消息文本（#83 L0 全量写「宁漏勿杀」）
  const mk = (classification: InboundClassification, text: string): ClassifiedMessage => ({
    index,
    classification,
    text,
    raw: recordRaw ?? raw,
  });
  if (!raw.trim()) return mk("scaffold", "");
  if (isClaudeCodeInternalPrompt(raw)) return mk("scaffold", "");
  if (isDshRuntimeContextSnapshot(raw)) return mk("scaffold", "");

  // <user_query> 显式用户输入块：按契约整块即用户键入（legacy 语义，无大小写规则）
  const uqBlocks = raw.match(USER_QUERY_RE);
  if (uqBlocks && uqBlocks.length > 0) {
    const text = uqBlocks
      .map((b) => b.replace(USER_QUERY_RE, "$1").trim())
      .filter(Boolean)
      .join("\n\n");
    if (!text) return mk("scaffold", "");
    const fp = text.replace(/\s+/g, " ").trim();
    if (seenReal.has(fp)) return mk("dup", text);
    seenReal.add(fp);
    return mk("real", text);
  }

  // ①结构信号：'<'-前缀且根标签在协议枚举内 → 剥头部已知协议块后按残差分类。
  //   #83 生产实证（2026-10-21 L0）：`<acp …>m00458</acp> 不要影子期…` 标签与真实键入
  //   同条消息共存是 DSH 主形态，整条丢弃违反 m00047「消息内共存绝不整条丢」；
  //   残差为空才整条判注入物（防 <current_feeling> 等 CJK 巨块经内容级剥噪泄漏）。
  const trimmed = raw.trim();
  const root = trimmed.match(/^<([a-zA-Z_][a-zA-Z0-9_.-]*)/);
  if (root && KNOWN_PROTOCOL_TAGS.has(root[1])) {
    const residual = stripLeadingProtocolBlocks(trimmed);
    if (!residual) return mk("scaffold", "");
    return classifyOne(index, residual, seenReal, raw);
  }

  // ②行首头规则
  if (SCAFFOLD_HEAD_PREFIXES.some((h) => trimmed.startsWith(h))) return mk("scaffold", "");
  if (REPLAY_RE.test(raw)) return mk("scaffold", "");

  // ③内容级剥噪 → ④残差兜底
  const cleaned = stripInboundNoise(raw);
  if (!cleaned) {
    // 残差为空但存在未知根标签：用户粘贴的纯工件（xml/jsx），保留不丢失、不作意图
    if (root) return mk("artifact", trimmed);
    return mk("scaffold", "");
  }

  // ⑤语义规则：CJK 含判 + 占比门（#83）。占比 <T 的零星 CJK = 误归因碎片特征
  // （真实库实测 0.003–0.036），不判 real；大写开头+零星 CJK 同理落 unknown（观测不作意图）。
  if (CJK_RE.test(cleaned) && cjkRatio(cleaned) >= CJK_RATIO_GATE) {
    const fp = cleaned.replace(/\s+/g, " ").trim();
    if (seenReal.has(fp)) return mk("dup", cleaned);
    seenReal.add(fp);
    return mk("real", cleaned);
  }
  // ⑥ 小写英文问句 → real（P2，2026-10-22 journal 实锚误杀「do you remember…pipeline?」）：
  //    小写开头 + 句末问号 + 长度≥10 是键入问句强信号；助手碎片为句中截断，句末问号罕见。
  //    用户拍板（m00576）不设影子期，直接完整实现。
  if (/^[a-z]/.test(cleaned) && cleaned.length >= 10 && QUESTION_TAIL_RE.test(cleaned)) {
    const fp = cleaned.replace(/\s+/g, " ").trim();
    if (seenReal.has(fp)) return mk("dup", cleaned);
    seenReal.add(fp);
    return mk("real", cleaned);
  }
  // ⑦ 尾行 CJK 信号 → real（M3 标定盲区，审查 4544dc9d）：整条占比 <门 但最后一非空行
  //    占比 ≥门 —— 长英文日志/代码粘贴 + 短中文提问的典型形态；碎片尾行罕为 CJK 高占比。
  if (CJK_RE.test(cleaned) && tailCjkSignal(cleaned)) {
    const fp = cleaned.replace(/\s+/g, " ").trim();
    if (seenReal.has(fp)) return mk("dup", cleaned);
    seenReal.add(fp);
    return mk("real", cleaned);
  }
  if (/^[a-z]/.test(cleaned)) return mk("echo", cleaned);
  return mk("unknown", cleaned);
}

/**
 * 入口单点分类：对 messages 数组一次性产出 turnIntent 与逐条分类。
 * 仅处理 role==="user" 的消息；其余角色按原数组下标跳过。
 */
export function classifyInbound(messages: unknown[]): TurnContext {
  const classified: ClassifiedMessage[] = [];
  const seenReal = new Set<string>();
  let turnIntent: { index: number; text: string } | null = null;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i] as { role?: unknown; content?: unknown } | null;
    if (!msg || msg.role !== "user") continue;
    const raw = contentText(msg.content);
    const entry = classifyOne(i, raw, seenReal);
    classified.push(entry);
    if (entry.classification === "real") {
      turnIntent = { index: i, text: entry.text };
    }
  }
  return { turnIntent, classified };
}
