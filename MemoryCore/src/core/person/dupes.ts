/**
 * 同一租户内同名人物（soul_person 两行）的只读检测。
 *
 * 为什么单独一个文件：合并方案
 * `docs/specs/2026-11-10-soul-person-dedupe-spec.md` 要求「先人工确认属于 A/B 级」，
 * 而判据（归一化同名、platform_id 有无、aliases 是否已登记、墓碑是否还挂着数据）
 * 必须和代码里的写法一致，否则人工照着 SQL 手抄就会漂。这里只做只读扫描，
 * 一行都不写；真正的键改写仍按 spec §4 人工执行。
 *
 * 设计边界：
 * - 不 import store / sqlite（脚本用 node:sqlite 直接开库），只吃一个最小 db 句柄；
 * - 表可能不存在（旧库/迁移前形态）——一律当「0 行」，不抛；
 * - C 级只登记不合并（错字、角色名、跨租户、两个不同 platform_id）。
 */
import { normalizePersonName } from "./resolve.js";

/** 只读扫描需要的最小数据库句柄（node:sqlite 的 DatabaseSync 满足）。 */
export interface DupScanDb {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
}

interface PersonRow {
  person_key: string;
  team_id: string | null;
  user_id: string | null;
  agent_id: string | null;
  platform: string | null;
  platform_id: string | null;
  display_name: string | null;
  aliases_json: string | null;
  merged_into: string | null;
  created_at: string | null;
}

export interface DupCandidateRow {
  personKey: string;
  displayName: string;
  platform: string;
  platformId: string;
  aliases: string[];
  createdAt: string;
}

export interface DupGroup {
  teamId: string;
  userId: string;
  agentId: string;
  name: string;
  /** A：同 platform_id（理论不可达，历史行可能残留）；B：人工确认后合并；C：只登记候选。 */
  level: "A" | "B" | "C";
  reason: string;
  rows: DupCandidateRow[];
}

export interface AliasCandidate {
  teamId: string;
  userId: string;
  agentId: string;
  /** 别名持有行（合并后它应并入 target）。 */
  fromKey: string;
  alias: string;
  /** 别名指向的存活行。 */
  targetKey: string;
}

export interface TombstoneHealth {
  personKey: string;
  mergedInto: string;
  relSubj: number;
  relObj: number;
  state: number;
  stateEvents: number;
  personaHuman: number;
  episodes: number;
}

export interface DupScan {
  persons: number;
  alive: number;
  tombstones: number;
  groups: DupGroup[];
  aliasCandidates: AliasCandidate[];
  tombstoneHealth: TombstoneHealth[];
  /** 墓碑键上残留的数据行数合计（应为 0；非 0 说明合并只立了指针没改键）。 */
  leakedTotal: number;
}

function tableExists(db: DupScanDb, table: string): boolean {
  try {
    db.prepare("SELECT 1 FROM " + table + " LIMIT 1").all();
    return true;
  } catch {
    return false;
  }
}

function count(db: DupScanDb, sql: string, ...params: unknown[]): number {
  const rows = db.prepare(sql).all(...params) as Array<{ n?: number | bigint }>;
  const n = rows[0]?.n;
  return typeof n === "bigint" ? Number(n) : (n ?? 0);
}

function parseAliases(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function tenantKey(row: PersonRow): string {
  return [row.team_id ?? "", row.user_id ?? "", row.agent_id ?? ""].join("|");
}

function toCandidate(row: PersonRow): DupCandidateRow {
  return {
    personKey: row.person_key,
    displayName: row.display_name ?? "",
    platform: (row.platform ?? "").trim(),
    platformId: (row.platform_id ?? "").trim(),
    aliases: parseAliases(row.aliases_json),
    createdAt: row.created_at ?? "",
  };
}

/**
 * 分级（spec §2.2）。只在「同租户三元组 + 都活着 + key 不同」的集合内判定：
 * - A：全部行的 platform_id 都非空且（platform, platform_id）一致；
 * - B：都无 platform_id，或任一方向 aliases 已登记对方 display_name；
 * - C：其余（含两个不同 platform_id、一方有 id 一方没有）。
 */
function classify(rows: DupCandidateRow[]): { level: "A" | "B" | "C"; reason: string } {
  const pids = rows.map((r) => r.platformId);
  if (rows.length >= 2 && pids.every((v) => v !== "")) {
    const samePlatform = rows.every((r) => r.platform === rows[0]!.platform);
    if (samePlatform && pids.every((v) => v === pids[0])) {
      return { level: "A", reason: "同 platform + 同 platform_id（历史行残留；执行前重跑一次重复检查）" };
    }
  }
  if (pids.every((v) => v === "")) {
    return { level: "B", reason: "归一化同名，且全部无 platform_id" };
  }
  const aliasHit = rows.some((a) =>
    rows.some((b) => {
      if (a === b) return false;
      const target = normalizePersonName(b.displayName);
      return target !== "" && a.aliases.some((alias) => normalizePersonName(alias) === target);
    }),
  );
  if (aliasHit) return { level: "B", reason: "归一化同名，且一方 aliases 已登记对方 display_name" };
  const distinctIds = new Set(pids.filter((v) => v !== ""));
  if (distinctIds.size > 1) {
    return { level: "C", reason: "两个不同的 platform_id：先人工判断是否同一人换号" };
  }
  return { level: "C", reason: "一行有 platform_id、一行没有：先人工判断哪条是规范身份" };
}

/** 只读扫描：同名分组 + 别名候选 + 墓碑健康。任何写操作都不在本文。 */
export function scanSoulPersonDupes(db: DupScanDb): DupScan {
  if (!tableExists(db, "soul_person")) {
    return { persons: 0, alive: 0, tombstones: 0, groups: [], aliasCandidates: [], tombstoneHealth: [], leakedTotal: 0 };
  }
  const people = db
    .prepare(
      "SELECT person_key, team_id, user_id, agent_id, platform, platform_id, display_name, aliases_json, merged_into, created_at FROM soul_person",
    )
    .all() as PersonRow[];

  const aliveRows = people.filter((p) => !p.merged_into);
  const tombRows = people.filter((p) => !!p.merged_into);

  const byTenant = new Map<string, PersonRow[]>();
  for (const row of aliveRows) {
    const key = tenantKey(row);
    const list = byTenant.get(key);
    if (list) list.push(row);
    else byTenant.set(key, [row]);
  }

  const groups: DupGroup[] = [];
  const aliasCandidates: AliasCandidate[] = [];
  for (const [key, list] of byTenant) {
    const [teamId = "", userId = "", agentId = ""] = key.split("|");
    const byName = new Map<string, PersonRow[]>();
    for (const row of list) {
      const name = normalizePersonName(row.display_name);
      if (name === "") continue;
      const bucket = byName.get(name);
      if (bucket) bucket.push(row);
      else byName.set(name, [row]);
    }
    for (const [name, rows] of byName) {
      if (rows.length < 2) continue;
      const candidates = rows.map(toCandidate);
      const { level, reason } = classify(candidates);
      groups.push({ teamId, userId, agentId, name, level, reason, rows: candidates });
    }
    // 别名候选：某行 aliases 里登记的名字，恰好是另一存活行的 display_name（两边名字不同）。
    for (const row of list) {
      for (const alias of parseAliases(row.aliases_json)) {
        const normalized = normalizePersonName(alias);
        if (normalized === "") continue;
        if (normalized === normalizePersonName(row.display_name)) continue;
        const target = list.find(
          (other) => other !== row && normalizePersonName(other.display_name) === normalized,
        );
        if (target) {
          aliasCandidates.push({ teamId, userId, agentId, fromKey: row.person_key, alias, targetKey: target.person_key });
        }
      }
    }
  }

  const hasRel = tableExists(db, "soul_person_relation");
  const hasState = tableExists(db, "soul_person_state");
  const hasStateEvents = tableExists(db, "soul_person_state_events");
  const hasPersona = tableExists(db, "soul_persona");
  const hasEpisodes = tableExists(db, "soul_episodes");

  const tombstoneHealth: TombstoneHealth[] = tombRows.map((row) => {
    const params = [row.team_id ?? "", row.user_id ?? "", row.agent_id ?? "", row.person_key];
    const health: TombstoneHealth = {
      personKey: row.person_key,
      mergedInto: row.merged_into ?? "",
      relSubj: hasRel
        ? count(
            db,
            "SELECT COUNT(*) AS n FROM soul_person_relation WHERE team_id=? AND user_id=? AND agent_id=? AND subj_key=?",
            ...params,
          )
        : 0,
      relObj: hasRel
        ? count(
            db,
            "SELECT COUNT(*) AS n FROM soul_person_relation WHERE team_id=? AND user_id=? AND agent_id=? AND obj_key=?",
            ...params,
          )
        : 0,
      state: hasState
        ? count(
            db,
            "SELECT COUNT(*) AS n FROM soul_person_state WHERE team_id=? AND user_id=? AND agent_id=? AND person_key=?",
            ...params,
          )
        : 0,
      stateEvents: hasStateEvents
        ? count(
            db,
            "SELECT COUNT(*) AS n FROM soul_person_state_events WHERE team_id=? AND user_id=? AND agent_id=? AND person_key=?",
            ...params,
          )
        : 0,
      personaHuman: hasPersona
        ? count(
            db,
            "SELECT COUNT(*) AS n FROM soul_persona WHERE team_id=? AND user_id=? AND agent_id=? AND layer='human' AND json_extract(meta_json,'$.person.key')=?",
            ...params,
          )
        : 0,
      episodes: hasEpisodes
        ? count(
            db,
            "SELECT COUNT(*) AS n FROM soul_episodes WHERE team_id=? AND user_id=? AND agent_id=? AND persons_json IS NOT NULL AND EXISTS (SELECT 1 FROM json_each(persons_json) WHERE value=?)",
            ...params,
          )
        : 0,
    };
    return health;
  });

  const leakedTotal = tombstoneHealth.reduce(
    (sum, h) => sum + h.relSubj + h.relObj + h.state + h.stateEvents + h.personaHuman + h.episodes,
    0,
  );

  return {
    persons: people.length,
    alive: aliveRows.length,
    tombstones: tombRows.length,
    groups,
    aliasCandidates,
    tombstoneHealth,
    leakedTotal,
  };
}
