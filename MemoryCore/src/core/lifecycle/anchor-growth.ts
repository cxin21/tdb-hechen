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
  personEvCount,
  personValenceSymbol,
  personEvidenceMeanValence,
  parsePersonProposals,
  PERSON_DISCOVER_SYSTEM_PROMPT,
  buildPersonDiscoverPrompt,
} from "../../gateway/core-values-discover.js";
import { identityFactSlice } from "./identity-discovery.js";

/** GROW：自生长配置（memory.coreMemory.anchorDiscovery；解析+clamp+默认见 config.ts）。 */
/** P2（spec §2.6/§5 F15/F19）：人物锚池独立护栏（QUOTA/护栏四件按 node_type 分池）。 */
export interface AnchorDiscoveryPersonConfig {
  enabled: boolean;
  minEvidence: number;
  maxPerPass: number;
  maxTotal: number;
}

export interface AnchorDiscoveryConfig {
  enabled: boolean;
  minEvidence: number;
  maxPerPass: number;
  maxTotal: number;
  intervalHours: number;
  person: AnchorDiscoveryPersonConfig;
  /** P3：品格锚池（spike 定案：聚合源=self_identity 槽事实；enabled 缺省 false=逐位现状）。 */
  character: { enabled: boolean; minEvidence: number; maxPerPass: number; maxTotal: number };
  /** P2：GROW-MAINT 身份分支开关（F15 身份分支；缺省 false=逐位现状）。 */
  identityMaintain: { enabled: boolean };
}

export const DEFAULT_ANCHOR_DISCOVERY_CONFIG: AnchorDiscoveryConfig = {
  enabled: true,
  minEvidence: 5,
  maxPerPass: 2,
  maxTotal: 15,
  intervalHours: 24,
  // P2：人物池缺省关闭=逐位现状（config-first 铁律）；yaml 显式开启后生效。
  person: { enabled: false, minEvidence: 5, maxPerPass: 1, maxTotal: 8 },
  // P3：品格池缺省关闭=逐位现状（config-first 铁律）；聚合源=self_identity 槽事实（spike 定案）。
  character: { enabled: false, minEvidence: 2, maxPerPass: 1, maxTotal: 8 },
  identityMaintain: { enabled: false },
}

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

type CoreValueRow = { value_id: string; label: string; weight: number; created_by: string; valence: number | null; origin: "seed" | "manual" | "auto"; pinned: 0 | 1; state: "active" | "retired" | "vetoed"; node_type?: "theme" | "person" | "character"; attrs_json?: string };

/** P2：attrs_json 宽松解析单源（损坏/缺失 → {aliases:[]}——人物锚维护/去重/挤出共用）。 */
function attrsOf(row: { attrs_json?: string }): { role?: string; aliases: string[] } {
  try {
    const parsed = row.attrs_json && row.attrs_json !== "{}" ? JSON.parse(row.attrs_json) : {};
    return {
      role: typeof parsed?.role === "string" ? parsed.role : undefined,
      aliases: Array.isArray(parsed?.aliases) ? parsed.aliases.map(String).filter((s: string) => s.length > 0) : [],
    };
  } catch {
    return { aliases: [] };
  }
}

/** 自生长锚 value_id：slug(label)；纯 CJK（slug 化为空）→ auto-<sha256[:10]>。
 *  P2（spec §2.6 跨类命名空间）：person 域加 p- 前缀（人物"咖啡"与主题"咖啡"不再同 id 互覆）。 */
export function growthValueId(label: string, nodeType: "theme" | "person" | "character" = "theme"): string {
  const normalized = label.trim().toLowerCase();
  const slug = normalized.replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, "");
  if (nodeType === "person") {
    return slug ? "p-" + slug : "p-auto-" + createHash("sha256").update(normalized).digest("hex").slice(0, 10);
  }
  if (nodeType === "character") {
    return slug ? "c-" + slug : "c-auto-" + createHash("sha256").update(normalized).digest("hex").slice(0, 10);
  }
  if (slug) return slug;
  return "auto-" + createHash("sha256").update(normalized).digest("hex").slice(0, 10);
}

/**
 * P2（spec §5 F15 身份分支 / F20 红线）：身份事实全量语料重验——失撑**只告警**，
 * 永不自动退场（身份红线=人工确认路径；upsertCore/retire 零调用）。
 * 弱口径 = identityFactSlice 20 字切片（identity-discovery 单源导出）。
 * 返回失撑事实数（0 = 全部有支撑或无身份槽）。
 */
export async function maintainIdentityFacts(
  store: { readCore?: (tenant?: CoreTenant) => Array<{ slot: string; content: string }> | Promise<Array<{ slot: string; content: string }>> },
  tenant: CoreTenant,
  corpus: string[],
  logger?: Logger,
): Promise<number> {
  // sqlite store readCore 为同步（v2 实证教训）；await Promise.resolve 兼容两种形态
  const core = ((await Promise.resolve(store.readCore?.(tenant))) as unknown as Array<{ slot: string; content: string }> | undefined) ?? [];
  const identity = core.find((s) => s.slot === "identity");
  if (!identity || !identity.content) return 0;
  let unsupported = 0;
  for (const line of identity.content.split("\n")) {
    const fact = line.trim();
    if (!fact.startsWith("-") || fact.length <= 1) continue;
    const slice = identityFactSlice(fact);
    if (!slice) continue;
    const ev = corpus.filter((c) => c.includes(slice)).length;
    if (ev === 0) {
      unsupported++;
      logger?.warn?.(`[GROW-MAINT] identity fact unsupported (warning-only, F20): ${slice}… (tenant=${JSON.stringify([tenant.teamId, tenant.userId, tenant.agentId])})`);
    }
  }
  return unsupported;
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
  // P2：person 子配置深合并（调用方传 Partial 且缺 person 键时不落 undefined）。
  cfg.person = { ...DEFAULT_ANCHOR_DISCOVERY_CONFIG.person, ...(deps.config?.person ?? {}) };
  cfg.identityMaintain = { ...DEFAULT_ANCHOR_DISCOVERY_CONFIG.identityMaintain, ...(deps.config?.identityMaintain ?? {}) };
  const logger = deps.logger;
  if (!cfg.enabled) return { ran: false, adopted: 0, retired: 0, reweighted: 0, displaced: 0, skipped: 0, reason: "disabled" };
  if (!deps.llmRunner || typeof deps.llmRunner.run !== "function") {
    return { ran: false, adopted: 0, retired: 0, reweighted: 0, displaced: 0, skipped: 0, reason: "no-llm" };
  }
  const store = deps.store as IMemoryStore & {
    listValuesAnyState?: (tenant?: CoreTenant) => Promise<CoreValueRow[]> | CoreValueRow[];
    retireValue?: (valueId: string, tenant?: CoreTenant) => Promise<boolean> | boolean;
    upsertValue?: (valueId: string, label: string, weight: number, createdBy?: string, tenant?: CoreTenant, valence?: number, origin?: "seed" | "manual" | "auto", nodeType?: "theme" | "person", attrs?: { role?: string; aliases?: string[] }) => Promise<boolean> | boolean;
    backfillMemoryRef?: (recordId: string, key: "coreRefs" | "personRefs" | "identityRefs", label: string, tenant?: CoreTenant) => Promise<boolean> | boolean;
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
          // v4#7：拦截静默 debug 化——"为什么锚没长出来"不再需要插桩考古
          logger?.debug?.(`[anchor-growth] gate block agent=${JSON.stringify([tenant.teamId, tenant.userId, tenant.agentId])} reason=attempt-cooldown lastAttempt=${state.lastAttemptAt} now=${new Date(nowMs).toISOString()}`);
          firstBlockReason ??= "attempt-cooldown";
          continue;
        }
        // 1b 采纳冷却：上次「有采纳」不足 intervalHours → 不跑。
        //    兼容映射：存量状态只有 lastDiscoveryAt（旧语义=每次消费轮都写）→ 视作
        //    lastAdoptedAt（保守 24h，与旧行为等价）；新写入双字段后语义精确。
        // D-R5-5：双字段行（有 lastAttemptAt）0 采纳轮不写 lastAdoptedAt → interval 门由
        // attempt-cooldown(1h) 承担（头部注释"0 采纳 1h"语义）；存量行（无 lastAttemptAt）
        // 仍用 lastDiscoveryAt 兜底保守 24h（与旧行为等价）。否则首轮失败也拉满 24h 冷却，
        // 新租户永远只有一次机会（ev11 实证：苏教授锚 ev=3 被 24h 门锁死永无第二次）。
        const lastAdoptedRaw = state.lastAdoptedAt ?? (state.lastAttemptAt != null ? undefined : state.lastDiscoveryAt);
        const lastAdopted = lastAdoptedRaw ? Date.parse(lastAdoptedRaw) : NaN;
        if (Number.isFinite(lastAdopted) && nowMs - lastAdopted < cfg.intervalHours * 3600_000) {
          // v4#7：拦截静默 debug 化（同 1a）
          logger?.debug?.(`[anchor-growth] gate block agent=${JSON.stringify([tenant.teamId, tenant.userId, tenant.agentId])} reason=interval lastAdopted=${String(lastAdoptedRaw)} intervalHours=${cfg.intervalHours} now=${new Date(nowMs).toISOString()}`);
          firstBlockReason ??= "interval";
          continue;
        }
        // ── 门 2（per-agent）：语料有新增（该桶条数 > 上轮基线；首轮无基线 → 放行建立基线）──
        // P2：cast 交集扩展后 TS 对 resolveCorpusCount 结构参数失守（TS2345）——局部结构化 cast，零行为。
        const corpusCount = await resolveCorpusCount(
          store as unknown as { countL1?: (filter?: unknown) => Promise<number> | number; queryL1Records: (filter?: unknown) => Promise<unknown[]> | unknown[] },
          tenant,
        );
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
        // F-EV12-5（REG-REMAINING-006 A-5①）：现行 self_identity 槽事实切片——character
        // 维护/守卫与采纳同源口径（identityFactSlice 单一源）；无槽/无切片 → 冻结不误退。
        const selfSlotRows = ((await Promise.resolve(store.readCore?.(tenant))) ?? []) as Array<{ slot: string; content: string }>;
        const currentFactSlices = ((selfSlotRows.find((s) => s.slot === "self_identity")?.content ?? "")
          .split("\n").map((l) => l.trim()).filter((l) => l.startsWith("-") && l.length > 1)
          .map((l) => identityFactSlice(l))).filter((s) => s.length > 0);

        // ── 自维护（GROW-MAINT）：auto 锚权重重算 + 低证据退场 ──────────
        // 只管自己生的锚（created_by='auto-growth'）；pinned 豁免；manual/seed 永不自动动。
        // 标签不原地改写（coreRefs/dedup 身份锚点）；主题演化 = 退场 + 新提案以新标签再入。
        let retiredA = 0;
        let reweightedA = 0;
        let quotaRetiredA = 0; // GROW-QUOTA：名额回归守卫退场数（并入 retired 计数）
        for (const a of anyState0) {
          if (a.state !== "active" || a.origin !== "auto" || a.created_by !== "auto-growth") continue;
          // P2：person 行分叉 personEv 口径（label+alias）；person 池关闭时不参与维护
          //（冻结而非误退——theme 口径会把 alias 支撑的人物锚误判零证据）。
          const isPerson = a.node_type === "person";
          if (isPerson && !cfg.person.enabled) continue;
          // F-EV12-5（A-5①）：character 行分叉事实切片口径（与采纳同源）；池关闭或无现行
          // 切片 → 冻结（宁缺毋滥）。theme 口径的字面 label 计数会把品格锚误判零证据。
          const isCharacter = a.node_type === "character";
          if (isCharacter && (!cfg.character?.enabled || currentFactSlices.length === 0)) continue;
          const aliases = isPerson ? attrsOf(a).aliases : [];
          const ev = isPerson
            ? personEvCount(a.label, aliases, corpus)
            : isCharacter
              ? characterEvCount(currentFactSlices, corpus)
              : recountEvidence(a.label, corpus);
          // P2：分池阈值——人物锚退场门槛用 cfg.person.minEvidence（F15/F19 护栏四件分池），
          // 沿用 theme 阈值会把别名支撑的人物锚误退（TDD QUOTA 分池用例实证）。
          // F-EV12-5：品格锚门槛用 cfg.character.minEvidence（分池同款）。
          const minEv = isPerson
            ? cfg.person.minEvidence
            : (isCharacter ? (cfg.character?.minEvidence ?? cfg.minEvidence) : cfg.minEvidence);
          if (ev < minEv) {
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
            // P2：person reweight 保留 node_type/attrs（重写不丢人物属性，A8 语义）
            // F-EV12-5：character reweight 不漂 node_type；attrs 传 undefined（不碰原 attrs_json）
            const ok = await Promise.resolve(store.upsertValue!(a.value_id, a.label, newW, a.created_by, tenant, a.valence ?? undefined, "auto", isPerson ? "person" : (isCharacter ? "character" : "theme"), isPerson ? attrsOf(a) : undefined));
            if (ok) reweightedA++;
          }
        }
        retired += retiredA;
        reweighted += reweightedA;
        const anyState = retiredA + reweightedA > 0
          ? (((await Promise.resolve(store.listValuesAnyState(tenant))) ?? []) as CoreValueRow[])
          : anyState0;
        // ── GROW-QUOTA（名额回归守卫，REG-REMAINING-004 #9）：maxTotal 的第一性目的 =
        // soul-feeling 注入预算保护——存量超限（并发竞态超采/名额下调遗留）必须回归名额，
        // 否则注入面失控且永无自愈路径（GROW-MAINT 只有证据退场）。超出部分按强度
        //（weight × 证据）升序 retire（可恢复非删除）；manual/钉住豁免（信任边界）。
        // 名额口径与 free 计算一致：限额对象 = origin=auto 活跃锚 + 钉住。
        // P2（F15 QUOTA 分池）：theme/person 各自独立计数与 maxTotal——防人物锚挤占主题锚名额。
        // theme 池行集 = 非 person 行（无 person 行时与旧口径逐位一致）；person 池仅 enabled 时守卫。
        const activeNow = anyState.filter((r) => r.state === "active");
        // P3：口径收紧——theme 池 = 显式 theme（缺省无 node_type 行=theme）；person/character 各自独立。
        const themeActive = activeNow.filter((r) => (r.node_type ?? "theme") === "theme");
        const personActive = activeNow.filter((r) => r.node_type === "person");        const characterActive = activeNow.filter((r) => r.node_type === "character");
        const quotaEvict = async (poolRows: CoreValueRow[], maxTotal: number, evOf: (r: CoreValueRow) => number, tag: string) => {
          const pinnedNow = poolRows.filter((r) => r.pinned === 1).length;
          const autoNow = poolRows.filter((r) => r.origin === "auto" && r.pinned !== 1); // 非钉 auto（钉住单列，避免 free 口径的 pinned-auto 双计）
          const overLimit = autoNow.length + pinnedNow - maxTotal;
          if (overLimit <= 0) return;
          const victims = autoNow
            .filter((r) => r.pinned !== 1 && r.created_by === "auto-growth")
            .map((r) => ({ row: r, strength: r.weight * evOf(r) }))
            .sort((a, b) => a.strength - b.strength || a.row.weight - b.row.weight || String(a.row.value_id).localeCompare(String(b.row.value_id)))
            .slice(0, overLimit);
          for (const v of victims) {
            // D-R5-2 家族：retireValue 可选方法在守卫后调用——非空断言（quotaEvict 闭包内 TS 不收窄）
            const ok = await Promise.resolve(store.retireValue!(v.row.value_id, tenant));
            if (ok) {
              quotaRetiredA++;
              logger?.warn?.(`[anchor-growth] quota guard retire (${tag}): ${v.row.value_id} (${v.row.label}) strength=${v.strength.toFixed(3)} over=${overLimit} (tenant=${JSON.stringify([tenant.teamId, tenant.userId, tenant.agentId])})`);
            } else {
              logger?.warn?.(`[anchor-growth] quota guard retire failed (${tag}): ${v.row.value_id} (${v.row.label}) (tenant=${JSON.stringify([tenant.teamId, tenant.userId, tenant.agentId])})`);
            }
          }
        };
        await quotaEvict(themeActive, cfg.maxTotal, (r) => recountEvidence(r.label, corpus), "theme");
        if (cfg.person.enabled) {
          await quotaEvict(personActive, cfg.person.maxTotal, (r) => personEvCount(r.label, attrsOf(r).aliases, corpus), "person");
        }        if (cfg.character?.enabled) {
          // F-EV12-5（A-5②）：character 池 QUOTA 守卫（与 theme/person 同款，防超限无自愈）。
          await quotaEvict(characterActive, cfg.character.maxTotal, () => characterEvCount(currentFactSlices, corpus), "character");
        }
        retired += quotaRetiredA; // GROW-QUOTA 退场并入（守卫块之后汇总）
        // GROW-MAINT v2（SOP 2026-09-17 修复）：守卫退场后刷新快照——dedup/名额/挤出必须
        // 基于退场后的真实状态（陈旧快照把已退场锚当 active：free 低估 + 挤出打已退场空炮）。
        // retired 行仍带 label，全态 dedup 集不变（veto/retire 永不重提语义不受影响）。
        const anyState2 = quotaRetiredA > 0
          ? (((await Promise.resolve(store.listValuesAnyState(tenant))) ?? []) as CoreValueRow[])
          : anyState;
        const existingLabels = anyState2.map((v) => v.label); // 全态清单进 dedup 指令（veto 永不重提）
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
        const candidates = dedupProposals(parseProposalsJson(String(raw ?? "")), existingLabels)
          .map((c) => ({ ...c, evidenceCount: recountEvidence(c.label, corpus) }))
          .filter((p) => p.evidenceCount >= cfg.minEvidence)
          .sort((a, b) => b.evidenceCount - a.evidenceCount)
          .slice(0, cfg.maxPerPass);
        // ── 名额（per-agent 桶内）：maxTotal = 钉住数 + 自生长活跃数 ──
        // GROW-MAINT v2（SOP 2026-09-17 修复）：名额口径与 GROW-QUOTA 守卫对齐——
        // 限额对象 = active 钉住（含钉 auto，只占一席）+ active 非钉 auto。旧口径把钉 auto
        // 在 pinnedCount 与 autoActive 各减一次（双计），并把 retired 钉住也计入占席——
        // 偏保守方向（少采纳），但与守卫口径不一致，统一之。
        const pinnedActive = anyState2.filter((r) => r.state === "active" && r.pinned === 1).length;
        const autoActiveNonPinned = anyState2.filter((r) => r.state === "active" && r.origin === "auto" && r.pinned !== 1);
        let free = Math.max(0, cfg.maxTotal - pinnedActive - autoActiveNonPinned.length);
        // 可挤出自生长锚列表（该 agent 的；pinned 豁免）：weight × 语料实际命中
        //（与候选同刻度，确定性），弱者优先被挤出；单轮多候选挤出时逐个弹出。
        const displaceable = autoActiveNonPinned
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
            if (ok) {
              adopted++; adoptedThisAgent++;
              // GROW-EVO P2.1（锚↔记忆双向链路）：采纳时把 label 回填进证据记录的 coreRefs
              // （证据口径 = recount 同款内容包含；R5 反查补池/Panel 金色节点/遗忘 salience 的数据前提）
              for (const r of rows) {
                if (String((r as { content?: string }).content ?? "").includes(c.label)) {
                  const rid = String((r as { record_id?: string }).record_id ?? "");
                  if (rid) store.backfillCoreRef?.(rid, c.label, tenant);
                }
              }
            }
            else { skipped++; logger?.warn?.(`[anchor-growth] adopt upsert failed: ${c.label}`); }
          }
        }
        // ── P2：person 池（同一 worker 策略化分叉，spec §2.6 单一源声明；非新 worker）──────
        // 复用已过的双门与语料；独立 LLM 调用（人物视角 prompt）+ 独立护栏（F19 别名维度去重）
        // + 独立名额（cfg.person.maxTotal，QUOTA 分池同口径）+ F12 valence 符号落列。
        if (cfg.person.enabled) {
          const personAll = anyState2.filter((r) => r.node_type === "person");
          const personNames = Array.from(new Set(personAll.flatMap((r) => [r.label, ...attrsOf(r).aliases]).map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0)));
          const personRaw = await deps.llmRunner!.run({
            prompt: buildPersonDiscoverPrompt(sampleContents, personNames),
            systemPrompt: PERSON_DISCOVER_SYSTEM_PROMPT,
            taskId: "person-discover-growth",
            timeoutMs: 0,
            maxTokens: 0,
          });
          logger?.debug?.(`[anchor-growth] person rawLen=${String(personRaw ?? "").length} rawPreview=${String(personRaw ?? "").slice(0, 200)} (tenant=${JSON.stringify([tenant.teamId, tenant.userId, tenant.agentId])})`);
          const personRowsForValence = rows.map((r) => ({
            content: String((r as { content?: string }).content ?? ""),
            valence: ((r as { valence?: number | null }).valence ?? null) as number | null,
          }));
          const personCandidates = parsePersonProposals(String(personRaw ?? ""))
            .filter((p) => {
              // F19 别名维度去重：提案 label 或任一 alias 命中既有 person label/alias（全态）→ 拒
              const names = [p.label, ...p.aliases].map((s) => s.trim().toLowerCase());
              return !names.some((nm) => personNames.includes(nm));
            })
            .map((p) => ({ ...p, evidenceCount: personEvCount(p.label, p.aliases, corpus) }))
            .filter((p) => p.evidenceCount >= cfg.person.minEvidence)
            .sort((a, b) => b.evidenceCount - a.evidenceCount)
            .slice(0, cfg.person.maxPerPass);
          const personPinnedActive = personAll.filter((r) => r.state === "active" && r.pinned === 1).length;
          const personAutoNonPinned = personAll.filter((r) => r.state === "active" && r.origin === "auto" && r.pinned !== 1);
          let freeP = Math.max(0, cfg.person.maxTotal - personPinnedActive - personAutoNonPinned.length);
          const displaceableP = personAutoNonPinned
            .map((r) => ({ row: r, strength: r.weight * personEvCount(r.label, attrsOf(r).aliases, corpus) }))
            .sort((a, b) => a.strength - b.strength || a.row.weight - b.row.weight || String(a.row.value_id).localeCompare(String(b.row.value_id)));
          for (const c of personCandidates) {
            const candidateStrength = suggestAnchorWeight(c.evidenceCount, corpus.length) * c.evidenceCount;
            let adoptedP = false;
            if (freeP > 0) {
              adoptedP = true;
              freeP--;
            } else if (displaceableP.length > 0 && candidateStrength > displaceableP[0]!.strength) {
              const weakest = displaceableP.shift()!;
              const retiredOk = await Promise.resolve(store.retireValue(weakest.row.value_id, tenant));
              if (!retiredOk) {
                skipped++;
                logger?.warn?.(`[anchor-growth] retire weakest person anchor failed: ${weakest.row.value_id} (tenant=${JSON.stringify([tenant.teamId, tenant.userId, tenant.agentId])})`);
                continue;
              }
              displaced++;
              adoptedP = true;
            } else {
              skipped++;
              continue;
            }
            if (adoptedP) {
              // F12：证据 valence 均值符号化（无 valence 证据 → undefined 走 C2 derive 钩子，IS NULL 守卫不覆盖非空）
              const meanV = personEvidenceMeanValence(c.label, c.aliases, personRowsForValence);
              const vSymbol = meanV === null ? undefined : personValenceSymbol(meanV);
              const ok = await Promise.resolve(store.upsertValue(growthValueId(c.label, "person"), c.label, suggestAnchorWeight(c.evidenceCount, corpus.length), "auto-growth", tenant, vSymbol, "auto", "person", { role: c.role, aliases: c.aliases }));
              if (ok) {
                adopted++;
                adoptedThisAgent++;
                // F12 证据链：personRefs 回填（命中口径 = personEv 同款 label/alias 包含）
                for (const r of rows) {
                  const content = String((r as { content?: string }).content ?? "");
                  if ([c.label, ...c.aliases].some((nm) => content.includes(nm))) {
                    const rid = String((r as { record_id?: string }).record_id ?? "");
                    if (rid) store.backfillMemoryRef?.(rid, "personRefs", c.label, tenant);
                  }
                }
              } else {
                skipped++;
                logger?.warn?.(`[anchor-growth] person adopt upsert failed: ${c.label}`);
              }
            }
          }
        }
        // ── P3：character 池（品格锚；聚合源=self_identity 槽事实——spike 定案 agentAct 占比 0%，
        // spec §7-P3 fallback 分支）。per-三元组（§110 拍板）；F15 独立 maxTotal 分池；
        // 证据=提案 fact 切片在语料的逐字包含（identityFactSlice 单一源复用）。
        if (cfg.character?.enabled) {
          const characterAll = anyState2.filter((r) => (r.node_type ?? "theme") === "character");
          const charNames = characterAll.map((r) => String(r.label).trim().toLowerCase()).filter((s) => s.length > 0);
          const selfFacts = (((await Promise.resolve(store.readCore?.(tenant))) ?? []) as Array<{ slot: string; content: string }>)
            .find((s) => s.slot === "self_identity")?.content
            ?.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("-") && l.length > 1) ?? [];
          if (selfFacts.length > 0) {
            const factSlices = selfFacts.map((l) => identityFactSlice(l)).filter((s): s is string => typeof s === "string" && s.length > 0);
          const charRaw = await deps.llmRunner!.run({
            prompt: buildCharacterDiscoverPrompt(selfFacts, charNames),
            systemPrompt: CHARACTER_DISCOVER_SYSTEM_PROMPT,
            taskId: "character-discover-growth",
            timeoutMs: 0,
            maxTokens: 0,
          });
          logger?.debug?.(`[anchor-growth] character rawLen=${String(charRaw ?? "").length} rawPreview=${String(charRaw ?? "").slice(0, 200)}`);
            const characterCandidates = parseCharacterProposals(String(charRaw ?? ""))
              .filter((p) => !charNames.includes(p.label.trim().toLowerCase()))
              .map((p) => {
                const slices = p.fact
                  ? selfFacts.filter((f) => f.includes(p.fact!)).map((l) => identityFactSlice(l)).filter((s): s is string => typeof s === "string" && s.length > 0)
                  : factSlices;
                return { ...p, evidenceCount: characterEvCount(slices.length > 0 ? slices : factSlices, corpus) };
              })
              .filter((p) => p.evidenceCount >= cfg.character!.minEvidence)
              .sort((a, b) => b.evidenceCount - a.evidenceCount)
              .slice(0, cfg.character!.maxPerPass);
            const characterPinnedActive = characterAll.filter((r) => r.state === "active" && r.pinned === 1).length;
            const characterAutoNonPinned = characterAll.filter((r) => r.state === "active" && r.origin === "auto" && r.pinned !== 1);
            let freeC = Math.max(0, cfg.character!.maxTotal - characterPinnedActive - characterAutoNonPinned.length);
            const displaceableC = characterAutoNonPinned
              .map((r) => ({ row: r, strength: r.weight * characterEvCount(factSlices, corpus) }))
              .sort((a, b) => a.strength - b.strength || a.row.weight - b.row.weight || String(a.row.value_id).localeCompare(String(b.row.value_id)));
            for (const c of characterCandidates) {
              const candidateStrength = suggestAnchorWeight(c.evidenceCount, corpus.length) * c.evidenceCount;
              let adoptedC = false;
              if (freeC > 0) { adoptedC = true; freeC--; }
              else if (displaceableC.length > 0 && candidateStrength > displaceableC[0]!.strength) {
                const weakest = displaceableC.shift()!;
                const retiredOk = await Promise.resolve(store.retireValue(weakest.row.value_id, tenant));
                if (!retiredOk) { skipped++; continue; }
                displaced++;
                adoptedC = true;
              } else { skipped++; continue; }
              if (adoptedC) {
                const ok = await Promise.resolve(store.upsertValue(
                  growthValueId(c.label, "character"), c.label,
                  suggestAnchorWeight(c.evidenceCount, corpus.length), "auto-growth", tenant,
                  undefined, "auto", "character", { source: "self_identity", facts: factSlices.slice(0, 3) },
                ));
                if (ok) { adopted++; adoptedThisAgent++; } else { skipped++; logger?.warn?.(`[anchor-growth] character adopt upsert failed: ${c.label}`); }
              }
            }
          }
        }
        // ── P2：identity GROW-MAINT（F15 身份分支；F20 红线——只警告永不自动退场）──────
        if (cfg.identityMaintain?.enabled) {
          const unsupported = await maintainIdentityFacts(store, tenant, corpus, logger);
          if (unsupported > 0) logger?.info?.(`[anchor-growth] identity maintain: unsupported=${unsupported} (warning-only)`);
        }
        // REG-REMAINING-003 #1：采纳路径 valence 补值钩子——自生长直调 store.upsertValue，
        // 不经 v2-router values/upsert 钩子（deriveValueValences 只在 API 路径触发），NULL valence
        // 原地落库后无人补判（boot derive 只兜重启）。本租户有采纳时 fire-and-forget 逐租户 derive
        //（写回带 valence IS NULL 守卫，与 boot / 用户微调三方幂等，LLM 永不覆盖非 NULL）。
        if (adoptedThisAgent > 0 && deps.llmRunner && typeof store.deriveValueValences === "function") {
          const deriveRunner = deps.llmRunner;
          void Promise.resolve(store.deriveValueValences(tenant, deriveRunner))
            .then((r) => {
              logger?.info?.(`[anchor-growth] valence derive (adopt): tenant=${JSON.stringify([tenant.teamId, tenant.userId, tenant.agentId])} derived=${r?.derived ?? 0} skipped=${r?.skipped ?? 0}`);
            })
            .catch((err) => {
              logger?.warn?.(`[anchor-growth] valence derive (adopt) failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
            });
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
    // ── 自维护观测（D8）：系统自计数 + 阈值旗标（P4 门槛 / arousal 漂移）──
    try {
      const obs = (store as { getSelfObsStats?: () => { l1: number; conflict: number; evolve: number; similar: number; archived: number; anchors: number } }).getSelfObsStats?.();
      if (obs) {
        // GROW-MAINT v2（SOP 2026-09-17 修复）：漂移基线经专用 kv（get/setSelfObsBaseline）
        // 持久化——此前 obs_* 键全库只有读者没有写入者，且 getAnchorGrowthState 的键集根本
        // 不含它们：±30% 归档率漂移旗标（P3.1 拍板②）是永不触发的死代码，违背自维护原则。
        // 基线全局单键组（self-obs 统计为全局口径，不 per-tenant）；首轮无基线 → drift=0 不误报。
        const baseline = (store as { getSelfObsBaseline?: () => { l1: number; archived: number } | null }).getSelfObsBaseline?.() ?? null;
        const totalMem = obs.l1 + obs.archived;
        const archiveRate = totalMem > 0 ? obs.archived / totalMem : 0;
        const prevTotal = baseline ? baseline.l1 + baseline.archived : 0;
        const prevRate = prevTotal > 0 ? baseline!.archived / prevTotal : archiveRate;
        const drift = prevRate > 0 ? Math.abs(archiveRate - prevRate) / prevRate : 0;
        const flags: string[] = [];
        if (obs.conflict >= 5) flags.push(`[P4-GATE] conflict 边 ${obs.conflict} ≥5——P4 观察期门槛到达，evolution-worker 可立项`);
        if (prevTotal > 0 && drift >= 0.3) flags.push(`[AROUSAL-GATE] 归档率漂移 ${(drift * 100).toFixed(0)}% ≥30%——arousalRetention 建议回 0`);
        logger?.info?.(`[self-obs] l1=${obs.l1} anchors=${obs.anchors} conflict=${obs.conflict} evolve=${obs.evolve} similar=${obs.similar} archived=${obs.archived} archiveRate=${archiveRate.toFixed(3)} flags=${flags.length > 0 ? flags.join(" | ") : "none"}`);
        // 本轮基线落盘（下一轮 drift 由此计算——自维护条款必须能自证）
        (store as { setSelfObsBaseline?: (b: { l1: number; archived: number }) => void }).setSelfObsBaseline?.({ l1: obs.l1, archived: obs.archived });
      }
    } catch (err) {
      logger?.warn?.(`[self-obs] failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
    // v4#7：summary 行补 firstBlockReason——ran=false 时对外宣告拦截原因（此前只有 agents/adopted 计数）
    logger?.info?.(`[anchor-growth] ran: agents=${tenants.length} adopted=${adopted} retired=${retired} reweighted=${reweighted} displaced=${displaced} skipped=${skipped}${!ranAny && firstBlockReason ? ` firstBlockReason=${firstBlockReason}` : ""}`);
    return { ran: ranAny, adopted, retired, reweighted, displaced, skipped, ...(ranAny ? {} : { reason: firstBlockReason ?? "error" }) };
  } catch (err) {
    logger?.warn?.(`[anchor-growth] failed: ${err instanceof Error ? err.message : String(err)}`);
    return { ran: false, adopted: 0, retired: 0, reweighted: 0, displaced: 0, skipped: 0, reason: "error" };
  }
}

// ── P3：character 池辅助（品格锚单一源）──────────────────────────────────────────

/** P3：品格锚 LLM 视角——只从给定自我事实归纳品格标签（宁缺毋滥；label ≤6 字）。 */
export const CHARACTER_DISCOVER_SYSTEM_PROMPT = [
  "你是团队记忆的品格锚提炼顾问。你只提议，不落库：你的输出只是候选提案，采纳与否由证据门决定。",
  "硬约束：",
  "1. 只从给定【自我事实】归纳品格标签（如 严谨/守诺/坦诚/复盘）；一次性任务、单次行为不提。",
  "2. 已有品格锚清单中的标签不得重复提议（去重）。",
  "3. 宁缺毋滥：估计支撑证据少于门槛的不要提；label 为品格词（≤6 字），不是事实复述。",
  "4. 每条提案标注其依据的自我事实原文（fact 字段，逐字摘自给定事实）。",
  "5. 只输出一个 JSON 数组，不要输出任何其它文字：[\"label\":\"…\",\"rationale\":\"…\",\"fact\":\"…\"]，无提议输出 []。",
].join("\n");

/** P3：user prompt——自我事实清单 + 既有品格锚清单 + 输出格式。 */
export function buildCharacterDiscoverPrompt(selfFacts: string[], existing: string[]): string {
  const lines: string[] = [];
  lines.push("【自我事实（agent 自我层，行为可证）】");
  for (const f of selfFacts) lines.push("- " + f);
  if (existing.length > 0) {
    lines.push("");
    lines.push("【已有品格锚（去重，不得重复提议）】");
    for (const e of existing) lines.push("- " + e);
  }
  lines.push("");
  lines.push("请输出品格提案 JSON 数组（字段：label/rationale/fact）。无合格提议输出 []。");
  return lines.join("\n");
}

/** P3：解析品格提案（宽松 JSON 提取，与 person/theme 解析同风格）。 */
export function parseCharacterProposals(raw: string): Array<{ label: string; rationale: string; fact?: string }> {
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
        label: typeof p.label === "string" ? p.label.trim() : "",
        rationale: typeof p.rationale === "string" ? p.rationale.trim() : "",
        fact: typeof p.fact === "string" ? p.fact.trim() : undefined,
      }))
      .filter((p) => p.label.length > 0 && p.label.length <= 12);
  } catch {
    return [];
  }
}

/** P3：品格证据计数——语料记录命中任一事实切片（逐字包含）的去重计数。 */
export function characterEvCount(slices: string[], corpus: string[]): number {
  let n = 0;
  for (const content of corpus) {
    const text = String(content ?? "");
    if (slices.some((s) => s.length > 0 && text.includes(s))) n++;
  }
  return n;
}
