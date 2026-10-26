import { createHash } from "node:crypto";
import type { TdaiClient } from "./client.js";
import type { TdaiIdentity, TdaiMessage } from "./types.js";
import { extractUserQueryText, isDshRuntimeContextSnapshot } from "../common/user-query-extractor.js";
import type { TurnContext } from "../common/intent-classifier.js";
import { stripDshAcpTags } from "../common/acp-tag.js";

/**
 * 从最后一条 user 消息中抽取「真正的用户提问」，写入 L0。
 *
 * 背景：CodeBuddy / Claude Code / DSH 等编码 agent 的 user 消息里除了真实问题，
 * 还塞了大量 harness 上下文（<additional_data>、current_time、<system_reminder>、
 * DSH 的 `Current runtime context.` 快照等）。如果把整条消息原样写进 L0，记忆
 * 会被这些噪声污染，而且每轮都不一样、检索价值极低。因此这里只保留真实提问。
 *
 * 采用**正向匹配**而非黑名单拒绝：
 *   一条 user 消息应被提取，当且仅当它「看起来是用户/插件直接书写，而非 dsh
 *   官方协议注入」——即 `extractUserQueryText` 清理后非空，且原始内容**不以 `<`
 *   开头**（dsh 的 `<EXTREMELY_IMPORTANT>` / `<system-reminder>` 等协议块都以 `<`
 *   开头），也**不是** `Current runtime context.` 快照。
 *
 *   不枚举任何插件 tag（如 `[分析纪律]`、`【诊断模式】`、`[scm-rag]`）：这些是
 *   团队插件注入、但形态上不以 `<` 开头，会被自然保留为记忆素材；后续新增插件
 *   亦然——**无需改源码**，只要新内容是「非 `<` 协议形态」即可被提取。
 *
 * 抽取算法在 `common/user-query-extractor.ts` 内实现（tdai / mem-command /
 * codebuddy adapter 共用同一份，避免语义漂移）；本模块负责"倒扫 user 消息 →
 * 正向匹配第一条真实用户提问 → 组装 TdaiMessage"。
 */

// 保留 re-export，避免下游（含单测）import 路径变化引发一次性大改。
export { extractUserQueryText };

/**
 * 正向匹配谓词：判定一条 user 消息是否「可提取为记忆的真人/插件输入」。
 *
 * 返回 true 当且仅当：
 *   - `extractUserQueryText` 清理后非空（排除 CC/CB 的 harness 剥离）
 *   - 原始内容不以 `<` 开头（排除 dsh 的 `<EXTREMELY_IMPORTANT>` / `<system-reminder>`
 *     / `<question_answer>` 等协议块）
 *   - 不是 dsh 的 `Current runtime context.` 运行时快照
 *
 * 注意：这里是**正向匹配**，不是维护一份"拒绝/接受"标签清单。插件注入的
 * `[分析纪律]` / `【诊断模式】` / `[scm-rag]` 等不以 `<` 开头，会被当作可提取
 * 记忆保留；dsh 官方协议块统一以 `<` 开头，被结构性地排除。
 */
export function isExtractableUserInput(content: unknown): boolean {
  const raw = extractContentText(content);
  if (!raw.trim()) return false;
  // dsh 官方协议注入统一是 `<...>` 包裹（EXTREMELY_IMPORTANT / system-reminder …）。
  // 真实用户输入 / 团队插件文本不以 `<` 开头。
  if (raw.trimStart().startsWith("<")) return false;
  // dsh 运行时快照（纯文本，无 XML 包裹）
  if (isDshRuntimeContextSnapshot(raw)) return false;
  // 再走一次统一语义清理（CC/CB harness 剥离）确认非空
  return extractUserQueryText(raw).trim().length > 0;
}

export function extractLatestUserMessage(messages: unknown[]): TdaiMessage | null {
  // 通用渠道（CC/CB/workbuddy 等）的原始语义：倒扫取第一条剥离 harness 后非空。
  // 保持原逻辑不变，避免影响其它渠道 —— dsh 用 extractLatestDshUserMessage。
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as Record<string, unknown>;
    if (msg?.role !== "user") continue;
    const content = extractUserQueryText(extractContentText(msg.content));
    if (content.trim()) return { role: "user", content };
  }
  return null;
}

/**
 * dsh 专用提取：**正向匹配**真实用户消息（而非枚举插件标签）。
 *
 * 与通用 `extractLatestUserMessage` 的区别：用 `isExtractableUserInput` 正向判定
 * 「这条 user 消息看起来是用户/插件直接书写，而不是 dsh 官方协议注入」——
 *    - 不以 `<` 开头（排除 `<EXTREMELY_IMPORTANT>` / `<system-reminder>` 等）
 *    - 不是 `Current runtime context.` 快照
 *    - `extractUserQueryText` 清理后非空
 *
 * 不枚举任何插件 tag（`[分析纪律]` / `【诊断模式】` / `[scm-rag]` 等），它们不以
 * `<` 开头，会被自然保留为记忆素材；新插件注入亦然——**无需改源码**。
 * 对齐 codex / workbuddy 的「渠道独立 extract」设计，仅供 handler.ts dsh 分支调用。
 */
export function extractLatestDshUserMessage(messages: unknown[]): TdaiMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as Record<string, unknown>;
    if (msg?.role !== "user") continue;
    if (!isExtractableUserInput(msg.content)) continue;
    return { role: "user", content: extractUserQueryText(extractContentText(msg.content)) };
  }
  return null;
}

/** #83 L0 捕获档位随流参数（captureMode/turnContext 由 handler 从 config+classifyInbound 注入） */
export interface RecordTurnCapture {
  captureMode?: "legacy" | "shadow" | "classified";
  turnContext?: TurnContext | null;
}

// ── M1 最小修（审查 4544dc9d，2026-10-22）：classified 全量写 + core F-DUP-1 仅 10min 窗 +
// 步间实测 10-16min → 整史重复落库 O(T²) 并逐条重 embed。代理侧 per-session 指纹集合做
// 增量提交：已提交过的 role+content 不再重发（重复≠丢失，「宁漏勿杀」不冲突）；进程重启
// 集合清空 → 最坏一批重复（有界，非 O(T²)），10min 内由 core F-DUP-1 兜住。
const L0_FP_MAX_SESSIONS = 200;
const submittedFingerprints = new Map<string, Set<string>>();

function l0Fingerprint(role: string, content: string): string {
  return createHash("sha256").update(role).update("\u0000").update(content).digest("hex");
}

/** 测试隔离用：清空指纹集合（生产代码勿调） */
export function resetSubmittedFingerprintsForTests(): void {
  submittedFingerprints.clear();
}

function submittedSetFor(sessionKey: string): Set<string> {
  let set = submittedFingerprints.get(sessionKey);
  if (!set) {
    if (submittedFingerprints.size >= L0_FP_MAX_SESSIONS) {
      const oldest = submittedFingerprints.keys().next().value;
      if (oldest !== undefined) submittedFingerprints.delete(oldest);
    }
    set = new Set();
    submittedFingerprints.set(sessionKey, set);
  }
  return set;
}

export async function recordTdaiTurn(client: TdaiClient, identity: TdaiIdentity | null, userMessage: TdaiMessage | null, assistantContent: string | null | undefined, capture?: RecordTurnCapture): Promise<void> {
  // [PROBE-v2] full-args dump for L0 write path — DEBUG ONLY
  try {
    const { log } = await import("../report/log.js");
    const caller = () => {
      try { return String(new Error().stack || "").split("\n").slice(2, 6).join("|"); } catch { return ""; }
    };
    log.info("dsh-l0-turn-v2", {
      identityPresent: !!identity,
      identity: identity ? {
        team: identity.teamId, user: identity.userId, agent: identity.agentId,
        session: identity.sessionId, task: identity.taskId, userKey: identity.userKey ? "set" : "unset",
      } : null,
      userMessagePresent: !!userMessage,
      userMessageLen: userMessage ? String(userMessage.content ?? "").length : null,
      userMessageFull: userMessage ? String(userMessage.content ?? "").slice(0, 500) : null,
      assistantLen: assistantContent ? String(assistantContent ?? "").length : null,
      assistantFull: assistantContent ? String(assistantContent ?? "").slice(0, 200) : null,
      caller: caller().slice(0, 300),
    });
  } catch { /* best effort */ }

  // #83 捕获三档（缺省 legacy = 现行为逐位不变）：
  //  legacy     —— 单条提取（现状）：userMessage 为空即整轮丢弃（脚手架轮 L0 缺失的旧病灶）。
  //  shadow     —— 双跑对比日志：行为仍 legacy，另打 classified 路径会写什么（对比观测）。
  //  classified —— turnContext 全量写入「宁漏勿杀」：逐条带 classification 标签；
  //                turnIntent 缺失（全脚手架轮）也写入（带标签，供哨兵观测与存量回填）。
  const mode = capture?.captureMode ?? "legacy";
  const turnContext = capture?.turnContext ?? null;
  if (mode === "shadow" && turnContext) {
    try {
      const { log } = await import("../report/log.js");
      const legacyHead = userMessage ? userMessage.content.slice(0, 80) : "(null)";
      const intentHead = turnContext.turnIntent ? turnContext.turnIntent.text.slice(0, 80) : "(none)";
      log.info("dsh-l0-capture-shadow", {
        legacyHead,
        intentHead,
        match: legacyHead === intentHead,
        classified: turnContext.classified.map((c) => c.classification),
      });
    } catch { /* best effort */ }
  }
  if (!identity || (!userMessage && !(mode === "classified" && turnContext))) {
    // [PROBE] reason why recordTdaiTurn early-returns — DEBUG ONLY
    try {
      const { log } = await import("../report/log.js");
      const prog = () => {
        try { return String(new Error().stack || "").split("\n").slice(2, 6).join("|"); } catch { return ""; }
      };
      log.info("dsh-l0-skip", {
        identity: !!identity, userMessage: !!userMessage,
        reason: !identity ? "no-identity" : "no-user-message",
        agent: identity?.agentId ?? null,
        user: identity?.userId ?? null,
        session: identity?.sessionId ?? null,
        caller: prog().slice(0, 200),
      });
    } catch { /* best effort */ }
    return;
  }
  let messages: TdaiMessage[];
  let fpSet: Set<string> | null = null;
  let userBefore = 0;
  if (mode === "classified" && turnContext) {
    // #83 classified：全量写入（宁漏勿杀）——classified 每条带行级 classification 标签；
    // scaffold 行清洗后 text 为空串，写原始内容（raw）供存量分析与 #84 回填。
    // M1 最小修：per-session 指纹增量——已提交条目不再重发（见 submittedFingerprints 注释）。
    fpSet = submittedSetFor(identity?.sessionId ?? identity?.userKey ?? "(no-session)");
    userBefore = turnContext.classified.length;
    messages = [];
    let emptySkipped = 0;
    for (const c of turnContext.classified) {
      // #89：写边界统一剥 acp 标签——纯标签行（剥后为空）跳过不写；指纹按剥后内容。
      const stored = stripDshAcpTags(c.raw || c.text);
      if (!stored) { emptySkipped += 1; continue; }
      const fp = l0Fingerprint("user", stored);
      if (fpSet.has(fp)) continue;
      fpSet.add(fp);
      messages.push({
        role: "user" as const,
        content: stored,
        classification: c.classification,
      });
    }
    try {
      const { log } = await import("../report/log.js");
      log.info("dsh-l0-capture-dedup", {
        session: identity?.sessionId ?? null,
        before: userBefore,
        submitted: messages.length,
        skipped: userBefore - messages.length,
        emptySkipped,
      });
    } catch { /* best effort */ }
  } else {
    messages = [];
    if (userMessage) {
      // #89：写边界统一剥 acp 标签（legacy 提取仍可能残留尾随标签）；剥后为空不写。
      const stored = stripDshAcpTags(userMessage.content);
      if (stored) messages.push({ ...userMessage, content: stored });
    }
  }
  if (assistantContent?.trim()) {
    // #89：assistant 尾随 acp 标签同规则剥除；剥后为空不写；指纹按剥后内容。
    const aStored = stripDshAcpTags(assistantContent);
    if (aStored) {
      if (fpSet) {
        const aFp = l0Fingerprint("assistant", aStored);
        if (!fpSet.has(aFp)) {
          fpSet.add(aFp);
          messages.push({ role: "assistant", content: aStored });
        }
      } else {
        messages.push({ role: "assistant", content: aStored });
      }
    }
  }
  if (messages.length === 0) return;
  await client.addConversation(identity, messages);
}

function extractContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      const p = part as Record<string, unknown>;
      if (typeof p.text === "string") return p.text;
      if (typeof p.content === "string") return p.content;
      return "";
    }).filter(Boolean).join("\n");
  }
  return "";
}
