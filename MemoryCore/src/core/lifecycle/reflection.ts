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
import type { Logger } from "../../types.js";

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
  store?: { upsertL1(record: unknown, embedding?: unknown): boolean | Promise<boolean> };
  llmRunner?: { run(p: { prompt: string; systemPrompt: string; taskId: string; timeoutMs: number; maxTokens: number }): Promise<string | undefined> | string | undefined };
  logger?: Logger;
  filter?: { teamId?: string; userId?: string; agentId?: string; taskId?: string };
}

const DEFAULTS = { rRef: 150, maxConclusions: 3, maxSample: 20 };

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

export async function runReflection(deps: ReflectionDeps): Promise<{ triggered: number; cardsWritten: number }> {
  const cfg = deps.config;
  if (!cfg?.enabled) return { triggered: 0, cardsWritten: 0 };
  if (!deps.store?.upsertL1 || !deps.llmRunner) return { triggered: 0, cardsWritten: 0 };
  const rRef = Number.isFinite(cfg.rRef) ? cfg.rRef : 150;
  const maxSample = cfg.maxSample ?? 20;
  const maxConclusions = cfg.maxConclusions ?? 3;

  const records = (await deps.queryL1()) as Array<Rec>;
  if (!Array.isArray(records) || records.length === 0) return { triggered: 0, cardsWritten: 0 };

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
  for (const { triple, rows } of byTenant.values()) {
    // 反思史即状态：最新反思结论卡的 updatedAt = 上次反思时间戳
    const lastReflectionAt = rows
      .filter((r) => r.type === "work_fact" && (r as { metadata?: { reflection?: boolean } }).metadata?.reflection === true)
      .map((r) => String(r.updatedAt ?? r.createdAt ?? ""))
      .filter((s) => s.length > 0)
      .sort()
      .at(-1) ?? "";
    const newRows = rows.filter((r) => {
      if (r.type === "work_fact") return false; // 持续态不入触发累计（防自我 reinforce）
      const t = String(r.updatedAt ?? r.createdAt ?? "");
      return t > lastReflectionAt;
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
    const proposals = parseReflectionProposals(String(raw ?? "")).slice(0, maxConclusions);
    const now = new Date().toISOString();
    for (const pr of proposals) {
      const rec = {
        id: `rf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        content: pr.conclusion,
        type: "work_fact",
        priority: 80,
        scene_name: "reflection",
        source_message_ids: [],
        metadata: { reflection: true, question: pr.question, evidence_record_ids: pr.evidence, subject: "反思结论" },
        timestamps: [now],
        createdAt: now,
        updatedAt: now,
        teamId: triple.teamId,
        userId: triple.userId,
        agentId: triple.agentId,
      };
      const ok = await Promise.resolve(deps.store.upsertL1(rec));
      if (ok) cardsWritten++;
    }
  }
  return { triggered, cardsWritten };
}
void DEFAULTS;
