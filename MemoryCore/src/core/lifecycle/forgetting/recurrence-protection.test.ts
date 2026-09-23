/**
 * D-4（2026-09-22 拍板）：遗忘保护钩子测试（forgetting-worker recurrenceProtection）。
 * RED 先行：cfg 键缺失=逐位现状（受周期保护记录也归档）；true=排除候选。
 * 镜像 forgetting-refprotection.test.ts 的 deps 构造。
 */
import { describe, it, expect, vi } from "vitest";
import { runForgetting } from "./forgetting-worker.js";
import { DEFAULT_FORGETTING_CONFIG } from "./scorer.js";

function rec(id: string, meta: Record<string, unknown> = {}) {
  return { id, record_id: id, priority: 0, metadata: meta, timestamps: ["2026-01-01T00:00:00Z"], certainty: "observed", content: "x" };
}

const REC_META = { recurrence: { cadence: "weekly", anchor: "WED", note: "每周三例会" } };
const REC_META_BAD = { recurrence: { cadence: "weekly", note: "缺锚" } };

describe("runForgetting recurrenceProtection（D-4 拍板 2）", () => {
  function makeRows() {
    return [
      rec("prot-rec", REC_META),
      rec("bad-shape", REC_META_BAD),
      rec("no-rec"),
    ];
  }
  function makeStore() {
    return {
      listValues: async () => [],
      archiveL1: vi.fn(() => true),
      readCore: async () => [],
    };
  }

  it("recurrenceProtection=true：合法形状不归档；非法形状/无 recurrence 照常归档", async () => {
    const store = makeStore();
    const res = await runForgetting({
      queryL1: () => makeRows(),
      config: { ...DEFAULT_FORGETTING_CONFIG, recurrenceProtection: true },
      store: store as never,
    });
    expect(res.candidates.sort()).toEqual(["bad-shape", "no-rec"]);
  });

  it("recurrenceProtection 缺省 false = 逐位现状（全部归档候选）", async () => {
    const store = makeStore();
    const res = await runForgetting({
      queryL1: () => makeRows(),
      store: store as never,
    });
    expect(res.candidates.length).toBe(3);
  });
});
