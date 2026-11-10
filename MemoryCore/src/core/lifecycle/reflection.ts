/**
 * P3-F13：反思触发（Generative Agents 对标：importance 累计 > 阈值 → 强制反思式 L3 蒸馏）。
 *
 * 设计（spec §5 F13 / §2.8）：语义=触发生成时机增强，不新增管道——挂在 lifecycle-scheduler
 * pass 内；三问式（近期高显著记录 → 提最显著高层问题 → 检索证据 → 合成结论卡）；
 * 产物=普通 L3 结论卡（type=work_fact，scene_name=reflection，evidence_record_ids 引用
 * 证据指针；U5 零适配）。**状态自锚**：上次反思时间戳 = 本组最新反思结论卡的 updatedAt
 * （反思史即状态，零 schema 变更）；固定 interval 兜底由 consolidation 既有节拍承担。
 * 租户：批内记录租户去重聚合（与 forgetting 同式——全表扫描路径无单租户概念）；
 * work_fact 不入触发累计（防"反思的反思"自我 reinforce，与 consolidation 分组同原则）。
 */
import { embedForLifecycle } from "./embed-helpers.js";
import { bindSoulAtWrite } from "./consolidation/content-soul.js";
import { withEvidenceIds } from "./evidence-ids.js";
import type { MemoryRecord } from "../record/l1-writer.js";
import { validateConclusionCard } from "../hooks/soul-reflection-contract.js";
import { LINK_TYPES } from "../store/types.js";
import type { Logger } from "../types.js";

// 2026-11-07（T1 提案/pending 通道清除）：本文件的 proposal push 旁路（#27 self_identity /
// #44 promise_transition / D8 promise_create）、相似门、shadow 定标全部删除——反思只产 L3
// 结论卡，不再向任何 pending 池提案。人格/承诺由 core/soul worker 自维护直写
// （core/soul/worker.ts，T2）；任何人工采纳入口已不存在。

export interface ReflectionConfig {
  enabled: boolean;
  /** 自上次反思起新入库记录 significance 累计阈值（Generative Agents 对标缺省 150）。 */
  rRef: number;
  /** 单次反思最多产出的结论卡数（宁缺毋滥）。 */
  maxConclusions?: number;
  /** 反思输入样本窗（significance 降序 cap）。 */
  maxSample?: number;
}

export interface ReflectionDeps {
  queryL1: () => Promise<Array<Record<string, unknown>>>;
  config?: ReflectionConfig;
  store?: {
    upsertL1(record: unknown, embedding?: unknown): boolean | Promise<boolean>;
    /** #78 W-a（survey F4 small-to-big 上半段）：记忆图 L1↔L1 边写入（同 (s,t,type) ON CONFLICT 幂等）。可选：旧后端安静跳过。 */
    addLink?(sourceId: string, targetId: string, type: string, strength?: number, now?: string): boolean | Promise<boolean>;
  };
  /** R1（09-27 源头嵌入）：产物写入前嵌入；缺省/失败回退 metadata-only（补偿器兜底）。 */

  embeddingService?: { embed(t: string): Promise<Float32Array> } | null;
  llmRunner?: { run(p: { prompt: string; systemPrompt: string; taskId: string; timeoutMs: number; maxTokens: number }): Promise<string | undefined> | string | undefined };
  logger?: Logger;
  filter?: { teamId?: string; userId?: string; agentId?: string; taskId?: string };
}

const DEFAULTS = { rRef: 150, maxConclusions: 3, maxSample: 20 };

/**
 * #78 W-a 写面（survey F4 small-to-big 上半段；拍板 Q2=(a) 写面无条件补边）：
 * reflection 结论卡写卡成功后，对触发行集补 part_of 身世边（卡→证据，对齐
 * consolidation-worker「持续态→其点状证据」语义）。addLink 同 (s,t,type) 幂等
 * （ON CONFLICT 更新）；失败/返回 false → warn 软处理，缺能力 → debug 静默跳过；
 * 只新卡调用，存量卡零改动。返回成功写入（含幂等更新）的边数。
 */
export async function writeReflectionPartOfEdges(
  store: ReflectionDeps["store"],
  cardId: string,
  evidenceIds: readonly string[],
  logger?: Logger,
): Promise<number> {
  if (!store || typeof store.addLink !== "function") {
    logger?.debug?.("[reflection] W-a: store.addLink unavailable — skip part_of edges (旧后端安静跳过)");
    return 0;
  }
  const addLink = store.addLink;
  let written = 0;
  const seen = new Set<string>();
  for (const rawId of evidenceIds) {
    const evId = String(rawId ?? "").trim();
    if (!evId || evId === cardId || seen.has(evId)) continue;
    seen.add(evId);
    try {
      const ok = await Promise.resolve(addLink.call(store, cardId, evId, LINK_TYPES.PART_OF, 1));
      if (ok === false) {
        logger?.warn?.(`[reflection] W-a part_of edge soft-failed (returned false): card=${cardId} evidence=${evId}`);
        continue;
      }
      written++;
    } catch (err) {
      logger?.warn?.(`[reflection] W-a part_of edge soft-failed: card=${cardId} evidence=${evId} err=${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return written;
}

/** 三问式反思系统提示（Generative Agents 对标，spec §5 F13）。 */
export const REFLECTION_SYSTEM_PROMPT = [
  "你是团队记忆的反思引擎。给定近期高显著度记忆样本，执行 Generative Agents 三问式反思：",
  "1. 从样本中提炼 1-3 个最显著的高层问题（跨记录的模式，不复述单条事实）；",
  "2. 为每个问题指出支撑证据（逐字引用给出的 record_id）；",
  "3. 合成一张结论卡（100 字内，跳出对话依然成立，引用证据指针）。",
  "硬约束：结论必须由所给证据支撑，不得引入样本之外的新事实；宁缺毋滥。",
  "只输出 JSON 数组：[\"question\":\"…\",\"conclusion\":\"…\",\"evidence\":[\"record_id\",…]]，无合格结论输出 []。",
].join("\n");

/** 解析反思产出（宽松 JSON 提取，与 person/character 解析同风格）。 */
export function parseReflectionProposals(raw: string): Array<{ question: string; conclusion: string; evidence: string[] }> {
  const text = String(raw ?? "").trim();
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const arr = JSON.parse(text.slice(start, end + 1)) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
      .map((p) => ({
        question: typeof p.question === "string" ? p.question.trim() : "",
        conclusion: typeof p.conclusion === "string" ? p.conclusion.trim() : "",
        evidence: Array.isArray(p.evidence) ? p.evidence.map(String).filter((s) => s.length > 0) : [],
      }))
      .filter((p) => p.question.length > 0 && p.conclusion.length > 0);
  } catch {
    return [];
  }
}

interface Rec {
  id?: string;
  content?: string;
  type?: string;
  significance?: number;
  createdAt?: string;
  updatedAt?: string;
  created_time?: string;
  updated_time?: string;
  teamId?: string;
  userId?: string;
  agentId?: string;
  team_id?: string;
  user_id?: string;
  agent_id?: string;
}

function tenantKey(r: Rec, filter?: ReflectionDeps["filter"]): string {
  const teamId = String(r.teamId ?? r.team_id ?? filter?.teamId ?? "default");
  const userId = String(r.userId ?? r.user_id ?? filter?.userId ?? "default");
  const agentId = String(r.agentId ?? r.agent_id ?? filter?.agentId ?? "default");
  return `${teamId}|${userId}|${agentId}`;
}

export async function runReflection(deps: ReflectionDeps): Promise<{ triggered: number; cardsWritten: number; skipped: number }> {
  const cfg = deps.config;
  if (!cfg?.enabled) return { triggered: 0, cardsWritten: 0, skipped: 0 };
  if (!deps.store?.upsertL1 || !deps.llmRunner) return { triggered: 0, cardsWritten: 0, skipped: 0 };
  const rRef = Number.isFinite(cfg.rRef) ? cfg.rRef : 150;
  const maxSample = cfg.maxSample ?? 20;
  const maxConclusions = cfg.maxConclusions ?? 3;

  const records = (await deps.queryL1()) as Array<Rec>;
  if (!Array.isArray(records) || records.length === 0) return { triggered: 0, cardsWritten: 0, skipped: 0 };

  const byTenant = new Map<string, { triple: { teamId: string; userId: string; agentId: string }; rows: Array<Rec> }>();
  for (const r of records) {
    const key = tenantKey(r, deps.filter);
    let g = byTenant.get(key);
    if (!g) {
      const [teamId, userId, agentId] = key.split("|");
      g = { triple: { teamId, userId, agentId }, rows: [] };
      byTenant.set(key, g);
    }
    g.rows.push(r);
  }

  let triggered = 0;
  let cardsWritten = 0;
  // #77 Batch D：结论卡校验门拒收计数（跨租户累加，终值随 return 暴露供可观测）。
  let skipped = 0;
  for (const { triple, rows } of byTenant.values()) {
    // #27：证据指针 → 原文内容映射（样本源即证据源；幻觉 id 无内容→去原文门按可用证据裁决）
    const contentById = new Map(rows.map((r) => [String(r.id ?? ""), String(r.content ?? "")]));
    // 反思史即状态：最新反思结论卡的 updatedAt = 上次反思时间戳
    // 时间戳键：camelCase（MemoryRecord 形）与 snake_case（裸行）双兼容——
    // scheduler 的 mapL1RowToRecord 只展开原始行，updatedAt/createdAt 可能缺位。
    const rowUpdated = (r: Rec): string => String(r.updatedAt ?? r.updated_time ?? r.createdAt ?? r.created_time ?? "");
    const lastReflectionAt = rows
      .filter((r) => r.type === "work_fact" && (r as { metadata?: { reflection?: boolean } }).metadata?.reflection === true)
      .map((r) => rowUpdated(r))
      .filter((s) => s.length > 0)
      .sort()
      .at(-1) ?? "";
    const newRows = rows.filter((r) => {
      if (r.type === "work_fact") return false; // 持续态不入触发累计（防自我 reinforce）
      return rowUpdated(r) > lastReflectionAt;
    });
    const sumSig = newRows.reduce((acc, r) => acc + (Number(r.significance) || 0), 0);
    if (sumSig <= rRef) continue;
    triggered++;
    const sample = [...newRows]
      .sort((a, b) => (Number(b.significance) || 0) - (Number(a.significance) || 0))
      .slice(0, maxSample);
    const promptLines: string[] = ["【近期记忆样本（record_id | significance | 内容）】"];
    for (const r of sample) promptLines.push(`- ${String(r.id ?? "")} | ${Number(r.significance) || 0} | ${String(r.content ?? "").slice(0, 160)}`);
    promptLines.push("");
    promptLines.push("请按三问式输出反思结论 JSON 数组（字段：question/conclusion/evidence）。无合格结论输出 []。");
    const raw = await deps.llmRunner.run({ prompt: promptLines.join("\n"), systemPrompt: REFLECTION_SYSTEM_PROMPT, taskId: "reflection-l3", timeoutMs: 0, maxTokens: 0 });
    deps.logger?.debug?.(`[reflection] tenant=${JSON.stringify([triple.teamId, triple.userId, triple.agentId])} rawLen=${String(raw ?? "").length} rawPreview=${String(raw ?? "").slice(0, 200)}`);
    const proposals = parseReflectionProposals(String(raw ?? "")).slice(0, maxConclusions);
    const now = new Date().toISOString();
    for (const pr of proposals) {
      // #77 Batch D（survey F1）：结论卡确定性校验门——空/超 300 码点拒收（D8 门只裁决不创作；
      // 语义拆分属 LLM few-shot 职责）。skipped 并入返回值供可观测。
      const gate = validateConclusionCard(pr.conclusion);
      if (!gate.ok) {
        skipped++;
        deps.logger?.warn?.(`[reflection] conclusion card rejected: ${gate.reason} len=${Array.from(String(pr.conclusion ?? "")).length}`);
        continue;
      }
      // 终测实证（D-R5-6 续）：真实 store.upsertL1 静默返回 false——MemoryRecord 必填
      // 会话/版本/确信度字段缺位（probe 的 mock store 掩盖）。补齐与 consolidation
      // 持续态同形（work_fact/observed 先例）：sessionKey/sessionId/version/certainty。
      const rec = {
        id: `rf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        content: pr.conclusion,
        type: "work_fact",
        priority: 80,
        scene_name: "reflection",
        source_message_ids: [],
        // WP7（#155 写面）：证据指针键名单源化——canonical evidence_ids + 兼容别名
        // evidence_record_ids 双写（同一份 id 集合）。gateway/atomic-by-ids.ts 只读
        // evidence_ids、auto-recall 只读 evidence_record_ids，单写一个键就有读面取不到证据。
        metadata: withEvidenceIds(
          { reflection: true, question: pr.question, subject: "反思结论" },
          pr.evidence,
        ) as unknown as MemoryRecord["metadata"],
        timestamps: [now],
        createdAt: now,
        updatedAt: now,
        teamId: triple.teamId,
        userId: triple.userId,
        agentId: triple.agentId,
        sessionKey: `reflection:${triple.teamId}:${triple.userId}:${triple.agentId}`,
        sessionId: `reflection-${Date.now()}`,
        taskId: "",
        version: 1,
        certainty: "observed",
      };
      // Batch C C-a（#77）：写链 soul 合标统一——本写链直调 store.upsertL1 绕过
      // l1-writer choke point，生产实证 340/340 空 occurred_at 全部来自本链
      // （scene_name=reflection）。bindSoulAtWrite 只填空字段：certainty 已有
      // → 零变化；occurred_at=now（真实记录时刻）；情感/重要性规则照常。
      bindSoulAtWrite(rec);
      const ok = await Promise.resolve(deps.store.upsertL1(rec, await embedForLifecycle(deps.embeddingService, String(rec.content ?? ""), "[reflection]", deps.logger)));
      if (ok) {
        cardsWritten++;
        // #78 W-a：写卡成功 → 触发行集 part_of 身世边。只对检索触发行写边
        // （contentById 过滤幻觉 id）；软失败不阻塞写卡主链路；存量卡零改动。
        const edgeN = await writeReflectionPartOfEdges(deps.store, rec.id, pr.evidence.filter((id) => contentById.has(String(id))), deps.logger);
        deps.logger?.debug?.(`[reflection] W-a part_of edges card=${rec.id} written=${edgeN}/${pr.evidence.length}`);
      }
    }
  }
  return { triggered, cardsWritten, skipped };
}
void DEFAULTS;
