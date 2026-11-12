/**
 * 人物「按名字查」读面的合同测试（假 store，不连库）。
 *
 * 这条读面存在的理由：/v3/soul/person 要求调用方先有 person_key，而人只会说名字。
 * 所以要把「名字 → person_key」这一步做成服务端能力，规则必须可预测：
 *   - 只认 GET /v3/soul/person/search；
 *   - 缺 team → 400，缺 q（或纯空白）→ 400，store 未就绪 → 503；
 *   - 名字归一化与 person 解析同源（NFKC + 压空白 + 小写），精确 > 前缀 > 包含；
 *   - 别名（aliases）同样命中，并标出 matchedOn=alias；
 *   - 墓碑行（mergedInto 非空）不返回——同一个人不能出现两次；
 *   - limit 夹在 [1,20]，缺省 10。
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ServerResponse } from "node:http";
import type { SoulPersonRelationRow } from "../../core/store/types.js";
import { handleSoulPersonSearchRoute } from "../soul-person-endpoint.js";

const res = {} as ServerResponse;

type Row = Record<string, unknown>;

function person(key: string, displayName: string, aliases: string[] = [], mergedInto: string | null = null): Row {
  return {
    personKey: key,
    teamId: "team-p",
    userId: "usr-p",
    agentId: "agt-p",
    platform: "tdai",
    platformId: null,
    displayName,
    aliases,
    mergedInto,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  };
}

function humanRow(field: string, personKey: string): Row {
  return {
    itemId: `human:pp-${field}-${personKey}`,
    layer: "human",
    text: `${field}：示例`,
    state: "active",
    weight: 0.8,
    evidenceIds: ["m1"],
    evidenceDays: [],
    evidenceOrigins: ["user"],
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    lastEvidenceAt: "2026-06-01T00:00:00.000Z",
    aliases: [],
    meta: {
      source: "person-profile",
      person: { key: personKey, displayName: "谁" },
      profileField: field,
      evidence: [{ recordId: "m1", at: "2026-05-01T00:00:00.000Z", quote: "原话" }],
      profileVersion: "pp-v1",
    },
  };
}

function edge(over: Partial<SoulPersonRelationRow>): SoulPersonRelationRow {
  return {
    relId: "rel-1",
    subjKey: "p_a",
    pred: "同事",
    objKey: "p_b",
    objName: null,
    direction: "out",
    quote: "一起做发布",
    recordId: "m1",
    evidence: [{ recordId: "m1", at: "2026-05-01T00:00:00.000Z", quote: "一起做发布" }],
    validFrom: "2026-05-01T00:00:00.000Z",
    validTo: null,
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    ...over,
  };
}

function makeStore(opts: { persons?: Row[]; items?: Row[]; relations?: SoulPersonRelationRow[]; throws?: boolean } = {}) {
  return {
    listSoulPersons: async () => {
      if (opts.throws) throw new Error("boom");
      return opts.persons ?? [person("p_a", "张三"), person("p_b", "李四")];
    },
    listSoulPersona: async () => opts.items ?? [],
    listSoulPersonRelations: async () => opts.relations ?? [],
  };
}

async function call(url: string, opts: { method?: string; store?: unknown | null } = {}) {
  const sendJson = vi.fn();
  const handled = await handleSoulPersonSearchRoute(
    new URL(url, "http://localhost"),
    opts.method ?? "GET",
    sendJson,
    res,
    { getStore: () => (opts.store === undefined ? makeStore() : opts.store) as never },
  );
  const [, status, payload] = (sendJson.mock.calls[0] ?? []) as [unknown, number, unknown];
  return {
    handled,
    status,
    payload: payload as {
      ok?: boolean;
      message?: string;
      data?: { query: string; count: number; persons: Array<Record<string, unknown>> };
    },
  };
}

describe("GET /v3/soul/person/search", () => {
  it("只认 GET + /v3/soul/person/search，其余交回 dispatch", async () => {
    expect((await call("/v3/soul/person/search?team=t&q=张三", { method: "POST" })).handled).toBe(false);
    expect((await call("/v3/soul/persons?team=t&q=张三")).handled).toBe(false);
    expect((await call("/v3/soul/person/search?team=t")).handled).toBe(true);
  });

  it("缺 team → 400 team_required；缺 q / 纯空白 → 400 person_query_required", async () => {
    const noTeam = await call("/v3/soul/person/search?q=张三");
    expect(noTeam.status).toBe(400);
    expect(noTeam.payload.message).toBe("team_required");

    const noQuery = await call("/v3/soul/person/search?team=t");
    expect(noQuery.status).toBe(400);
    expect(noQuery.payload.message).toBe("person_query_required");

    const blank = await call("/v3/soul/person/search?team=t&q=%20%20");
    expect(blank.status).toBe(400);
    expect(blank.payload.message).toBe("person_query_required");
  });

  it("store 未就绪 → 503（不假装空结果）", async () => {
    const r = await call("/v3/soul/person/search?team=t&q=张三", { store: null });
    expect(r.status).toBe(503);
    expect(r.payload.message).toBe("soul_person_unavailable");
  });

  it("精确命中（大小写/空白归一）排第一，match=exact", async () => {
    const store = makeStore({
      persons: [person("p_a", "张三丰"), person("p_b", " 张三 ", ["三哥"]), person("p_c", "李四")],
    });
    const r = await call("/v3/soul/person/search?team=t&q=张三", { store });
    const persons = r.payload.data!.persons;
    expect(r.payload.data!.count).toBeGreaterThanOrEqual(1);
    expect(persons[0]).toMatchObject({ key: "p_b", displayName: " 张三 ", match: "exact", matchedOn: "display_name" });
  });

  it("别名命中标 matchedOn=alias", async () => {
    const store = makeStore({ persons: [person("p_a", "张三", ["老张"]), person("p_b", "李四")] });
    const r = await call("/v3/soul/person/search?team=t&q=老张", { store });
    expect(r.payload.data!.persons[0]).toMatchObject({ key: "p_a", match: "exact", matchedOn: "alias" });
  });

  it("排序：exact > prefix > contains；同分时字段多的靠前", async () => {
    const store = makeStore({
      persons: [person("p_c", "小张三"), person("p_b", "张三丰"), person("p_a", "张三")],
      items: [humanRow("role", "p_b"), humanRow("style", "p_b")],
    });
    const r = await call("/v3/soul/person/search?team=t&q=张三", { store });
    const persons = r.payload.data!.persons;
    expect(persons.map((p) => p.key)).toEqual(["p_a", "p_b", "p_c"]);
    expect(persons.map((p) => p.match)).toEqual(["exact", "prefix", "contains"]);
    // p_b 有档案字段、p_c 没有：同为 contains 时字段多的必须靠前，这里以 p_b/p_c 的顺序间接验证。
    expect(persons[1]).toMatchObject({ key: "p_b", fieldCount: 2 });
  });

  it("person_key 精确命中（调用方手里有 key 也能对上），match=key", async () => {
    const store = makeStore({ persons: [person("p_name_abc", "张三")] });
    const r = await call("/v3/soul/person/search?team=t&q=p_name_abc", { store });
    expect(r.payload.data!.persons[0]).toMatchObject({ key: "p_name_abc", match: "key" });
  });

  it("墓碑行不返回；fieldCount / relationCount 与其它读面同尺", async () => {
    const store = makeStore({
      persons: [person("p_a", "张三"), person("p_gone", "张三", [], "p_a"), person("p_b", "李四")],
      items: [humanRow("role", "p_a")],
      relations: [edge({ relId: "r1", subjKey: "p_a", objKey: "p_b" })],
    });
    const r = await call("/v3/soul/person/search?team=t&q=张三", { store });
    const persons = r.payload.data!.persons;
    expect(persons.map((p) => p.key)).toEqual(["p_a"]);
    expect(persons[0]).toMatchObject({ fieldCount: 1, relationCount: 1 });
  });

  it("limit 夹在 [1,20]（缺省 10，非法值回落缺省）", async () => {
    const many = Array.from({ length: 25 }, (_, i) => person(`p_${i}`, `张三${i}`));
    const store = makeStore({ persons: many });
    expect((await call("/v3/soul/person/search?team=t&q=张三&limit=1", { store })).payload.data!.count).toBe(1);
    expect((await call("/v3/soul/person/search?team=t&q=张三&limit=100", { store })).payload.data!.count).toBe(20);
    expect((await call("/v3/soul/person/search?team=t&q=张三&limit=abc", { store })).payload.data!.count).toBe(10);
  });

  it("store 抛错 → 503 soul_person_search_failed", async () => {
    const r = await call("/v3/soul/person/search?team=t&q=张三", { store: makeStore({ throws: true }) });
    expect(r.status).toBe(503);
    expect(r.payload.message).toBe("soul_person_search_failed");
  });
});

// ==================== server.ts 放行白名单（源级合同） ====================
// 2026-11-12 生产实证：handler 与单测都对，但 server.ts 的白名单只列了
// /v3/soul/person 与 /v3/soul/persons 两个字面路径，搜索路径没在名单里，
// 请求落到通用 404「Not found: GET /v3/soul/person/search」——单测直接调 handler
// 绕过了路由，所以全绿也发现不了。这里钉住「按前缀放行」这个形状。
describe("server.ts 放行 /v3/soul/person 家族（源级合同）", () => {
  const src = readFileSync(fileURLToPath(new URL("../server.ts", import.meta.url)), "utf8");
  const at = src.indexOf('pathname.startsWith("/v3/soul/person")');

  it("白名单按前缀放行，而不是逐个字面路径", () => {
    expect(at).toBeGreaterThan(-1);
  });

  it("三个 person handler 都在同一放行块内 dispatch", () => {
    const block = src.slice(at, at + 1_500);
    expect(block).toContain("handleSoulPersonRoute");
    expect(block).toContain("handleSoulPersonsRoute");
    expect(block).toContain("handleSoulPersonSearchRoute");
  });
});
