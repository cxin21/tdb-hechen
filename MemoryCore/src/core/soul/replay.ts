/**
 * 回放校准：用历史提案（core_pending 的 rejected/adopted/expired）反测判据。
 *
 * 这是「0 人工」唯一可信的验收方式：判据不是靠人抽查，而是靠历史数据回放。
 * 期望口径：历史上被人工驳回的提案 ≥95% 应被判「非人格」（method/null）。
 * 达不到就说明判据太松，必须先收紧再上线——不允许「先上线再观察」。
 */
import { classifyLine, evaluateCandidate, failedCodes } from "./gates.js";
import { resolveSoulConfig, type SoulLayer, type SoulMaintenanceConfig } from "./types.js";
import type { CoreTenant, IMemoryStore } from "../store/types.js";

export interface ReplayCase {
  id: string;
  text: string;
  /** 历史裁决：rejected | adopted | expired | pending */
  state: string;
  /** 原始槽位（self_identity / strict_rule / core_value）：决定回放时按哪一层判。 */
  slot?: string;
}

export interface ReplayCaseResult {
  id: string;
  state: string;
  layer: SoulLayer | null;
  codes: string[];
  verdict: "persona" | "non_persona";
}

export interface ReplayResult {
  total: number;
  /** 判为「非人格」（method/null）的条数。 */
  nonPersona: number;
  persona: number;
  byCode: Record<string, number>;
  /** 被历史驳回、但判据仍判为「人格」的高危漏网（需要人工看）。 */
  falseAdmits: ReplayCaseResult[];
  /** 被历史采纳、但判据判为「非人格」的误杀（需要复核判据）。 */
  falseRejects: ReplayCaseResult[];
  /** 历史驳回但判非人格的比例（期望 ≥ 0.95）。 */
  rejectionCatchRate: number;
  cases: ReplayCaseResult[];
}

export function replayCalibration(cases: ReplayCase[], config?: SoulMaintenanceConfig): ReplayResult {
  const results: ReplayCaseResult[] = cases.map((c) => {
    const cls = classifyLine(c.text, false, config);
    const layer = cls.layer;
    const persona = layer === "identity" || layer === "values" || layer === "boundary" || layer === "relationship";
    return {
      id: c.id,
      state: c.state,
      layer,
      codes: cls.reports.filter((r) => !r.pass).map((r) => r.code),
      verdict: persona ? "persona" : "non_persona",
    };
  });
  const byCode: Record<string, number> = {};
  for (const r of results) for (const code of r.codes) byCode[code] = (byCode[code] ?? 0) + 1;
  const rejected = results.filter((r) => r.state === "rejected");
  const caught = rejected.filter((r) => r.verdict === "non_persona").length;
  const adopted = results.filter((r) => r.state === "adopted");
  return {
    total: results.length,
    nonPersona: results.filter((r) => r.verdict === "non_persona").length,
    persona: results.filter((r) => r.verdict === "persona").length,
    byCode,
    falseAdmits: rejected.filter((r) => r.verdict === "persona"),
    falseRejects: adopted.filter((r) => r.verdict === "non_persona"),
    rejectionCatchRate: rejected.length === 0 ? 1 : caught / rejected.length,
    cases: results,
  };
}

/* —— 严格回放（2026-11-05 事件层）：把「内容」与「出处」分开量 ——
 * 旧回放只用 classifyLine 问「像不像人格」，无法回答「凭什么知道」；新判据加了出处门
 * （episode/原话）。但历史 rejected 提案本身没有挂 episode，若把出处门算进回放，
 * 100% 都会因 episode_missing 被拦——那是循环论证，不是校准。
 * 因此这里把失败码分两类分别统计：
 *   content 失败（事件句/方法论/任务锚/没立场/没代价/超长…）= 内容不该进；
 *   provenance 失败（没 episode / 没原话）= 内容可能好，但没有出处，今天同样进不来。
 * catchRate 只对 content 失败计；provenanceOnly 单独列出来，不混进达标率。 */
const PROVENANCE_CODES = new Set(["episode_missing", "voice_quote_missing", "verbatim_missing", "self_evidence", "evidence", "insufficient_evidence"]);

export interface StrictReplayCaseResult extends ReplayCaseResult {
  /** 失败码里属于「内容不行」的那些（决定 verdict）。 */
  contentCodes: string[];
  /** 失败码里只缺出处的那些。 */
  provenanceCodes: string[];
  /** 首条失败原因（逐条理由，人可读）。 */
  detail: string;
  contentPersona: boolean;
}

export interface StrictReplayResult {
  total: number;
  rejected: number;
  /** 内容层面判非人格（历史驳回且今天内容门也拦）。 */
  contentNonPersona: number;
  /** 内容层面像人格、只缺出处（历史驳回，但今天会因无根据被拦）。 */
  provenanceOnly: number;
  /** 内容层面像人格、且出处门也满足（= 真正的漏网，需人工看）。 */
  contentAdmits: number;
  /** rejected 里内容判非人格的比例（期望 ≥ 0.95）。 */
  catchRate: number;
  /** 历史驳回、今天仅靠内容门就能全过的高危漏网（期望 ≤ 0.05 * rejected）。 */
  falseAdmitRate: number;
  byCode: Record<string, number>;
  cases: StrictReplayCaseResult[];
}

function layerOfSlot(slot?: string): SoulLayer {
  if (slot === "strict_rule") return "boundary";
  if (slot === "core_value") return "values";
  return "identity";
}

export function replayStrictCalibration(cases: ReplayCase[], config?: SoulMaintenanceConfig): StrictReplayResult {
  const cfg = config ?? resolveSoulConfig({});
  const results: StrictReplayCaseResult[] = cases.map((c) => {
    const layer = layerOfSlot(c.slot);
    const reports = evaluateCandidate(c.text, {
      layer,
      now: new Date().toISOString(),
      existing: [],
      config: cfg,
      evidenceOrigins: ["model"],
      // 不伪造出处：历史提案没有 episode，缺出处如实记为 provenance 失败。
    });
    const codes = failedCodes(reports);
    const contentCodes = codes.filter((x) => !PROVENANCE_CODES.has(x));
    const provenanceCodes = codes.filter((x) => PROVENANCE_CODES.has(x));
    const detail = reports.find((r) => !r.pass)?.detail ?? "";
    return {
      id: c.id,
      state: c.state,
      layer,
      codes,
      detail,
      contentCodes,
      provenanceCodes,
      contentPersona: contentCodes.length === 0,
      verdict: contentCodes.length === 0 ? "persona" : "non_persona",
    };
  });
  const rejected = results.filter((r) => r.state === "rejected");
  const contentNonPersona = rejected.filter((r) => !r.contentPersona).length;
  const provenanceOnly = rejected.filter((r) => r.contentPersona && r.provenanceCodes.length > 0).length;
  const contentAdmits = rejected.filter((r) => r.contentPersona && r.provenanceCodes.length === 0).length;
  const byCode: Record<string, number> = {};
  for (const r of results) for (const code of r.contentCodes) byCode[code] = (byCode[code] ?? 0) + 1;
  return {
    total: results.length,
    rejected: rejected.length,
    contentNonPersona,
    provenanceOnly,
    contentAdmits,
    catchRate: rejected.length === 0 ? 1 : contentNonPersona / rejected.length,
    falseAdmitRate: rejected.length === 0 ? 0 : contentAdmits / rejected.length,
    byCode,
    cases: results,
  };
}

/** 从 store 读 core_pending（含已裁决）构造回放集；store 不支持则返回空集。 */
export async function loadReplayCases(
  store: Pick<IMemoryStore, "listPendingCore">,
  tenant: CoreTenant,
): Promise<ReplayCase[]> {
  if (typeof store.listPendingCore !== "function") return [];
  const rows = await store.listPendingCore(tenant, { includeDecided: true });
  return (rows ?? []).map((r) => ({
    id: String((r as { pending_id?: string }).pending_id ?? ""),
    text: String((r as { content?: string }).content ?? ""),
    state: String((r as { state?: string }).state ?? "pending"),
    slot: typeof (r as { slot?: string }).slot === "string" ? (r as { slot?: string }).slot : undefined,
  }));
}

/** 回放报告的一行摘要（CLI/日志用）。 */
export function summarizeReplay(r: ReplayResult): string {
  const pct = (r.rejectionCatchRate * 100).toFixed(1);
  return [
    `cases=${r.total}`,
    `nonPersona=${r.nonPersona}`,
    `persona=${r.persona}`,
    `catchRate=${pct}%`,
    `falseAdmits=${r.falseAdmits.length}`,
    `falseRejects=${r.falseRejects.length}`,
  ].join(" ");
}
