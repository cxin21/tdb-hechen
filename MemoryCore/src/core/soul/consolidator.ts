/**
 * 人格整合器（后台，确定性 + 可选 LLM 只做「改写措辞」不做「决定采纳」）。
 *
 * 一轮整合做四件事：
 *  1) 摄入：把 core_memory 的 identity / self_identity / strict_rule / core_value 拆行分类，
 *     人格候选过六道闸，方法/事件进 method 池（可审计、不注入人格段）。
 *  2) 生命周期：α 内小步更新、相似合并、无证据降级、久无证据冻结、新证据复活。
 *  3) 漂移：与行为锚比对，连续低分降级/冻结（判断轨不自动复位）。
 *  4) 记账：每条动作写 soul_ledger（before/after 哈希 + 判定 + 证据 id），可回滚。
 *
 * 设计上刻意不让本模块调用 LLM 决定「什么算人格」——那等于把不可逆判断交给
 * 被判断者自己。LLM 只能被用来做措辞收敛（可选项），准入永远是确定性判据。
 */
import { classifyLine, stripBullet, textSimilarity } from "./gates.js";
import {
  planAdmit,
  planLifecycle,
  planMerge,
  planRevive,
  renderPersonaBlock,
  splitSlotLines,
} from "./persona.js";
import type { SoulLedgerEntry, PersonaItem, SoulBudgetReport, SoulLayer, SoulMaintenanceConfig } from "./types.js";
import { isSoulLayer, resolveSoulConfig } from "./types.js";
import { textHash } from "./gates.js";
import type { CoreTenant, IMemoryStore } from "../store/types.js";

export interface SoulSlotSnapshot {
  identity?: string | null;
  selfIdentity?: string | null;
  strictRule?: string | null;
  coreValue?: string | null;
}

export interface ImportedLine {
  /** null = 分类判为「既不进人格也不进方法池」（如用户画像行无原话支撑），进 rejected 留痕。 */
  layer: SoulLayer | null;
  text: string;
  source: "strict_rule" | "self_identity" | "identity" | "core_value";
  /** 存量导入标记：放宽形态与两难，但不放宽事件句。 */
  legacy: boolean;
  /** 分类阶段就已判死的理由码。 */
  codes?: string[];
}

export interface ConsolidationPlan {
  items: PersonaItem[];
  admitted: PersonaItem[];
  rejected: Array<{ layer: SoulLayer | null; text: string; codes: string[] }>;
  imported: number;
  merged: number;
  degraded: string[];
  frozen: string[];
  revived: string[];
  budgets: SoulBudgetReport[];
}

/**
 * 纯函数版整合：不碰 store，便于单测与 382 条 rejected 回放校准。
 * existing 为库内既有条目（可为空=首次导入）。
 */
export function planConsolidation(input: {
  slots: SoulSlotSnapshot;
  existing: PersonaItem[];
  now: string;
  config?: Partial<SoulMaintenanceConfig>;
  /** 用户原话语料（relationship 层逐字支撑用）。 */
  userCorpus?: string[];
  /** 明确的新证据 item：id → 证据 id 列表（用于复活与刷新 lastEvidenceAt）。 */
  newEvidence?: Record<string, string[]>;
  /** 是否导入存量槽（首次迁移用）。 */
  importSlots?: boolean;
}): ConsolidationPlan {
  const cfg = resolveSoulConfig(input.config);
  const importedLines = input.importSlots === false ? [] : collectSlotLines(input.slots, cfg);
  const passed = new Map<string, PersonaItem>();
  for (const it of input.existing) passed.set(it.itemId, { ...it });

  const rejected: ConsolidationPlan["rejected"] = [];
  const admitted: PersonaItem[] = [];
  let imported = 0;

  for (const line of importedLines) {
    imported += 1;
    if (line.layer === null) {
      rejected.push({ layer: null, text: line.text, codes: line.codes ?? ["dilemma_missing"] });
      continue;
    }
    // 存量行：按分类结果落层；事件/阶段仍拒收（哪怕 legacy），因为它就是污染源。
    const existingList = [...passed.values()];
    const res = planAdmit({
      layer: line.layer,
      text: line.text,
      now: input.now,
      existing: existingList,
      config: cfg,
      userCorpus: input.userCorpus,
      legacy: line.legacy,
      evidenceOrigins: ["user"],
      meta: { source: line.source, importedAt: input.now, legacy: line.legacy },
      weight: line.layer === "boundary" ? 0.9 : 0.6,
    });
    if (!res.item) {
      rejected.push({ layer: line.layer, text: line.text, codes: res.reports.filter((r) => !r.pass).map((r) => r.code) });
      continue;
    }
    const prev = passed.get(res.item.itemId);
    if (prev) {
      // 已存在：只刷新证据时间与权重，不改文本（文本改动必须走 α 更新）。
      passed.set(prev.itemId, {
        ...prev,
        lastEvidenceAt: input.now,
        updatedAt: input.now,
        weight: Math.max(prev.weight, res.item.weight),
        state: prev.state === "frozen" ? "frozen" : "active",
      });
      continue;
    }
    passed.set(res.item.itemId, res.item);
    admitted.push(res.item);
  }

  // 新证据 → 复活 / 刷新。
  const revived: string[] = [];
  for (const [id, evidenceIds] of Object.entries(input.newEvidence ?? {})) {
    const it = passed.get(id);
    if (!it) continue;
    if (it.state === "frozen" || it.state === "degraded") {
      passed.set(id, planRevive(it, input.now, evidenceIds));
      revived.push(id);
    } else {
      passed.set(id, {
        ...it,
        lastEvidenceAt: input.now,
        evidenceIds: Array.from(new Set([...it.evidenceIds, ...evidenceIds])),
      });
    }
  }

  // 生命周期（降级/冻结）。
  const life = planLifecycle([...passed.values()], input.now, cfg);
  for (const it of life.items) passed.set(it.itemId, it);

  // 合并（同层相似 ≥ 阈值）；只合并 active/degraded。
  const merge = planMerge([...passed.values()], cfg.mergeSimilarity, input.now, textSimilarity);
  for (const m of merge.merged) passed.set(m.item.itemId, m.item);

  const items = [...passed.values()].sort((a, b) => a.layer.localeCompare(b.layer) || a.itemId.localeCompare(b.itemId));
  return {
    items,
    admitted,
    rejected,
    imported,
    merged: merge.merged.length,
    degraded: life.degraded,
    frozen: life.frozen,
    revived,
    budgets: [],
  };
}

/** 把 core_memory 槽拆成「层 + 文本」候选。分类逻辑集中在 gates.classifyLine。 */
export function collectSlotLines(slots: SoulSlotSnapshot, _cfg: SoulMaintenanceConfig): ImportedLine[] {
  const out: ImportedLine[] = [];
  for (const line of splitSlotLines(slots.strictRule)) {
    out.push({ ...classifyImported(line, "strict_rule"), text: line, source: "strict_rule", legacy: true });
  }
  for (const line of splitSlotLines(slots.selfIdentity)) {
    out.push({ ...classifyImported(line, "self_identity"), text: line, source: "self_identity", legacy: true });
  }
  for (const line of splitSlotLines(slots.identity)) {
    out.push({ ...classifyImported(line, "identity"), text: line, source: "identity", legacy: true });
  }
  for (const line of splitSlotLines(slots.coreValue)) {
    out.push({ ...classifyImported(line, "core_value"), text: line, source: "core_value", legacy: true });
  }
  return out;
}

export type ImportSlotSource = "identity" | "self_identity" | "strict_rule" | "core_value";

/**
 * 导入分类：层的归属 = f(文本, 来源槽)，必须是纯函数。
 * 既有条目也能按自己的来源槽（evidenceIds 里的 slot:*）重算，因此「换层」是幂等的，
 * 不会因为本轮候选的到达顺序在不同轮之间来回漂。
 */
export function classifyImported(
  text: string,
  source: ImportSlotSource,
): { layer: SoulLayer | null; codes?: string[] } {
  // 红线槽不盲信：先分类，事件/阶段句一律进 method（不注入），其余按红线收。
  // 否则「红线槽里混进的事件报告」会被原样搬进「我不做的事」段。
  if (source === "strict_rule") {
    const raw = classifyLine(text, true);
    return { layer: raw.layer === "method" ? "method" : "boundary" };
  }
  const c = classifyLine(text, true);
  // 关于「他」的事实句即便带项目专名（「用户何晨是用友采购域开发」）也归关系层：
  // 判它 project_bound 只因为它提到公司，但它换项目也照样成立。
  if (c.layer === "method" && looksLikeUserFact(text) && !c.reports.some((r) => r.code === "event_sentence")) {
    return { layer: "relationship" };
  }
  if (c.layer === "method") return { layer: "method" };
  // identity 槽在旧系统里的语义就是「我心中的他」：句子里点名他（用户/何晨/对方）就是
  // 我与他的关系事实，不该因为句子含「取舍/而不是」被判成价值层。生产实测：「何晨是我
  // 锚定的重要的人…」曾落进 values（"我在冲突里站哪边"），把关系事实当成了价值取向。
  if (source === "identity" && !c.reports.some((r) => r.code === "event_sentence") && /(?:用户|何晨|对方)/u.test(text)) {
    return { layer: "relationship" };
  }
  if (c.layer !== null) return { layer: c.layer };
  // 身份槽里混着的「用户事实」（时区/环境/偏好）不是我的特质，但也不是该丢的噪音：
  // 它们属于关系层——「他是什么样的人」是我据以行事的稳定事实。存量导入按原文收。
  if (looksLikeUserFact(text)) return { layer: "relationship" };
  return { layer: null, codes: c.reports.filter((r) => !r.pass).map((r) => r.code) };
}

/** 「关于他」的事实句：主语是用户/对方，不是「我」。 */
export function looksLikeUserFact(text: string): boolean {
  return /^(?:用户|对方|他|她|何晨)[（(：:，,、\s]/.test(text) || /^用户/.test(text) || /^何晨/.test(text);
}

// ---------------------------------------------------------------- store 编排

export interface ConsolidationDeps {
  store: Pick<
    IMemoryStore,
    "readCore" | "listSoulPersona" | "commitSoulPersona" | "listValues" | "readSoulState"
  >;
  tenant: CoreTenant;
  now: string;
  config?: Partial<SoulMaintenanceConfig>;
  trigger: string;
  importSlots?: boolean;
  userCorpus?: string[];
  newEvidence?: Record<string, string[]>;
}

export interface ConsolidationReport extends ConsolidationPlan {
  trigger: string;
  at: string;
  ledgerEntries: number;
  stored: boolean;
  skipped?: string;
}

export async function runSoulConsolidation(deps: ConsolidationDeps): Promise<ConsolidationReport> {
  const cfg = resolveSoulConfig(deps.config);
  const base: ConsolidationReport = {
    items: [],
    admitted: [],
    rejected: [],
    imported: 0,
    merged: 0,
    degraded: [],
    frozen: [],
    revived: [],
    budgets: [],
    trigger: deps.trigger,
    at: deps.now,
    ledgerEntries: 0,
    stored: false,
  };
  if (!cfg.enabled && deps.trigger !== "import" && deps.trigger !== "replay") {
    return { ...base, skipped: "soulMaintenance.enabled=false" };
  }
  if (typeof deps.store.readCore !== "function") return { ...base, skipped: "store.readCore 缺失" };
  const rows = (await deps.store.readCore(deps.tenant)) as Array<{ slot: string; content?: string }> | null;
  const core: Record<string, { content?: string } | undefined> = {};
  for (const row of rows ?? []) core[row.slot] = { content: row.content };
  const slots: SoulSlotSnapshot = {
    identity: core?.identity?.content ?? null,
    selfIdentity: core?.self_identity?.content ?? null,
    strictRule: core?.strict_rule?.content ?? null,
    coreValue: core?.core_value?.content ?? null,
  };
  const existing =
    typeof deps.store.listSoulPersona === "function"
      ? await deps.store.listSoulPersona(deps.tenant)
      : [];
  const plan = planConsolidation({
    slots,
    existing,
    now: deps.now,
    config: cfg,
    userCorpus: deps.userCorpus,
    newEvidence: deps.newEvidence,
    importSlots: deps.importSlots,
  });
  if (typeof deps.store.commitSoulPersona !== "function") return { ...base, ...plan, skipped: "store.commitSoulPersona 缺失" };
  const ledger = buildLedger(plan, existing, deps.now, deps.trigger);
  const res = await deps.store.commitSoulPersona(deps.tenant, { upsert: plan.items, ledger });
  return { ...base, ...plan, ledgerEntries: res.ledgered, stored: true };
}

/** 由 plan diff 生成账本；未变化的条目不入账（避免每轮刷账）。 */
export function buildLedger(
  plan: ConsolidationPlan,
  existing: PersonaItem[],
  now: string,
  trigger: string,
): SoulLedgerEntry[] {
  const before = new Map(existing.map((i) => [i.itemId, i]));
  const out: SoulLedgerEntry[] = [];
  const push = (e: Omit<SoulLedgerEntry, "entryId" | "at">) => {
    const key = `${trigger}|${e.layer}|${e.itemId ?? "-"}|${e.action}|${e.afterHash ?? "-"}|${e.reason}`;
    out.push({ ...e, entryId: `led-${textHash(key)}`, at: now });
  };
  for (const item of plan.items) {
    const prev = before.get(item.itemId);
    if (!prev) {
      push({
        trigger,
        layer: item.layer,
        itemId: item.itemId,
        action: "admit",
        afterHash: itemHash(item),
        gates: ["ok"],
        reason: `准入（${item.evidenceOrigins.join("/")}）`,
        evidenceIds: item.evidenceIds,
        before: null,
      });
      continue;
    }
    if (item.state !== prev.state) {
      const action =
        item.state === "frozen" ? "freeze" : item.state === "merged" ? "merge" : item.state === "degraded" ? "degrade" : "revive";
      push({
        trigger,
        layer: item.layer,
        itemId: item.itemId,
        action,
        beforeHash: itemHash(prev),
        afterHash: itemHash(item),
        gates: [action],
        reason: `${prev.state} → ${item.state}`,
        evidenceIds: item.evidenceIds,
        before: prev,
      });
    } else if (item.text !== prev.text) {
      push({
        trigger,
        layer: item.layer,
        itemId: item.itemId,
        action: "update",
        beforeHash: itemHash(prev),
        afterHash: itemHash(item),
        gates: ["alpha"],
        reason: "α 内文本更新",
        evidenceIds: item.evidenceIds,
        before: prev,
      });
    }
  }
  for (const r of plan.rejected) {
    push({
      trigger,
      // 未落层的拒绝（分类即死）记在 method 名下：账本只要求可追溯，不要求编造层级。
      layer: r.layer ?? "method",
      action: "reject",
      gates: r.codes,
      reason: `拒收：${r.codes.join(",")}`,
      evidenceIds: [],
      before: null,
    });
  }
  return out;
}

export function itemHash(item: PersonaItem): string {
  return textHash(`${item.layer}|${item.text}|${item.state}|${item.weight.toFixed(3)}`);
}

// ---------------------------------------------------------------- 渲染入口

export interface PersonaRenderResult {
  text: string;
  reports: SoulBudgetReport[];
  itemCount: number;
}

/** 注入侧：读人格条目 → 分层预算渲染；任何 store 能力缺失都返回空（不影响旧渲染）。 */
export async function loadPersonaRender(
  store: Partial<IMemoryStore> | null | undefined,
  tenant: CoreTenant,
  config?: Partial<SoulMaintenanceConfig>,
): Promise<PersonaRenderResult> {
  const cfg = resolveSoulConfig(config);
  if (!store || typeof store.listSoulPersona !== "function") return { text: "", reports: [], itemCount: 0 };
  const items = await store.listSoulPersona(tenant);
  const render = renderPersonaBlock(items, cfg);
  return { text: render.text, reports: render.reports, itemCount: items.length };
}

/** 保存到 method 池的候选（被拒为人格但值得审计的事件/方法论）。 */
export function methodPoolItems(plan: ConsolidationPlan): PersonaItem[] {
  return plan.items.filter((i) => i.layer === "method");
}

export function asBudgetReport(layer: SoulLayer, items: PersonaItem[], cfg: SoulMaintenanceConfig): SoulBudgetReport {
  const visible = items.filter((i) => i.layer === layer && i.state !== "frozen" && i.state !== "merged");
  return {
    layer,
    usedChars: visible.reduce((n, i) => n + i.text.length, 0),
    budgetChars: cfg.budget[layer] ?? 0,
    rendered: visible.length,
    omitted: [],
  };
}

export { isSoulLayer };
