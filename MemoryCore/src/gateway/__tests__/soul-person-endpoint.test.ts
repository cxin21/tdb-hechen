/**
 * P2-H §8：`GET /v3/soul/person` 的合同测试（假 store，不连库）。
 *
 * 这条读面只解决一件事：面板/排查要能看到「某个人档案里到底写了什么、证据是哪条记忆」。
 * 因此测试盯六个点——只接 GET、缺 team 400、key 不像 person_key 400、
 * store 未就绪 503、人不存在 404、命中时信封形状（9 字段顺序 + in 边 counterpartKey + stale）。
 */
import { describe, expect, it, vi } from "vitest";
import type { ServerResponse } from "node:http";
import type { SoulPersonRelationRow } from "../../core/store/types.js";
import { handleSoulPersonRoute } from "../soul-person-endpoint.js";

const res = {} as ServerResponse;
const NOW = "2027-01-01T00:00:00.000Z";
const ME = "p_me";

type Row = Record<string, unknown>;

function person(key: string, displayName: string, aliases: string[] = []): Row {
  return {
    personKey: key,
    teamId: "team-p",
    userId: "usr-p",
    agentId: "agt-p",
    platform: "",
    platformId: null,
    displayName,
    aliases,
    mergedInto: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function humanRow(
  field: string,
  text: string,
  extra: { updatedAt?: string; validTo?: string; personKey?: string; at?: string } = {},
): Row {
  return {
    itemId: `human:pp-${field}`,
    layer: "human",
    text,
    state: "active",
    weight: 0.8,
    evidenceIds: ["m1"],
    evidenceDays: [],
    evidenceOrigins: ["user"],
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: extra.updatedAt ?? "2026-12-01T00:00:00.000Z",
    lastEvidenceAt: extra.updatedAt ?? "2026-12-01T00:00:00.000Z",
    aliases: [],
    ...(extra.validTo ? { validTo: extra.validTo } : {}),
    meta: {
      source: "person-profile",
      person: { key: extra.personKey ?? ME, displayName: "何辰" },
      profileField: field,
      evidence: [{ recordId: "m1", at: extra.at ?? "2026-12-01T00:00:00.000Z", quote: "我负责发布流程" }],
      profileVersion: "pp-v1",
    },
  };
}

function edge(over: Partial<SoulPersonRelationRow>): SoulPersonRelationRow {
  return {
    relId: "rel-1",
    subjKey: ME,
    pred: "同事",
    objKey: "p_other",
    objName: null,
    direction: "out",
    quote: "我们一起来",
    recordId: "m1",
    evidence: [{ recordId: "m1", at: "2026-12-01T00:00:00.000Z", quote: "我们一起来" }],
    validFrom: "2026-12-01T00:00:00.000Z",
    validTo: null,
    createdAt: "2026-12-01T00:00:00.000Z",
    updatedAt: "2026-12-01T00:00:00.000Z",
    ...over,
  };
}

function makeStore(opts: {
  persons?: Row[];
  items?: Row[];
  out?: SoulPersonRelationRow[];
  inbound?: SoulPersonRelationRow[];
  throws?: boolean;
} = {}) {
  const calls = { relations: [] as unknown[] };
  const store = {
    listSoulPersons: async () => opts.persons ?? [person(ME, "何辰", ["hechen"])],
    listSoulPersona: async () => opts.items ?? [],
    listSoulPersonRelations: async (_tenant: unknown, filter: unknown) => {
      calls.relations.push(filter);
      if (opts.throws) throw new Error("boom");
      const f = filter as { subjKey?: string; objKey?: string };
      if (f.subjKey) return opts.out ?? [];
      return opts.inbound ?? [];
    },
  };
  return { store, calls };
}

async function call(
  url: string,
  opts: { method?: string; store?: unknown | null; now?: string } = {},
) {
  const sendJson = vi.fn();
  const handled = await handleSoulPersonRoute(
    new URL(url, "http://localhost"),
    opts.method ?? "GET",
    sendJson,
    res,
    {
      getStore: () => (opts.store === undefined ? makeStore().store : opts.store) as never,
      now: () => opts.now ?? NOW,
    },
  );
  const [, status, payload] = (sendJson.mock.calls[0] ?? []) as [unknown, number, unknown];
  return {
    handled,
    sendJson,
    status,
    payload: payload as { ok?: boolean; code?: number; message?: string; data?: Record<string, never> },
  };
}

describe("GET /v3/soul/person（§8）", () => {
  it("只认 GET + /v3/soul/person，其余交回 dispatch", async () => {
    expect((await call("/v3/soul/person?team=t&key=p_me", { method: "POST" })).handled).toBe(false);
    expect((await call("/v3/soul/card?team=t&key=p_me")).handled).toBe(false);
  });

  it("缺 team → 400 team_required（§8 只说缺 team 400）", async () => {
    const r = await call("/v3/soul/person?key=p_me");
    expect(r.handled).toBe(true);
    expect(r.status).toBe(400);
    expect(r.payload.message).toBe("team_required");
  });

  it("key 缺失或不像 person_key → 400 person_key_required", async () => {
    expect((await call("/v3/soul/person?team=t")).status).toBe(400);
    const bad = await call("/v3/soul/person?team=t&key=hechen");
    expect(bad.status).toBe(400);
    expect(bad.payload.message).toBe("person_key_required");
  });

  it("store 未就绪 → 503 soul_person_unavailable", async () => {
    const r = await call("/v3/soul/person?team=t&key=p_me", { store: null });
    expect(r.status).toBe(503);
    expect(r.payload.message).toBe("soul_person_unavailable");
  });

  it("人不存在 → 404 person_not_found", async () => {
    const r = await call("/v3/soul/person?team=t&key=p_nobody");
    expect(r.status).toBe(404);
    expect(r.payload.message).toBe("person_not_found");
  });

  it("200：信封 {ok:true,data} + 字段按 9 字段序 + 只留现行行 + 排除别人/别来源的行", async () => {
    const { store } = makeStore({
      items: [
        humanRow("style", "说话直接"),
        humanRow("role", "负责发布流程"),
        humanRow("focus", "回归覆盖"),
        // 非 person-profile 来源（上阶段残留）→ 不进读面
        { ...humanRow("likes", "喝茶"), meta: { source: "soul" } },
        // 别人的行 → 不进这个人的读面
        humanRow("story", "别人写过的事", { personKey: "p_other" }),
        // 已作废的旧版本 → 不进读面
        humanRow("role", "负责旧流程", { validTo: "2026-12-05T00:00:00.000Z" }),
        // 非 human 层 → 不进读面
        { ...humanRow("alias", "老何"), layer: "relationship" },
      ],
    });
    const r = await call("/v3/soul/person?team=t&key=p_me", { store });
    expect(r.status).toBe(200);
    expect(r.payload.ok).toBe(true);
    const data = r.payload.data as unknown as {
      person: { key: string; displayName: string; aliases: string[] };
      fields: Array<{ field: string; label: string; text: string; evidence: unknown[]; stale: boolean }>;
      relations: unknown[];
    };
    expect(data.person).toEqual({ key: ME, displayName: "何辰", aliases: ["hechen"] });
    expect(data.fields.map((f) => f.field)).toEqual(["role", "style", "focus"]);
    expect(data.fields.map((f) => f.label)).toEqual(["身份", "说话方式", "近况"]);
    // 文本按「标签：正文」落库，读面剥掉标签前缀，只回正文。
    expect(data.fields[0]!.text).toBe("负责发布流程");
    expect(data.fields[0]!.evidence).toEqual([
      { recordId: "m1", at: "2026-12-01T00:00:00.000Z", quote: "我负责发布流程" },
    ]);
    // A7 同一把尺子：focus 7 天 → NOW 前 31 天，判过期；role 永久 → 不过期。
    expect(data.fields.find((f) => f.field === "focus")!.stale).toBe(true);
    expect(data.fields.find((f) => f.field === "role")!.stale).toBe(false);
  });

  it("A6：out/in 双查，in 边 direction=in 且 counterpartKey 是对方", async () => {
    const { store, calls } = makeStore({
      out: [edge({ relId: "rel-out", subjKey: ME, pred: "上级", objKey: "p_boss", objName: "张总" })],
      inbound: [
        edge({ relId: "rel-in", subjKey: "p_boss2", pred: "下属", objKey: ME, objName: null }),
        // 双向都回时去重：同一条边（mutual，双向都能查到）
        edge({ relId: "rel-mutual", subjKey: ME, pred: "同事", objKey: "p_peer", direction: "mutual" }),
      ],
    });
    const r = await call("/v3/soul/person?team=t&key=p_me", { store });
    const data = r.payload.data as unknown as {
      relations: Array<{ relId: string; direction: string; counterpartKey: string | null; pred: string }>;
    };
    expect(calls.relations).toEqual([{ subjKey: ME }, { objKey: ME }]);
    // mutual 边既在 out 又在 in 里 → 只回一次
    expect(data.relations.map((x) => x.relId)).toEqual(["rel-out", "rel-in", "rel-mutual"]);
    const out = data.relations.find((x) => x.relId === "rel-out")!;
    expect(out.direction).toBe("out");
    expect(out.counterpartKey).toBe("p_boss");
    const inbound = data.relations.find((x) => x.relId === "rel-in")!;
    expect(inbound.direction).toBe("in");
    expect(inbound.counterpartKey).toBe("p_boss2");
    expect(data.relations.find((x) => x.relId === "rel-mutual")!.direction).toBe("mutual");
  });

  it("store 抛错 → 503 soul_person_failed（不是 500、不把栈回给调用方）", async () => {
    const { store } = makeStore({ throws: true });
    const r = await call("/v3/soul/person?team=t&key=p_me", { store });
    expect(r.status).toBe(503);
    expect(r.payload.message).toBe("soul_person_failed");
  });

  it("缺 listSoulPersonRelations（旧替身）→ relations 空数组，不抛", async () => {
    const r = await call("/v3/soul/person?team=t&key=p_me", {
      store: { listSoulPersons: async () => [person(ME, "何辰")], listSoulPersona: async () => [] },
    });
    expect(r.status).toBe(200);
    expect((r.payload.data as unknown as { relations: unknown[] }).relations).toEqual([]);
  });
});
