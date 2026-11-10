/**
 * #36（R5）soul_introspect 测试：三返回段齐备、零写入路径、探针评估、
 * 孤儿锚证据窗、快照面缺失降级、端点 handler 503/200。
 * 合同：r5-36（只读；孤儿=低活性指标非删除建议；证据窗口 config 化）。
 */
import { describe, expect, it } from "vitest";
import { introspectSoul } from "../soul-introspect.js";
import { handleSoulIntrospectCore } from "../../../gateway/soul-introspect-endpoint.js";
import type { IMemoryStore } from "../../store/types.js";

const TENANT = { teamId: "ti", userId: "u1", agentId: "a1" };
const NOW = Date.now();
const iso = (t: number) => new Date(t).toISOString();

function makeStore(over: {
  slots?: Array<{ slot: string; content: string }>;
  rows?: Array<Record<string, unknown>>;
  snaps?: Array<{
    ts: string;
    content_hash: string;
    payload_json: string;
    trigger: string;
    version?: number;
    parent_hash?: string | null;
    reason_detail?: string;
    slots_json?: string;
  }>;
  withSnapshotSurface?: boolean;
  writeSpy?: { calls: number };
}) {
  const store: Record<string, unknown> = {
    readCore: async () => over.slots ?? [],
    listValues: async () => over.rows ?? [],
  };
  if (over.withSnapshotSurface !== false) {
    store.listSoulSnapshots = async () => over.snaps ?? [];
    store.writeSoulSnapshot = () => {
      over.writeSpy!.calls += 1;
    };
  }
  return store as never as IMemoryStore;
}

const anchorRow = (id: string, label: string) => ({
  value_id: id,
  label,
  weight: 0.5,
  valence: 1,
  state: "active",
  node_type: "theme",
  attrs_json: `{"description":"${label}的稳定描述句。"}`,
});

describe("#36 introspectSoul 三段+零写入", () => {
  it("三返回段齐备：rendered 含 soul-identity；快照 diff 行级；零写入（writeSoulSnapshot 0 调用）", async () => {
    const spy = { calls: 0 };
    const store = makeStore({
      slots: [{ slot: "identity", content: "我是测试。" }],
      rows: [anchorRow("v1", "根因"), anchorRow("v2", "孤儿锚")],
      snaps: [
        { ts: iso(NOW - 3000), content_hash: "h1", payload_json: "x\ny", trigger: "render" },
        { ts: iso(NOW - 2000), content_hash: "h2", payload_json: "x\nz", trigger: "render" },
        { ts: iso(NOW - 1000), content_hash: "h3", payload_json: "x\nz", trigger: "manual" },
      ],
      writeSpy: spy,
    });
    const out = await introspectSoul(store, TENANT, { snapshotLimit: 3 });
    expect(out.rendered).not.toContain("soul-identity");
    // task-6：人格渲染已移交插件——槽内容不再进 rendered（自省面只剩 <soul-feeling>）。
    expect(out.rendered).not.toContain("我是测试。");
    expect(out.snapshots).toHaveLength(3);
    expect(out.snapshots[1].diff).toEqual({ addedLines: 1, removedLines: 1 }); // s2(x,z) vs s1(x,y)
    expect(out.snapshots[2].diff).toEqual({ addedLines: 0, removedLines: 0 });
    expect(out.soulVersion).toMatch(/^sv-/);
    expect(spy.calls).toBe(0); // 零写入合同（渲染旁路快照落账已退役）
  });

  it("探针注入评估：通过/失败带 reason；缺省 null+note 如实降级", async () => {
    const store = makeStore({ slots: [{ slot: "identity", content: "我是测试。" }] });
    const probed = await introspectSoul(store, TENANT, {
      probes: [
        { id: "P-pass", category: "render", layer: "direct", expectNotContains: ["soul-identity", "soul-persona"] },
        { id: "P-fail", category: "render", layer: "direct", expectContains: ["soul-identity"] },
      ],
    });
    expect(probed.probes).toHaveLength(2);
    expect(probed.probes![0].passed).toBe(true);
    expect(probed.probes![1].passed).toBe(false);
    expect(probed.probes![1].reason).toContain("missing:soul-identity");

    const unprobed = await introspectSoul(store, TENANT, {});
    expect(unprobed.probes).toBeNull();
    expect(unprobed.notes.join("\n")).toContain("probes-not-provided");
  });

  it("孤儿锚：窗内命中不入列；窗外证据不计数；无语料全列+note；快照面缺失降级", async () => {
    const spy = { calls: 0 };
    const store = makeStore({
      rows: [anchorRow("v1", "根因"), anchorRow("v2", "孤儿锚")],
      writeSpy: spy,
      withSnapshotSurface: false,
    });
    const out = await introspectSoul(store, TENANT, {
      evidenceWindowHours: 168,
      evidence: [
        { content: "这里讨论根因问题", at: iso(NOW) },
        { content: "陈旧证据提到根因", at: iso(NOW - 200 * 3600_000) },
        { content: "无时间戳证据泛泛而谈", at: undefined },
      ],
    });
    expect(out.snapshots).toEqual([]);
    expect(out.notes.join("\n")).toContain("snapshot-surface-unavailable");
    // S8：core_values 整表删除 → 孤儿锚扫描退休（恒空 + note）。
    expect(out.orphanAnchors).toEqual([]);
    expect(out.notes.join("\n")).toContain("orphan-scan-retired");
    expect(out.evidenceWindowHours).toBe(168);

    const noEvidence = await introspectSoul(store, TENANT, {});
    expect(noEvidence.orphanAnchors).toEqual([]);
    expect(spy.calls).toBe(0);
  });

  it("缺口 A：版本链与变更原因可读（version/parentHash/reasonCode/reasonDetail/slotDiff）；老行不带受控原因", async () => {
    const spy = { calls: 0 };
    const v1Slots = { "slot:self_identity": "我是测试者。", "slot:identity": "用户是工程师。" };
    const v2Slots = { ...v1Slots, "slot:strict_rule": "禁止注入测试数据。" };
    const store = makeStore({
      slots: [{ slot: "identity", content: "我是测试。" }],
      writeSpy: spy,
      snaps: [
        {
          ts: iso(NOW - 2000),
          content_hash: "h1",
          payload_json: "p1",
          trigger: "first-version",
          version: 1,
          parent_hash: null,
          reason_detail: "keys=slot:identity,slot:self_identity",
          slots_json: JSON.stringify(v1Slots),
        },
        {
          ts: iso(NOW - 1000),
          content_hash: "h2",
          payload_json: "p2",
          trigger: "core-values",
          version: 2,
          parent_hash: "h1",
          reason_detail: "keys=slot:strict_rule",
          slots_json: JSON.stringify(v2Slots),
        },
        // 老行（迁移前）：无 version/slots_json，trigger 是自由文本 ⇒ 不冒充受控原因
        { ts: iso(NOW - 500), content_hash: "h3", payload_json: "p3", trigger: "render" },
      ],
    });
    const out = await introspectSoul(store, TENANT, { snapshotLimit: 5 });
    expect(out.snapshots.map((s) => s.version)).toEqual([1, 2, undefined]);
    expect(out.snapshots[1]!.parentHash).toBe("h1");
    expect(out.snapshots[1]!.reasonCode).toBe("core-values");
    expect(out.snapshots[1]!.reasonDetail).toContain("slot:strict_rule");
    // 首版 diff 相对空 = 全 added；第二版只新增 strict_rule
    expect(out.snapshots[0]!.slotDiff).toMatchObject({ added: 2, removed: 0, changed: 0 });
    expect(out.snapshots[1]!.slotDiff).toMatchObject({ added: 1, removed: 0, changed: 0 });
    expect(out.snapshots[1]!.slotDiff!.summary).toContain("added=1");
    expect(out.snapshots[2]!.reasonCode).toBeUndefined();
    expect(spy.calls).toBe(0);
  });
});

describe("#36 端点 handler（soul-introspect-endpoint）", () => {
  it("store 未就绪 → 503；正常 → 200 {code:0,data} 三段齐备", async () => {
    const noStore = await handleSoulIntrospectCore({}, { getStore: () => null });
    expect(noStore.status).toBe(503);

    const ok = await handleSoulIntrospectCore(
      { teamId: "ti", userId: "u1", agentId: "a1", evidence: [{ content: "提到根因" }] },
      {
        getStore: () =>
          makeStore({
            slots: [{ slot: "identity", content: "我是测试。" }],
            rows: [anchorRow("v1", "根因"), anchorRow("v2", "孤儿锚")],
          }),
        // 人格渲染退役后 rendered 只剩 <soul-feeling>：给一个基调，保证三段里 rendered 非空可查。
        moodTierProvider: async () => ({ tier: "neutral", sampleCount: 5 }),
      },
    );
    expect(ok.status).toBe(200);
    const data = (ok.payload as { code: number; data: { rendered: string; probes: unknown; orphanAnchors: Array<{ label: string }> } }).data;
    expect(data.rendered).toContain("近期基调：平稳。");
    expect(data.rendered).not.toContain("soul-identity");
    expect(data.rendered).not.toContain("我是测试。");
    expect(data.probes).toBeNull();
    // S8：价值锚整表删除，孤儿锚扫描退休（恒空）。
    expect(data.orphanAnchors).toEqual([]);
  });
});

describe("#36 保真度补全：端点 defaultRenderOpts + moodTierProvider（body 逐键覆盖）", () => {
  const fidelitySlots = [
    { slot: "self_identity", content: "我是测试者。" },
    { slot: "identity", content: "用户是系统维护者。" },
    { slot: "strict_rule", content: "绝不可删除记忆。" },
  ];

  it("defaultRenderOpts 不再改变渲染：即便传入退役开关也不出身份/红线段（人格已移交插件）", async () => {
    const out = await handleSoulIntrospectCore(
      { teamId: "ti", userId: "u1", agentId: "a1" },
      { getStore: () => makeStore({ slots: fidelitySlots }), defaultRenderOpts: {} },
    );
    expect(out.status).toBe(200);
    const data = (out.payload as { code: number; data: { rendered: string } }).data;
    expect(data.rendered).not.toContain("## 不可逾越（红线）");
    expect(data.rendered).not.toContain("绝不可删除记忆。");
    expect(data.rendered).not.toContain("我是测试者。");
  });

  it("body renderOpts 逐键覆盖 defaultRenderOpts：显式 false 回退 legacy（无红线段）", async () => {
    const out = await handleSoulIntrospectCore(
      { teamId: "ti", userId: "u1", agentId: "a1", renderOpts: {} },
      { getStore: () => makeStore({ slots: fidelitySlots }), defaultRenderOpts: {} },
    );
    const data = (out.payload as { code: number; data: { rendered: string } }).data;
    expect(data.rendered).not.toContain("## 不可逾越（红线）");
  });

  it("moodTierProvider 现算基调行；未提供 provider 不渲染基调（诚实降级）", async () => {
    const slots = [{ slot: "identity", content: "我是测试。" }];
    const withMood = await handleSoulIntrospectCore(
      { teamId: "ti", userId: "u1", agentId: "a1" },
      {
        getStore: () => makeStore({ slots }),
        defaultRenderOpts: {},
        moodTierProvider: async () => ({ tier: "strained", sampleCount: 5 }),
      },
    );
    const d1 = (withMood.payload as { data: { rendered: string } }).data;
    expect(d1.rendered).toContain("近期基调：");
    expect(d1.rendered).toContain("近期基调：偏承压。"); // 质量轮 2026-10-19：实现细节括号退役

    const noMood = await handleSoulIntrospectCore(
      { teamId: "ti", userId: "u1", agentId: "a1" },
      { getStore: () => makeStore({ slots }), defaultRenderOpts: {} },
    );
    const d2 = (noMood.payload as { data: { rendered: string } }).data;
    expect(d2.rendered).not.toContain("近期基调：");
  });

  it("moodTierProvider 抛错非致命：warn + 省略基调行、其余段照常", async () => {
    const warns: string[] = [];
    const out = await handleSoulIntrospectCore(
      { teamId: "ti", userId: "u1", agentId: "a1" },
      {
        getStore: () => makeStore({ slots: [{ slot: "identity", content: "我是测试。" }] }),
        defaultRenderOpts: {},
        moodTierProvider: async () => {
          throw new Error("mood down");
        },
        logger: { warn: (m: string) => warns.push(m) },
      },
    );
    expect(out.status).toBe(200);
    const data = (out.payload as { code: number; data: { rendered: string } }).data;
    expect(data.rendered).not.toContain("近期基调：");
    expect(data.rendered).not.toContain("我是测试。");
    expect(warns.join("\n")).toContain("mood down");
  });

  it("stateProvider 返回 state → rendered 含当下状态行（探针与生产同形）", async () => {
    const out = await handleSoulIntrospectCore(
      { teamId: "ti", userId: "u1", agentId: "a1" },
      {
        getStore: () => makeStore({ slots: [{ slot: "identity", content: "我是测试。" }] }),
        defaultRenderOpts: {},
        stateProvider: async () => ({ valence: 0.6, arousal: 0.4, topValue: "用户拍板" }),
      },
    );
    expect(out.status).toBe(200);
    const data = (out.payload as { code: number; data: { rendered: string } }).data;
    expect(data.rendered).toContain("此刻心里明亮，劲头正足，状态平稳安定。眼下最想推进的是用户拍板。"); // #52 P2 词表去黑话
  });

  it("stateProvider 抛错非致命：warn + 省略状态行、其余段照常", async () => {
    const warns: string[] = [];
    const out = await handleSoulIntrospectCore(
      { teamId: "ti", userId: "u1", agentId: "a1" },
      {
        getStore: () => makeStore({ slots: [{ slot: "identity", content: "我是测试。" }] }),
        defaultRenderOpts: {},
        stateProvider: async () => {
          throw new Error("state down");
        },
        logger: { warn: (m: string) => warns.push(m) },
      },
    );
    expect(out.status).toBe(200);
    const data = (out.payload as { code: number; data: { rendered: string } }).data;
    expect(data.rendered).not.toContain("当下状态：");
    expect(data.rendered).not.toContain("我是测试。");
    expect(warns.join("\n")).toContain("state down");
  });

});
