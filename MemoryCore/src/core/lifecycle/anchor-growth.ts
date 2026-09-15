/**
 * anchor-growth —— 价值锚自生长（Task GROW）：调度器挂钩的自发现+自动采纳流水线。
 *
 * 设计裁决（task-grow-brief 2026-09-10 + task-grow-report §0）：
 *   - 触发双门：距上次发现 ≥ intervalHours **且** 语料条数有新增；任一不过 → 不跑、
 *     不消费轮次（lastDiscoveryAt 不更新，下个 tick 重查）。状态持久化在
 *     anchor_growth_state kv（sqlite），重启不失忆。
 *   - 护栏四件：证据 ≥ minEvidence（默认 5，严于 DISC 提案区的 3）/ 每轮 ≤ maxPerPass（2）/
 *     总名额 maxTotal（15 = 钉住数 + 自生长活跃数）/ 去重查全态（active+retired+vetoed，
 *     veto 永不重提）。
 *   - 挤出：名额满时，新候选强度（suggestedWeight × evidenceCount）**>** 最弱自生长锚
 *     （active + origin=auto + pinned=0，pinned 豁免）才替换；被挤出者 retire（可恢复）。
 *     存量 auto 锚无证据列（brief 只加三列，最小侵入），其强度 = weight ×
 *     recountEvidence(label, 当前样本语料)——与候选强度同刻度、确定性纯函数复用
 *     （core-values-discover 导出复用，禁第二份）。tie → weight 升序 → value_id 升序。
 *   - 信任边界（DISC K1 的自动化延伸）：LLM 只提议；采纳走 store.upsertValue 落库，
 *     origin='auto'、created_by='auto-growth'、weight=建议权重（证据密度公式）、
 *     valence 落 NULL（C2 钩子自动判）。
 *   - PA（推翻 spec §5.1 裁决 2）：**per-agent 严格独立**——发现循环遍历有记忆的
 *     distinct agent 三元组（store.listL1TenantTriplets，l1_records SELECT DISTINCT 单源），
 *     逐 agent：采样 = 该 agent 自己的记忆（跨 agent 零蒸馏）；候选去重对照 = 该 agent
 *     自己的全态锚；护栏四件独立计数；双门（interval/语料基线）per-agent（per-tenant
 *     growth state 键）。store 缺 listL1TenantTriplets（旧后端）→ 回退 default 单桶
 *     （旧行为，feature-detect 家族先例，loud warn）。LLM 成本 = 有记忆 agent 数 × 发现循环。
 *   - GROW-MAINT（2026-09-15）：自维护——auto 锚（created_by='auto-growth'）每轮按**全量语料**
 *     重算证据：<minEvidence → retire（pinned/manual 豁免）；权重=suggestAnchorWeight(证据,全量语料)，
 *     |Δw|≥0.05 才写；标签不原地改写（coreRefs/dedup 身份锚点），主题演化=退场+新标签再入。
 *     冷却分级：有采纳 intervalHours / 0 采纳 1h（lastAttemptAt/lastAdoptedAt 落 kv；
 *     存量状态兼容映射 lastDiscoveryAt→视作采纳时刻，保守 24h 与旧行为等价）。
 *   - value_id：slug(label)；纯 CJK 回退 auto-<sha256(归一化label)[:10]>（确定性 ASCII，
 *     保证 pin/retire/delete 路由的 normalizeValueId 不吞 CJK）。
 */
import { createHash } from "node:crypto";
import { DEFAULT_CORE_TENANT, type IMemoryStore, type CoreTenant } from "../store/types.js";
import type { Logger } from "../types.js";
import {
  selectSampleRows,
  buildDiscoverPrompt,
  DISCOVER_SYSTEM_PROMPT,
  parseProposalsJson,
  dedupProposals,
  recountEvidence,
  suggestAnchorWeight,
  DISCOVER_SAMPLE_CAP,
} from "../../gateway/core-values-discover.js";

/** GROW：自生长配置（memory.coreMemory.anchorDiscovery；解析+clamp+默认见 config.ts）。 */
export interface AnchorDiscoveryConfig {
  enabled: boolean;
  minEvidence: number;
  maxPerPass: number;
  maxTotal: number;
  intervalHours: number;
}

export const DEFAULT_ANCHOR_DISCOVERY_CONFIG: AnchorDiscoveryConfig = {
  enabled: true,
  minEvidence: 5,
  maxPerPass: 2,
  maxTotal: 15,
  intervalHours: 24,
};

/** 旧 store（缺 listL1TenantTriplets）回退用的 default 桶三元组；PA 起自生长默认遍历全部有记忆 agent。 */
export const ANCHOR_GROWTH_TENANT: CoreTenant = { teamId: "default", userId: "default", agentId: "default" };

/** GROW-MAINT：自生长状态读形状（lastAttemptAt/lastAdoptedAt 新增可选；存量行缺省 undefined）。 */
export type AnchorGrowthStateRead = { lastDiscoveryAt: string | null; lastCorpusCount: number | null; lastAttemptAt?: string | null; lastAdoptedAt?: string | null };
/** GROW-MAINT：自生长状态写形状（lastAdoptedAt 仅在有采纳轮写入）。 */
export type AnchorGrowthStateWrite = { lastDiscoveryAt: string; lastCorpusCount: number; lastAttemptAt?: string; lastAdoptedAt?: string };

/** GROW-MAINT：0 采纳轮短冷却——语料增长期发现节奏跟随语料（最密 1h 一试），防 10min tick 空烧 LLM。 */
const ATTEMPT_COOLDOWN_MS = 3600_000;
/** GROW-MAINT：权重重写防抖阈值（|Δw| 低于此不落库）。 */
const REWEIGHT_DELTA = 0.05;

type CoreValueRow = { value_id: string; label: string; weight: number; created_by: string; valence: number | null; origin: "seed" | "manual" | "auto"; pinned: 0 | 1; state: "active" | "retired" | "vetoed" };

/** 自生长锚 value_id：slug(label)；纯 CJK（slug 化为空）→ auto-<sha256[:10]>。 */
export function growthValueId(label: string): string {
  const normalized = label.trim().toLowerCase();
  const slug = normalized.replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, "");
  if (slug) return slug;
  return "auto-" + createHash("sha256").update(normalized).digest("hex").slice(0, 10);
}

export interface AnchorGrowthResult {
  ran: boolean;
  adopted: number;
  retired: number;
  reweighted: number;
  displaced: number;
  skipped: number;
  reason?: "disabled" | "no-llm" | "store-unsupported" | "interval" | "attempt-cooldown" | "no-new-corpus" | "no-corpus" | "error";
}

/**
 * 语料口径（GROW 裁定 §0.4 v2 + PA per-agent 化）：**该 agent 三元组自己的语料**——
 * 不做全量无过滤查询（那会把其它 agent/租户的主题蒸馏进它的锚 = 泄漏向量）。
 * 计数门用 countL1（便宜、零载荷）；语料正文查询仅在双门全过时才发生
 * （且该桶语料为空时在 queryL1Records 之前短路——不白拉行）。
 */
async function resolveCorpusCount(store: {
  countL1?: (filter?: unknown) => Promise<number> | number;
  queryL1Records: (filter?: unknown) => Promise<unknown[]> | unknown[];
}, tenant: CoreTenant): Promise<number> {
  if (typeof store.countL1 === "function") {
    return Number(await Promise.resolve(store.countL1(tenant))) || 0;
  }
  const rows = (await Promise.resolve(store.queryL1Records(tenant))) ?? [];
  return rows.length;
}

/** PA：default 三元组判定（default 桶保持旧键/旧调用形状，存量状态与测试契约连续）。 */
function isDefaultTenant(t: CoreTenant): boolean {
  return t.teamId === DEFAULT_CORE_TENANT.teamId && t.userId === DEFAULT_CORE_TENANT.userId && t.agentId === DEFAULT_CORE_TENANT.agentId;
}

/** PA：三元组归一（缺维度兜 default，防半缺省三元组拼出越界桶）。 */
function normalizeTriplet(t: CoreTenant): CoreTenant {
  return {
    teamId: String(t.teamId ?? "").trim() || "default",
    userId: String(t.userId ?? "").trim() || "default",
    agentId: String(t.agentId ?? "").trim() || "default",
  };
}

/**
 * 自生长一轮（由 lifecycle-scheduler 在巩固周期后挂钩；best-effort，失败只 warn 不抛）。
 * PA：per-agent 严格独立——逐"有记忆的 agent 三元组"跑完整发现循环（双门/护栏/挤出
 * 全部 per-agent 独立计数）；任一 agent 的失败不阻断其它 agent（单 agent 内错误只
 * 跳过该 agent 并 warn）。返回值为各 agent 聚合（adopted/displaced/skipped 求和）。
 */
export async function runAnchorGrowth(deps: {
  store: IMemoryStore;
  llmRunner?: { run(params: { prompt: string; systemPrompt?: string; taskId: string; timeoutMs?: number; maxTokens?: number }): Promise<string> } | null;
  config?: Partial<AnchorDiscoveryConfig>;
  logger?: Logger;
  now?: () => Date;
}): Promise<AnchorGrowthResult> {
  const cfg: AnchorDiscoveryConfig = { ...DEFAULT_ANCHOR_DISCOVERY_CONFIG, ...(deps.config ?? {}) };
  const logger = deps.logger;
  if (!cfg.enabled) return { ran: false, adopted: 0, retired: 0, reweighted: 0, displaced: 0, skipped: 0, reason: "disabled" };
  if (!deps.llmRunner || typeof deps.llmRunner.run !== "function") {
    return { ran: false, adopted: 0, retired: 0, reweighted: 0, displaced: 0, skipped: 0, reason: "no-llm" };
  }
  const store = deps.store as IMemoryStore & {
    listValuesAnyState?: (tenant?: CoreTenant) => Promise<CoreValueRow[]> | CoreValueRow[];
    retireValue?: (valueId: string, tenant?: CoreTenant) => Promise<boolean> | boolean;
    upsertValue?: (valueId: string, label: string, weight: number, createdBy?: string, tenant?: CoreTenant, valence?: number, origin?: "seed" | "manual" | "auto") => Promise<boolean> | boolean;
    getAnchorGrowthState?: (tenant?: CoreTenant) => Promise<{ lastDiscoveryAt: string | null; lastCorpusCount: number | null }> | { lastDiscoveryAt: string | null; lastCorpusCount: number | null };
    setAnchorGrowthState?: (state: { lastDiscoveryAt: string; lastCorpusCount: number }, tenant?: CoreTenant) => Promise<void> | void;
    listL1TenantTriplets?: () => Promise<CoreTenant[]> | CoreTenant[];
  };
  // feature-detect：store 缺自生长能力（旧 tcvdb 委托等）→ 安全跳过
  if (!store.queryL1Records || !store.listValuesAnyState || !store.upsertValue || !store.retireValue || !store.getAnchorGrowthState || !store.setAnchorGrowthState) {
    return { ran: false, adopted: 0, retired: 0, reweighted: 0, displaced: 0, skipped: 0, reason: "store-unsupported" };
  }
  const now = deps.now ?? (() => new Date());
  try {
    // ── PA：枚举"有记忆的 agent"三元组（迁移与自生长共用单源）──────────
    let tenants: CoreTenant[];
    if (typeof store.listL1TenantTriplets === "function") {
      const listed = ((await Promise.resolve(store.listL1TenantTriplets())) ?? []) as CoreTenant[];
      tenants = listed.map(normalizeTriplet);
    } else {
      // 旧 store（无三元组枚举能力）→ 回退 default 单桶（旧行为；loud 登记不静默）
      logger?.warn?.("[anchor-growth] store lacks listL1TenantTriplets — falling back to default bucket only (legacy per-instance behavior)");
      tenants = [ANCHOR_GROWTH_TENANT];
    }
    if (tenants.length === 0) {
      return { ran: false, adopted: 0, retired: 0, reweighted: 0, displaced: 0, skipped: 0, reason: "no-corpus" };
    }
    let ranAny = false;
    let adopted = 0;
    let retired = 0;
    let reweighted = 0;
    let displaced = 0;
    let skipped = 0;
    let firstBlockReason: NonNullable<AnchorGrowthResult["reason"]> | undefined;
    for (const tenant of tenants) {
      // default 三元组 → 无参调用（旧键/旧调用形状；非 default → per-tenant 键）
      const legacyDefault = isDefaultTenant(tenant);
      const readState = async () =>
        legacyDefault ? await Promise.resolve(store.getAnchorGrowthState!()) : await Promise.resolve(store.getAnchorGrowthState!(tenant));
      const writeState = async (s: AnchorGrowthStateWrite) => {
        if (legacyDefault) await Promise.resolve(store.setAnchorGrowthState!(s));
        else await Promise.resolve(store.setAnchorGrowthState!(s, tenant));
      };
      try {
        // ── 门 1（per-agent）：冷却分级（GROW-MAINT）──────────────
        const state = await readState();
        const nowMs = now().getTime();
        // 1a 尝试冷却：上次跑过 LLM 不足 ATTEMPT_COOLDOWN → 不跑（最密 1h 一试）
        const lastAttempt = state.lastAttemptAt ? Date.parse(state.lastAttemptAt) : NaN;
        if (Number.isFinite(lastAttempt) && nowMs - lastAttempt < ATTEMPT_COOLDOWN_MS) {
          firstBlockReason ??= "attempt-cooldown";
          continue;
        }
        // 1b 采纳冷却：上次「有采纳」不足 intervalHours → 不跑。
        //    兼容映射：存量状态只有 lastDiscoveryAt（旧语义=每次消费轮都写）→ 视作
        //    lastAdoptedAt（保守 24h，与旧行为等价）；新写入双字段后语义精确。
        const lastAdoptedRaw = state.lastAdoptedAt ?? state.lastDiscoveryAt;
        const lastAdopted = lastAdoptedRaw ? Date.parse(lastAdoptedRaw) : NaN;
        if (Number.isFinite(lastAdopted) && nowMs - lastAdopted < cfg.intervalHours * 3600_000) {
          firstBlockReason ??= "interval";
          continue;
        }
        // ── 门 2（per-agent）：语料有新增（该桶条数 > 上轮基线；首轮无基线 → 放行建立基线）──
        const corpusCount = await resolveCorpusCount(store, tenant);
        if (state.lastCorpusCount !== null && corpusCount <= state.lastCorpusCount) {
          firstBlockReason ??= "no-new-corpus";
          continue;
        }
        // ── 门 3（per-agent）：该桶无语料 → 短路（宁缺毋滥，零 LLM 成本）──
        if (corpusCount === 0) {
          firstBlockReason ??= "no-corpus";
          continue;
        }
        // ── 发现（该 agent 自己的记忆；DISC 导出复用，禁第二份）────────
        const rows = ((await Promise.resolve(store.queryL1Records(tenant as never))) ?? []) as unknown[];
        const sample = selectSampleRows(rows as never, DISCOVER_SAMPLE_CAP);
        const sampleContents = sample.map((r) => String((r as { content?: string }).content ?? ""));
        // GROW-MAINT：证据重算语料 = 该 agent **全量语料**（非 50 采样窗）——避免"锚的支撑
        // 记忆老化出 recent 窗 → 证据假衰减 → 误退场"；候选与维护同刻度（§0.4 v3）。
        const corpus = rows.map((r) => String((r as { content?: string }).content ?? ""));
        const anyState0 = ((await Promise.resolve(store.listValuesAnyState(tenant))) ?? []) as CoreValueRow[];

        // ── 自维护（GROW-MAINT）：auto 锚权重重算 + 低证据退场 ──────────
        // 只管自己生的锚（created_by='auto-growth'）；pinned 豁免；manual/seed 永不自动动。
        // 标签不原地改写（coreRefs/dedup 身份锚点）；主题演化 = 退场 + 新提案以新标签再入。
        let retiredA = 0;
        let reweightedA = 0;
        for (const a of anyState0) {
          if (a.state !== "active" || a.origin !== "auto" || a.created_by !== "auto-growth") continue;
          const ev = recountEvidence(a.label, corpus);
          if (ev < cfg.minEvidence) {
            if (a.pinned === 1) continue; // 钉住豁免（人拍板常驻）
            const ok = await Promise.resolve(store.retireValue!(a.value_id, tenant));
            if (ok) {
              retiredA++;
              logger?.warn?.(`[anchor-growth] maintain retire: ${a.value_id} (${a.label}) evidence=${ev}<${cfg.minEvidence} (tenant=${JSON.stringify([tenant.teamId, tenant.userId, tenant.agentId])})`);
            }
            continue;
          }
          const newW = suggestAnchorWeight(ev, corpus.length);
          if (Math.abs(newW - a.weight) >= REWEIGHT_DELTA) {
            const ok = await Promise.resolve(store.upsertValue!(a.value_id, a.label, newW, a.created_by, tenant, a.valence ?? undefined, "auto"));
            if (ok) reweightedA++;
          }
        }
        retired += retiredA;
        reweighted += reweightedA;
        const anyState = retiredA + reweightedA > 0
          ? (((await Promise.resolve(store.listValuesAnyState(tenant))) ?? []) as CoreValueRow[])
          : anyState0;
        const existingLabels = anyState.map((v) => v.label); // 全态清单进 dedup 指令（veto 永不重提）
        const raw = await deps.llmRunner!.run({
          prompt: buildDiscoverPrompt(sampleContents, existingLabels),
          systemPrompt: DISCOVER_SYSTEM_PROMPT,
          taskId: "core-values-discover-growth",
          // GROW-EVO P2.1（用户裁定）：不控制 maxTokens 与超时——0 = 不限制（llm-runner 语义），
          // 推理模型 thinking 不设预算/时延上限（成本与时延风险已向用户明示并接受）。
          timeoutMs: 0,
          maxTokens: 0,
        });
        // ── 护栏（per-agent 独立计数）：证据门槛 → 强者优先 → 每轮上限 ──
        // [DEBUG-GROW] 临时插桩：定位 candidates=0 归零环节（解析/去重/证据重算）
        const rawParsed = parseProposalsJson(String(raw ?? ""));
        const rawDeduped = dedupProposals(rawParsed, existingLabels);
        logger?.warn?.(`[DEBUG-GROW] rawLen=${String(raw ?? "").length} parsed=${rawParsed.length} deduped=${rawDeduped.length} labels=${JSON.stringify(rawDeduped.map((c) => c.label))} recounts=${JSON.stringify(rawDeduped.map((c) => recountEvidence(c.label, corpus)))} minEvidence=${cfg.minEvidence} maxPerPass=${cfg.maxPerPass} corpusLen=${corpus.length}`);
        const candidates = dedupProposals(parseProposalsJson(String(raw ?? "")), existingLabels)
          .map((c) => ({ ...c, evidenceCount: recountEvidence(c.label, corpus) }))
          .filter((p) => p.evidenceCount >= cfg.minEvidence)
          .sort((a, b) => b.evidenceCount - a.evidenceCount)
          .slice(0, cfg.maxPerPass);
        // ── 名额（per-agent 桶内）：maxTotal = 钉住数 + 自生长活跃数 ──
        const pinnedCount = anyState.filter((r) => r.pinned === 1).length;
        const autoActive = anyState.filter((r) => r.state === "active" && r.origin === "auto");
        let free = Math.max(0, cfg.maxTotal - pinnedCount - autoActive.length);
        // 可挤出自生长锚列表（该 agent 的；pinned 豁免）：weight × 语料实际命中
        //（与候选同刻度，确定性），弱者优先被挤出；单轮多候选挤出时逐个弹出。
        const displaceable = autoActive
          .filter((r) => r.pinned !== 1)
          .map((r) => ({ row: r, strength: r.weight * recountEvidence(r.label, corpus) }))
          .sort((a, b) => a.strength - b.strength || a.row.weight - b.row.weight || String(a.row.value_id).localeCompare(String(b.row.value_id)));
        let adoptedThisAgent = 0;
        for (const c of candidates) {
          const candidateStrength = suggestAnchorWeight(c.evidenceCount, corpus.length) * c.evidenceCount;
          let adoptedThis = false;
          if (free > 0) {
            adoptedThis = true;
            free--;
          } else if (displaceable.length > 0 && candidateStrength > displaceable[0]!.strength) {
            const weakest = displaceable.shift()!;
            const retiredOk = await Promise.resolve(store.retireValue(weakest.row.value_id, tenant));
            if (!retiredOk) {
              skipped++;
              logger?.warn?.(`[anchor-growth] retire weakest anchor failed: ${weakest.row.value_id} (tenant=${JSON.stringify([tenant.teamId, tenant.userId, tenant.agentId])})`);
              continue;
            }
            displaced++;
            adoptedThis = true;
          } else {
            skipped++;
            continue;
          }
          if (adoptedThis) {
            const ok = await Promise.resolve(store.upsertValue(growthValueId(c.label), c.label, suggestAnchorWeight(c.evidenceCount, corpus.length), "auto-growth", tenant, undefined, "auto"));
            if (ok) { adopted++; adoptedThisAgent++; }
            else { skipped++; logger?.warn?.(`[anchor-growth] adopt upsert failed: ${c.label}`); }
          }
        }
        // ── 消费轮次（per-agent；LLM 成功即持久化该 agent 的基线，0 候选也消费）──
        await writeState({
          lastDiscoveryAt: new Date(nowMs).toISOString(),
          lastCorpusCount: corpusCount,
          lastAttemptAt: new Date(nowMs).toISOString(),
          ...(adoptedThisAgent > 0 ? { lastAdoptedAt: new Date(nowMs).toISOString() } : {}),
        });
        ranAny = true;
        logger?.debug?.(`[anchor-growth] agent=${JSON.stringify([tenant.teamId, tenant.userId, tenant.agentId])} corpus=${corpusCount} candidates=${candidates.length} retired=${retiredA} reweighted=${reweightedA}`);
      } catch (err) {
        // per-agent 容错：单个 agent 失败不阻断其它 agent（loud warn，继续下一个）
        logger?.warn?.(`[anchor-growth] agent ${JSON.stringify([tenant.teamId, tenant.userId, tenant.agentId])} failed: ${err instanceof Error ? err.message : String(err)}`);
        firstBlockReason ??= "error";
      }
    }
    logger?.info?.(`[anchor-growth] ran: agents=${tenants.length} adopted=${adopted} retired=${retired} reweighted=${reweighted} displaced=${displaced} skipped=${skipped}`);
    return { ran: ranAny, adopted, retired, reweighted, displaced, skipped, ...(ranAny ? {} : { reason: firstBlockReason ?? "error" }) };
  } catch (err) {
    logger?.warn?.(`[anchor-growth] failed: ${err instanceof Error ? err.message : String(err)}`);
    return { ran: false, adopted: 0, retired: 0, reweighted: 0, displaced: 0, skipped: 0, reason: "error" };
  }
}
