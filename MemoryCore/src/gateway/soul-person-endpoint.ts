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

function relationView(row: SoulPersonRelationRow, personKey: string): SoulPersonRelationView {
  const isOut = row.subjKey === personKey;
  return {
    relId: row.relId,
    pred: row.pred,
    objKey: row.objKey,
    objName: row.objName,
    direction: row.direction === "mutual" ? "mutual" : isOut ? "out" : "in",
    counterpartKey: isOut ? row.objKey : row.subjKey,
    quote: row.quote,
    recordId: row.recordId,
    validFrom: row.validFrom,
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
    const rawPersons = typeof store.listSoulPersons === "function" ? ((await store.listSoulPersons(tenant)) ?? []) : [];
    const alive = rawPersons.filter((p) => p.mergedInto === null);
    const byKey = new Map(rawPersons.map((p) => [p.personKey, p]));
    /** 名字解析：墓碑行顺着 mergedInto 找到活着的那一行；找不到返回 null（前端自己有「某人」兜底）。 */
    const displayNameOf = (key: string | null): string | null => {
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

    // 字段数：与 /v3/soul/person 同一把尺子（human 层、PROFILE_SOURCE、未作废、九字段之一）。
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
    const edges: SoulPersonGraphEdgeView[] = [];
    for (const row of relations) {
      if (row.validTo) continue;
      degree.set(row.subjKey, (degree.get(row.subjKey) ?? 0) + 1);
      if (row.objKey) degree.set(row.objKey, (degree.get(row.objKey) ?? 0) + 1);
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

    const relations: SoulPersonRelationView[] = [];
    const seen = new Set<string>();
    if (typeof store.listSoulPersonRelations === "function") {
      // A6：双向查。out 边（他指向别人）与 in 边（别人指向他）都要回，否则「谁把他当领导」读不出来。
      const out = (await store.listSoulPersonRelations(tenant, { subjKey: key })) ?? [];
      const inbound = (await store.listSoulPersonRelations(tenant, { objKey: key })) ?? [];
      for (const row of [...out, ...inbound]) {
        if (seen.has(row.relId)) continue;
        seen.add(row.relId);
        relations.push(relationView(row, key));
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
