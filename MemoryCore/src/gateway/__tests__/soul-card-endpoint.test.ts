import { describe, expect, it, vi } from "vitest";
import type { ServerResponse } from "node:http";
import { handleSoulCardRoute, handleSoulTraitStateRoute } from "../soul-card-endpoint.js";
import { createHash } from "node:crypto";
import { SEED_LABELS, activationOf, normalizeDirection, seedStateFromSeeds } from "../../core/soul/traits.js";
import { seedLabelRows } from "../../core/soul/trait-drift.js";

const res = {} as ServerResponse;

function call(url: string, method = "GET", store: unknown = {}) {
  const sendJson = vi.fn();
  return handleSoulCardRoute(new URL(url, "http://localhost"), method, sendJson, res, {
    getStore: () => store as never,
  }).then((handled) => ({ handled, sendJson }));
}

describe("GET /v3/soul/card · /v3/soul/turn（S2 注入数据源）", () => {
  it("只认 GET 与两条路径，其余交回 dispatch", async () => {
    expect((await call("/v3/soul/card", "POST")).handled).toBe(false);
    expect((await call("/v3/other")).handled).toBe(false);
  });

  it("store 未就绪 → 503，插件侧据此 fail-open", async () => {
    const sendJson = vi.fn();
    const handled = await handleSoulCardRoute(new URL("http://localhost/v3/soul/card"), "GET", sendJson, res, {
      getStore: () => null,
    });
    expect(handled).toBe(true);
    expect(sendJson.mock.calls[0]?.[1]).toBe(503);
    expect(sendJson.mock.calls[0]?.[2]).toMatchObject({ message: "soul_card_unavailable" });
  });

  it("GET card 纯读：返回版本/文本/来源，且绝不落快照", async () => {
    const writeSoulSnapshot = vi.fn();
    const store = {
      readLastSoulSnapshot: async () => null,
      listSoulPersona: async () => [],
      readSoulTraitState: async () => null,
      listSoulTraitLabels: async () => [],
      writeSoulSnapshot,
    };
    const { handled, sendJson } = await call("/v3/soul/card?team=t&user=u&agent=a", "GET", store);
    expect(handled).toBe(true);
    const [, status, payload] = sendJson.mock.calls[0]!;
    expect(status).toBe(200);
    const data = (payload as { data: Record<string, unknown> }).data;
    expect(typeof data.version).toBe("number");
    expect(typeof data.hash).toBe("string");
    expect(String(data.text)).toContain("读法");
    // v13：来源是九块的键。这个 fixture 没有观察层行，所以只有第一眼是有源的，其余如实记 absent。
    expect(data.schema).toBe("13");
    expect(data.sources).toMatchObject({ firstLook: "declared", character: "absent", us: "absent" });
    const blocks = data.blocks as Array<{ id: string; chars: number }>;
    expect(blocks.map((b) => b.id)).toEqual([
      "firstLook",
      "life",
      "character",
      "voice",
      "us",
      "now",
      "memory",
      "boundaries",
      "recent",
    ]);
    expect(writeSoulSnapshot).not.toHaveBeenCalled();
  });

  it("textHash：卡正文的 SHA-256（64 hex），两次调用稳定，旧 hash 口径不变", async () => {
    const store = {
      readLastSoulSnapshot: async () => null,
      listSoulPersona: async () => [],
      readSoulTraitState: async () => null,
      listSoulTraitLabels: async () => [],
    };
    const first = await call("/v3/soul/card?team=t&user=u&agent=a", "GET", store);
    const data = (first.sendJson.mock.calls[0]![2] as { data: { hash: string; text: string; textHash: string } }).data;
    expect(typeof data.hash).toBe("string");
    expect(data.textHash).toMatch(/^[0-9a-f]{64}$/);
    expect(data.textHash).toBe(createHash("sha256").update(data.text, "utf8").digest("hex"));
    const second = await call("/v3/soul/card?team=t&user=u&agent=a", "GET", store);
    expect((second.sendJson.mock.calls[0]![2] as { data: { textHash: string } }).data.textHash).toBe(data.textHash);
  });

  it("渲染异常 → 503 soul_card_failed（不抛给会话）", async () => {
    const store = {
      readLastSoulSnapshot: async () => {
        throw new Error("db locked");
      },
    };
    const { sendJson } = await call("/v3/soul/card", "GET", store);
    expect(sendJson.mock.calls[0]?.[1]).toBe(503);
    expect(sendJson.mock.calls[0]?.[2]).toMatchObject({ message: "soul_card_failed" });
  });

  it("GET turn 返回心境 + 未完的事，字符数上报", async () => {
    const store = {
      readSoulState: async () => ({
        valence: 0,
        arousal: 0.3,
        baselineValence: 0,
        baselineArousal: 0.3,
        sampleCount: 3,
        updatedAt: "2026-11-07T12:00:00.000Z",
      }),
      listSoulPromises: async () => [
        { promiseId: "p1", content: "把这步收口", status: "open", source: "episode", refKey: "", createdAt: "", updatedAt: "" },
      ],
    };
    const { sendJson } = await call("/v3/soul/turn", "GET", store);
    const data = (sendJson.mock.calls[0]![2] as { data: { text: string; openLoops: string[]; chars: number } }).data;
    expect(data.text).toContain("近期心境");
    expect(data.openLoops).toEqual(["把这步收口"]);
    expect(data.chars).toBe(data.text.length);
    expect(data.chars).toBeLessThanOrEqual(400);
  });
});

describe("GET /v3/soul/trait-state（表单两栏数据源）", () => {
  const route = (url: string, store: unknown, profile?: unknown) =>
    handleSoulTraitStateRoute(
      new URL(url, "http://localhost"),
      "GET",
      sendJson,
      res,
      {
        getStore: () => store as never,
        getReadAgentProfile: () => (profile === undefined ? null : async () => profile as never),
      },
    );
  // vi.fn 的 Mock<Procedure> 与 sendJson 的窄签名不兼容，测试里只要能读 mock.calls。
  let sendJson: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  it("只认 GET /v3/soul/trait-state，其余交回 dispatch", async () => {
    sendJson = vi.fn();
    expect(await route("/v3/soul/card", {})).toBe(false);
  });

  const traitsOf = (payload: unknown) =>
    (payload as { data: { traits: Array<Record<string, unknown>> } }).data.traits;

  it("无状态行：与卡同源——nowWeight 由种子现算、drifted 全 false、seedSource=seed", async () => {
    sendJson = vi.fn();
    const handled = await route(
      "/v3/soul/trait-state?team=t&user=u&agent=a",
      { readSoulTraitState: () => null, listSoulTraitLabels: () => [] },
      { traits: [{ label: "严谨", weight: 0.4 }, { label: "好奇", weight: 0.2 }] },
    );
    expect(handled).toBe(true);
    const [res0, status, payload] = sendJson.mock.calls[0]!;
    expect(status).toBe(200);
    expect(res0).toBe(res);
    // 信封：与 /card、/turn 同形；不再是裸 JSON。
    expect((payload as { code: number }).code).toBe(0);
    const envelope = payload as { data: { seedSource: string } };
    expect(envelope.data.seedSource).toBe("seed");
    const traits = traitsOf(payload);
    expect(traits.map((t) => t.label)).toEqual(["严谨", "好奇"]);
    // 审墨 A2：卡按 seedState 显示 0.8/0.7…，这一屏必须同源，不许给 0.5 / 0。
    const seedState = seedStateFromSeeds([{ label: "严谨", weight: 0.4 }, { label: "好奇", weight: 0.2 }]);
    const strictDirection = normalizeDirection(SEED_LABELS.find((seed) => seed.label === "严谨")!.direction);
    expect(traits[0]!.nowWeight).toBe(Number(activationOf(seedState, strictDirection).toFixed(2)));
    expect(traits.every((t) => Number(t.nowWeight) > 0)).toBe(true);
    expect(traits.every((t) => t.drifted === false)).toBe(true);
    const text = JSON.stringify(payload);
    for (const axis of ["warmth", "agency", "rigor", "openness", "stability", "boundary", "tanh", "α"]) {
      expect(text).not.toContain(axis);
    }
  });

  it("零漂移：declared 2 条、drifted 全 false（不许拿 act 去比声明权重）", async () => {
    sendJson = vi.fn();
    const seedState = seedStateFromSeeds([{ label: "严谨", weight: 0.5 }, { label: "好奇", weight: 0.3 }]);
    await route(
      "/v3/soul/trait-state?team=t&user=u&agent=a",
      { readSoulTraitState: () => ({ state: { ...seedState }, seedState: { ...seedState }, updatedAt: "2026-11-07T00:00:00.000Z" }), listSoulTraitLabels: () => [] },
      { traits: [{ label: "严谨", weight: 0.5 }, { label: "好奇", weight: 0.3 }] },
    );
    const payload = sendJson.mock.calls[0]![2] as { updatedAt: string; data: { traits: Array<{ label: string; seedWeight: number; nowWeight: number; drifted: boolean }> } };
    expect(payload.data.traits.map((t) => t.label)).toEqual(["严谨", "好奇"]);
    expect(payload.data.traits.every((t) => t.drifted === false)).toBe(true);
    expect((payload as { data: { seedSource?: string } }).data.seedSource).toBe("state");
    // nowWeight 仍是 act（展示口径），声明权重只进 seedWeight。
    expect(payload.data.traits[0]!.seedWeight).toBe(0.5);
    expect(payload.data.traits[0]!.nowWeight).toBeGreaterThanOrEqual(0);
  });

  it("同量纲漂移：某轴推 0.006 → drifted=true；推 0.004 → false（epsilon=0.005）", async () => {
    sendJson = vi.fn();
    const seedState = seedStateFromSeeds([{ label: "严谨", weight: 0.5 }]);
    const pushed = { ...seedState, rigor: seedState.rigor + 0.006 };
    await route(
      "/v3/soul/trait-state?team=t&user=u&agent=a",
      { readSoulTraitState: () => ({ state: pushed, seedState, updatedAt: "2026-11-07T00:00:00.000Z" }), listSoulTraitLabels: () => [] },
      { traits: [{ label: "严谨", weight: 0.5 }] },
    );
    const t1 = traitsOf(sendJson.mock.calls[0]![2]);
    expect(t1.length).toBe(1);
    expect(t1[0]!.drifted).toBe(true);

    sendJson = vi.fn();
    const small = { ...seedState, rigor: seedState.rigor + 0.004 };
    await route(
      "/v3/soul/trait-state?team=t&user=u&agent=a",
      { readSoulTraitState: () => ({ state: small, seedState, updatedAt: "2026-11-07T00:00:00.000Z" }), listSoulTraitLabels: () => [] },
      { traits: [{ label: "严谨", weight: 0.5 }] },
    );
    expect(traitsOf(sendJson.mock.calls[0]![2])[0]!.drifted).toBe(false);
  });

  it("自生长标签：evidence>0 且未 dormant 才出；evidence=0 的种子不出现", async () => {
    sendJson = vi.fn();
    // 模拟生产：18 条种子行 evidence=0，只有「通透」攒到 5 条证据。
    const rows = seedLabelRows(SEED_LABELS, "2026-11-07T00:00:00.000Z").map((r) => ({
      ...r,
      evidence: r.label === "通透" ? 5 : 0,
    }));
    await route(
      "/v3/soul/trait-state?team=t&user=u&agent=a",
      { readSoulTraitState: () => null, listSoulTraitLabels: () => rows },
      { traits: [] },
    );
    const labels = traitsOf(sendJson.mock.calls[0]![2]).map((t) => t.label);
    expect(labels).toContain("通透");
    expect(labels).not.toContain("冷淡");
    expect(labels.length).toBe(1);
  });

  it("读状态抛错 → 503 soul_trait_state_failed（信封同形）", async () => {
    sendJson = vi.fn();
    await route("/v3/soul/trait-state?team=t&user=u&agent=a", {
      readSoulTraitState: () => {
        throw new Error("db locked");
      },
    });
    expect(sendJson.mock.calls[0]?.[1]).toBe(503);
    expect(sendJson.mock.calls[0]?.[2]).toMatchObject({ code: 503, message: "soul_trait_state_failed" });
  });
});
