/**
 * P0-1A（issue #1，Spec 审查 c1 修正）：/core-memory/values/upsert 的
 * attrs.description 单一源质量门回归测试。
 *
 * 直连 API（curl 菜单/脚本）不再能绕过 anchorDescriptionAttr 清洗：
 *   - 合格描述 → 句边界截取后 P-B 消毒落库；
 *   - episode 特征/断尾半句/超长无句读 → 显式 400（宁缺毋滥，不静默清空）；
 *   - 与 core/hooks/anchor-desc.ts（写入口单一源）行为逐位一致。
 */
import { describe, expect, it, vi } from "vitest";
import { handleCoreMemoryValuesUpsert } from "./v2-router.js";
import type { IMemoryStore } from "../core/store/types.js";
import type { V2RouterDeps } from "./v2-router.js";
// handleCoreMemoryValuesUpsert 经 v2-router.ts 底部 export 块导出（S1 verify-s1 直调惯例），
// 无需为本测试新增导出。

function depsFor(store: unknown): V2RouterDeps {
  return {
    getStore: () => store,
    requestIsolation: { teamId: "t", userId: "u", agentId: "a" },
  } as unknown as V2RouterDeps;
}

function mockStore(): { store: IMemoryStore; upsertValue: ReturnType<typeof vi.fn> } {
  const upsertValue = vi.fn(async () => true);
  return { store: { upsertValue } as unknown as IMemoryStore, upsertValue };
}

const BASE = { value_id: "knot-upsert", label: "增量对账", weight: 0.5 };

describe("P0-1A：values/upsert attrs.description 质量门（单一源 anchor-desc）", () => {
  it("合格描述 → 句边界截取后落库（'证据裁决一切。拒绝粉饰，' → '证据裁决一切。'）", async () => {
    const { store, upsertValue } = mockStore();
    const res = await handleCoreMemoryValuesUpsert({ ...BASE, attrs: { description: "证据裁决一切。拒绝粉饰，" } }, {} as never, "req-u1", depsFor(store));
    expect(res.code).toBe(0);
    expect(upsertValue).toHaveBeenCalledWith("knot-upsert", "增量对账", 0.5, "agent", expect.objectContaining({ teamId: "t" }), undefined, undefined, undefined, { description: "证据裁决一切。" });
  });

  it("episode 特征描述 → 400（直连 API 不可绕过）", async () => {
    const { store, upsertValue } = mockStore();
    const res = await handleCoreMemoryValuesUpsert({ ...BASE, attrs: { description: "2026-09-01 部署完成。" } }, {} as never, "req-u2", depsFor(store));
    expect(res.code).toBe(400);
    expect(upsertValue).not.toHaveBeenCalled();
  });

  it("断尾半句描述 → 400", async () => {
    const { store } = mockStore();
    const res = await handleCoreMemoryValuesUpsert({ ...BASE, attrs: { description: "证据裁决一切，" } }, {} as never, "req-u3", depsFor(store));
    expect(res.code).toBe(400);
  });

  it("超 80 字描述 → 400（合同上限）", async () => {
    const { store } = mockStore();
    const long = "证".repeat(81) + "。";
    const res = await handleCoreMemoryValuesUpsert({ ...BASE, attrs: { description: long } }, {} as never, "req-u4", depsFor(store));
    expect(res.code).toBe(400);
  });

  it("description + role 组合 → 各自消毒后合并落库", async () => {
    const { store, upsertValue } = mockStore();
    const res = await handleCoreMemoryValuesUpsert({ ...BASE, attrs: { role: "家人", description: "需要持续陪伴的家庭核心。" } }, {} as never, "req-u5", depsFor(store));
    expect(res.code).toBe(0);
    expect(upsertValue).toHaveBeenCalledWith("knot-upsert", "增量对账", 0.5, "agent", expect.anything(), undefined, undefined, undefined, { role: "家人", description: "需要持续陪伴的家庭核心。" });
  });
});
