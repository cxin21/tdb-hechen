/**
 * 注入块服务端守卫（D-8，2026-10-31）
 *
 * 缺陷（docs/ops/fullstack-test-capture-isolation.md §4）：
 * 探针矩阵把整段 `【agemem 记忆提示】…` 当作 ordinary user 消息 POST 到
 * /v3/conversation/add，服务端 200 收下并落进 L0 —— 于是「检索注入」被记成
 * 「用户说过的话」，之后每次召回都会把它当真实输入再喂回模型（自我中毒，
 * 一轮比一轮更像用户原话）。
 *
 * 修法取向：core 侧做**窄识别 + 三档处置**，不改契约、不动 schema（generated
 * 是 Kubb 生成禁手改）：
 *
 *   识别（窄，两条独立证据）
 *     ① 前缀标记：文本**行首**命中已登记标记表（下面 INJECTED_BLOCK_MARKERS，
 *        与 dsh-plugin/src/writeback.ts 的清单同源）。行首限定是关键——用户
 *        在句子里引用一句标记不该被判注入（会丢真实发言）。
 *     ② plugin 声明：请求头 x-tdai-source-kind 以 `plugin:` 开头（TDB 系客户端
 *        的自我声明，见 dsh-plugin 的 VOLATILE_SOURCE_KIND）。
 *
 *   处置（mode）
 *     allow  —— 现状：照收（调试/回溯用）
 *     skip   —— 默认：丢掉命中的消息，其余照常落库，响应 200 + skipped 计数
 *     reject —— 仅当 ① 与 ② 同时成立才 400（code=INJECTED_BLOCK）：既声明是插件
 *               又带插件头 = 100% 是自注，硬失败能让写侧立刻暴露问题；缺任一
 *               证据时降级为 skip，避免误伤真实用户文本。
 *
 * 为什么缺省是 skip 而不是 reject：
 *   · reject 会连带丢掉**同一批里的真实用户消息**（一次 POST 最多 100 条），
 *     把「自注污染」升级成「用户数据丢失」，代价远大于多一次静默；
 *   · 注入块本身对 L1 无用（它不是人说的话），但它也不是错误——静默丢弃 +
 *     journal 记一次即可（H-15 语义：降级可见，不 fail-fast）。
 *   · skip 保留了「真实数据优先」原则：宁可少存一条注入，不可丢一条发言。
 *
 * 误伤面：用户逐字引用 `【agemem 记忆提示】` 作为行首。已登记标记都是本系统
 * 专属文案，现实中不会自然出现；即便出现，代价是丢一条消息（skip）而非整批失败
 * （reject），且日志带 marker 可追溯。
 *
 * task-85（2026-11-01）硬化：归一化后再判，且判定范围收紧
 * ---------------------------------------------------------------------------
 * 红队实测的绕过：「一句前缀 + 换行 + **缩进**标记」整段落库
 * （accepted:1、无 skipped、markerStored=true）—— 旧实现只认严格行首，
 * 行首多一个空格/制表符、或 `\r\n` 换行、或标记在第 4 行之后就完全不认。
 *
 * 归一化（normalizeInjectionLines）：`\r\n`/`\r` → `\n`，逐行 trimStart，
 * 去掉整段前导空行（空行保留位置，只影响「第几个非空行」的计数）。
 *
 * 判定范围收紧（为什么不是「全文任一行命中就判注入」）：
 *   · 用户会把我们的块**贴出来讨论**（历史上已误杀过一次真实提问：「我把
 *     【agemem 记忆提示】这段贴给你看，是不是有问题？」）。归一化把缩进/换行
 *     归一后，这种引用在正文里到处都是，全文 contains 判定必然误杀。
 *   · 故只认两条窄路径：
 *       ① 命中行必须是该消息**前 3 个非空行**之一 —— 注入块永远在消息开头
 *          （插件把 volatile 块作为独立消息的首行发出），正文中段的引用不会
 *          落在前三行；
 *       ② 或命中段占该消息**非空白字符 ≥30%** —— 覆盖「两行前缀 + 整块注入」
 *          这种把块埋在第 3 行之后、但块本身就是消息主体的情形。
 *   · 反例（必须仍放行）：长正文中引用了标记、且引用占比 < 30% 且不在前三
 *     非空行 —— 见 `__tests__/injection-guard.test.ts` 的 negative 用例。
 *   · 残余误伤面：用户在消息中段复制整段注入块（≥30% 字符）会被判注入。这是
 *     刻意取舍：那种消息对 L1 无信息价值，而放过它会重新引入自我中毒。
 *
 * task-92（2026-11-01）Cf 类补漏 + 一条「已知不处理」
 * ---------------------------------------------------------------------------
 * 行首归一化补 Unicode Cf（格式）字符：`LEADING_INVISIBLE_CHARS_RE`（见 :96-116）。
 * 原实现只剥 `[\s\u00a0\u3000]`，而 U+200B/200C/200D/200E/200F/2060 都**不在
 * ECMAScript \s 内** ⇒ 行首塞一个零宽空格即可绕过识别（panel-misc W4 实测
 * accepted:1）。BOM U+FEFF 恰被 \s 覆盖，历史上「BOM 已封」的结论掩盖了 Cf 缺口。
 *
 * 已知不处理（**有意**，非待办）：Cf 只剥**行首**，标记内部不归一化。
 * 即 `<soul\u200b-identity>` 这类「把标记本身拆开」的写法不认。理由：
 *   · 拆开后的串已经不是我们的注入块，也就不构成自我中毒回路；
 *   · 要认它，就得再引一层「只对已知整块形态生效」的上下文判据，而代价是把
 *     「用户真在讨论这个字符串」判成注入（task-92 的负例正是在守这条线）；
 *   · 收益不抵复杂度。Lead 2026-11-01 裁决为终局。
 */

/** 处置档位。缺省 skip，可用环境变量或 config 覆盖。 */
export type InjectionGuardMode = "reject" | "skip" | "allow";

/**
 * 已登记的注入块标记（归一化后的行首匹配）。新增注入器时必须同步这里 + 插件侧清单
 * （dsh-plugin/src/writeback.ts 的 INJECTION_TEXT_MARKERS）。
 *
 * task-85：补齐插件会发的三种块（此前 core 侧漏登记 ⇒ 服务端第二层对它们形同虚设）。
 */
export const INJECTED_BLOCK_MARKERS: readonly string[] = [
  "【agemem 记忆提示】",
  "【币值判定规则",
  "【建议类问题口径",
  "<soul-identity>",
  "<soul-feeling>",
  "<relevant-memories>",
  "<team-wiki>",
  "<available_skills>",
  "<core_memory>",
];

/** 判定范围：命中行必须落在消息前 N 个非空行内（注入块永远在开头）。 */
export const LEADING_NON_EMPTY_LINE_LIMIT = 3;

/** 判定范围（兜底路径）：命中段占消息非空白字符的比例下限。 */
export const MIN_MATCHED_SEGMENT_RATIO = 0.3;

/** 缺省处置：丢弃命中消息、保留真实消息、200 + skipped。 */
export const DEFAULT_INJECTION_GUARD_MODE: InjectionGuardMode = "skip";

/** plugin 声明头（写侧自我声明的注入来源种类）。 */
export const SOURCE_KIND_HEADER = "x-tdai-source-kind";

/**
 * 行首「不可见填充」字符集：空白 + 零宽/Cf 类。
 *
 * 为什么单列 Cf 类而不是只靠 \s（task-92）：
 *   Unicode 的 Cf（格式字符）**不属于 ECMAScript \s**——U+200B ZWSP、U+200C ZWNJ、
 *   U+200D ZWJ、U+200E LRM、U+200F RLM、U+2060 WORD JOINER 在 JS 里都不是空白。
 *   只剥 \s 时，行首塞一个 ZWSP 就能让 `startsWith(marker)` 落空 ⇒ 归一化形同虚设
 *   （panel-misc 实测：`"\u200b<relevant-memories>…"` → accepted:1，应 skipped:1）。
 *   对照组：U+FEFF BOM 恰好被 \s 覆盖（ES 规范把 FEFF 列入 WhiteSpace），历史测试
 *   因此只证明了 BOM 这一种，掩盖了 Cf 系缺口。这里把 BOM 也显式写出来，
 *   免得将来换运行时/引擎时依赖 \s 的实现细节。
 *   U+00A0 NBSP / U+3000 全角空格同理显式列出（语义上都是「看着像缩进」）。
 */
export const LEADING_INVISIBLE_CHARS_RE = /^[\s\u00a0\u3000\u200b-\u200f\u2060\ufeff]+/u;

/**
 * 归一化：统一换行符 + 逐行去掉前导不可见填充（空白 / tab / 全角空格 / 零宽 Cf 类）。
 *
 * 保留空行位置（不压缩、不丢弃）——「第几个非空行」的计数要靠它区分
 * 段落边界；返回的每一行都已 trimStart，行首匹配因此对缩进与零宽字符免疫。
 */
export function normalizeInjectionLines(text: string): string[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(LEADING_INVISIBLE_CHARS_RE, ""));
}

/** 非空白字符数（判定占比用；空白不计入分母，避免缩进把占比稀释掉）。 */
function countNonWhitespace(text: string): number {
  return text.replace(/\s+/g, "").length;
}

/**
 * 命中段的非空白字符数：从命中行起，连着后面的非空行组成的连续块
 * （遇空行或文本结束即止）。注入块是「首行标记 + 多行内容」的整块，
 * 用整块而不是单行去算占比，才不会把长块误判成零星引用。
 */
function matchedSegmentLength(lines: readonly string[], startIndex: number): number {
  let total = 0;
  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (i > startIndex && line.trim().length === 0) break;
    total += countNonWhitespace(line);
  }
  return total;
}

/**
 * 判定一条消息是否以已登记的注入块开头。命中返回 marker，否则 undefined。
 *
 * 两步：
 *   ① 归一化后逐行做**行首**前缀匹配（不做子串搜索——子串会把
 *      「我把【agemem 记忆提示】贴给你看」这类真实发言判成注入）；
 *   ② 命中行必须满足「在前 LEADING_NON_EMPTY_LINE_LIMIT 个非空行之内」，
 *      或「命中段非空白字符 ≥ 消息非空白字符 × MIN_MATCHED_SEGMENT_RATIO」。
 *
 * ② 是防误杀的关键：用户会把我们的块贴出来讨论，那种引用出现在正文中段、
 * 占比很小，不能判注入（历史上误杀过真实提问）。详见文件头 task-85 段。
 */
export function detectInjectedBlock(text: string): string | undefined {
  if (typeof text !== "string" || text.length === 0) return undefined;
  const lines = normalizeInjectionLines(text);
  const totalChars = countNonWhitespace(text);
  if (totalChars === 0) return undefined;
  let nonEmptySeen = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim().length === 0) continue;
    nonEmptySeen += 1;
    for (const marker of INJECTED_BLOCK_MARKERS) {
      if (!line.startsWith(marker)) continue;
      if (nonEmptySeen <= LEADING_NON_EMPTY_LINE_LIMIT) return marker;
      const segment = matchedSegmentLength(lines, i);
      if (segment / totalChars >= MIN_MATCHED_SEGMENT_RATIO) return marker;
    }
  }
  return undefined;
}

/** 请求是否由 TDB 插件自我声明（`plugin:*`）。 */
export function isPluginDeclared(sourceKind?: string): boolean {
  if (typeof sourceKind !== "string") return false;
  return sourceKind.trim().startsWith("plugin:");
}

/** 解析配置档位：非法值回落缺省（不抛错，写路径不能因配置笔误 500）。 */
export function resolveInjectionGuardMode(raw?: unknown): InjectionGuardMode {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (value === "reject" || value === "skip" || value === "allow") return value;
  return DEFAULT_INJECTION_GUARD_MODE;
}

/** 当前生效档位：环境变量 TDB_INJECTION_GUARD_MODE 优先（便于线上快速切换）。 */
export function currentInjectionGuardMode(): InjectionGuardMode {
  return resolveInjectionGuardMode(process.env.TDB_INJECTION_GUARD_MODE);
}

export interface InjectedBlockFinding {
  /** 命中的标记原文。 */
  marker: string;
  /** 消息在请求批次里的下标。 */
  index: number;
  /** 文本前 80 字符（日志采样用，避免整段入日志）。 */
  preview: string;
}

/**
 * 扫描一批消息，返回命中清单。不做处置，纯判定——便于单测直接断言识别结果。
 * 命中判定与处置分离，避免「改了处置逻辑反而让识别回归」。
 */
export function scanInjectedBlocks(
  messages: ReadonlyArray<{ role?: string; content?: string }>,
): InjectedBlockFinding[] {
  const findings: InjectedBlockFinding[] = [];
  for (const [index, msg] of messages.entries()) {
    const marker = detectInjectedBlock(msg?.content ?? "");
    if (!marker) continue;
    findings.push({
      marker,
      index,
      // role 一起带出来：注入块正常只出现在 user 侧，assistant 侧命中说明另有问题
      preview: String(msg?.content ?? "").slice(0, 80).replace(/\s+/g, " "),
    });
  }
  return findings;
}
