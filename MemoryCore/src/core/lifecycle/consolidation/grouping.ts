/**
 * H 巩固 · 分组：把同"subject"的多条点状 L1 归组，符合阈值才触发巩固（TSM 思路）。
 * 纯逻辑、无副作用、可单测。阈值来自配置（memory.consolidation）。
 */
import type { MemoryRecord } from "../../record/l1-writer.js";
import { deriveAttributeKey, subjectOf } from "./attribute-key.js";
import { cosineSimilarity } from "../../hooks/soul-anchor-scorer.js";

// B1：subjectOf 实体已迁 attribute-key.ts（与 deriveAttributeKey 共用同一主语口径，
// 避免两套抽取漂移）；此处 re-export 保持既有 import 面不变。
export { subjectOf } from "./attribute-key.js";

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
  /** B1：属性键（entity|attribute）；仅属性归组产出，旧的 subject 归组保持 undefined。 */
  attributeKey?: string;
  entity?: string;
  attribute?: string;
}

/** B1：embedding 兜底默认阈值（与 config lifecycle.consolidation.attributeGrouping.minCos 缺省同值）。 */
export const DEFAULT_ATTRIBUTE_MIN_COS = 0.82;

/**
 * B1 防大卡：单张巩固卡最多吸收多少条源记忆。
 * 超过则按属性键均分切卡（后缀 #2/#3…，各自独立幂等/证据链），
 * 绝不把一整批同键记录压成一张巨卡——那正是 862 条反思合成一张卡的老病。
 */
export const MAX_RECORDS_PER_CARD = 50;

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

/** 属性归组选项：embedding 兜底阈值与向量来源（worker 侧异步 embed，本层保持纯同步）。 */
export interface AttributeGroupingOptions {
  /** cos ≥ minCos 才同簇；缺省 DEFAULT_ATTRIBUTE_MIN_COS。 */
  minCos?: number;
  /** 记录 id → 向量。缺向量/零向量的记录各自成组（不静默丢弃）。 */
  vectors?: ReadonlyMap<string, Float32Array>;
}

/** 待成组的中间态（属性键组或 embedding 簇）。 */
interface PendingGroup {
  subject: string;
  attributeKey?: string;
  entity?: string;
  attribute?: string;
  memories: MemoryRecord[];
}

/**
 * B1：只返回"属性键归一不了"的记录（进 embedding 待聚类池）。
 * worker 用它对池内记录按需 embed；导出以便单测与调用方保持同一判定口径。
 */
export function poolRecordsOf(memories: MemoryRecord[]): MemoryRecord[] {
  return (Array.isArray(memories) ? memories : []).filter((m) => deriveAttributeKey(m) === null);
}

/** 单链聚类：与簇内任一成员 cos ≥ minCos 即并入（可传递合并多个簇）。 */
function clusterByEmbedding(
  memories: MemoryRecord[],
  minCos: number,
  vectors?: ReadonlyMap<string, Float32Array>,
): MemoryRecord[][] {
  const clusters: Array<{ members: MemoryRecord[]; vecs: Float32Array[] }> = [];
  for (const m of memories) {
    const v = vectors?.get(String(m.id ?? ""));
    if (!v || v.length === 0) {
      clusters.push({ members: [m], vecs: [] });
      continue;
    }
    const hits: number[] = [];
    clusters.forEach((c, i) => {
      if (c.vecs.some((cv) => cosineSimilarity(cv, v) >= minCos)) hits.push(i);
    });
    if (hits.length === 0) {
      clusters.push({ members: [m], vecs: [v] });
      continue;
    }
    // 单链：命中多簇时全并入首簇（hits 升序，倒序 splice 保索引有效）
    const target = clusters[hits[0]];
    target.members.push(m);
    target.vecs.push(v);
    for (const i of hits.slice(1).reverse()) {
      const c = clusters[i];
      target.members.push(...c.members);
      target.vecs.push(...c.vecs);
      clusters.splice(i, 1);
    }
  }
  return clusters.map((c) => c.members);
}

/** 池簇的稳定 subject（无法归一时用最早记录 id 标识，便于日志/去重排查）。 */
function poolSubjectOf(cluster: MemoryRecord[]): string {
  const ids = cluster.map((m) => String(m.id ?? "")).filter(Boolean).sort();
  return `pool:${ids[0] ?? "unknown"}`;
}

/** minCount/租户/跨期校验 + 组内时间升序（与 groupBySubject 同口径，独立成函数以便切卡前后复算）。 */
function finalizePending(
  pending: PendingGroup,
  cfg: ConsolidationConfig,
  log?: { warn?: (msg: string) => void },
): ConsolidationGroup | null {
  const mems = pending.memories;
  if (mems.length < cfg.minCount) return null;
  const tenantKeys = new Set(mems.map((m) => tenantKeyOf(m)));
  if (tenantKeys.size > 1) {
    log?.warn?.(
      `[consolidation] mixed-tenant group dropped (key="${pending.subject}", tenants=${tenantKeys.size}, members=${mems.length})` +
        ` — 跨租户同键不串组（H-B2 数据级双保险）`,
    );
    return null;
  }
  const ts = mems.map(occurredTs).filter((t) => !Number.isNaN(t)).sort((a, b) => a - b);
  const spanDays = ts.length >= 2 ? (ts[ts.length - 1] - ts[0]) / 86_400_000 : 0;
  if (ts.length >= 2 && spanDays < cfg.minSpanDays) return null;
  const sorted = [...mems].sort((a, b) => (occurredTs(a) || 0) - (occurredTs(b) || 0));
  return {
    subject: pending.subject,
    attributeKey: pending.attributeKey,
    entity: pending.entity,
    attribute: pending.attribute,
    memories: sorted,
    earliestTs: ts[0] ?? 0,
    latestTs: ts[ts.length - 1] ?? 0,
  };
}

/** 防大卡切分：均分到 ceil(n/max) 段（60 条/50 上限 → 30+30，而不是 50+10）。 */
function splitChunks(memories: MemoryRecord[], max: number): MemoryRecord[][] {
  const n = memories.length;
  if (max <= 0 || n <= max) return [memories];
  const parts = Math.ceil(n / max);
  const base = Math.floor(n / parts);
  const rem = n - base * parts;
  const out: MemoryRecord[][] = [];
  let cursor = 0;
  for (let i = 0; i < parts; i++) {
    const size = base + (i < rem ? 1 : 0);
    out.push(memories.slice(cursor, cursor + size));
    cursor += size;
  }
  return out;
}

/**
 * B1：按 (entity, attribute) 归组，属性归一不了的记录进池内 embedding 单链聚类兜底。
 *
 * 与 groupBySubject 的差别只在"键"：键来自 deriveAttributeKey，池内簇用 cos ≥ minCos 连通。
 * 关闭开关时 worker 根本不走本函数（groupBySubject 行为逐位不变）。
 *
 * 防大卡：单组超过 MAX_RECORDS_PER_CARD 按序均分，后续段 subject/attributeKey 加 #2/#3 后缀，
 * 各自独立幂等（否则第二段会复用第一段的卡，又把巨卡合回来）。
 */
export function groupByAttribute(
  memories: MemoryRecord[],
  cfg: ConsolidationConfig = DEFAULT_CONSOLIDATION_CONFIG,
  log?: { warn?: (msg: string) => void },
  options: AttributeGroupingOptions = {},
): ConsolidationGroup[] {
  const list = Array.isArray(memories) ? memories : [];
  const minCos =
    typeof options.minCos === "number" && Number.isFinite(options.minCos)
      ? options.minCos
      : DEFAULT_ATTRIBUTE_MIN_COS;
  const byKey = new Map<string, PendingGroup>();
  const pool: MemoryRecord[] = [];
  for (const m of list) {
    const k = deriveAttributeKey(m);
    if (!k) {
      pool.push(m);
      continue;
    }
    const g = byKey.get(k.key) ?? {
      subject: k.key,
      attributeKey: k.key,
      entity: k.entity,
      attribute: k.attribute,
      memories: [],
    };
    g.memories.push(m);
    byKey.set(k.key, g);
  }
  const pending: PendingGroup[] = [...byKey.values()];
  for (const cluster of clusterByEmbedding(pool, minCos, options.vectors)) {
    pending.push({ subject: poolSubjectOf(cluster), memories: cluster });
  }

  const groups: ConsolidationGroup[] = [];
  for (const p of pending) {
    const group = finalizePending(p, cfg, log);
    if (!group) continue;
    const chunks = splitChunks(group.memories, MAX_RECORDS_PER_CARD);
    if (chunks.length === 1) {
      groups.push(group);
      continue;
    }
    chunks.forEach((members, i) => {
      const suffix = i === 0 ? "" : `#${i + 1}`;
      groups.push({
        ...group,
        subject: group.subject + suffix,
        attributeKey: group.attributeKey ? group.attributeKey + suffix : undefined,
        memories: members,
        earliestTs: occurredTs(members[0]) || group.earliestTs,
        latestTs: occurredTs(members[members.length - 1]) || group.latestTs,
      });
    });
  }
  groups.sort((a, b) => b.latestTs - b.earliestTs - (a.latestTs - a.earliestTs));
  return cfg.maxPerRun > 0 ? groups.slice(0, cfg.maxPerRun) : groups;
}
