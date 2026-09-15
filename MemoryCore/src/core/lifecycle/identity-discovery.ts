/**
 * identity-discovery —— 身份自发现（SOUL-PIPELINE §2.2，GROW 模式复用）。
 *
 * 灵魂公式"此刻的你"的材料源：LLM 从对话中自发现身份事实（我是谁/我的职责/我的红线），
 * 提案制 + 分级门采纳后写入 core_memory slots。
 *
 * 分级门（用户拍板 2026-09-15）：
 *   - identity（描述类）：多源一致 ≥ minEvidence + observed → 高置信自动采纳
 *   - core_value / strict_rule（红线类）：→ pending 列表（永不自动写入——Panel 人工采纳）
 *
 * 与 anchor-growth 的关系：同构不同对象——锚=价值参照系（core_values），身份=自我认知（core_memory slots）。
 * 共享：采样/冷却/状态机/证据重算模式；差异：slot 白名单/分级门/无 weight。
 */
import type { IMemoryStore, CoreTenant } from "../store/types.js";
import type { Logger } from "../types.js";

export interface IdentityDiscoveryConfig {
  enabled: boolean;
  minEvidence: number;
  maxPerPass: number;
  intervalHours: number;
}

export const DEFAULT_IDENTITY_DISCOVERY_CONFIG: IdentityDiscoveryConfig = {
  enabled: true,
  minEvidence: 3,
  maxPerPass: 2,
  intervalHours: 24,
};

export interface IdentityDiscoveryResult {
  ran: boolean;
  adopted: number;
  pending: number;
  reason?: "disabled" | "no-llm" | "store-unsupported" | "interval" | "no-new-corpus" | "no-corpus" | "error";
}

const DISCOVERY_SYSTEM_PROMPT = [
  "你是团队身份提炼顾问。从样本记忆中提炼\"这个 agent/团队是谁\"的身份事实。",
  "你只提案，不落库：你的输出只是候选提案。",
  "",
  "每个提案包含：",
  '- slot: "identity"（描述类：我是谁/我的职责/我的角色）或 "core_value"（价值观：什么是对的/什么最重要）或 "strict_rule"（红线：绝不做的事/必须遵守的规则）',
  "- content: 身份事实正文（≤200 字，必须是样本记忆中的原文短语或直接改写）",
  "- rationale: 提炼理由",
  "",
  "硬约束：",
  "1. 只提炼身份层面的持续事实（我是谁/我信什么/我绝不做什么），不提一次性任务或事件。",
  "2. 已有身份事实不得重复。",
  "3. 宁缺毋滥：证据不足的主题不要提。",
  "4. 只输出一个 JSON 数组：[{\"slot\":\"identity\",\"content\":\"…\",\"rationale\":\"…\"}]，无提议输出 []。",
].join("\n");

const DISCOVER_SAMPLE_CAP = 50;
const DISCOVER_TRUNCATE_CHARS = 200;
const DISCOVER_MAX_TOKENS = 16384;

/** 身份事实演化状态键（per-agent） */
function stateKey(tenant: CoreTenant | undefined, kind: string): string {
  if (!tenant || (tenant.teamId === "default" && tenant.userId === "default" && tenant.agentId === "default")) {
    return `identity_${kind}`;
  }
  return `identity_${kind}:${JSON.stringify([tenant.teamId, tenant.userId, tenant.agentId])}`;
}

export async function runIdentityDiscovery(deps: {
  store: IMemoryStore;
  llmRunner?: { run(params: { prompt: string; systemPrompt?: string; taskId: string; maxTokens?: number }): Promise<string> };
  config?: Partial<IdentityDiscoveryConfig>;
  logger?: Logger;
  now?: () => Date;
}): Promise<IdentityDiscoveryResult> {
  const cfg: IdentityDiscoveryConfig = { ...DEFAULT_IDENTITY_DISCOVERY_CONFIG, ...(deps.config ?? {}) };
  if (cfg.enabled === false) {
    return { ran: false, adopted: 0, pending: 0, reason: "disabled" };
  }
  const store = deps.store;
  const logger = deps.logger;
  if (!deps.llmRunner) {
    return { ran: false, adopted: 0, pending: 0, reason: "no-llm" };
  }
  if (!store.queryL1Records || !store.upsertCore || !store.readCore) {
    return { ran: false, adopted: 0, pending: 0, reason: "store-unsupported" };
  }

  const now = deps.now ?? (() => new Date());
  try {
    let tenants: CoreTenant[];
    if (typeof store.listL1TenantTriplets === "function") {
      tenants = ((await Promise.resolve(store.listL1TenantTriplets())) ?? []).map((t: unknown) => {
        const r = t as { teamId: string; userId: string; agentId: string };
        return { teamId: r.teamId || "default", userId: r.userId || "default", agentId: r.agentId || "default" };
      });
    } else {
      tenants = [{ teamId: "default", userId: "default", agentId: "default" }];
    }
    if (tenants.length === 0) return { ran: false, adopted: 0, pending: 0, reason: "no-corpus" };

    let ranAny = false;
    let adopted = 0;
    let pending = 0;

    for (const tenant of tenants) {
      try {
        const state = readState(store, tenant);
        const nowMs = now().getTime();
        // 冷却：距上次尝试 ≥ intervalHours
        if (state.lastAttemptAt) {
          const last = Date.parse(state.lastAttemptAt);
          if (Number.isFinite(last) && nowMs - last < cfg.intervalHours * 3600_000) continue;
        }
        // 语料基线：无新增 → 跳过
        const corpusCount = typeof store.countL1 === "function" ? Number(store.countL1(tenant)) || 0 : 0;
        if (corpusCount === 0 || (state.lastCorpusCount !== null && state.lastCorpusCount !== undefined && corpusCount <= state.lastCorpusCount)) continue;

        const rows = (store.queryL1Records(tenant) ?? []) as Array<{ content?: string }>;
        const sample = rows
          .slice(0, DISCOVER_SAMPLE_CAP)
          .map((r) => String((r as { content?: string }).content ?? "").slice(0, 200));
        const corpus = rows.map((r) => String((r as { content?: string }).content ?? ""));

        // 已有 slots（去重）
        const existing = (store.readCore(tenant) ?? []) as Array<{ slot: string; content: string }>;
        const existingSummaries = existing.map((s) => `${s.slot}: ${s.content.slice(0, 100)}`);

        const prompt = buildIdentityPrompt(sample, existingSummaries);
        const raw = await deps.llmRunner.run({
          prompt,
          systemPrompt: DISCOVERY_SYSTEM_PROMPT,
          taskId: "identity-discovery",
          maxTokens: DISCOVER_MAX_TOKENS,
        });

        const proposals = parseProposals(String(raw ?? ""));
        let adoptedThis = 0;
        let pendingThis = 0;

        for (const p of proposals) {
          const ev = recountEvidence(p.content, corpus);
          if (ev < cfg.minEvidence) continue;
          // 分级门：identity → 自动；core_value/strict_rule → pending
          if (p.slot === "identity") {
            const ok = store.upsertCore("identity", p.content, "identity-discovery", tenant);
            if (ok) { adoptedThis++; pendingThis++; logger?.info?.(`[identity-discovery] adopted identity: ${p.content.slice(0, 60)}`); }
          } else {
            pendingThis++;
            logger?.info?.(`[identity-discovery] pending ${p.slot}: ${p.content.slice(0, 60)} (evidence=${ev})`);
          }
        }
        adopted += adoptedThis;
        pending += pendingThis;

        writeState(store, tenant, {
          lastDiscoveryAt: now().toISOString(),
          lastCorpusCount: corpusCount,
          lastAttemptAt: now().toISOString(),
        });
        ranAny = true;
        logger?.info?.(`[identity-discovery] agent=${JSON.stringify([tenant.teamId, tenant.userId, tenant.agentId])} corpus=${corpusCount} proposals=${proposals.length} adopted=${adoptedThis}`);
      } catch (err) {
        logger?.warn?.(`[identity-discovery] agent error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    logger?.info?.(`[identity-discovery] ran: agents=${tenants.length} adopted=${adopted} pending=${pending}`);
    return { ran: ranAny, adopted, pending };
  } catch (err) {
    logger?.warn?.(`[identity-discovery] failed: ${err instanceof Error ? err.message : String(err)}`);
    return { ran: false, adopted: 0, pending: 0, reason: "error" };
  }
}

// ── helpers ──

function buildIdentityPrompt(samples: string[], existing: string[]): string {
  const sampleText = samples.map((s, i) => `${i + 1}. ${s}`).join("\n");
  const existingText = existing.length > 0 ? existing.map((e) => `- ${e}`).join("\n") : "（空，无已有身份事实）";
  return `## 样本记忆（最近 ${samples.length} 条）\n\n${sampleText}\n\n## 已有身份事实（不得重复）\n\n${existingText}\n\n请提炼身份事实提案。`;
}

function parseProposals(raw: string): Array<{ slot: string; content: string; rationale: string }> {
  let cleaned = (raw ?? "").trim();
  if (!cleaned) return [];
  if (cleaned.startsWith("```")) cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  const match = cleaned.match(/\[[\s\S]*\]/);
  if (!match) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(match[0]); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const valid = new Set(["identity", "core_value", "strict_rule"]);
  const out: Array<{ slot: string; content: string; rationale: string }> = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const slot = typeof o.slot === "string" ? o.slot : "";
    const content = typeof o.content === "string" ? o.content.trim() : "";
    if (!slot || !content || !valid.has(slot)) continue;
    out.push({ slot, content, rationale: typeof o.rationale === "string" ? o.rationale : "" });
  }
  return out;
}

function recountEvidence(content: string, corpus: string[]): number {
  let hits = 0;
  for (const c of corpus) {
    if (c.includes(content.slice(0, Math.min(content.length, 20)))) hits++;
  }
  return hits;
}

// ── state helpers ──
function readState(store: IMemoryStore, tenant: CoreTenant): { lastDiscoveryAt?: string; lastCorpusCount?: number; lastAttemptAt?: string } {
  try {
    const raw = (store as unknown as { getAnchorGrowthState?: (t?: CoreTenant) => unknown }).getAnchorGrowthState?.(tenant);
    if (raw && typeof raw === "object") return raw as { lastDiscoveryAt?: string; lastCorpusCount?: number; lastAttemptAt?: string };
  } catch { /* fall through */ }
  return {};
}
function writeState(store: IMemoryStore, tenant: CoreTenant | undefined, state: { lastDiscoveryAt: string; lastCorpusCount: number; lastAttemptAt: string }): void {
  try {
    (store as unknown as { setAnchorGrowthState?: (s: unknown, t?: CoreTenant) => void }).setAnchorGrowthState?.(state, tenant);
  } catch { /* best-effort */ }
}