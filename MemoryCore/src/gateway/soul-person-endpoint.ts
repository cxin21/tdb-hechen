/**
 * P2-H §8：`GET /v3/soul/person?team&user&agent&key=p_xxx` —— 单个人的档案读面。
 *
 * 合同：
 *   - 纯读：只调 listSoulPersona / listSoulPersonRelations / listSoulPersons，不写任何表。
 *   - `key` 是 person_key（`p_...`）；缺 key 或 key 不像 person_key → 400。
 *   - 人不存在 / 已合并（墓碑）→ 404。
 *   - store 未就绪 → 503。
 *   - 字段按固定 9 字段顺序输出（与提示词、卡渲染同源），`stale` 用 A7 的同一把尺子。
 *
 * 为什么单独一个端点而不是塞进 /v3/soul/card：卡是按人过滤后的注入文本，
 * 这里要的是「档案里到底写了什么、证据是哪条记忆」——两者用途不同，混在一起会让
 * 读面为了展示而改变注入口径。
 */
import type { URL } from "node:url";
import type { ServerResponse } from "node:http";
import type { CoreTenant, IMemoryStore, SoulPersonRelationRow } from "../core/store/types.js";
import type { SoulPerson } from "../core/person/types.js";
import { normalizePersonName } from "../core/person/resolve.js";
import {
  PERSON_PROFILE_FIELD_ORDER,
  PERSON_PROFILE_FIELDS,
  PROFILE_SOURCE,
  isPersonProfileField,
  isProfileFieldStale,
  stripProfileLabel,
  type PersonProfileField,
} from "../core/person/profile.js";

export interface SoulPersonRouteDeps {
  getStore: () => IMemoryStore | null;
  logger?: { info?: (msg: string) => void; warn?: (msg: string) => void };
  /** 「现在」的来源（测试可注入；缺省取系统时间）。 */
  now?: () => string;
}

/** 与 soul-card-endpoint 同一口径的租户解析（但缺 team 时这里要 400，见 §8）。 */
function tenantOf(url: URL): CoreTenant {
  const pick = (k: string): string => {
    const v = url.searchParams.get(k);
    return v && v.trim() !== "" ? v.trim() : "default";
  };
  return { teamId: pick("team"), userId: pick("user"), agentId: pick("agent") };
}

function hasTeam(url: URL): boolean {
  const team = (url.searchParams.get("team") ?? "").trim();
  return team !== "";
}

interface ProfileMetaView {
  source?: unknown;
  person?: { key?: unknown; displayName?: unknown };
  profileField?: unknown;
  evidence?: unknown;
  profileVersion?: unknown;
}

export interface SoulPersonFieldView {
  field: PersonProfileField;
  label: string;
  text: string;
  evidence: Array<{ recordId: string; at: string; quote: string }>;
  updatedAt: string;
  stale: boolean;
}

export interface SoulPersonRelationView {
  relId: string;
  pred: string;
  objKey: string | null;
  objName: string | null;
  direction: "out" | "in" | "mutual";
  /** 相对「这个人」的另一端（A6）：out 边 = objKey，in 边 = subjKey。 */
  counterpartKey: string | null;
  /**
   * 「对方」的名字，按 counterpartKey 解析（与 /v3/soul/persons 同一把尺子）。
   * 不用 objName 顶替：in 边的 objName 指的是「这个人自己」，拿它当对方名字会把关系读反。
   */
  counterpartName: string | null;
  quote: string;
  recordId: string;
  validFrom: string;
}

function evidenceOf(meta: ProfileMetaView | null): Array<{ recordId: string; at: string; quote: string }> {
  if (!meta || !Array.isArray(meta.evidence)) return [];
  const out: Array<{ recordId: string; at: string; quote: string }> = [];
  for (const raw of meta.evidence) {
    if (!raw || typeof raw !== "object") continue;
    const rec = raw as { recordId?: unknown; at?: unknown; quote?: unknown };
    const recordId = typeof rec.recordId === "string" ? rec.recordId : "";
    if (recordId === "") continue;
    out.push({
      recordId,
      at: typeof rec.at === "string" ? rec.at : "",
      quote: typeof rec.quote === "string" ? rec.quote : "",
    });
  }
  return out;
}

function relationView(
  row: SoulPersonRelationRow,
  personKey: string,
  displayNameOf: (key: string | null) => string | null,
): SoulPersonRelationView {
  const isOut = row.subjKey === personKey;
  const counterpartKey = isOut ? row.objKey : row.subjKey;
  return {
    relId: row.relId,
    pred: row.pred,
    objKey: row.objKey,
    // 档案提炼在有 obj.key 时只写 key 不写 obj_name；这里与 /v3/soul/persons 走同一个解析器补齐，
    // 否则单人读面的关系只剩裸 person_key（2026-11-12 实测：soul_person_profile 回「上级 → p_name_…」）。
    objName: row.objName ?? displayNameOf(row.objKey),
    direction: row.direction === "mutual" ? "mutual" : isOut ? "out" : "in",
    counterpartKey,
    // 优先按 key 解析登记名；对方还没登记成人、但边上记了名字时用那个名字；都没有就 null（不编）。
    counterpartName: displayNameOf(counterpartKey) ?? (isOut ? row.objName : null),
    quote: row.quote,
    recordId: row.recordId,
    validFrom: row.validFrom,
  };
}

/**
 * 两个人的读面共用同一把「名字尺子」：墓碑行顺着 mergedInto 找到活着的那一行；
 * 找不到返回 null（前端自己有「某人」兜底，读面不替它编名字）。
 * 抽出来是为了让 /v3/soul/person 与 /v3/soul/persons 对同一条边给出同一个名字。
 */
function makeDisplayNameOf(persons: SoulPerson[]): (key: string | null) => string | null {
  const byKey = new Map(persons.map((p) => [p.personKey, p]));
  return (key: string | null): string | null => {
    let cur = key;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      const row = byKey.get(cur);
      if (!row) return null;
      if (row.mergedInto === null) return row.displayName;
      seen.add(cur);
      cur = row.mergedInto;
    }
    return null;
  };
}

/**
 * P2-D 配套读面（2026-11-08）：`GET /v3/soul/persons?team&user&agent` —— 本租户的人物列表 + 关系边。
 *
 * 为什么需要它：`/v3/soul/person` 是单人读面，调用方必须先知道 person_key；
 * Panel 的「人物档案 + 关系图」要从零枚举，所以补一个列表面。仍守同一条纪律：
 *   - 纯读，只调 listSoulPersons / listSoulPersona / listSoulPersonRelations；
 *   - 缺 team → 400；store 未就绪 → 503；
 *   - 墓碑行（mergedInto 非空）不进列表，避免「同一个人出现两次」；
 *   - 关系边只回现行边（valid_to IS NULL，store 缺省口径），历史边在库里可审计但不进图。
 */
export interface SoulPersonSummaryView {
  key: string;
  displayName: string;
  aliases: string[];
  platform: string;
  platformId: string | null;
  /** 档案里现行字段数（0 = 还没提炼出任何字段）。 */
  fieldCount: number;
  /** 图上的度数（出入都算）。 */
  relationCount: number;
  updatedAt: string;
}

export interface SoulPersonGraphEdgeView {
  relId: string;
  subjKey: string;
  subjName: string | null;
  pred: string;
  objKey: string | null;
  /** 终点可能还不是人（只有名字）：保留名字，等它出现时再绑，不猜。 */
  objName: string | null;
  direction: "out" | "mutual";
  quote: string;
  recordId: string;
  validFrom: string;
}

/**
 * 两个读面（/persons 列表、/person/search 按名字查）共用同一把尺子：
 *   - 活人 = mergedInto 为空的行；
 *   - 字段数 = human 层 + PROFILE_SOURCE + 未作废 + 九字段之一（与 /v3/soul/person 同源）；
 *   - 度数 = 现行关系边出入两端都算。
 * 抽出来是为了让「列表里的 fieldCount」与「搜出来的 fieldCount」永远不会各算一套。
 */
interface PersonReadModel {
  rawPersons: SoulPerson[];
  alive: SoulPerson[];
  fieldsByKey: Map<string, Set<string>>;
  degree: Map<string, number>;
  relations: SoulPersonRelationRow[];
}

async function loadPersonReadModel(store: IMemoryStore, tenant: CoreTenant): Promise<PersonReadModel> {
  const rawPersons = typeof store.listSoulPersons === "function" ? ((await store.listSoulPersons(tenant)) ?? []) : [];
  const alive = rawPersons.filter((p) => p.mergedInto === null);
  const items = typeof store.listSoulPersona === "function" ? ((await store.listSoulPersona(tenant)) ?? []) : [];
  const fieldsByKey = new Map<string, Set<string>>();
  for (const item of items) {
    if (item.layer !== "human" || item.validTo) continue;
    const meta = (item.meta ?? null) as ProfileMetaView | null;
    if (!meta || meta.source !== PROFILE_SOURCE) continue;
    if (typeof meta.person?.key !== "string" || !isPersonProfileField(meta.profileField)) continue;
    const key = meta.person.key;
    const set = fieldsByKey.get(key) ?? new Set<string>();
    set.add(meta.profileField);
    fieldsByKey.set(key, set);
  }
  const relations =
    typeof store.listSoulPersonRelations === "function" ? ((await store.listSoulPersonRelations(tenant)) ?? []) : [];
  const degree = new Map<string, number>();
  for (const row of relations) {
    if (row.validTo) continue;
    degree.set(row.subjKey, (degree.get(row.subjKey) ?? 0) + 1);
    if (row.objKey) degree.set(row.objKey, (degree.get(row.objKey) ?? 0) + 1);
  }
  return { rawPersons, alive, fieldsByKey, degree, relations };
}

export interface SoulPersonsView {
  persons: SoulPersonSummaryView[];
  edges: SoulPersonGraphEdgeView[];
}

export async function handleSoulPersonsRoute(
  url: URL,
  method: string,
  sendJson: (res: ServerResponse, status: number, payload: unknown) => void,
  res: ServerResponse,
  deps: SoulPersonRouteDeps,
): Promise<boolean> {
  if (method !== "GET") return false;
  if (url.pathname !== "/v3/soul/persons") return false;
  if (!hasTeam(url)) {
    sendJson(res, 400, { code: 400, message: "team_required" });
    return true;
  }
  const store = deps.getStore();
  if (!store) {
    sendJson(res, 503, { code: 503, message: "soul_person_unavailable" });
    return true;
  }
  const tenant = tenantOf(url);
  try {
    const { rawPersons, alive, fieldsByKey, degree, relations } = await loadPersonReadModel(store, tenant);
    const displayNameOf = makeDisplayNameOf(rawPersons);

    // 字段数 / 度数：与 /v3/soul/person 同一把尺子（见 loadPersonReadModel）。
    const edges: SoulPersonGraphEdgeView[] = [];
    for (const row of relations) {
      if (row.validTo) continue;
      edges.push({
        relId: row.relId,
        subjKey: row.subjKey,
        subjName: displayNameOf(row.subjKey),
        pred: row.pred,
        objKey: row.objKey,
        // 档案提炼在有 obj.key 时只写 key 不写 obj_name；读面按 key 补名，避免关系图 hover 出现「某人」。
        objName: row.objName ?? displayNameOf(row.objKey),
        direction: row.direction === "mutual" ? "mutual" : "out",
        quote: row.quote,
        recordId: row.recordId,
        validFrom: row.validFrom,
      });
    }

    const persons: SoulPersonSummaryView[] = alive
      .map((p) => ({
        key: p.personKey,
        displayName: p.displayName,
        aliases: p.aliases,
        platform: p.platform,
        platformId: p.platformId,
        fieldCount: fieldsByKey.get(p.personKey)?.size ?? 0,
        relationCount: degree.get(p.personKey) ?? 0,
        updatedAt: p.updatedAt,
      }))
      .sort((a, b) => b.relationCount - a.relationCount || a.displayName.localeCompare(b.displayName, "zh-CN"));

    sendJson(res, 200, {
      ok: true,
      data: { persons, edges },
    });
    return true;
  } catch (err) {
    deps.logger?.warn?.(
      `[soul-person-endpoint] list failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    sendJson(res, 503, { code: 503, message: "soul_persons_failed" });
    return true;
  }
}

export async function handleSoulPersonRoute(
  url: URL,
  method: string,
  sendJson: (res: ServerResponse, status: number, payload: unknown) => void,
  res: ServerResponse,
  deps: SoulPersonRouteDeps,
): Promise<boolean> {
  if (method !== "GET") return false;
  if (url.pathname !== "/v3/soul/person") return false;

  const key = (url.searchParams.get("key") ?? "").trim();
  if (!hasTeam(url)) {
    sendJson(res, 400, { code: 400, message: "team_required" });
    return true;
  }
  if (key === "" || !key.startsWith("p_")) {
    sendJson(res, 400, { code: 400, message: "person_key_required" });
    return true;
  }

  const store = deps.getStore();
  if (!store) {
    sendJson(res, 503, { code: 503, message: "soul_person_unavailable" });
    return true;
  }
  const tenant = tenantOf(url);
  const nowIso = deps.now?.() ?? new Date().toISOString();

  try {
    const persons = typeof store.listSoulPersons === "function" ? ((await store.listSoulPersons(tenant)) ?? []) : [];
    const person = persons.find((p) => p.personKey === key);
    if (!person) {
      sendJson(res, 404, { code: 404, message: "person_not_found" });
      return true;
    }

    const items =
      typeof store.listSoulPersona === "function" ? ((await store.listSoulPersona(tenant)) ?? []) : [];
    const byField = new Map<PersonProfileField, SoulPersonFieldView>();
    for (const item of items) {
      if (item.layer !== "human") continue;
      // 已作废的行不进读面（validTo 非空 = 被 supersede 的旧版本），但它们仍在库里可审计。
      if (item.validTo) continue;
      const meta = (item.meta ?? null) as ProfileMetaView | null;
      if (!meta || meta.source !== PROFILE_SOURCE) continue;
      if (typeof meta.person?.key !== "string" || meta.person.key !== key) continue;
      if (!isPersonProfileField(meta.profileField)) continue;
      const field = meta.profileField;
      const evidence = evidenceOf(meta);
      const updatedAt = item.updatedAt;
      const view: SoulPersonFieldView = {
        field,
        label: PERSON_PROFILE_FIELDS[field].label,
        text: stripProfileLabel(field, item.text),
        evidence,
        updatedAt,
        stale: isProfileFieldStale({ field, evidenceAt: evidence[0]?.at ?? updatedAt, nowIso }),
      };
      // 同一字段多行（历史遗留）：留最新的一行，与卡侧「现行」口径一致。
      const prev = byField.get(field);
      if (!prev || prev.updatedAt < view.updatedAt) byField.set(field, view);
    }

    const fields = PERSON_PROFILE_FIELD_ORDER.filter((f) => byField.has(f)).map((f) => byField.get(f)!);

    const displayNameOf = makeDisplayNameOf(persons);
    const relations: SoulPersonRelationView[] = [];
    const seen = new Set<string>();
    if (typeof store.listSoulPersonRelations === "function") {
      // A6：双向查。out 边（他指向别人）与 in 边（别人指向他）都要回，否则「谁把他当领导」读不出来。
      const out = (await store.listSoulPersonRelations(tenant, { subjKey: key })) ?? [];
      const inbound = (await store.listSoulPersonRelations(tenant, { objKey: key })) ?? [];
      for (const row of [...out, ...inbound]) {
        if (seen.has(row.relId)) continue;
        seen.add(row.relId);
        relations.push(relationView(row, key, displayNameOf));
      }
    }

    sendJson(res, 200, {
      ok: true,
      data: {
        person: {
          key: person.personKey,
          displayName: person.displayName,
          aliases: person.aliases,
        },
        fields,
        relations,
      },
    });
    return true;
  } catch (err) {
    deps.logger?.warn?.(
      `[soul-person-endpoint] read failed key=${key}: ${err instanceof Error ? err.message : String(err)}`,
    );
    sendJson(res, 503, { code: 503, message: "soul_person_failed" });
    return true;
  }
}

/** 搜索名的匹配档位：person_key 精确 > 名字精确 > 前缀 > 包含。 */
export type SoulPersonMatch = "key" | "exact" | "prefix" | "contains";

export interface SoulPersonSearchHit extends SoulPersonSummaryView {
  match: SoulPersonMatch;
  /** 命中的是 key、显示名还是别名——调用方据此解释「为什么它算这个人」。 */
  matchedOn: "key" | "display_name" | "alias";
}

const SEARCH_LIMIT_DEFAULT = 10;
const SEARCH_LIMIT_MAX = 20;

const MATCH_RANK: Record<SoulPersonMatch, number> = { key: 4, exact: 3, prefix: 2, contains: 1 };

/**
 * 一行人对一个查询的最佳命中（没有命中返回 null）。
 * 归一化与 person 解析同源（normalizePersonName），所以「张 三」「张三」「ZhangSan」的
 * 空白/大小写差异不会让同一个人搜不到；刻意不做拼音与去标点（与 resolve.ts 同一理由：
 * 这类判断交给人，猜错会把两个人的档案混一起）。
 */
function matchPerson(
  person: SoulPerson,
  rawQuery: string,
  normalizedQuery: string,
): { match: SoulPersonMatch; matchedOn: "key" | "display_name" | "alias" } | null {
  if (person.personKey === rawQuery) return { match: "key", matchedOn: "key" };
  const candidates: Array<{ value: string; on: "display_name" | "alias" }> = [
    { value: person.displayName, on: "display_name" },
    ...(person.aliases ?? []).map((alias) => ({ value: alias, on: "alias" as const })),
  ];
  let best: { match: SoulPersonMatch; matchedOn: "key" | "display_name" | "alias" } | null = null;
  for (const candidate of candidates) {
    const name = normalizePersonName(candidate.value);
    if (name === "" || normalizedQuery === "") continue;
    const match: SoulPersonMatch | null =
      name === normalizedQuery
        ? "exact"
        : name.startsWith(normalizedQuery)
          ? "prefix"
          : name.includes(normalizedQuery)
            ? "contains"
            : null;
    if (match === null) continue;
    if (
      best === null ||
      MATCH_RANK[match] > MATCH_RANK[best.match] ||
      (MATCH_RANK[match] === MATCH_RANK[best.match] && candidate.on === "display_name" && best.matchedOn === "alias")
    ) {
      best = { match, matchedOn: candidate.on };
    }
  }
  return best;
}

/**
 * 人物「按名字查」读面（2026-11-12）：`GET /v3/soul/person/search?team&user&agent&q=&limit=`。
 *
 * 为什么需要它：/v3/soul/person 只认 person_key，而人和 agent 手里只有名字；
 * 缺这一步，人物档案在实际对话里就只能靠别处碰巧拿到 key 才读得到。
 *
 * 合同（与 /persons 同一纪律）：
 *   - 纯读，只调 listSoulPersons / listSoulPersona / listSoulPersonRelations；
 *   - 缺 team → 400 team_required；缺 q 或纯空白 → 400 person_query_required；
 *   - store 未就绪 → 503；读失败 → 503 soul_person_search_failed（不假装空结果）；
 *   - 墓碑行不返回；limit 夹在 [1,20]，缺省 10。
 * 刻意只回摘要（不回字段正文/关系）：名字查是入口，正文留给 /v3/soul/person。
 */
export async function handleSoulPersonSearchRoute(
  url: URL,
  method: string,
  sendJson: (res: ServerResponse, status: number, payload: unknown) => void,
  res: ServerResponse,
  deps: SoulPersonRouteDeps,
): Promise<boolean> {
  if (method !== "GET") return false;
  if (url.pathname !== "/v3/soul/person/search") return false;
  if (!hasTeam(url)) {
    sendJson(res, 400, { code: 400, message: "team_required" });
    return true;
  }
  const rawQuery = (url.searchParams.get("q") ?? "").trim();
  if (rawQuery === "" || normalizePersonName(rawQuery) === "") {
    sendJson(res, 400, { code: 400, message: "person_query_required" });
    return true;
  }
  const store = deps.getStore();
  if (!store) {
    sendJson(res, 503, { code: 503, message: "soul_person_unavailable" });
    return true;
  }
  const requested = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit = Number.isFinite(requested) ? Math.min(SEARCH_LIMIT_MAX, Math.max(1, requested)) : SEARCH_LIMIT_DEFAULT;
  const normalizedQuery = normalizePersonName(rawQuery);
  const tenant = tenantOf(url);

  try {
    const { alive, fieldsByKey, degree } = await loadPersonReadModel(store, tenant);
    const hits: SoulPersonSearchHit[] = [];
    for (const person of alive) {
      const matched = matchPerson(person, rawQuery, normalizedQuery);
      if (matched === null) continue;
      hits.push({
        key: person.personKey,
        displayName: person.displayName,
        aliases: person.aliases,
        platform: person.platform,
        platformId: person.platformId,
        fieldCount: fieldsByKey.get(person.personKey)?.size ?? 0,
        relationCount: degree.get(person.personKey) ?? 0,
        updatedAt: person.updatedAt,
        match: matched.match,
        matchedOn: matched.matchedOn,
      });
    }
    hits.sort(
      (a, b) =>
        MATCH_RANK[b.match] - MATCH_RANK[a.match] ||
        b.fieldCount - a.fieldCount ||
        b.relationCount - a.relationCount ||
        a.displayName.localeCompare(b.displayName, "zh-CN"),
    );
    const persons = hits.slice(0, limit);
    sendJson(res, 200, {
      ok: true,
      data: { query: rawQuery, count: persons.length, persons },
    });
    return true;
  } catch (err) {
    deps.logger?.warn?.(
      `[soul-person-endpoint] search failed q=${rawQuery}: ${err instanceof Error ? err.message : String(err)}`,
    );
    sendJson(res, 503, { code: 503, message: "soul_person_search_failed" });
    return true;
  }
}