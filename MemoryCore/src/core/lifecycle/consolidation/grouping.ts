/**
 * H 巩固 · 分组：把同"subject"的多条点状 L1 归组，符合阈值才触发巩固（TSM 思路）。
 * 纯逻辑、无副作用、可单测。阈值来自配置（memory.consolidation）。
 */
import type { MemoryRecord } from "../../record/l1-writer.js";

export interface ConsolidationConfig {
  enabled: boolean;
  /** 组内至少多少条才巩固 */
  minCount: number;
  /** 跨期至少多少天（occurred_at 跨度）才巩固，避免过早撮合 */
  minSpanDays: number;
  /** 单次运行最多处理多少个组（成本护栏） */
  maxPerRun: number;
}

export const DEFAULT_CONSOLIDATION_CONFIG: ConsolidationConfig = {
  enabled: true,
  minCount: 3,
  minSpanDays: 1,
  maxPerRun: 20,
};

/** 观察 vs 推断：是否可在巩固/重缝合时动它（reconsolidation 只动 observed 层） */
export function isObservable(m: { certainty?: string }): boolean {
  return (m.certainty ?? "observed") !== "inferred";
}

export interface ConsolidationGroup {
  subject: string;
  memories: MemoryRecord[];
  /** 组内最早的 occurred_at（ISO，用于判定跨期跨度） */
  earliestTs: number;
  latestTs: number;
}

/**
 * P2-T14（H-B2 数据级双保险）：租户一致性键。
 * 读 camelCase（MemoryRecord 权威字段）；兜底读 snake_case（lifecycle-scheduler
 * 派生行直接展开 L1RecordRow 时 snake_case 仍在对象上）。缺省视为 ""。
 */
function tenantKeyOf(m: unknown): string {
  const r = m as { teamId?: string; userId?: string; agentId?: string; team_id?: string; user_id?: string; agent_id?: string };
  const teamId = r.teamId ?? r.team_id ?? "";
  const userId = r.userId ?? r.user_id ?? "";
  const agentId = r.agentId ?? r.agent_id ?? "";
  return `${teamId}\u0000${userId}\u0000${agentId}`;
}

function occurredTs(m: MemoryRecord): number {
  if (m.metadata && typeof m.metadata === "object") {
    const t = (m.metadata as Record<string, unknown>).activity_start_time
      ?? (m.metadata as Record<string, unknown>).occurred_at
      ?? (m.metadata as Record<string, unknown>).timestamp;
    if (typeof t === "string" && t) return new Date(t).getTime();
  }
  const ts = m.timestamps?.[0];
  if (ts) return new Date(ts).getTime();
  return Number.NaN;
}

/** 从一条记忆内容提取"主体/归并键"。保守规则：取首个顿号/冒号前，或前 N 字符主题词。 */
export function subjectOf(m: MemoryRecord, maxLen = 24): string {
  const c = m.content ?? "";
  if (!c) return "unknown";
  for (const sep of ["：", ":", " — "]) {
    const idx = c.indexOf(sep);
    if (idx > 0 && idx <= maxLen) return c.slice(0, idx).trim();
  }
  const n = Math.min(Math.max(4, maxLen), c.length);
  return c.slice(0, n);
}

/** T17-B（H1，拍板④）：归组策略——llm=语义 subject 优先词法兜底（默认）；lexical=纯词法前缀。 */
export type SubjectStrategy = "llm" | "lexical";

/**
 * T17-B：LLM 语义归组键——读源记忆 metadata.subject（dedup LLM 顺带抽取，T17-A）。
 * 非空字符串才返回；缺省/空串 → null（调用方词法兜底）。
 * 注意与 durative 的 metadata.subject（幂等键，existingDurativeOf 读 scene_name=consolidated
 * 的行）同名不同行：这里只读源记忆，消费方互不冲突。
 */
export function subjectOfLlm(m: MemoryRecord): string | null {
  const meta = m.metadata as Record<string, unknown> | undefined;
  const s = meta?.subject;
  return typeof s === "string" && s.trim() ? s.trim() : null;
}

/**
 * 按 subject 将 memories 分组，仅返回满足 minCount 与跨期(minSpanDays) 的组。
 * 组内排序：发生时间升序（便于后续熬成持续态）。
 *
 * P3-T17（H1，拍板④）策略门（渐进叠加，默认 "llm"）：
 *   - "llm"     = subjectOfLlm(m) ?? subjectOf(m)——有 dedup LLM 抽的语义 subject 用之，
 *                 缺省词法兜底（存量无 subject 的记忆仍可词法归组，行为不变）。
 *   - "lexical" = 纯 subjectOf（字面量前缀，修复前的行为）。
 *
 * P2-T14（H-B2 数据级双保险）：组内出现 >1 种 (teamId,userId,agentId) 组合 →
 * 整组丢弃 + warn（跨租户同前缀 subject 不得串组——B 租户内容不能进 A 租户的
 * 摘要/证据链）。filter 是部署级（读侧收窄），这里是数据级（组内校验），双保险。
 */
export function groupBySubject(
  memories: MemoryRecord[],
  cfg: ConsolidationConfig = DEFAULT_CONSOLIDATION_CONFIG,
  log?: { warn?: (msg: string) => void },
  strategy: SubjectStrategy = "llm",
): ConsolidationGroup[] {
  const map = new Map<string, MemoryRecord[]>();
  for (const m of memories) {
    const s = strategy === "lexical" ? subjectOf(m) : (subjectOfLlm(m) ?? subjectOf(m));
    const arr = map.get(s) ?? [];
    arr.push(m);
    map.set(s, arr);
  }
  const groups: ConsolidationGroup[] = [];
  for (const [subject, mems] of map) {
    if (mems.length < cfg.minCount) continue;
    // P2-T14：组内租户一致性校验（守卫在咽喉——进组唯一出口）
    const tenantKeys = new Set(mems.map((m) => tenantKeyOf(m)));
    if (tenantKeys.size > 1) {
      log?.warn?.(
        `[consolidation] mixed-tenant group dropped (subject="${subject}", tenants=${tenantKeys.size}, members=${mems.length})` +
          ` — 跨租户同前缀 subject 不串组（H-B2 数据级双保险）`,
      );
      continue;
    }
    const ts = mems.map(occurredTs).filter((t) => !Number.isNaN(t)).sort((a, b) => a - b);
    const spanDays = ts.length >= 2 ? (ts[ts.length - 1] - ts[0]) / 86_400_000 : 0;
    if (ts.length >= 2 && spanDays < cfg.minSpanDays) continue;
    const sorted = [...mems].sort((a, b) => (occurredTs(a) || 0) - (occurredTs(b) || 0));
    groups.push({
      subject,
      memories: sorted,
      earliestTs: ts[0] ?? 0,
      latestTs: ts[ts.length - 1] ?? 0,
    });
  }
  // 按跨度从大到小（优先合并时间跨度大的成熟主题）
  groups.sort((a, b) => b.latestTs - b.earliestTs - (a.latestTs - a.earliestTs));
  return cfg.maxPerRun > 0 ? groups.slice(0, cfg.maxPerRun) : groups;
}