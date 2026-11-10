/**
 * I 遗忘 · worker：读 L1 → 打分 → 挑出应归档的候选（软删，宁漏勿多）。
 * 幂等 + 审计 C：支持租户 filter（默认不过滤保持兼容，显式传入才生效）；
 * 审计 B1：价值锚命中 → 显著性 boost → 更难被遗忘。价值锚来源已退场（2026-11-07）：
 * 只有调用方显式传入 deps.values 才生效，本 worker 不从任何表读取。
 */
import type { IMemoryStore } from "../../store/types.js";
import type { Logger } from "../../types.js";
import type { SoulLedgerEntry } from "../../soul/types.js";
import { classify, classifyWithValues, DEFAULT_FORGETTING_CONFIG, isRefProtected } from "./scorer.js";
import { identityFactSlice } from "../identity-discovery.js";
import { isRecurrenceMeta } from "../../record/l1-extractor.js";
import type { ForgettingConfig } from "./scorer.js";
import type { AppraisalConfig } from "../feeling/appraisal.js";

// 审计修复（lifecycle-scheduler 依赖此 re-export）
export type { ForgettingConfig };

export interface ForgettingWorkerDeps {
  queryL1: () => Promise<Array<{ id?: string; record_id?: string; priority: number; metadata?: unknown; timestamps?: string[]; certainty?: string; content?: string }>> | Array<{ id?: string; record_id?: string; priority: number; metadata?: unknown; timestamps?: string[]; certainty?: string; content?: string }>;
  config?: ForgettingConfig;
  logger?: Logger;
  /** 提供则把候选真正归档到 l1_archive（软删可恢复，仅 observed 自动归档——红线） */
  store?: IMemoryStore;
  /** 审计 B1：价值锚清单——只能由调用方显式提供（价值锚表已退场，本 worker 不读任何表）；未传=无 boost。 */
  /** P2（F14）：现行身份事实切片集（identityRefs 重验基准）。runForgettingOnStore 自动从
   *  store.readCore(filter) 的 identity 槽提取；直连 runForgetting 的调用方需显式传入。 */
  identitySlices?: string[];
  /** P2 SOP 实证修正：锚扫描租户——缺省 undefined=default 租户，非默认租户的保护名集
   *  会恒空（保护静默失效）；调度器/OnStore 路径传 deps.config.filter。 */
  tenant?: { teamId?: string; userId?: string; agentId?: string };
  values?: Array<{ id: string; label: string; weight: number }>;
  /** 审计 B1：appraisal 配置（enabled/firedThreshold）。缺省用默认（enabled, 0.4）。 */
  appraisalConfig?: AppraisalConfig;
}

export interface ForgettingRunResult {
  candidates: string[];
  archived: number;
  counts: { scanned: number; archive: number };
}

/** 运行一轮遗忘：判出候选，并在提供 store 时真正软删归档（仅 observed；宁漏勿多 + 可恢复）。 */
export async function runForgetting(deps: ForgettingWorkerDeps): Promise<ForgettingRunResult> {
  const cfg = { ...DEFAULT_FORGETTING_CONFIG, ...(deps.config ?? {}) };
  const candidates: string[] = [];
  // S8（2026-11-07）：价值锚整表已删除，锚名保护维度随数据面退场；仅保留显式 deps.values
  // （调用方自备清单/测试）与身份切片保护。
  // P0-C（2026-11-07）：既然 values 来源已不可用，就不能再静默报 valuesAnchor=0——
  // 保护源改成 soul_persona 的引用对象（personaAnchor），一个都取不到时明确告警一次。
  const explicitAnchors = deps.values ?? [];

  const records = typeof deps.queryL1 === "function" ? await deps.queryL1() : (deps.queryL1 as unknown as Array<unknown>);
  let scanned = 0;
  // P2（F14）：保护上下文——active 锚名集（theme label ∪ person label/alias）+ 现行身份事实切片集。
  // P2 SOP 实证修正：租户聚合——显式 deps.tenant 优先（单租户路径）；否则按批内记录租户去重
  // （调度器无 filter 时全表扫描，单租户取锚=非默认租户保护名集恒空=保护静默失效）。
  const refProtectionOn = cfg.refProtection === true;
  // D-4（2026-09-22 拍板）：周期性事实遗忘保护（缺省 false=逐位现状）。
  const recurrenceProtectionOn = cfg.recurrenceProtection === true;
  const anchorNames = new Set<string>();
  let personaAnchorCount = 0;
  const identitySliceSet = new Set<string>(refProtectionOn ? (deps.identitySlices ?? []) : []);
  if (refProtectionOn) {
    type TenantTriple = { teamId: string; userId: string; agentId: string };
    const tenants = new Map<string, TenantTriple>();
    if (deps.tenant) {
      tenants.set(`${deps.tenant.teamId ?? "default"}|${deps.tenant.userId ?? "default"}|${deps.tenant.agentId ?? "default"}`, { teamId: deps.tenant.teamId ?? "default", userId: deps.tenant.userId ?? "default", agentId: deps.tenant.agentId ?? "default" });
    } else {
      for (const m of (records as Array<{ teamId?: string; userId?: string; agentId?: string; team_id?: string; user_id?: string; agent_id?: string }>)) {
        const teamId = m.teamId ?? m.team_id ?? "default";
        const userId = m.userId ?? m.user_id ?? "default";
        const agentId = m.agentId ?? m.agent_id ?? "default";
        tenants.set(`${teamId}|${userId}|${agentId}`, { teamId, userId, agentId });
      }
    }
    const readCoreOf = deps.store as unknown as { readCore?: (t?: unknown) => Array<{ slot: string; content: string }> | Promise<Array<{ slot: string; content: string }>> } | undefined;
    for (const t of tenants.values()) {
      try {
        const core = ((await Promise.resolve(readCoreOf?.readCore?.(t))) ?? []) as Array<{ slot: string; content: string }>;
        const identity = core.find((s) => s.slot === "identity");
        if (identity?.content) {
          for (const l of identity.content.split("\n").filter((l) => l.trim().startsWith("-"))) {
            const s = identityFactSlice(l);
            if (s) identitySliceSet.add(s);
          }
        }
      } catch { /* 身份切片缺失只损失 identityRefs 保护维度 */ }
    }
    // P0-C：锚名保护源的替代——core_values 删表后 valuesAnchor 恒 0，改用 soul_persona
    // 条目的对象名（meta.object）作为 personaAnchor；调用方显式传入的 deps.values 仍然生效。
    const personaAnchorNames = await readPersonaAnchorNames(deps.store, deps.tenant);
    for (const n of personaAnchorNames) anchorNames.add(n);
    for (const v of explicitAnchors) if (v?.label) anchorNames.add(v.label);
    personaAnchorCount = personaAnchorNames.size;
    if (anchorNames.size === 0) {
      await reportAnchorUnavailable(deps, personaAnchorCount);
    }
  }
  for (const m of (records as Array<{ id?: string; record_id?: string; priority: number; metadata?: unknown; timestamps?: string[]; certainty?: string; content?: string }>)) {
    const rec = m as unknown as Parameters<typeof classify>[0] & { content?: string };
    const action = explicitAnchors.length > 0
      ? classifyWithValues(rec, explicitAnchors, cfg, Date.now(), deps.appraisalConfig)
      : classify(rec, cfg);
    if (action === "archive") {
      // 红线：仅 observed 自动归档；inferred 需人工/更高阈值
      if ((m.certainty ?? "observed") === "inferred") continue;
      const id = m.id ?? m.record_id;
      // P2（F14）：refs 遗忘保护——排除前重验（悬空 refs 不保护，防永生记忆）；缺省关闭=逐位现状
      if (refProtectionOn && isRefProtected((m as { metadata?: unknown }).metadata, anchorNames, identitySliceSet)) continue;
      // D-4：周期性事实遗忘保护——normalize 形状重验后才保护（防提取侧绕过）。
      if (recurrenceProtectionOn && isRecurrenceMeta((m as { metadata?: Record<string, unknown> }).metadata?.recurrence)) continue;
      if (id) candidates.push(id);
    }
    scanned++;
    if (cfg.maxPerRun > 0 && candidates.length >= cfg.maxPerRun) break;
  }
  let archived = 0;
  if (deps.store?.archiveL1 && candidates.length > 0) {
    for (const id of candidates) {
      try {
        if (deps.store.archiveL1(id, "forgetting")) archived++;
      } catch (err) {
        deps.logger?.warn?.(`[forgetting] archive failed for ${id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  // P0-C：字段从 valuesAnchor 改成 personaAnchor——values 数据面已删，再报 valuesAnchor=0
  // 会让人以为「价值锚保护在工作、只是命中 0」，实际是来源不存在。
  deps.logger?.info?.(
    `[forgetting] ran: scanned=${scanned}, archiveCandidates=${candidates.length}, archived=${archived}, personaAnchor=${personaAnchorCount}`,
  );
  return { candidates, archived, counts: { scanned, archive: candidates.length } };
}

/** P0-C 告警码：锚保护源不可用（core_values 已删、soul_persona 也没给出可用的对象名）。 */
export const FORGETTING_ANCHOR_ALERT = "forgetting_values_protection_unavailable";
/** 与 soul worker 的 alert 同口径：同一 code 6 小时内只留一条账本，不每 tick 刷。 */
const ANCHOR_ALERT_SUPPRESS_MS = 6 * 3_600_000;

type ForgettingTenant = { teamId?: string; userId?: string; agentId?: string } | undefined;

/**
 * 锚名来源（P0-C）：soul_persona 条目的对象名（meta.object）。
 * 取 2–24 字：太短是「他/她」这类代词，太长是整句任务标题——都不是 refs 里会出现的名字。
 */
async function readPersonaAnchorNames(store: IMemoryStore | undefined, tenant: ForgettingTenant): Promise<Set<string>> {
  const out = new Set<string>();
  if (typeof store?.listSoulPersona !== "function") return out;
  try {
    const rows = (await Promise.resolve(store.listSoulPersona(tenant as never))) ?? [];
    for (const item of rows) {
      const meta = (item?.meta ?? {}) as Record<string, unknown>;
      const object = typeof meta.object === "string" ? meta.object.trim() : "";
      if (object.length >= 2 && object.length <= 24) out.add(object);
    }
  } catch {
    // 读不到 persona 只损失锚名保护维度，告警走同一个 unavailable 事件。
  }
  return out;
}

/** 6h 抑制：近 6 小时内已有同 code 的 alert 账本 → true。 */
async function anchorAlertRecentlyLogged(
  store: IMemoryStore | undefined,
  tenant: ForgettingTenant,
  nowMs: number,
): Promise<boolean> {
  if (typeof store?.listSoulLedger !== "function") return false;
  try {
    const rows = (await Promise.resolve(store.listSoulLedger(tenant as never, 200))) ?? [];
    return rows.some((e) => {
      if (e.action !== "alert" || !(e.gates ?? []).includes(FORGETTING_ANCHOR_ALERT)) return false;
      const at = Date.parse(e.at);
      return Number.isFinite(at) && at > nowMs - ANCHOR_ALERT_SUPPRESS_MS;
    });
  } catch {
    return false;
  }
}

/**
 * 显式报告「锚保护源不可用」（P0-C）：一次 warn + 一条 soul_ledger alert（6h 抑制）。
 * 此前这件事完全没有信号——生产日志只有 `valuesAnchor=0`，看上去像「保护正常、命中 0」。
 */
async function reportAnchorUnavailable(deps: ForgettingWorkerDeps, personaAnchor: number): Promise<void> {
  const nowMs = Date.now();
  if (await anchorAlertRecentlyLogged(deps.store, deps.tenant, nowMs)) return;
  const at = new Date(nowMs).toISOString();
  deps.logger?.warn?.(
    `[forgetting] 锚保护源不可用：core_values 已删、soul_persona 也没给出对象名（personaAnchor=${personaAnchor}）；` +
      `refs 保护只剩 identityRefs，coreRefs/personRefs 不会挡住任何归档`,
  );
  if (typeof deps.store?.commitSoulPersona !== "function") return;
  const entry: SoulLedgerEntry = {
    // 6h 一个桶：同一窗口内重复调用落同一条（soul_ledger 主键幂等）。
    entryId: `alert-forgetting-anchor-${Math.floor(nowMs / ANCHOR_ALERT_SUPPRESS_MS)}`,
    at,
    trigger: "forgetting",
    layer: "all",
    action: "alert",
    gates: [FORGETTING_ANCHOR_ALERT],
    reason: `锚保护源不可用：personaAnchor=${personaAnchor}（core_values 已删）`,
    evidenceIds: [],
  };
  try {
    await Promise.resolve(deps.store.commitSoulPersona(deps.tenant as never, { upsert: [], ledger: [entry] }));
  } catch (err) {
    deps.logger?.warn?.(`[forgetting] alert ledger write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 便捷封装：从 store 读 L1 后判定并归档（隔离过滤可选；租户 filter 透传——审计 C）。 */
export async function runForgettingOnStore(
  store: IMemoryStore,
  opts: { config?: ForgettingConfig; filter?: { teamId: string; userId: string; agentId: string }; logger?: Logger; appraisalConfig?: AppraisalConfig },
): Promise<ForgettingRunResult> {
  const records = store.queryL1Records ? await store.queryL1Records(opts.filter) : [];
  // P2（F14）：身份切片集自动接线（identity 槽 → identityFactSlice 20 字单源；失败降级空集）
  let identitySlices: string[] | undefined;
  if (opts.config?.refProtection === true) {
    try {
      const core = ((await Promise.resolve((store as unknown as { readCore?: (f?: unknown) => Array<{ slot: string; content: string }> | Promise<Array<{ slot: string; content: string }>> }).readCore?.(opts.filter))) ?? []) as Array<{ slot: string; content: string }>;
      const identity = core.find((s) => s.slot === "identity");
      if (identity?.content) {
        identitySlices = identity.content.split("\n").filter((l) => l.trim().startsWith("-")).map((l) => identityFactSlice(l)).filter(Boolean);
      }
    } catch { identitySlices = []; }
  }
  return runForgetting({ queryL1: () => records as never, config: opts.config, logger: opts.logger, store, appraisalConfig: opts.appraisalConfig, identitySlices, tenant: opts.filter });
}
