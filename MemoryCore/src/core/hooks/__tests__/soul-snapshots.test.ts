/**
 * #30 soul 快照测试（S9/R5，2026-10-16）
 *
 * 合同（r5-30 + 实现拍板 + 第三路对抗审查修正）：
 * 1. 渲染尾单咽喉 append 落行——**contentHash=渲染字节哈希（R5-F2，非 sv）**：
 *    同 sv 布局变体各自成行；内容不变零落行（last-hash 去重防膨胀）；
 * 2. payload=本次渲染全文（时间旅行可重建任一时点）；
 * 3. store 缺实现静默跳过；**store 写失败抛出（R5-F5），调用方吞错单点**——
 *    失败不置旗标 → 下次渲染（含缓存命中路径）自动补账；
 * 4. snapshotsEnabled:false 关闭（R5-F1：config soulRender.snapshotsEnabled 接线）；
 * 5. capture point=渲染路径单一咽喉（锚变更→指纹变化→下次渲染必经，at-least-once）。
 *
 * 测试隔离：soulPrefixCache 为模块级——每个用例独立 tenant（cacheKey 含租户）。
 */
import { describe, expect, it, vi } from "vitest";
import { buildSoulPrefix } from "../soul-assembler.js";
import type { IMemoryStore, CoreTenant } from "../../../core/store/types.js";
import type { Logger } from "../../../core/types.js";

const CT = { selfIdentityEnabled: true, budgetSelfChars: 600, budgetIdentityChars: 900 };

function row(over: Partial<Record<string, unknown>> & { value_id: string; label: string; weight: number; valence: number }): Record<string, unknown> {
  return {
    state: "active",
    node_type: "theme",
    attrs_json: JSON.stringify({ description: over.value_id === "v1" ? "第一句锚。" : "次锚描述。" }),
    ...over,
  };
}

const DEFAULT_SLOTS = [
  { slot: "self_identity", content: "我是测试者。" },
  { slot: "identity", content: "用户是工程师。" },
  { slot: "strict_rule", content: "禁止注入测试数据。" },
];

interface SnapRow { ts: string; contentHash: string; payloadJson: string; trigger: string }

function makeStore(rows: Record<string, unknown>[], failWrites = 0, slots: Array<{ slot: string; content: string }> = DEFAULT_SLOTS) {
  const snapshots: SnapRow[] = [];
  let writes = 0;
  const store = {
    readCore: vi.fn(async () => slots),
    listValues: vi.fn(async () => rows),
    readLastSoulSnapshotHash: vi.fn(async () => (snapshots.length ? snapshots[snapshots.length - 1].contentHash : null)),
    writeSoulSnapshot: vi.fn(async (_t: CoreTenant, snap: SnapRow) => {
      writes++;
      if (writes <= failWrites) throw new Error("simulated write failure");
      snapshots.push({ ...snap });
    }),
  } as unknown as IMemoryStore;
  return { store, snapshots, writeCalls: store.writeSoulSnapshot as ReturnType<typeof vi.fn> };
}

const LOG = { warn: vi.fn(), debug: vi.fn() } as unknown as Logger;

describe("#30 soul snapshots", () => {
  it("首次渲染落 1 行（contentHash=渲染字节哈希，payload=渲染全文）", async () => {
    const rows = [row({ value_id: "v1", label: "根因", weight: 0.8, valence: 1 })];
    const { store, snapshots } = makeStore(rows);
    await buildSoulPrefix(store, { teamId: "ts1", userId: "u1", agentId: "a1" }, LOG, { ...CT });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].contentHash).toMatch(/^[0-9a-f]{8}$/);
    expect(snapshots[0].trigger).toBe("render");
    expect(snapshots[0].payloadJson).toContain("根因(趋近·w0.8)");
  });

  it("内容不变重复渲染零落行（last-hash 去重防膨胀）", async () => {
    const rows = [row({ value_id: "v1", label: "根因", weight: 0.8, valence: 1 })];
    const { store, snapshots } = makeStore(rows);
    const t = { teamId: "ts2", userId: "u1", agentId: "a1" };
    await buildSoulPrefix(store, t, LOG, { ...CT });
    await buildSoulPrefix(store, t, LOG, { ...CT });
    await buildSoulPrefix(store, t, LOG, { ...CT });
    expect(snapshots).toHaveLength(1);
  });

  it("锚变更→字节变化→新 contentHash 落新行（时间旅行基础）", async () => {
    const rows = [row({ value_id: "v1", label: "根因", weight: 0.8, valence: 1 })];
    const { store, snapshots } = makeStore(rows);
    const t = { teamId: "ts4", userId: "u1", agentId: "a1" };
    await buildSoulPrefix(store, t, LOG, { ...CT });
    rows[0] = row({ value_id: "v1", label: "根因", weight: 0.95, valence: 1 });
    await buildSoulPrefix(store, t, LOG, { ...CT });
    expect(snapshots).toHaveLength(2);
    expect(snapshots[1].contentHash).not.toBe(snapshots[0].contentHash);
    expect(snapshots[1].payloadJson).toContain("根因(趋近·w0.95)");
  });

  it("写失败抛出→旗标不置→缓存命中路径自动补账（R5-F5 吞错单点=调用方；R5-F3 分支覆盖）", async () => {
    const rows = [row({ value_id: "v1", label: "根因", weight: 0.8, valence: 1 })];
    const { store, snapshots } = makeStore(rows, 1); // 首次写失败
    const t = { teamId: "ts7", userId: "u1", agentId: "a1" };
    await buildSoulPrefix(store, t, LOG, { ...CT }); // miss → write 抛 → 0 行，旗标未置（渲染主链不受影响）
    expect(snapshots).toHaveLength(0);
    await buildSoulPrefix(store, t, LOG, { ...CT }); // cache hit + !snapshotted → 补账 → 1 行
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].payloadJson).toContain("根因(趋近·w0.8)");
  });

  it("同 sv 布局变体各自成行（R5-F2：contentHash=渲染字节哈希）", async () => {
    const rows = [row({ value_id: "v1", label: "根因", weight: 0.8, valence: 1 })];
    const { store, snapshots } = makeStore(rows);
    const t = { teamId: "ts8", userId: "u1", agentId: "a1" };
    await buildSoulPrefix(store, t, LOG, { ...CT }); // F17 布局
    await buildSoulPrefix(store, t, LOG, { ...CT, selfIdentityEnabled: false }); // legacy 布局（同 sv 不同字节）
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0].contentHash).not.toBe(snapshots[1].contentHash);
    expect(snapshots[0].payloadJson).toContain("（我是谁）");
    expect(snapshots[1].payloadJson).not.toContain("（我是谁）");
  });

  it("多行 strict_rule 原样直出（R5-F6 合同钉：换行/伪标题逐字保留进段与快照）", async () => {
    const raw = "禁A。\n## 伪标题\n禁B。";
    const slots = [
      { slot: "self_identity", content: "我是测试者。" },
      { slot: "identity", content: "用户是工程师。" },
      { slot: "strict_rule", content: raw },
    ];
    const { store, snapshots } = makeStore([row({ value_id: "v1", label: "根因", weight: 0.8, valence: 1 })], 0, slots);
    const out = await buildSoulPrefix(store, { teamId: "ts9", userId: "u1", agentId: "a1" }, LOG, { ...CT });
    const idx = out.indexOf("## 不可逾越（红线）");
    expect(idx).toBeGreaterThan(-1);
    expect(out.slice(idx)).toContain(raw);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].payloadJson).toContain(raw);
  });

  it("store 缺快照方法→静默跳过，注入不受影响", async () => {
    const rows = [row({ value_id: "v1", label: "根因", weight: 0.8, valence: 1 })];
    const { store } = makeStore(rows);
    const bare = store as unknown as Record<string, unknown>;
    delete bare.readLastSoulSnapshotHash;
    delete bare.writeSoulSnapshot;
    const out = await buildSoulPrefix(store, { teamId: "ts5", userId: "u1", agentId: "a1" }, LOG, { ...CT });
    expect(out).toContain("根因(趋近·w0.8)");
  });

  it("snapshotsEnabled:false → 不落行（观测旁路可关）", async () => {
    const rows = [row({ value_id: "v1", label: "根因", weight: 0.8, valence: 1 })];
    const { store, snapshots, writeCalls } = makeStore(rows);
    await buildSoulPrefix(store, { teamId: "ts6", userId: "u1", agentId: "a1" }, LOG, { ...CT, snapshotsEnabled: false });
    expect(snapshots).toHaveLength(0);
    expect(writeCalls).not.toHaveBeenCalled();
  });
});
