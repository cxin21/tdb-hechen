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
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { embedForLifecycle } from "./embed-helpers.js";
import { bindSoulAtWrite } from "./consolidation/content-soul.js";
import { withEvidenceIds } from "./evidence-ids.js";
import type { MemoryRecord } from "../record/l1-writer.js";
import { bestVerbatimOverlapLen, proposalAlreadyKnown, vetReflectionIdentityProposal, VERBATIM_FRAGMENT_MIN_CHARS } from "./soul-reflection-proposals.js";
import { buildSelfIdentityMarkers, similarSelfIdentityProposalExists, similarSelfIdentityProposalMatch, SIM_GATE_DEFAULT_THRESHOLD, type SelfIdentityMarker } from "./proposal-sim-gate.js";
import { vetPromiseCreationProposal, vetPromiseTransitionProposal } from "../hooks/soul-promise-proposal.js";
import { REFLECTION_CARD_CONTRACT_PROMPT, REFLECTION_CONCLUSION_CONTRACT_PROMPT, labelsFromCoreValueRows, validateConclusionCard, validateReflectionCardContract } from "../hooks/soul-reflection-contract.js";
import type { Logger } from "../types.js";

// #ε-定标（ADR0003 D7）：shadow 定标旁路（行为零变化）——被判定提案的 best verbatim
// overlap 以 JSONL 逐行追加，供 ε 定量阈值先看分布再定标（不拍脑袋阈值）。
// fail-safe：任何写错误只 warn 一次（每文件路径一次），随后静默降级，绝不抛进提案流程；
// sync fs（无未处理 rejection）。shadow off / 门 off = 零调用 = 逐位现状。
const shadowDegradedPaths = new Set<string>();

function appendShadowCalibrationRow(
  file: string,
  row: { ts: string; slot: string; verdict: "accepted" | "rejected"; bestLen: number; verbatimGate: number },
  logger?: Logger,
): void {
  const target = resolve(process.cwd(), file);
  if (shadowDegradedPaths.has(target)) return; // 已降级：同一路径不再重试不再刷屏
  try {
    mkdirSync(dirname(target), { recursive: true });
    appendFileSync(target, `${JSON.stringify(row)}\n`, "utf8");
  } catch (err) {
    shadowDegradedPaths.add(target);
    logger?.warn?.(`[reflection] shadow calibration write failed (degraded, non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface ReflectionConfig {
  enabled: boolean;
  /** 自上次反思起新入库记录 significance 累计阈值（Generative Agents 对标缺省 150）。 */
  rRef: number;
  /** 单次反思最多产出的结论卡数（宁缺毋滥）。 */
  maxConclusions?: number;
  /** 反思输入样本窗（significance 降序 cap）。 */
  maxSample?: number;
  /** #27（R5）：反思结论 → 身份层提案（O13 rail）桥接门；缺省 false=零提案=逐位现状。 */
  soulProposals?: {
    enabled?: boolean;
    shadowCalibration?: { enabled?: boolean; file?: string };
    /** #60（S22，2026-10-18）：产物契约门（D6 禁伪造当下体验+第一人称+价值锚引用）；缺省 false=逐位现状。 */
    cardContract?: { enabled?: boolean };
    /** #77 Batch D（survey F1）：结论卡原子性契约门（一句话一件事拆条引导）；缺省 false=逐位现状。 */
    conclusionContract?: { enabled?: boolean };
  };
  /** #44（D8-(c)）：反思周期 → promise 迁移提案桥接门；缺省 false=逐位现状。 */
  promiseProposals?: { enabled?: boolean };
  /**
   * #81（拍板 2026-10-21）：self_identity 提案相似门 + 生成端抑制——闸门缺省开（拍板②）、
   * 抑制缺省开（拍板③）、阈值缺省 0.65 config 可配（拍板①）。降级合同见 proposal-sim-gate.ts。
   */
  selfIdentityGate?: {
    enabled?: boolean;
    threshold?: number;
    suppression?: { enabled?: boolean; maxPending?: number };
    /** #91：复现即投票+默认终局——缺省 false=逐位现状（Exists 原路径）；votes/ttlHours 缺省 3/24（票面标定 N=3/T=24h）。spanHours：ready 晋升跨度（缺省跟随 ttlHours；返工拍板拆键，TTL 管过期、span 管晋升）。 */
    recurrence?: { enabled?: boolean; votes?: number; ttlHours?: number; spanHours?: number };
    /** #91 K 阀（2026-10-24 拍板「剩余两项」）：源头硬闸缺省 off=逐位现状；窗口内该租户 self_identity 新落库 >= maxNew → push 支路跳过落库。maxNew 标定 12（人工带宽口径）、窗口缺省 24h。 */
    rateLimit?: { enabled?: boolean; maxNew?: number; windowHours?: number };
    /** #92 stage 2（2026-10-25 拍板四项）：确定性自动采纳门缺省 off=逐位现状（晋升只到 ready，人审不变）。votes/spanHours=N₂/T₂ 缺省 4/72（比 ready 严一票，跨 3 天复现才够格）；contradictionThreshold=同主题 rejected 矛盾线缺省 0.60（宁拦勿收）；dupThreshold=槽内重复线缺省 0.75（单一源标准）。 */
    autoAdopt?: { enabled?: boolean; votes?: number; spanHours?: number; contradictionThreshold?: number; dupThreshold?: number };
  };
}

export interface ReflectionDeps {
  queryL1: () => Promise<Array<Record<string, unknown>>>;
  config?: ReflectionConfig;
  store?: {
    upsertL1(record: unknown, embedding?: unknown): boolean | Promise<boolean>;
    /** #78 W-a（survey F4 small-to-big 上半段）：记忆图 L1↔L1 边写入（同 (s,t,type) ON CONFLICT 幂等）。可选：旧后端安静跳过。 */
    addLink?(sourceId: string, targetId: string, type: string, strength?: number, now?: string): boolean | Promise<boolean>;
    /** #27：O13 rail 桥接可选面（缺实现→桥接安静跳过，采纳侧人工裁决兜底）。 */
    upsertPendingCore?(slot: string, content: string, evidence: number, tenant?: unknown, extra?: { label?: string; description?: string; attrs?: Record<string, unknown>; reproposalOf?: string; reproposalGen?: number }): boolean | Promise<boolean>;
    listPendingCore?(tenant?: unknown, opts?: { includeDecided?: boolean }): Array<{ pending_id: string; slot: string; content: string; state: string; attrs_json?: string | null }> | Promise<Array<{ pending_id: string; slot: string; content: string; state: string; attrs_json?: string | null }>>;
    /** #44：promise 提案桥可选面（缺实现→桥接优雅跳过，采纳侧人工裁决兜底）。 */
    listSoulPromises?(tenant?: unknown, opts?: { status?: string; limit?: number }): Array<{ promiseId: string; content?: string; status: string; refKey?: string }> | Promise<Array<{ promiseId: string; content?: string; status: string; refKey?: string }>>;
    readCore?(tenant?: unknown): Array<{ slot: string; content: string }> | Promise<Array<{ slot: string; content: string }> | null> | null;
    /** #91：复现即投票三方法可选面（缺实现→调用方降级不计票不 init，宁漏勿误）。 */
    updatePendingRecurrence?(pendingId: string, episode: { ts?: string; content?: string; evidenceRecordIds?: string[]; embedding?: number[] }, opts?: { votesN?: number; spanHours?: number; tenant?: unknown }): { count: number; first_seen: string; last_seen: string; ready: boolean; revived: boolean } | null | Promise<{ count: number; first_seen: string; last_seen: string; ready: boolean; revived: boolean } | null>;
    initPendingRecurrenceByContent?(slot: string, content: string, tenant?: unknown, episode?: { ts?: string; content?: string; evidenceRecordIds?: string[]; embedding?: number[] }): { count: number; first_seen: string; last_seen: string; ready: boolean; revived: boolean } | null | Promise<{ count: number; first_seen: string; last_seen: string; ready: boolean; revived: boolean } | null>;
    /** #91 K 阀（2026-10-24）：窗口内该租户 self_identity 新落库行数（缺实现→阀门旁路，宽容降级=现状）。 */
    countSelfIdentityRecent?(tenant?: unknown, windowHours?: number): number | Promise<number>;
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
      const ok = await Promise.resolve(addLink.call(store, cardId, evId, "part_of", 1));
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
export function parseReflectionProposals(raw: string): Array<{ question: string; conclusion: string; evidence: string[]; echoKey: string; promiseTransitions: Array<{ promiseId: string; to: string; reason: string }>; promiseCreations: Array<{ content: string }> }> {
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
        // #91 返工（M-marker 路由）：宽松解析产卡 echo_key 指认（缺失/非法 → 空串=无指认）。
        echoKey: typeof p.echo_key === "string" ? p.echo_key.trim() : "",
        evidence: Array.isArray(p.evidence) ? p.evidence.map(String).filter((s) => s.length > 0) : [],
        // #44（D-44-1）：可选 promiseTransitions 提议（宽松解析，非法项由确定性门拒绝）。
        promiseTransitions: Array.isArray(p.promiseTransitions)
          ? (p.promiseTransitions as unknown[])
              .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
              .map((t) => ({
                promiseId: typeof t.promiseId === "string" ? t.promiseId.trim() : "",
                to: typeof t.to === "string" ? t.to.trim() : "",
                reason: typeof t.reason === "string" ? t.reason.trim() : "",
              }))
              .filter((t) => t.promiseId.length > 0 || t.to.length > 0 || t.reason.length > 0)
          : [],
        // D8 创建通道：可选 promiseCreations 提议（宽松解析同 promiseTransitions，非法项由确定性门拒绝）。
        promiseCreations: Array.isArray(p.promiseCreations)
          ? (p.promiseCreations as unknown[])
              .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
              .map((c) => ({
                content: typeof c.content === "string" ? c.content.trim() : "",
              }))
              .filter((c) => c.content.length > 0)
          : [],
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

export async function runReflection(deps: ReflectionDeps): Promise<{ triggered: number; cardsWritten: number; proposalsPushed: number; simGated: number; echoVotes: number; echoSkipped: number; promiseProposalsPushed: number; promiseCreationsPushed: number; skipped: number; recurrenceVotes: number; rateLimitSkipped: number; gateDegraded: number }> {
  const cfg = deps.config;
  if (!cfg?.enabled) return { triggered: 0, cardsWritten: 0, proposalsPushed: 0, simGated: 0, echoVotes: 0, echoSkipped: 0, promiseProposalsPushed: 0, promiseCreationsPushed: 0, skipped: 0, recurrenceVotes: 0, rateLimitSkipped: 0, gateDegraded: 0 };
  if (!deps.store?.upsertL1 || !deps.llmRunner) return { triggered: 0, cardsWritten: 0, proposalsPushed: 0, simGated: 0, echoVotes: 0, echoSkipped: 0, promiseProposalsPushed: 0, promiseCreationsPushed: 0, skipped: 0, recurrenceVotes: 0, rateLimitSkipped: 0, gateDegraded: 0 };
  const rRef = Number.isFinite(cfg.rRef) ? cfg.rRef : 150;
  const maxSample = cfg.maxSample ?? 20;
  const maxConclusions = cfg.maxConclusions ?? 3;

  const records = (await deps.queryL1()) as Array<Rec>;
  if (!Array.isArray(records) || records.length === 0) return { triggered: 0, cardsWritten: 0, proposalsPushed: 0, simGated: 0, echoVotes: 0, echoSkipped: 0, promiseProposalsPushed: 0, promiseCreationsPushed: 0, skipped: 0, recurrenceVotes: 0, rateLimitSkipped: 0, gateDegraded: 0 };

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
  let proposalsPushed = 0;
  let promiseProposalsPushed = 0;
  let promiseCreationsPushed = 0;
  // #81：相似门拦截计数（跨租户累加，随 return 暴露供可观测）。
  let simGated = 0;
  // #91：复现即投票计票数（跨租户累加；同拍多提案命中同一 pending 行只计一票）。
  let recurrenceVotes = 0;
  // #91 返工（M-marker 路由）：echo 指认计数——命中 pending 计票 / 命中 core 跳过（跨租户累加）。
  let echoVotes = 0;
  let echoSkipped = 0;
  // #91 K 阀/provider 治理（2026-10-24）：阀门跳过计数 + sim-gate 降级放行计数（拍级日志可观测）。
  let rateLimitSkipped = 0;
  let gateDegraded = 0;
  const soulProposalsOn = cfg.soulProposals?.enabled === true;
  // #81（拍板②①）：相似门缺省开；阈值 0.65 config 可配。
  const simGateOn = cfg.selfIdentityGate?.enabled !== false;
  const simGateThreshold = cfg.selfIdentityGate?.threshold ?? SIM_GATE_DEFAULT_THRESHOLD;
  // #81（拍板③）：生成端抑制缺省开；maxPending 缺省 20。
  const simSuppressionOn = cfg.selfIdentityGate?.suppression?.enabled !== false;
  const simSuppressionMaxPending = cfg.selfIdentityGate?.suppression?.maxPending;
  // #91：复现即投票门（缺省 false=逐位现状）；votes/ttlHours 票面标定缺省 3/24。
  const recOn = cfg.selfIdentityGate?.recurrence?.enabled === true;
  const recVotes = Math.max(1, Math.floor(cfg.selfIdentityGate?.recurrence?.votes ?? 3));
  const recTtlHours = Math.max(0, cfg.selfIdentityGate?.recurrence?.ttlHours ?? 24);
  // #91 返工：晋升跨度与 TTL 拆键——spanHours 缺省跟随 recTtlHours（C1 回归锚 24 不变）
  const recSpanHours = Math.max(0, cfg.selfIdentityGate?.recurrence?.spanHours ?? recTtlHours);
  // #91 K 阀（2026-10-24）：源头硬闸缺省 off=逐位现状；maxNew 标定 12、窗口缺省 24h。
  const rateLimitOn = cfg.selfIdentityGate?.rateLimit?.enabled === true;
  const rateLimitMaxNew = Math.max(1, Math.floor(cfg.selfIdentityGate?.rateLimit?.maxNew ?? 12));
  const rateLimitWindowHours = Math.max(0, cfg.selfIdentityGate?.rateLimit?.windowHours ?? 24);
  // #44（D-44-3）：promise 提案桥接门（缺省 false=逐位现状：零提示词段、零 store 调用、零提案）
  const promiseProposalsOn = cfg.promiseProposals?.enabled === true;
  for (const { triple, rows } of byTenant.values()) {
    // #27：证据指针 → 原文内容映射（样本源即证据源；幻觉 id 无内容→去原文门按可用证据裁决）
    const contentById = new Map(rows.map((r) => [String(r.id ?? ""), String(r.content ?? "")]));
    // #91 K 阀（2026-10-24 拍板「剩余两项」）：窗口内该租户 self_identity 新落库 >= maxNew →
    // push 支路跳过落库（只拦未路由新行；echo/计票/sim-gated 路径不经过此处，fail 方向=少落库）。
    // store 缺方法/计数异常 → 旁路（宽容降级=现状逐位）。
    const rateLimitBlocksPush = async (slot: string, content: string): Promise<boolean> => {
      if (!rateLimitOn || slot !== "self_identity") return false;
      let recent = 0;
      try {
        const n = await Promise.resolve(deps.store?.countSelfIdentityRecent?.(triple, rateLimitWindowHours));
        if (typeof n === "number" && Number.isFinite(n)) recent = n;
      } catch (err) {
        deps.logger?.warn?.(`[reflection] rate-limit count failed (non-fatal, bypass): ${err instanceof Error ? err.message : String(err)}`);
        return false;
      }
      if (recent < rateLimitMaxNew) return false;
      rateLimitSkipped++;
      deps.logger?.info?.(`[reflection] soul proposal rate-limit skipped (recent=${recent} >= max=${rateLimitMaxNew} in ${rateLimitWindowHours}h): ${content.slice(0, 60)}`);
      return true;
    };
    // #91：同拍双提案命中同一 pending 行只计一票（per-run per-tenant 去重；独立 episode 由 store 侧合并）。
    const votedPids = new Set<string>();
    // #44（D-44-1）：在途承诺仅在 gate on 时拉取（gate off=零 store 调用=逐位现状）
    const openPromises: Array<{ promiseId: string; content?: string; status: string; refKey?: string }> = promiseProposalsOn
      ? ((await Promise.resolve(deps.store.listSoulPromises?.(triple, { status: "open" }))) ?? [])
      : [];
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
    // #44（D-44-1）：在途承诺段仅当 gate on 且存在 open promise（gate off=提示词逐位现状）
    if (promiseProposalsOn && openPromises.length > 0) {
      promptLines.push("【在途承诺（promise_id | 内容 | refKey）】");
      for (const p of openPromises.slice(0, 20)) promptLines.push(`- ${p.promiseId} | ${String(p.content ?? "").slice(0, 80)} | ${String(p.refKey ?? "")}`);
      promptLines.push("如样本证据显示某在途承诺已兑现或已失约，可在对应结论卡附 promiseTransitions 数组（字段 promiseId/to/reason；to 仅限 kept|broken|withdrawn；reason ≤100 字说明证据依据）。无证据依据不提议。");
    }
    // D8 创建通道：创建指引仅当 gate on（不要求 open promise 存在——第一条承诺就是从无到有）；
    // 只提明确、可验证的承诺；无承诺语义/宽泛意向不提议（宁缺毋滥，确定性门在解析侧兜底）。
    if (promiseProposalsOn) {
      promptLines.push(
        "若近期样本显示助手作出了明确、可验证的承诺（例：「我会修复 X」「下次先跑测试再合并」），可在对应结论卡附 promiseCreations 数组（字段 content，≤120 字）；无明确承诺语义不提议，宽泛意向（如「我会努力」「尽量」）不提议。",
      );
    }
    // #60（S22，2026-10-18）：产物契约提示——cardContract on 才附加（off = prompt 逐位现状）。
    if (cfg.soulProposals?.cardContract?.enabled === true) {
      promptLines.push(REFLECTION_CARD_CONTRACT_PROMPT);
    }
    // #77 Batch D（survey F1）：结论卡拆条引导——conclusionContract on 才附加（off = prompt 逐位现状）。
    if (cfg.soulProposals?.conclusionContract?.enabled === true) {
      promptLines.push(REFLECTION_CONCLUSION_CONTRACT_PROMPT);
    }
    // #81（拍板③）：生成端同主题抑制——soulProposals on 且 suppression 未关时注入「已有身份认知」段
    // （槽行+在途 pending，语义相近不得再提）。store 缺方法/抛错/无内容 → [] 不注入（降级=逐位现状）。
    // #91 返工（M-marker 路由）：清单行带 [M#] 编号 + 保存 marker 映射（产卡 echo_key 指认回路的路由依据）。
    // suppression off / 映射空 → echo_key 全部落 fallback（保守走 Match 原路径，fail 方向=多落库人工门纠正）。
    let selfIdentityMarkers: SelfIdentityMarker[] = [];
    if (soulProposalsOn && simSuppressionOn) {
      const markerRes = await buildSelfIdentityMarkers({
        store: deps.store,
        tenant: triple,
        maxPending: simSuppressionMaxPending,
        logger: deps.logger,
      });
      selfIdentityMarkers = markerRes.markers;
      if (markerRes.lines.length > 0) {
        promptLines.push("");
        for (const line of markerRes.lines) promptLines.push(line);
      }
    }
    if (simGateOn && recOn && selfIdentityMarkers.length > 0) {
      // #91 返工（M-marker 路由）：recurrence on 才指引 echo_key（flag 关 → prompt 逐位现状）。
      promptLines.push("若某条结论与上方已有认知清单中某条 [M#] 同义（场景不同、内核相同），在该条目对象加字段 echo_key 填对应编号（如 \"echo_key\":\"M3\"）；清单无对应条目则不输出 echo_key。");
    }
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
      // #27（R5）：反思结论 → 身份层提案（O13 rail）。门 on 才启用；确定性门
      // （slot 白名单→安全阀→证据非空→去 L1 原文→重复抑制）逐条裁决，被拒只记日志
      // 不抛（反思主路径零影响）。提案内容=结论卡原文直出（不做 LLM 改写）；
      // 采纳侧沿用 decidePendingCore→mergeIdentityFacts；identity 变更→sv 变化→
      // 渲染路径 #30 快照全量落账（调度单一源：F13 触发+consolidation 节拍，零新调度器）。
      if (ok && soulProposalsOn) {
        try {
          // #60（S22，2026-10-18）：产物契约门（先于 vet；config-first 缺省 off=逐位现状）。
          // D6 禁伪造当下体验 + 第一人称 + 价值锚引用（锚集=readCore 的 core_value 行，
          // 读失败/缺实现降级空锚集=跳过锚校验）；通过 → anchor_refs 并入 attrs
          // （契约 on 恒带键，空数组也带——采纳侧可区分「锚集缺失降级」与「未接线」）；
          // 拒绝只记日志不推提案（promise 提案段不受影响；契约拒不产 shadow 行——
          // shadow 是 vet 定标旁路，契约门先挡则 vet 未跑）。
          const contractOn = cfg.soulProposals?.cardContract?.enabled === true;
          let anchorRefs: string[] = [];
          let contractOk = true;
          if (contractOn) {
            let labels: string[] = [];
            try {
              const coreRows = (await Promise.resolve(deps.store.readCore?.(triple))) ?? [];
              labels = labelsFromCoreValueRows(Array.isArray(coreRows) ? (coreRows as Array<{ slot: string; content: string }>) : []);
            } catch {
              labels = [];
            }
            const contract = validateReflectionCardContract({ content: pr.conclusion, validAnchorLabels: labels });
            if (!contract.ok) {
              contractOk = false;
              deps.logger?.info?.(`[reflection] soul proposal contract rejected (${String(contract.reason).slice(0, 80)}): ${pr.conclusion.slice(0, 60)}`);
            } else {
              anchorRefs = contract.anchorRefs;
            }
          }
          const verdict = contractOk
            ? vetReflectionIdentityProposal({
                slot: "self_identity",
                content: pr.conclusion,
                evidenceRecordIds: pr.evidence,
                evidenceContents: pr.evidence.map((id) => contentById.get(id)),
                echoKey: pr.echoKey || undefined,
              })
            : null;
          // #ε-定标（ADR0003 D7）：shadow 旁路采集——与门完全相同的匹配逻辑记录 best
          // verbatim overlap，判定行为零变化（仅 soulProposalsOn 块内=门 off 零判定零采集；
          // shadow off 零旁路；写失败 fail-safe 每路径 warn 一次后静默）。
          if (verdict && cfg.soulProposals?.shadowCalibration?.enabled === true) {
            appendShadowCalibrationRow(
              cfg.soulProposals.shadowCalibration.file ?? "data/logs/soul-reflection-shadow.jsonl",
              {
                ts: new Date().toISOString(),
                slot: "self_identity",
                verdict: verdict.ok ? "accepted" : "rejected",
                bestLen: bestVerbatimOverlapLen(pr.conclusion, pr.evidence.map((id) => contentById.get(id))),
                verbatimGate: VERBATIM_FRAGMENT_MIN_CHARS,
              },
              deps.logger,
            );
          }
          if (!contractOk) {
            // 契约拒绝已记日志（上方）；不推提案，promise 提案段不受影响。
          } else if (verdict && !verdict.ok) {
            deps.logger?.info?.(`[reflection] soul proposal rejected (${verdict.reason.slice(0, 80)}): ${pr.conclusion.slice(0, 60)}`);
          } else if (verdict?.ok && (await proposalAlreadyKnown(deps.store, triple, verdict.proposal.content))) {
            deps.logger?.info?.("[reflection] soul proposal deduped (already pending or in core identity)");
          } else if (verdict?.ok && simGateOn && !recOn && (await similarSelfIdentityProposalExists({
            store: deps.store,
            tenant: triple,
            content: verdict.proposal.content,
            threshold: simGateThreshold,
            embeddingService: deps.embeddingService,
            logger: deps.logger,
          }))) {
            // #81（拍板②）：语义相似门（#91 recurrence off 原路径逐位）——与在途 pending/core 槽行
            // 同构的 self_identity 提案不再重复入轨（洪泛根治：词面闸门拦不住互异文案复读）。
            simGated++;
            deps.logger?.info?.(`[reflection] soul proposal sim-gated (similar self_identity in flight, threshold=${simGateThreshold}): ${verdict.proposal.content.slice(0, 60)}`);
          } else if (verdict?.ok && simGateOn && recOn) {
            // #91：复现即投票——Match 版相似门（语料含 expired 供 TTL 过期后再命中→计票复活；
            // 恒嵌候选，vector 供 push 支路预嵌落库）。命中 pending 行→计票（每 run 每 pending 一次）；
            // 命中 core 行→仅拦不投；未命中→push + init 复现账本（重推不双计由 store 侧保证）。
            // #91 返工（M-marker 路由）：产卡 echo_key 指认优先——零嵌入零向量门直接路由：
            // 命中 pending marker → 计票；命中 core marker → skip 零落库；未命中/映射缺失 → 保守走 Match 原路径。
            const recEvidenceIds = Array.isArray((verdict.proposal.attrs as { evidence_record_ids?: unknown } | undefined)?.evidence_record_ids)
              ? ((verdict.proposal.attrs as { evidence_record_ids?: unknown }).evidence_record_ids as unknown[]).filter((s): s is string => typeof s === "string")
              : [];
            const echoKeyRaw = (verdict.proposal.attrs as { echo_key?: unknown } | undefined)?.echo_key;
            const echoKey = typeof echoKeyRaw === "string" ? echoKeyRaw.trim() : "";
            const echoMk = echoKey ? selfIdentityMarkers.find((x) => x.key === echoKey) : undefined;
            if (echoMk?.kind === "pending" && echoMk.pid) {
              echoVotes++;
              const pid = echoMk.pid;
              if (typeof deps.store.updatePendingRecurrence === "function" && !votedPids.has(pid)) {
                votedPids.add(pid);
                try {
                  await Promise.resolve(deps.store.updatePendingRecurrence(pid, { content: verdict.proposal.content, evidenceRecordIds: recEvidenceIds }, { votesN: recVotes, spanHours: recSpanHours, tenant: triple }));
                  recurrenceVotes++;
                } catch (err) {
                  deps.logger?.warn?.(`[reflection] recurrence vote failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
                }
              }
            } else if (echoMk?.kind === "core") {
              echoSkipped++;
              deps.logger?.info?.(`[reflection] soul proposal echo-skipped (already in core, marker=${echoKey}): ${verdict.proposal.content.slice(0, 60)}`);
            } else {
            const m = await similarSelfIdentityProposalMatch({
              store: deps.store,
              tenant: triple,
              content: verdict.proposal.content,
              threshold: simGateThreshold,
              embeddingService: deps.embeddingService,
              logger: deps.logger,
            });
            if (m.degraded) gateDegraded++;
            if (m.hit) {
              simGated++;
              deps.logger?.info?.(`[reflection] soul proposal sim-gated (similar self_identity in flight, threshold=${simGateThreshold}): ${verdict.proposal.content.slice(0, 60)}`);
              const pid = m.pending?.pending_id;
              if (m.pending && pid && typeof deps.store.updatePendingRecurrence === "function" && !votedPids.has(pid)) {
                votedPids.add(pid);
                try {
                  await Promise.resolve(deps.store.updatePendingRecurrence(pid, { content: verdict.proposal.content, evidenceRecordIds: recEvidenceIds }, { votesN: recVotes, spanHours: recSpanHours, tenant: triple }));
                  recurrenceVotes++;
                } catch (err) {
                  deps.logger?.warn?.(`[reflection] recurrence vote failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
                }
              }
            } else if (!(await rateLimitBlocksPush(verdict.proposal.slot, verdict.proposal.content))) {
              const pushed = await Promise.resolve(
                deps.store.upsertPendingCore?.(verdict.proposal.slot, verdict.proposal.content, verdict.proposal.evidence, triple, {
                  attrs: { ...verdict.proposal.attrs, anchor_refs: anchorRefs },
                }),
              );
              if (pushed) proposalsPushed++;
              if (typeof deps.store.initPendingRecurrenceByContent === "function") {
                try {
                  await Promise.resolve(deps.store.initPendingRecurrenceByContent(verdict.proposal.slot, verdict.proposal.content, triple, { content: verdict.proposal.content, evidenceRecordIds: recEvidenceIds, embedding: m.vector ? Array.from(m.vector) : undefined }));
                } catch (err) {
                  deps.logger?.warn?.(`[reflection] recurrence init failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
                }
              }
            }
            }
          } else if (verdict?.ok && !(await rateLimitBlocksPush(verdict.proposal.slot, verdict.proposal.content))) {
            const pushed = await Promise.resolve(
              deps.store.upsertPendingCore?.(verdict.proposal.slot, verdict.proposal.content, verdict.proposal.evidence, triple, {
                attrs: { ...verdict.proposal.attrs, anchor_refs: anchorRefs },
              }),
            );
            if (pushed) proposalsPushed++;
          }
        } catch (err) {
          deps.logger?.warn?.(`[reflection] soul proposal failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      // #44（D8-(c) 提案通道）：结论卡附带的 promiseTransitions 提议 → 确定性门裁决
      // （vetPromiseTransitionProposal：目标 terminal→id 归一→promise 存在且 open→
      // reason 非空≤200→去 L1 原文；refKey 取 store 行不采信 LLM）→ 重复抑制
      // （listPendingCore slot=promise_transition attrs promiseId+to 全等）→ O13 rail 入轨
      // （slot="promise_transition"，attrs{promiseId,to,refKey?,origin:"reflection-promise"}）。
      // LLM 仅提议、store 写入一律 pending 待人工采纳（ADR0003 D8 判定权=确定性证据门+用户）。
      // 采纳侧由 v2-router pending-decide promise_transition 分支落 transitionSoulPromise(source="proposal")。
      // 非致命：桥接失败仅记日志，反思主路径零影响。
      if (ok && promiseProposalsOn && openPromises.length > 0 && pr.promiseTransitions.length > 0) {
        try {
          const pendingRows = ((await Promise.resolve(deps.store.listPendingCore?.(triple, { includeDecided: false }))) ?? []) as Array<{ slot?: string; state?: string; attrs_json?: string | null }>;
          // #50④：openPromises 快照先于 LLM 调用拉取（上方 ：154），调用期间承诺可能已被
          // 迁移（人工采纳/迁移→closed）——vet 前重取 open 快照，防过期快照放行产生死 pending
          // （下游人工采纳 409 的诚实垃圾轨）。重取缺实现或返回 undefined 时回退旧快照（不放大失败面）。
          // #50③：verbatim 门证据集须含 fresh open promise 内容——防 LLM 逐字抄 promise 内容进
          // reason 绕过去 L1 拒推（与 #27 提示注入持久化同理据）。
          const freshOpenPromises =
            ((await Promise.resolve(deps.store.listSoulPromises?.(triple, { status: "open" }))) as Array<{ promiseId: string; content?: string; status: string; refKey?: string }>) ?? openPromises;
          for (const pt of pr.promiseTransitions) {
            const verdict = vetPromiseTransitionProposal(
              { promiseId: pt.promiseId, to: pt.to, reason: pt.reason },
              freshOpenPromises,
              [...sample.map((r) => String(r.content ?? "")), ...freshOpenPromises.map((p) => p.content)],
            );
            if (!verdict.ok) {
              deps.logger?.info?.(`[reflection] promise proposal rejected (${verdict.reason.slice(0, 80)}): ${pt.promiseId}`);
              continue;
            }
            const proposal = verdict.proposal;
            const dup = pendingRows.some((p) => {
              if (p.slot !== "promise_transition" || p.state !== "pending") return false;
              try {
                const a = JSON.parse(String(p.attrs_json ?? "{}")) as { promiseId?: unknown; to?: unknown };
                return a.promiseId === proposal.promiseId && a.to === proposal.to;
              } catch {
                return false;
              }
            });
            if (dup) {
              deps.logger?.info?.(`[reflection] promise proposal deduped (already pending): ${proposal.promiseId}`);
              continue;
            }
            const pushed = await Promise.resolve(
              deps.store.upsertPendingCore?.(
                "promise_transition",
                proposal.reason,
                pr.evidence.length,
                triple,
                { attrs: { promiseId: proposal.promiseId, to: proposal.to, ...(proposal.attrs.refKey ? { refKey: proposal.attrs.refKey } : {}), origin: "reflection-promise" } },
              ),
            );
            if (pushed) {
              promiseProposalsPushed++;
              deps.logger?.info?.(`[reflection] promise proposal queued: ${proposal.promiseId} -> ${proposal.to}`);
            }
          }
        } catch (err) {
          deps.logger?.warn?.(`[reflection] promise proposal failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      // D8 创建通道（2026-10-17 票面 ③）：结论卡附带的 promiseCreations 提议 → 确定性门裁决
      // （vetPromiseCreationProposal：非空≤120→逐字公共串≥12 拒→open/pending promise_create
      // 全等拒；不设 refKey，宁缺毋滥）→ O13 rail 入轨（slot="promise_create"，
      // attrs{origin:"reflection-promise"}）。与迁移分支不同：创建分支【不要求
      // openPromises.length>0】——第一条承诺就是从无到有，仅挂 promiseProposalsOn 门。
      // 重复抑制内置于 vet（pending promise_create 内容全等）；被拒/重复只记日志不抛（非致命）。
      // 采纳侧由 v2-router pending-decide promise_create 分支落 upsertSoulPromise(source="reflection")。
      if (ok && promiseProposalsOn && pr.promiseCreations.length > 0) {
        try {
          const pendingRows = ((await Promise.resolve(deps.store.listPendingCore?.(triple, { includeDecided: false }))) ?? []) as Array<{ slot: string; state: string; content: string }>;
          // 逐字门证据集 = 样本内容 ∪ open promise 内容（#50③ 同理据：防 LLM 逐字抄既有承诺
          // 内容做创建绕过全等去重——部分抄写由 ≥12 字公共串门拦截）。
          const verbatimEvidence = [...sample.map((r) => String(r.content ?? "")), ...openPromises.map((p) => String(p.content ?? ""))];
          for (const pc of pr.promiseCreations) {
            const verdict = vetPromiseCreationProposal(
              { content: pc.content },
              verbatimEvidence,
              openPromises.map((p) => ({ content: String(p.content ?? "") })),
              pendingRows,
            );
            if (!verdict.ok) {
              deps.logger?.info?.(`[reflection] promise creation rejected (${verdict.reason.slice(0, 80)}): ${pc.content.slice(0, 60)}`);
              continue;
            }
            const pushed = await Promise.resolve(
              deps.store.upsertPendingCore?.(
                "promise_create",
                verdict.proposal.content,
                pr.evidence.length,
                triple,
                { attrs: { origin: "reflection-promise" } },
              ),
            );
            if (pushed) {
              promiseCreationsPushed++;
              deps.logger?.info?.(`[reflection] promise creation queued: ${verdict.proposal.content.slice(0, 60)}`);
            }
          }
        } catch (err) {
          deps.logger?.warn?.(`[reflection] promise creation failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }
  return { triggered, cardsWritten, proposalsPushed, simGated, echoVotes, echoSkipped, promiseProposalsPushed, promiseCreationsPushed, skipped, recurrenceVotes, rateLimitSkipped, gateDegraded };
}
void DEFAULTS;
