/**
 * 任务5（用户 2026-09-22 拍板定案）：召回/灵魂注入日志 writer——单一源。
 * 采集点=performLayeredRecall 返回点（两路共用于同一函数，禁第二份）；
 * 存储=<dataDir>/logs/recall/ 按租户 recall-journal-{team}-{agent}.jsonl；
 * 大小轮转缺省 5MB、数量上限缺省 5（memory.recallJournal.{enabled,rotationSizeMB,maxFiles} 全可配）；
 * best-effort：任何失败吞错零影响主链路（召回热路径纪律）。
 */
import fs from "node:fs";
import path from "node:path";
// P1-T7：类型单一源在 recall-signals.ts——import type 供本文件接口引用，
// 再 re-export 供 journal 消费方单点 import。
import type { RecallJournalImportanceGate } from "../tools/recall-signals.js";

export interface RecallJournalSearchTiming {
  ftsMs: number;
  embeddingMs: number;
  ftsHits: number;
  embeddingHits: number;
}

/**
 * P1 Task 2（spec §4.5，r3=232a124）：精排观测 gate —— kept/dropped 以本调用候选池口径记录；
 * gate 为真实生效后的结果观测（用户 2026-10-14 拍板移除 shadowMode，重排恒真实生效）；
 * 降级路径（不可用/熔断开/adapter null）ms=0（未外呼）或实际耗时、kept=池大小、dropped=0、无 topScore。
 */
export interface RecallJournalRerankGate {
  provider: string;
  ms: number;
  kept: number;
  dropped: number;
  topScore?: number;
}

/** R71-A1（2026-10-19）：work_fact 候选 bm25 预地板观测门。kept=地板后剩余候选数。 */
export interface RecallJournalConclusionBm25Gate {
  minRel: number;
  kept: number;
  dropped: number;
}

/** R71-A2（2026-10-19）：结论层 rerank 语义门观测（shadow 记 would-be 决策）。
 *  bypass ∈ rerank-off | rerank-unavailable | breaker-open | rerank-failed（旁路留痕=未执行门控）。 */
export interface RecallJournalConclusionRerankGate {
  mode: "off" | "shadow" | "enforce";
  provider: string;
  ms: number;
  kept: number;
  dropped: number;
  topScore?: number;
  bypass?: "rerank-off" | "rerank-unavailable" | "breaker-open" | "rerank-failed";
}

export interface RecallJournalGates {
  nativeMinRRF?: { gate: number; kept: number; dropped: number };
  rerank?: RecallJournalRerankGate;
  conclusionBm25?: RecallJournalConclusionBm25Gate;
  conclusionRerank?: RecallJournalConclusionRerankGate;
  /**
   * P1-T7（worthiness importance）：重要度降权观测门——raw vs penalized 双分量
   * （乘子恒真实生效：penalized=实际排序分，raw 为反推值）。类型单一源
   * 在 recall-signals.ts（与乘子实现同文件，防止口径分裂）。
   */
  importancePenalty?: RecallJournalImportanceGate;
}

// P1-T7：类型再导出（journal 消费方 import 单一源 recall-journal 即可）
export type { RecallJournalImportanceGate, RecallJournalImportanceGateSpec } from "../tools/recall-signals.js";

/**
 * #61（2026-10-18）：/v3/recall v2 5000ms 硬超时贴脸——分段计时观测。
 * 全部为毫秒整数值；l2 段在 conclusionLayer.enabled=false 时恒为 0；
 * l1 段含 R7 经验行组装（slice/动态 topK/budget，同步微秒级）；
 * soul 段含 mood/state/soul-prefix 渲染全链。
 */
export interface RecallJournalPerfMs {
  total: number;
  scene: number;
  /**
   * #63（2026-10-18）：V2-2 LLM 查询扩展（getExpansionTerms，keyword/hybrid-fallback
   * 路消费）耗时。journal 实锤 l1=4305ms 中 ~4s 为 query-expand LLM 串行阻塞（真实
   * embedding RTT 仅 108ms），不拆本段会再次误诊为「embedding 慢」。native/embedding
   * 路零 LLM 调用 → 恒 0；qe.enabled=false → ≈0。
   */
  expand: number;
  l2: number;
  l1: number;
  soul: number;
}

export interface RecallJournalEntry {
  ts: string;
  query: string;
  strategy: string;
  teamId: string;
  userId?: string;
  agentId?: string;
  sessionKey?: string;
  sessionReused: boolean;
  layered: boolean;
  conclusionCount: number;
  experienceCount: number;
  searchTiming: RecallJournalSearchTiming;
  /**
   * P0-2 验证（issue #2，Spec 终审 a1 落实 2026-10-13）：召回门槛观测——门生效且
   * 有淘汰时记录 kept/dropped（挡下率对比）。缺字段 = 门未启用或未淘汰。
   */
  gates?: RecallJournalGates;
  /** #61 分段计时观测（毫秒）；缺字段 = 旧入口未打点。 */
  perfMs?: RecallJournalPerfMs;
  block?: string;
  memoryLines: string[];
  /**
   * #74（Batch A，2026-10-20）：跳过语义注记。skip 路是独立语义入口（如端点路纯
   * 脚手架查询整条跳过：零检索零注入零指标上报），以 skipReason="scaffold-query"
   * 区分于正常召回条目；缺字段 = 正常召回（向后兼容旧条目与旧消费方）。
   */
  skipReason?: string;
}

export interface RecallJournalTenant {
  teamId: string;
  agentId?: string;
}

export interface RecallJournalOpts {
  enabled: boolean;
  rotationSizeMB: number;
  maxFiles: number;
}

/** 租户分文件名（缺省 agent 兜底 default；组件 encode 防路径注入）。 */
export function recallJournalFileName(tenant: RecallJournalTenant): string {
  return `recall-journal-${encodeURIComponent(tenant.teamId || "default")}-${encodeURIComponent(tenant.agentId || "default")}.jsonl`;
}

function rotateOldFiles(basePath: string, maxFiles: number): void {
  // 轮转语义：当前文件满 → 改名 .1.jsonl（扩展名保留在尾）；旧 .k.jsonl 顺延 .(k+1).jsonl；
  // 总数（含当前）≤ maxFiles。stem=去掉 .jsonl 扩展后的基名。
  const rotatedKeep = Math.max(maxFiles - 1, 0);
  const stem = basePath.endsWith(".jsonl") ? basePath.slice(0, -".jsonl".length) : basePath;
  for (let i = rotatedKeep; i >= 1; i--) {
    const from = i === 1 ? basePath : `${stem}.${i - 1}.jsonl`;
    const to = `${stem}.${i}.jsonl`;
    if (fs.existsSync(from)) {
      try { fs.rmSync(to, { force: true }); fs.renameSync(from, to); } catch { /* 单轮失败不影响写入 */ }
    }
  }
}

export function appendRecallJournal(
  journalDir: string,
  tenant: RecallJournalTenant,
  entry: RecallJournalEntry,
  opts: RecallJournalOpts,
): void {
  try {
    if (!opts?.enabled) return;
    fs.mkdirSync(journalDir, { recursive: true });
    const file = path.join(journalDir, recallJournalFileName(tenant));
    const line = `${JSON.stringify(entry)}\n`;
    let size = 0;
    try { size = fs.statSync(file).size; } catch { /* 新文件 */ }
    const limit = Math.max(opts.rotationSizeMB ?? 5, 0) * 1024 * 1024;
    if (size > 0 && limit > 0 && size + Buffer.byteLength(line, "utf8") > limit) {
      rotateOldFiles(file, Math.max(opts.maxFiles ?? 5, 1));
    }
    fs.appendFileSync(file, line, "utf8");
  } catch {
    // best-effort（拍板定案）：日志失败零影响主链路，绝不抛出。
  }
}
