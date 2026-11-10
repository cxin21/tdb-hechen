/**
 * 关系状态写者（P2 §4.4）：把已落库事件里的关系事实，确定性累加成「我对某人此刻的
 * 信任/亲近/尊重/亏欠」，并把每次变化写进 soul_person_state_events。
 *
 * 为什么必须确定性、且不做心理推断（spec §9）：
 *  - 状态只能从 history.ts 已有的 relationship 事实（trust/conflict/repair）来；
 *    抽不到就不写，不拿 valence/情绪分猜「他现在信不信我」。
 *  - 归属只在「这条事件恰好只涉及一个人」时成立（persons_json 长度 === 1）；
 *    0 个或 ≥2 个人一律不猜——把两个人的态度记到一个人头上，比不记更糟。
 *  - 同一事件重放不重复累加：已进 evidence_event_ids_json 的 episode 直接跳过。
 *    维护 tick 会重算派生视图，没有这层幂等，信任分会随 tick 次数单调漂移。
 *
 * 常量直接写在代码里（用户拍板：不新增配置项/开关/环境变量）。
 */

import { textHash } from "./gates.js";
import { factsFromEpisode, type HistoryFact } from "./history.js";
import type { SoulEpisode } from "./types.js";
import type { SoulPersonStateEventInsert, SoulPersonStateInsert, SoulPersonStateRow } from "../store/soul-event-types.js";
import type { CoreTenant } from "../store/types.js";

export type PersonStateAxis = "trust" | "affinity" | "respect" | "obligation";

/** 四轴起点：没有旧行时从 0.5 开始（既不是满分也不是零分，避免第一件事把人打成负分）。 */
export const PERSON_STATE_AXIS_DEFAULTS: Readonly<Record<PersonStateAxis, number>> = {
  trust: 0.5,
  affinity: 0.5,
  respect: 0.5,
  obligation: 0.5,
};

/** 证据再多也不把 confidence 推到 1：关系状态永远有下一步可能推翻它。 */
export const PERSON_STATE_MAX_CONFIDENCE = 0.9;
export const PERSON_STATE_BASE_CONFIDENCE = 0.5;
/** 每多一条新证据 +0.05；到 8 条封顶。 */
export const PERSON_STATE_CONFIDENCE_STEP = 0.05;

/** 单条事实对四轴的影响。数值是产品手感（可调要改代码，不开口子）：
 *  - 把判断权交给我：信任 +0.08、尊重 +0.03；
 *  - 开始不放心：信任 -0.10、亲近 -0.03（比正向更重，失信是关系里更贵的事）；
 *  - 冲突未修复：信任 -0.05、亲近 -0.04、尊重 -0.02；
 *  - 修复：信任 +0.06、亲近 +0.05、尊重 +0.02（补上不等于没发生，所以低于单次信任上行）。
 */
export const PERSON_STATE_DELTAS: Readonly<Record<string, Partial<Record<PersonStateAxis, number>>>> = {
  "trust:up": { trust: 0.08, respect: 0.03 },
  "trust:down": { trust: -0.1, affinity: -0.03 },
  conflict: { trust: -0.05, affinity: -0.04, respect: -0.02 },
  repair: { trust: 0.06, affinity: 0.05, respect: 0.02 },
};

/** 事实 → 轴增量。self 层事实（failure/promise/review）对关系状态没有贡献，返回空对象。 */
export function personStateDeltaForFact(fact: HistoryFact): Partial<Record<PersonStateAxis, number>> {
  if (fact.layer !== "relationship") return {};
  if (fact.kind === "trust") {
    if (fact.direction === "up") return PERSON_STATE_DELTAS["trust:up"]!;
    if (fact.direction === "down") return PERSON_STATE_DELTAS["trust:down"]!;
    return {};
  }
  return PERSON_STATE_DELTAS[fact.kind] ?? {};
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, Number(v.toFixed(4))));
}

function parseIds(json: string | undefined): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string" && x !== "") : [];
  } catch {
    return [];
  }
}

/** 事件行 id 确定性：同一 (person, episode, field, 那条原话) 只写一次（重放不翻倍）。 */
function stateEventId(personKey: string, fact: HistoryFact, field: string): string {
  const episode = fact.episodeIds[0] ?? "no-episode";
  return "pse:" + personKey + ":" + episode + ":" + field + ":" + textHash(fact.kind + "|" + fact.text);
}

export interface DerivedPersonState {
  state: SoulPersonStateInsert;
  events: SoulPersonStateEventInsert[];
}

/**
 * 纯派生：给定一个人、他此前状态和一批事件，算出「新的状态行 + 需要追加的审计行」。
 * 返回 null 表示这批事件与这个人无关（不建行、不写审计）。
 */
export function derivePersonState(args: {
  personKey: string;
  previous: SoulPersonStateRow | null;
  episodes: SoulEpisode[];
  now: string;
}): DerivedPersonState | null {
  const { personKey, previous, episodes, now } = args;
  const mine = episodes.filter((ep) => Array.isArray(ep.persons) && ep.persons.length === 1 && ep.persons[0] === personKey);
  if (mine.length === 0) return null;

  const facts = mine
    .flatMap((ep) => factsFromEpisode(ep))
    .filter((f) => f.layer === "relationship")
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  const seen = new Set(parseIds(previous?.evidence_event_ids_json));
  const newFacts = facts.filter((f) => f.episodeIds.every((id) => !seen.has(id)));

  const axes: Record<PersonStateAxis, number> = {
    trust: clamp01(previous?.trust ?? PERSON_STATE_AXIS_DEFAULTS.trust),
    affinity: clamp01(previous?.affinity ?? PERSON_STATE_AXIS_DEFAULTS.affinity),
    respect: clamp01(previous?.respect ?? PERSON_STATE_AXIS_DEFAULTS.respect),
    obligation: clamp01(previous?.obligation ?? PERSON_STATE_AXIS_DEFAULTS.obligation),
  };
  const events: SoulPersonStateEventInsert[] = [];
  for (const fact of newFacts) {
    const delta = personStateDeltaForFact(fact);
    for (const field of Object.keys(delta) as PersonStateAxis[]) {
      const step = delta[field] ?? 0;
      if (step === 0) continue;
      const oldValue = axes[field];
      const newValue = clamp01(oldValue + step);
      if (newValue === oldValue) continue;
      axes[field] = newValue;
      events.push({
        id: stateEventId(personKey, fact, field),
        person_key: personKey,
        event_id: fact.episodeIds[0] ?? null,
        field,
        old_value: oldValue,
        new_value: newValue,
        reason: fact.text.slice(0, 160),
        at: fact.at,
      });
    }
  }

  const evidence = Array.from(new Set([...seen, ...facts.flatMap((f) => f.episodeIds)]));
  const lastAt = mine.reduce((acc, ep) => (ep.at > acc ? ep.at : acc), previous?.last_interaction_at ?? "");
  const confidence = clamp01(
    Math.min(
      PERSON_STATE_MAX_CONFIDENCE,
      (previous?.confidence ?? PERSON_STATE_BASE_CONFIDENCE) + PERSON_STATE_CONFIDENCE_STEP * newFacts.length,
    ),
  );

  return {
    state: {
      person_key: personKey,
      trust: axes.trust,
      affinity: axes.affinity,
      respect: axes.respect,
      obligation: axes.obligation,
      boundaries_json: previous?.boundaries_json ?? "{}",
      model_json: previous?.model_json ?? "{}",
      last_interaction_at: lastAt === "" ? null : lastAt,
      evidence_event_ids_json: JSON.stringify(evidence),
      confidence,
      updated_at: now,
    },
    events,
  };
}

/** 写者只依赖这些可选 store 能力（缺失时整体跳过，与人物档案通道同一惯例）。 */
export interface PersonStateStorePort {
  listSoulEpisodes?: (tenant?: CoreTenant, opts?: { limit?: number; includeArchived?: boolean }) => SoulEpisode[] | Promise<SoulEpisode[]>;
  listSoulPersonStates?: (tenant?: CoreTenant) => SoulPersonStateRow[] | Promise<SoulPersonStateRow[]>;
  /** 返回值只用于「写成功了没有」的 await 边界；具体形状由 store 实现决定（created/updated 或整行）。 */
  upsertSoulPersonState?: (tenant: CoreTenant | undefined, row: SoulPersonStateInsert) => unknown;
  insertSoulPersonStateEvents?: (
    tenant: CoreTenant | undefined,
    rows: SoulPersonStateEventInsert[],
  ) => { inserted: number } | Promise<{ inserted: number }>;
}

export interface PersonStateMaintenanceResult {
  /** 本轮观察到、且只涉及一个人的 person 数。 */
  persons: number;
  /** 实际 upsert 的状态行数。 */
  updated: number;
  /** 实际新增的审计行数（幂等命中的重复行不计）。 */
  events: number;
}

/**
 * 维护 tick 的写者：按人聚合事件 → 派生 → upsert 状态 + 追加审计。
 * episodes 可由调用方直接传（tick 里已经有 episodePool，避免再查一次库）。
 */
export async function runPersonStateMaintenance(args: {
  store: PersonStateStorePort;
  tenant: CoreTenant;
  episodes?: SoulEpisode[];
  now?: string;
  logger?: { warn?: (msg: string) => void };
}): Promise<PersonStateMaintenanceResult> {
  const { store, tenant } = args;
  const now = args.now ?? new Date().toISOString();
  const result: PersonStateMaintenanceResult = { persons: 0, updated: 0, events: 0 };
  let episodes = args.episodes;
  if (!episodes) {
    if (typeof store.listSoulEpisodes !== "function") return result;
    episodes = (await store.listSoulEpisodes(tenant, { limit: 500 })) ?? [];
  }
  const keys = new Set<string>();
  for (const ep of episodes) {
    if (Array.isArray(ep.persons) && ep.persons.length === 1 && ep.persons[0]) keys.add(ep.persons[0]);
  }
  if (keys.size === 0) return result;

  const existing =
    typeof store.listSoulPersonStates === "function" ? ((await store.listSoulPersonStates(tenant)) ?? []) : [];
  const byKey = new Map(existing.map((row) => [row.person_key, row]));
  const upsert = store.upsertSoulPersonState;
  const appendEvents = store.insertSoulPersonStateEvents;
  if (typeof upsert !== "function") return result;

  for (const key of keys) {
    result.persons += 1;
    try {
      const derived = derivePersonState({ personKey: key, previous: byKey.get(key) ?? null, episodes, now });
      if (!derived) continue;
      await Promise.resolve(upsert.call(store, tenant, derived.state));
      result.updated += 1;
      if (derived.events.length > 0 && typeof appendEvents === "function") {
        const written = await Promise.resolve(appendEvents.call(store, tenant, derived.events));
        result.events += written?.inserted ?? 0;
      }
    } catch (err) {
      args.logger?.warn?.(
        "[soul-person-state] " + key + " 写入失败：" + (err instanceof Error ? err.message : String(err)),
      );
    }
  }
  return result;
}
