/**
 * #52 P4 采纳侧 pending 清扫单元测试（pending-adopt-sweep.ts）。
 *
 * 合同：
 * 1. core_value：label 归一（trim+lowercase）相等判重——生产实证 label sim=1.000 而
 *    正文 Jaccard 仅 0.107（措辞差异），label 才是锚身份；其他 slot 不比对。
 * 2. strict_rule：合并后槽全文逐行作比对域，行级 bigram Jaccard ≥ 0.75 判重
 *    （复用 proposal-dedup 生产标定阈值）。
 * 3. 执行=rejected best-effort；decide 返回 null（并发已处置）不入结果；
 *    list/decide 抛错→warn+空数组（非致命，采纳主流程不受影响）。
 * 4. store 缺方法（feature-detect 失败）→ 零清扫；swept>0 记 info 一条。
 */
import { describe, expect, it, vi } from "vitest";
import { sweepPendingDuplicatesAfterAdopt } from "../pending-adopt-sweep.js";

const CT = { teamId: "t1", userId: "u1", agentId: "a1" };

function makeStore(rows: Array<Record<string, unknown>>, decideImpl?: (pendingId: string) => Record<string, unknown> | null) {
  return {
    listPendingCore: vi.fn(async () => rows),
    decidePendingCore: vi.fn(async (pendingId: string) => (decideImpl ? decideImpl(pendingId) : { slot: "x", content: "y" })),
  };
}

describe("#52 P4 sweepPendingDuplicatesAfterAdopt", () => {
  it("core_value：label 归一相等（trim+lowercase）→ 同族 pending 自动 rejected", async () => {
    const store = makeStore([
      { pending_id: "pd-1", slot: "core_value", content: "先取证再下结论：……证据不足不擅动。", label: " 取证先行 " },
      { pending_id: "pd-2", slot: "core_value", content: "措辞完全不同的另一提案。", label: "其他锚" },
      { pending_id: "pd-3", slot: "strict_rule", content: "- 不该被 core_value 清扫波及。", label: "取证先行" },
    ]);
    const swept = await sweepPendingDuplicatesAfterAdopt({ store: store as never, tenant: CT, slot: "core_value", adoptedLabel: "取证先行" });
    expect(swept).toEqual([{ pendingId: "pd-1", slot: "core_value", reason: expect.stringContaining("duplicate of adopted anchor label") }]);
    expect(store.decidePendingCore).toHaveBeenCalledWith("pd-1", "rejected", CT);
    expect(store.decidePendingCore).not.toHaveBeenCalledWith("pd-2", expect.anything(), expect.anything());
  });

  it("core_value：adoptedLabel 缺省/空白 → 零清扫（宁漏勿错杀）", async () => {
    const store = makeStore([{ pending_id: "pd-1", slot: "core_value", content: "x", label: "y" }]);
    expect(await sweepPendingDuplicatesAfterAdopt({ store: store as never, tenant: CT, slot: "core_value" })).toEqual([]);
    expect(await sweepPendingDuplicatesAfterAdopt({ store: store as never, tenant: CT, slot: "core_value", adoptedLabel: "   " })).toEqual([]);
    expect(store.decidePendingCore).not.toHaveBeenCalled();
  });

  it("strict_rule：行级 Jaccard ≥0.75 判重（同义换措辞提案）；低相似提案保留", async () => {
    const merged = [
      "排查期间绝不可通过任何路径删除记忆（P1红线），也绝不可注入测试对话，以免测试数据永久污染l1_records。",
      "无论排查还是运维操作，对记忆库零删除、零注入。",
    ].join("\n");
    const store = makeStore([
      { pending_id: "pd-a", slot: "strict_rule", content: "排查期间绝不可通过任何路径删除记忆（P1红线），也绝不可注入测试对话，以免测试数据永久污染l1记录。" },
      { pending_id: "pd-b", slot: "strict_rule", content: "测试一律走临时目录（临时 SQLite），绝不触碰生产数据与真实记忆库。" },
    ]);
    const swept = await sweepPendingDuplicatesAfterAdopt({ store: store as never, tenant: CT, slot: "strict_rule", mergedContent: merged });
    expect(swept.map((s) => s.pendingId)).toEqual(["pd-a"]);
    expect(swept[0].reason).toContain("line-similar");
  });

  it("strict_rule：mergedContent 缺省/全空行 → 零清扫", async () => {
    const store = makeStore([{ pending_id: "pd-a", slot: "strict_rule", content: "x" }]);
    expect(await sweepPendingDuplicatesAfterAdopt({ store: store as never, tenant: CT, slot: "strict_rule" })).toEqual([]);
    expect(await sweepPendingDuplicatesAfterAdopt({ store: store as never, tenant: CT, slot: "strict_rule", mergedContent: " \n \n" })).toEqual([]);
    expect(store.decidePendingCore).not.toHaveBeenCalled();
  });

  it("adoptedPendingId 跳过：刚采纳行不在清扫域（防重决=幂等底线，mock/竞态防御）", async () => {
    const store = makeStore([{ pending_id: "pd-1", slot: "core_value", content: "x", label: "取证先行" }]);
    const swept = await sweepPendingDuplicatesAfterAdopt({ store: store as never, tenant: CT, slot: "core_value", adoptedLabel: "取证先行", adoptedPendingId: "pd-1" });
    expect(swept).toEqual([]);
    expect(store.decidePendingCore).not.toHaveBeenCalled();
  });

  it("decide 返回 null（并发已处置）不入结果；swept>0 记 info", async () => {
    const store = makeStore([{ pending_id: "pd-1", slot: "core_value", content: "x", label: "取证先行" }], () => null);
    const info = vi.fn();
    const swept = await sweepPendingDuplicatesAfterAdopt({ store: store as never, tenant: CT, slot: "core_value", adoptedLabel: "取证先行", logger: { info } as never });
    expect(swept).toEqual([]);
    expect(info).not.toHaveBeenCalled();
  });

  it("swept>0 → logger.info 一条（含 slot 与 swept 计数）", async () => {
    const store = makeStore([{ pending_id: "pd-1", slot: "core_value", content: "x", label: "取证先行" }]);
    const info = vi.fn();
    await sweepPendingDuplicatesAfterAdopt({ store: store as never, tenant: CT, slot: "core_value", adoptedLabel: "取证先行", logger: { info } as never });
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0][0])).toContain("slot=core_value swept=1");
  });

  it("listPendingCore 抛错 → warn+空数组（非致命）；store 缺方法 → 零清扫", async () => {
    const broken = { listPendingCore: vi.fn(async () => { throw new Error("db down"); }), decidePendingCore: vi.fn() };
    const warn = vi.fn();
    expect(await sweepPendingDuplicatesAfterAdopt({ store: broken as never, tenant: CT, slot: "core_value", adoptedLabel: "x", logger: { warn } as never })).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("non-fatal");
    expect(await sweepPendingDuplicatesAfterAdopt({ store: {} as never, tenant: CT, slot: "core_value", adoptedLabel: "x" })).toEqual([]);
  });
});
