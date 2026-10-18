/**
 * #52 P4（2026-10-18）：采纳侧 pending 清扫——同一事实的多份换措辞提案在 Panel
 * 采纳其一后，其余自动 rejected（防 pending 队列被同族提案淤积；生产实证 61 条
 * pending 中「取证先行」存 active 锚后仍留重复提案）。
 *
 * 判据（按 slot 分域，宁漏勿错杀——漏放由 Panel 人工兜底，误杀=真实提案静默丢失）：
 * - core_value：label 归一相等（trim+lowercase）。生产实证：pending「取证先行」与
 *   active 锚的正文 bigram Jaccard 仅 0.107（长文本措辞差异），但 label 相似度 1.000
 *   ——label 才是锚身份；且采纳路径 v2-router 已有同 label 预检（#12 T6），语义同源。
 * - strict_rule：行级 bigram Jaccard（复用 proposal-dedup.findDuplicateProposal，
 *   阈值 0.75 生产标定）——采纳后槽全文逐行作为比对域，pending 提案与其任一行
 *   相似度达标即判重。
 *
 * 执行语义：best-effort、非致命——list/decide 任何失败只 warn 并返回已完成部分，
 * 绝不影响采纳主流程结果（采纳已落库，清扫是锦上添花）。
 */
import { findDuplicateProposal, PROPOSAL_DUP_THRESHOLD } from "./proposal-dedup.js";
import type { CoreTenant, MaybePromise } from "../store/types.js";
import type { Logger } from "../types.js";

/** 清扫结果行：被自动 rejected 的 pending 及判重理由。 */
export interface PendingAdoptSweepRow {
  pendingId: string;
  slot: string;
  reason: string;
}

/** 结构化最小 store 面（调用方传完整 store；feature-detect 缺方法→零清扫）。 */
export interface PendingAdoptSweepStore {
  listPendingCore?: (
    tenant?: CoreTenant,
    opts?: { includeDecided?: boolean },
  ) => MaybePromise<Array<{ pending_id: string; slot: string; content: string; label?: string | null }>>;
  decidePendingCore?: (
    pendingId: string,
    decision: "adopted" | "rejected",
    tenant?: CoreTenant,
  ) => MaybePromise<{ slot: string; content: string } | null>;
}

/**
 * 采纳后清扫同族 pending 提案。
 * - slot=core_value：deps.adoptedLabel 必传（label 归一相等判重）；
 * - slot=strict_rule：deps.mergedContent 必传（合并后槽全文，行级 Jaccard 判重）；
 * 返回实际 rejected 成功的行（decide 返回 null=已被并发处置，不入结果）。
 */
export async function sweepPendingDuplicatesAfterAdopt(deps: {
  store: PendingAdoptSweepStore;
  tenant: CoreTenant;
  slot: "core_value" | "strict_rule";
  /** core_value：本次采纳锚的 label（判重域=label 归一相等）。 */
  adoptedLabel?: string;
  /** strict_rule：合并后的槽全文（判重域=行级 bigram Jaccard ≥ PROPOSAL_DUP_THRESHOLD）。 */
  mergedContent?: string;
  /** 刚被采纳的 pending 行 id——防御性跳过（includeDecided=false 本应排除已决行；
   *  mock/竞态下防同一行被二次裁决=幂等底线）。 */
  adoptedPendingId?: string;
  logger?: Logger;
}): Promise<PendingAdoptSweepRow[]> {
  const { store, tenant, slot, logger } = deps;
  if (typeof store.listPendingCore !== "function" || typeof store.decidePendingCore !== "function") return [];
  try {
    const rows = (await Promise.resolve(store.listPendingCore(tenant, { includeDecided: false }))) ?? [];
    const norm = (s: unknown) => String(s ?? "").trim().toLowerCase();
    const dups: Array<{ pendingId: string; reason: string }> = [];
    if (slot === "core_value") {
      const label = norm(deps.adoptedLabel);
      if (label === "") return [];
      for (const r of rows) {
        if (r.slot !== "core_value") continue;
        if (r.pending_id === deps.adoptedPendingId) continue; // 刚采纳行防重决（幂等底线）
        if (norm(r.label) === label) {
          dups.push({ pendingId: r.pending_id, reason: `duplicate of adopted anchor label "${label}"` });
        }
      }
    } else {
      const lines = String(deps.mergedContent ?? "")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l !== "");
      if (lines.length === 0) return [];
      const domain = lines.map((l) => ({ slot: "strict_rule", content: l }));
      for (const r of rows) {
        if (r.slot !== "strict_rule") continue;
        if (r.pending_id === deps.adoptedPendingId) continue; // 刚采纳行防重决（幂等底线）
        const dup = findDuplicateProposal(String(r.content ?? ""), "strict_rule", domain, PROPOSAL_DUP_THRESHOLD);
        if (dup) dups.push({ pendingId: r.pending_id, reason: `line-similar to merged strict_rule (Jaccard=${dup.similarity.toFixed(2)})` });
      }
    }
    const swept: PendingAdoptSweepRow[] = [];
    for (const d of dups) {
      const decided = await Promise.resolve(store.decidePendingCore(d.pendingId, "rejected", tenant));
      if (decided) swept.push({ pendingId: d.pendingId, slot, reason: d.reason });
    }
    if (swept.length > 0) {
      logger?.info?.(`[pending-adopt-sweep] slot=${slot} swept=${swept.length}: ${swept.map((s) => s.pendingId).join(",")}`);
    }
    return swept;
  } catch (err) {
    logger?.warn?.(
      `[pending-adopt-sweep] failed (non-fatal, adopt result unaffected): ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}
