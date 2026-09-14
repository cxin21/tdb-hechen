/**
 * I 遗忘 · worker：读 L1 → 打分 → 挑出应归档的候选（软删，宁漏勿多）。
 * 幂等 + 审计 C：支持租户 filter（默认不过滤保持兼容，显式传入才生效）；
 * 审计 B1：提供 store 时自动从 core_values 表读价值锚，价值命中 → 显著性 boost → 更难被遗忘。
 */
import type { IMemoryStore } from "../../store/types.js";
import type { Logger } from "../../types.js";
import { classify, classifyWithValues, DEFAULT_FORGETTING_CONFIG } from "./scorer.js";
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
  /** 审计 B1：价值锚（缺省从 store.listValues() 读 core_values 表；读不到则退化为无 boost）。 */
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

  // 审计 B1：单一价值锚源 = core_values 表（store.listValues）。显式传入 deps.values 优先。
  let values = deps.values;
  if (values === undefined && deps.store?.listValues) {
    try {
      const rows = await deps.store.listValues();
      values = (rows ?? []).map((r) => ({ id: r.value_id, label: r.label, weight: r.weight }));
    } catch {
      values = [];
    }
  }
  values = values ?? [];

  const records = typeof deps.queryL1 === "function" ? await deps.queryL1() : (deps.queryL1 as unknown as Array<unknown>);
  let scanned = 0;
  for (const m of (records as Array<{ id?: string; record_id?: string; priority: number; metadata?: unknown; timestamps?: string[]; certainty?: string; content?: string }>)) {
    const rec = m as unknown as Parameters<typeof classify>[0] & { content?: string };
    const action = values.length > 0
      ? classifyWithValues(rec, values, cfg, Date.now(), deps.appraisalConfig)
      : classify(rec, cfg);
    if (action === "archive") {
      // 红线：仅 observed 自动归档；inferred 需人工/更高阈值
      if ((m.certainty ?? "observed") === "inferred") continue;
      const id = m.id ?? m.record_id;
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
  deps.logger?.info?.(`[forgetting] ran: scanned=${scanned}, archiveCandidates=${candidates.length}, archived=${archived}, valuesAnchor=${values.length}`);
  return { candidates, archived, counts: { scanned, archive: candidates.length } };
}

/** 便捷封装：从 store 读 L1 后判定并归档（隔离过滤可选；租户 filter 透传——审计 C）。 */
export async function runForgettingOnStore(
  store: IMemoryStore,
  opts: { config?: ForgettingConfig; filter?: { teamId: string; userId: string; agentId: string }; logger?: Logger; appraisalConfig?: AppraisalConfig },
): Promise<ForgettingRunResult> {
  const records = store.queryL1Records ? await store.queryL1Records(opts.filter) : [];
  return runForgetting({ queryL1: () => records as never, config: opts.config, logger: opts.logger, store, appraisalConfig: opts.appraisalConfig });
}
