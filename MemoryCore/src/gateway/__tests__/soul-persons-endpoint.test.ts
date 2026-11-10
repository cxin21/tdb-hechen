/**
 * P2-D 配套：`GET /v3/soul/persons` 的合同测试（假 store，不连库）。
 *
 * 这条读面只解决一件事：调用方手里没有 person_key 时，也要能枚举「这个租户里有哪些人、
 * 他们之间有哪些边」，Panel 的人物档案 / 关系图就建在这里。
 * 因此测试盯六个点——只接 GET、缺 team 400、store 未就绪 503、墓碑行不进列表、
 * fieldCount 用与 /v3/soul/person 同一把尺子（human + PROFILE_SOURCE + 未作废 + 九字段）、
 * 边只回现行边且度数按出入两端都算。
 */
import { describe, expect, it, vi } from "vitest";
import type { ServerResponse } from "node:http";
import type { SoulPersonRelationRow } from "../../core/store/types.js";
import { handleSoulPersonsRoute } from "../soul-person-endpoint.js";

const res = {} as ServerResponse;

type Row = Record<string, unknown>;

function person(key: string, displayName: string, mergedInto: string | null = null): Row {
  return {
    personKey: key,
    teamId: "team-p",
    userId: "usr-p",
    agentId: "agt-p",
    platform: "tdai",
    platformId: null,
    displayName,
    aliases: [`${displayName}-alias`],
    mergedInto,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  };
}

function humanRow(field: string, personKey: string, opts: { validTo?: string; layer?: string } = {}): Row {
  return {
    itemId: `human:pp-${field}-${personKey}`,
    layer: opts.layer ?? "human",
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
    ...(opts.validTo ? { validTo: opts.validTo } : {}),
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
    quote: "我们一起做发布",
    recordId: "m1",
    evidence: [{ recordId: "m1", at: "2026-05-01T00:00:00.000Z", quote: "我们一起做发布" }],
    validFrom: "2026-05-01T00:00:00.000Z",
    validTo: null,
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    ...over,
  };
}

function makeStore(opts: { persons?: Row[]; items?: Row[]; relations?: SoulPersonRelationRow[]; throws?: boolean } = {}) {
  return {
    listSoulPersons: async () => opts.persons ?? [person("p_a", "甲"), person("p_b", "乙")],
    listSoulPersona: async () => opts.items ?? [],
    listSoulPersonRelations: async () => {
      if (opts.throws) throw new Error("boom");
      return opts.relations ?? [];
    },
  };
}

async function call(url: string, opts: { method?: string; store?: unknown | null } = {}) {
  const sendJson = vi.fn();
  const handled = await handleSoulPersonsRoute(
    new URL(url, "http://localhost"),
    opts.method ?? "GET",
    sendJson,
    res,
    { getStore: () => (opts.store === undefined ? makeStore() : opts.store) as never },
  );
  const [, status, payload] = (sendJson.mock.calls[0] ?? []) as [unknown, number, unknown];
  return { handled, status, payload: payload as { ok?: boolean; message?: string; data?: never } };
}

describe("GET /v3/soul/persons", () => {
  it("只认 GET + /v3/soul/persons，其余交回 dispatch", async () => {
    expect((await call("/v3/soul/persons?team=t", { method: "POST" })).handled).toBe(false);
    expect((await call("/v3/soul/person?team=t&key=p_a")).handled).toBe(false);
  });

  it("缺 team → 400 team_required", async () => {
    const r = await call("/v3/soul/persons");
    expect(r.handled).toBe(true);
    expect(r.status).toBe(400);
    expect(r.payload.message).toBe("team_required");
  });

  it("store 未就绪 → 503（列表读不到时不假装空列表）", async () => {
    const r = await call("/v3/soul/persons?team=t", { store: null });
    expect(r.status).toBe(503);
    expect(r.payload.message).toBe("soul_person_unavailable");
  });

  it("墓碑行（已合并）不进列表，但边的 subjName 仍能取到活着的那个名字", async () => {
    const store = makeStore({
      persons: [person("p_a", "甲"), person("p_gone", "旧名", "p_a"), person("p_b", "乙")],
      relations: [edge({ relId: "r1", subjKey: "p_a", objKey: "p_b" })],
    });
    const r = await call("/v3/soul/persons?team=t", { store });
    const data = r.payload.data as unknown as {
      persons: Array<{ key: string; relationCount: number }>;
      edges: Array<{ subjName: string | null; direction: string }>;
    };
    expect(data.persons.map((p) => p.key)).toEqual(["p_a", "p_b"]);
    expect(data.edges[0]?.subjName).toBe("甲");
    expect(data.edges[0]?.direction).toBe("out");
  });

  it("合并过的主体边也顺着 mergedInto 取活名；对象缺 obj_name 时按 obj_key 补名", async () => {
    const store = makeStore({
      persons: [person("p_a", "甲"), person("p_gone", "旧名", "p_a"), person("p_b", "乙")],
      relations: [
        edge({ relId: "r1", subjKey: "p_gone", objKey: "p_b" }),
        edge({ relId: "r2", subjKey: "p_a", pred: "上级", objKey: null, objName: "老板" }),
      ],
    });
    const r = await call("/v3/soul/persons?team=t", { store });
    const data = r.payload.data as unknown as {
      edges: Array<{ relId: string; subjName: string | null; objName: string | null }>;
    };
    expect(data.edges[0]).toMatchObject({ relId: "r1", subjName: "甲", objName: "乙" });
    // 显式 obj_name 优先，不被 key 覆盖（没有 key 的历史边也能显示人名）。
    expect(data.edges[1]).toMatchObject({ relId: "r2", subjName: "甲", objName: "老板" });
  });

  it("fieldCount 只用现行 human 档案行；作废行、别的层、非档案来源都不算", async () => {
    const store = makeStore({
      persons: [person("p_a", "甲"), person("p_b", "乙")],
      items: [
        humanRow("role", "p_a"),
        humanRow("style", "p_a"),
        humanRow("likes", "p_a", { validTo: "2026-06-02T00:00:00.000Z" }),
        humanRow("focus", "p_a", { layer: "identity" }),
        humanRow("story", "p_b"),
      ],
    });
    const r = await call("/v3/soul/persons?team=t", { store });
    const data = r.payload.data as unknown as { persons: Array<{ key: string; fieldCount: number }> };
    const byKey = new Map(data.persons.map((p) => [p.key, p.fieldCount]));
    expect(byKey.get("p_a")).toBe(2);
    expect(byKey.get("p_b")).toBe(1);
  });

  it("只回现行边；度数按出入两端都算，并按度数降序排列", async () => {
    const store = makeStore({
      persons: [person("p_a", "甲"), person("p_b", "乙"), person("p_c", "丙")],
      relations: [
        edge({ relId: "r1", subjKey: "p_a", objKey: "p_b" }),
        edge({ relId: "r2", subjKey: "p_c", objKey: "p_a", direction: "out" }),
        edge({ relId: "r3", subjKey: "p_c", objKey: "p_a", validTo: "2026-06-01T00:00:00.000Z" }),
        edge({ relId: "r4", subjKey: "p_b", pred: "上级", objKey: null, objName: "老板" }),
      ],
    });
    const r = await call("/v3/soul/persons?team=t", { store });
    const data = r.payload.data as unknown as {
      persons: Array<{ key: string; relationCount: number }>;
      edges: Array<{ relId: string; objKey: string | null; objName: string | null }>;
    };
    expect(data.edges.map((e) => e.relId)).toEqual(["r1", "r2", "r4"]);
    expect(data.edges[2]).toMatchObject({ objKey: null, objName: "老板" });
    const degree = new Map(data.persons.map((p) => [p.key, p.relationCount]));
    expect(degree.get("p_a")).toBe(2);
    expect(degree.get("p_b")).toBe(2);
    expect(degree.get("p_c")).toBe(1);
    expect(data.persons.map((p) => p.key).slice(0, 2).sort()).toEqual(["p_a", "p_b"]);
  });

  it("store 抛错 → 503 soul_persons_failed（不让异常冒到 dispatch）", async () => {
    const r = await call("/v3/soul/persons?team=t", { store: makeStore({ throws: true }) });
    expect(r.status).toBe(503);
    expect(r.payload.message).toBe("soul_persons_failed");
  });
});
