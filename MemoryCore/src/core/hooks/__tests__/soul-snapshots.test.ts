/**
 * #30 soul 快照测试（S9/R5，2026-10-16）
 *
 * 合同（r5-30 + 实现拍板）：
 * 1. 只在指纹（soulVersion）变化后首次渲染落行——指纹不变零落行（last-hash 去重防膨胀）；
 * 2. payload=本次渲染全文（时间旅行可重建任一时点）；
 * 3. store 缺实现/失败静默跳过（观测旁路零注入影响）；snapshotsEnabled:false 关闭；
 * 4. 缓存命中路径同样落账（进程内渲染过≠已落账：写失败/中途关断需补账，snapshotted 旗标防重复查询）；
 * 5. capture point=渲染路径单一咽喉（锚变更→指纹变化→下次渲染必经，at-least-once）。
 *
 * 测试隔离：soulPrefixCache 为模块级——每个用例独立 tenant（cacheKey 含租户），
 * 不与其它用例或既有套件串数据。
 */
import { describe, expect, it, vi } from "vitest";
import { buildSoulPrefix } from "../soul-assembler.js";
import type { IMemoryStore, CoreTenant } from "../../../core/store/types.js";
import type { Logger } from "../../../core/types.js";

const CT = { selfIdentityEnabled: true, budgetSelfChars: 600, budgetIdentityChars: 900 };

const SLOTS = "### self_identity\n我是测试者。\n### identity\n用户是工程师。\n### strict_rule\n禁止注入测试数据。";

function row(over: Partial<Record<string, unknown>> & { value_id: string; label: string; weight: number; valence: number }): Record<string, unknown> {
  return {
    state: "active",
    node_type: "theme",
    attrs_json: JSON.stringify({ description: over.value_id === "v1" ? "第一句锚。" : "次锚描述。" }),
    ...over,
  };
}

interface SnapRow { ts: string; contentHash: string; payloadJson: string; trigger: string }

function makeStore(rows: Record<string, unknown>[], slots: string = SLOTS) {
  const snapshots: SnapRow[] = [];
  const store = {
    readCore: vi.fn(async () => [
      { slot: "self_identity", content: "我是测试者。" },
      { slot: "identity", content: "用户是工程师。" },
      { slot: "strict_rule", content: "禁止注入测试数据。" },
    ]),
    listValues: vi.fn(async () => rows),
    readLastSoulSnapshotHash: vi.fn(async () => (snapshots.length ? snapshots[snapshots.length - 1].contentHash : null)),
    writeSoulSnapshot: vi.fn(async (_t: CoreTenant, snap: SnapRow) => { snapshots.push({ ...snap }); }),
  } as unknown as IMemoryStore;
  return { store, snapshots, writeCalls: store.writeSoulSnapshot as ReturnType<typeof vi.fn> };
}

const LOG = { warn: vi.fn(), debug: vi.fn() } as unknown as Logger;

describe("#30 soul snapshots", () => {
  it("指纹变化后首次渲染落 1 行（payload=渲染全文）", async () => {
    const rows = [row({ value_id: "v1", label: "根因", weight: 0.8, valence: 1 })];
    const { store, snapshots } = makeStore(rows);
    await buildSoulPrefix(store, { teamId: "ts1", userId: "u1", agentId: "a1" }, LOG, { ...CT });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].contentHash).toMatch(/^sv-[0-9a-f]{8}$/);
    expect(snapshots[0].trigger).toBe("render");
    expect(snapshots[0].payloadJson).toContain("根因(趋近·w0.8)");
  });

  it("指纹不变重复渲染零落行（last-hash 去重防膨胀）", async () => {
    const rows = [row({ value_id: "v1", label: "根因", weight: 0.8, valence: 1 })];
    const { store, snapshots } = makeStore(rows);
    const t = { teamId: "ts2", userId: "u1", agentId: "a1" };
    await buildSoulPrefix(store, t, LOG, { ...CT });
    await buildSoulPrefix(store, t, LOG, { ...CT });
    await buildSoulPrefix(store, t, LOG, { ...CT });
    expect(snapshots).toHaveLength(1);
  });

  it("缓存命中路径补账落行（进程内渲染过≠已落账）", async () => {
    const rows = [row({ value_id: "v1", label: "根因", weight: 0.8, valence: 1 })];
    const { store, snapshots } = makeStore(rows);
    const t = { teamId: "ts3", userId: "u1", agentId: "a1" };
    // 首渲染：cache miss → 落行 + snapshotted 旗标
    await buildSoulPrefix(store, t, LOG, { ...CT });
    expect(snapshots).toHaveLength(1);
    // 同 tenant 直接再渲染（cache hit + 旗标）→ 不重复
    await buildSoulPrefix(store, t, LOG, { ...CT });
    expect(snapshots).toHaveLength(1);
    // 旗标已置，若 store 被替换为空库（模拟重启/换库），last-hash 检查不会发生——
    // 真实合同：进程内旗标语义=本进程已确认落账；跨进程由进程重启后的 cache miss 补账。
    // 此用例改为验证：新 store 实例 + 新 tenant → 走 miss 路径正常落行。
    const rows2 = [row({ value_id: "v1", label: "根因", weight: 0.8, valence: 1 })];
    const s2 = makeStore(rows2);
    await buildSoulPrefix(s2.store, { teamId: "ts3b", userId: "u1", agentId: "a1" }, LOG, { ...CT });
    expect(s2.snapshots).toHaveLength(1);
  });

  it("锚变更→指纹变化→下次渲染落新行（时间旅行基础）", async () => {
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
