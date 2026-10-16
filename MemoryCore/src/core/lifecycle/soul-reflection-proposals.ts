/**
 * #27（R5，2026-10-16）：反思结论 → 身份层提案（O13 rail）确定性门。
 *
 * 合同（r5-27 安全条款，逐条对应实现）：
 * 1. slot 白名单：仅 identity/self_identity 可被提案修订；strict_rule 与身份基线绝不放行
 *    ——否则红线可被「自我反思」流程绕过（红线只可由用户显式维护）。
 * 2. 提案去原文（提示注入面）：LLM 反思以 L1 原文为输入，用户内容可能诱导持久化注入
 *    ——门侧校验「提案文本禁逐字包含 L1 片段」（句级 ≥VERBATIM_FRAGMENT_MIN_CHARS，
 *    空白归一后比对）+ 证据指针非空双保险。
 * 3. 调度单一源：本模块为纯裁决函数，无 IO 无调度；桥接内联 runReflection（F13 importance
 *    触发为主、consolidation 既有节拍兜底），不造第二套调度器。
 * 4. 采纳侧语义沿用既有 decidePendingCore → mergeIdentityFacts（identity 类槽 worker 承载）；
 *    identity 变更 → sv 变化 → 渲染路径 #30 快照全量落账（零新增快照代码）。
 * 5. 重复抑制：与在途 pending / 既有 core 身份行归一化重复 → 拒推（宁缺毋滥）。
 *
 * 提案内容=反思结论卡原文直出（确定性，不做 LLM 改写）；证据指针随 attrs 落 pending
 * 供人工裁决复核。门 off（soulProposals.enabled 缺省 false）=零调用=逐位现状。
 */

/** slot 白名单：可被反思提案修订的身份层槽位（strict_rule 永不在列）。 */
export const REFLECTION_PROPOSAL_SLOTS = ["identity", "self_identity"] as const;

/** 提案安全阀：反思结论卡 ≤100 字（REFLECTION_SYSTEM_PROMPT），上限留余量防提示漂移。 */
export const REFLECTION_PROPOSAL_MAX_CHARS = 200;

/** 句级碎片入检查集的最小长度（短于阈值的公共短语不做逐字比对，防误杀）。 */
export const VERBATIM_FRAGMENT_MIN_CHARS = 12;

export function isReflectionProposalSlotAllowed(slot: string): boolean {
  return (REFLECTION_PROPOSAL_SLOTS as readonly string[]).includes(slot);
}

/** 空白归一（连续空白→单空格，trim）——逐字比对与重复判定共用。 */
export function normalizeProposalText(s: string): string {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

/**
 * L1 文本 → 句级碎片检查集：按句界（。！？；!?与换行）切分，取 ≥12 字碎片，
 * 空白归一（跨行复述仍可命中）。
 */
export function l1VerbatimFragments(content: string): string[] {
  return String(content ?? "")
    .split(/[。！？；!?\n]+/)
    .map((s) => normalizeProposalText(s))
    .filter((s) => s.length >= VERBATIM_FRAGMENT_MIN_CHARS);
}

/**
 * 提案是否逐字包含任一证据 L1 句碎片；命中返回该碎片（供 reason 取证），未命中返回 null。
 */
export function findVerbatimL1Fragment(
  proposal: string,
  evidenceContents: readonly (string | null | undefined)[],
): string | null {
  const norm = normalizeProposalText(proposal);
  if (!norm) return null;
  for (const c of evidenceContents) {
    for (const f of l1VerbatimFragments(String(c ?? ""))) {
      if (norm.includes(f)) return f;
    }
  }
  return null;
}

export interface ReflectionIdentityProposal {
  slot: string;
  content: string;
  /** 证据指针数（O13 evidence 计数）。 */
  evidence: number;
  attrs: Record<string, unknown>;
}

export type ReflectionProposalVerdict =
  | { ok: true; proposal: ReflectionIdentityProposal }
  | { ok: false; reason: string };

/**
 * 单条提案全链裁决（确定性，按序短路）：
 * slot 白名单 → 内容非空/长度安全阀 → 证据非空 → 去 L1 原文。
 */
export function vetReflectionIdentityProposal(input: {
  slot: string;
  content: string;
  evidenceRecordIds: readonly string[];
  evidenceContents: readonly (string | null | undefined)[];
}): ReflectionProposalVerdict {
  if (!isReflectionProposalSlotAllowed(input.slot)) return { ok: false, reason: `slot-not-allowed:${input.slot}` };
  const content = normalizeProposalText(input.content);
  if (!content) return { ok: false, reason: "empty-content" };
  if (content.length > REFLECTION_PROPOSAL_MAX_CHARS) return { ok: false, reason: "content-too-long" };
  if (input.evidenceRecordIds.length === 0) return { ok: false, reason: "no-evidence" };
  const frag = findVerbatimL1Fragment(content, input.evidenceContents);
  if (frag) return { ok: false, reason: `verbatim-l1:${frag}` };
  return {
    ok: true,
    proposal: {
      slot: input.slot,
      content,
      evidence: input.evidenceRecordIds.length,
      attrs: { origin: "reflection", evidence_record_ids: [...input.evidenceRecordIds] },
    },
  };
}

/** 行归一（identity/self_identity 为按行累积结构，逐行比对防整段包含误判）。 */
const coreLines = (content: string): string[] =>
  String(content ?? "").split("\n").map((l) => normalizeProposalText(l)).filter((l) => l.length > 0);

/**
 * 重复抑制：提案内容与在途 pending（state=pending）或既有 core 身份行（逐行）归一化重复。
 * store 面为可选能力（缺实现→视为无重复，由 O13 采纳侧人工裁决兜底）。
 */
export async function proposalAlreadyKnown(
  store: {
    listPendingCore?(tenant?: unknown, opts?: { includeDecided?: boolean }): unknown;
    readCore?(tenant?: unknown): unknown;
  } | undefined,
  tenant: unknown,
  content: string,
): Promise<boolean> {
  const norm = normalizeProposalText(content);
  if (!norm || !store) return false;
  try {
    const pending = await Promise.resolve(store.listPendingCore?.(tenant, { includeDecided: false }) ?? []);
    for (const p of pending as Array<{ content?: string; state?: string }>) {
      if (p?.state === "pending" && normalizeProposalText(String(p.content ?? "")) === norm) return true;
    }
  } catch { /* pending 面失败不阻断（采纳侧人工兜底） */ }
  try {
    const core = await Promise.resolve(store.readCore?.(tenant) ?? null);
    if (Array.isArray(core)) {
      for (const row of core as Array<{ slot?: string; content?: string }>) {
        if (row?.slot !== "identity" && row?.slot !== "self_identity") continue;
        if (coreLines(String(row.content ?? "")).some((l) => l === norm)) return true;
      }
    }
  } catch { /* core 面失败不阻断 */ }
  return false;
}
