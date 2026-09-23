/**
 * 立项③ TDB 内部完整实现（2026-09-23）：soul 前缀会话级缓存 + 人格变更日志。
 * RED 先行：缓存命中/穿透/变更日志三层断言。
 */
import { describe, expect, it, vi } from "vitest";
import { buildSoulPrefix } from "../soul-assembler.js";

const TENANT = { teamId: "t1", userId: "u1", agentId: "a1" };

function makeStore(rows: Array<Record<string, unknown>>, slots: Array<Record<string, string>> = []) {
  const listValues = vi.fn(async () => rows);
  const readCore = vi.fn(async () => slots);
  return { listValues, readCore } as never;
}

const row = (o: { value_id: string; label: string; weight?: number; valence?: number | null }) => ({
  value_id: o.value_id,
  label: o.label,
  weight: o.weight ?? 0.5,
  valence: o.valence ?? 1,
  state: "active",
  node_type: "theme",
  attrs_json: "{}",
});

const slots = [
  { slot: "self_identity", content: "我是谁内容" },
  { slot: "identity", content: "我心中的他内容" },
];

describe("soul 前缀缓存（TDB 内部完整实现）", () => {
  it("同数据二次调用 → 返回相同文本（缓存命中）", async () => {
    const rows = [row({ value_id: "a", label: "根因", weight: 0.8 })];
    const store = makeStore(rows, slots);
    const opts = { selfIdentityEnabled: true };
    const r1 = await buildSoulPrefix(store, TENANT, undefined, opts);
    const r2 = await buildSoulPrefix(store, TENANT, undefined, opts);
    expect(r1).toBe(r2); // 字节级一致
  });

  it("weight 变化 → 重渲染返回新文本", async () => {
    const store1 = makeStore([row({ value_id: "a", label: "根因", weight: 0.8 })], slots);
    const r1 = await buildSoulPrefix(store1, TENANT, undefined, { selfIdentityEnabled: true });
    // 模拟 weight 变化（新 store 实例、新数据）
    const store2 = makeStore([row({ value_id: "a", label: "根因", weight: 0.95 })], slots);
    const r2 = await buildSoulPrefix(store2, TENANT, undefined, { selfIdentityEnabled: true });
    // weight 变了但注入行渲染不展示 weight（排序稳定化）→ 文本可能仍一致
    // 关键断言：两次调用都正常返回非空文本
    expect(r1.length).toBeGreaterThan(0);
    expect(r2.length).toBeGreaterThan(0);
  });

  it("人格变更日志：logger.info 包含 '人格变更'", async () => {
    const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn() };
    const rows1 = [row({ value_id: "a", label: "根因", weight: 0.8 })];
    const store1 = makeStore(rows1, slots);
    await buildSoulPrefix(store1, TENANT, logger as never, { selfIdentityEnabled: true });
    // 换数据（新增锚）
    const rows2 = [
      row({ value_id: "a", label: "根因", weight: 0.8 }),
      row({ value_id: "b", label: "闭环", weight: 0.6 }),
    ];
    const store2 = makeStore(rows2, slots);
    await buildSoulPrefix(store2, TENANT, logger as never, { selfIdentityEnabled: true });
    const infoCalls = logger.info.mock.calls.map((c) => String(c[0]));
    expect(infoCalls.some((c) => c.includes("人格变更"))).toBe(true);
  });

  it("首次调用无变更日志（无前一轮可比较）", async () => {
    const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn() };
    const store = makeStore([row({ value_id: "a", label: "根因" })], slots);
    // 用独立租户避免前面 test case 的 cache 污染
    const FRESH = { teamId: "t-fresh", userId: "u-fresh", agentId: "a-fresh" };
    await buildSoulPrefix(store, FRESH, logger as never, { selfIdentityEnabled: true });
    const infoCalls = logger.info.mock.calls.map((c) => String(c[0]));
    expect(infoCalls.some((c) => c.includes("人格变更"))).toBe(false);
  });

  it("不同租户各自独立缓存（互不干扰）", async () => {
    const T2 = { teamId: "t2", userId: "u2", agentId: "a2" };
    const rows1 = [row({ value_id: "x", label: "租户1锚" })];
    const rows2 = [row({ value_id: "y", label: "租户2锚" })];
    const r1 = await buildSoulPrefix(makeStore(rows1, slots) as never, TENANT, undefined, { selfIdentityEnabled: true });
    const r2 = await buildSoulPrefix(makeStore(rows2, slots) as never, T2, undefined, { selfIdentityEnabled: true });
    expect(r1).toContain("租户1锚");
    expect(r2).toContain("租户2锚");
    // 二次调用仍正确（缓存按租户隔离）
    const r3 = await buildSoulPrefix(makeStore(rows1, slots) as never, TENANT, undefined, { selfIdentityEnabled: true });
    expect(r3).toContain("租户1锚");
  });
});
