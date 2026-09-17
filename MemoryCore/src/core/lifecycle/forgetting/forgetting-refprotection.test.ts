/**
 * P2 Task 5（spec §5 F14）：遗忘保护——forget 候选排除 coreRefs/personRefs/identityRefs
 * 指向仍 active 锚/现行身份事实的记录；排除前重验 refs 有效性（悬空不保护——防永生记忆）。
 */
import { describe, it, expect, vi } from "vitest";
import { runForgetting } from "./forgetting-worker.js";
import { isRefProtected, DEFAULT_FORGETTING_CONFIG } from "./scorer.js";

const ANCHOR_NAMES = new Set(["数据隐私", "女儿", "闺女"]);
const IDENTITY_SLICES = new Set(["用户每周日陪女儿去图书馆"]);

function rec(id: string, refs: Record<string, unknown> = {}) {
  return { id, record_id: id, priority: 0, metadata: refs, timestamps: ["2026-01-01T00:00:00Z"], certainty: "observed", content: "x" };
}

describe("isRefProtected 判定（F14 refs 重验）", () => {
  it("coreRefs 命中 active 锚 → true", () => {
    expect(isRefProtected({ coreRefs: ["数据隐私"] }, ANCHOR_NAMES, IDENTITY_SLICES)).toBe(true);
  });
  it("personRefs 命中 person alias（闺女）→ true", () => {
    expect(isRefProtected({ personRefs: ["闺女"] }, ANCHOR_NAMES, IDENTITY_SLICES)).toBe(true);
  });
  it("悬空 refs（锚已退休=不在 active 集）→ false", () => {
    expect(isRefProtected({ coreRefs: ["已被退休的锚"] }, ANCHOR_NAMES, IDENTITY_SLICES)).toBe(false);
  });
  it("identityRefs 命中现行事实切片 → true；事实已被修订替换（不在切片集）→ false", () => {
    expect(isRefProtected({ identityRefs: ["用户每周日陪女儿去图书馆"] }, ANCHOR_NAMES, IDENTITY_SLICES)).toBe(true);
    expect(isRefProtected({ identityRefs: ["用户已被修订掉的旧事实"] }, ANCHOR_NAMES, IDENTITY_SLICES)).toBe(false);
  });
  it("无 refs/坏 metadata → false", () => {
    expect(isRefProtected({}, ANCHOR_NAMES, IDENTITY_SLICES)).toBe(false);
    expect(isRefProtected(null, ANCHOR_NAMES, IDENTITY_SLICES)).toBe(false);
    expect(isRefProtected("oops", ANCHOR_NAMES, IDENTITY_SLICES)).toBe(false);
  });
});

describe("worker 集成（refProtection）", () => {
  function makeRows() {
    return [
      rec("prot-core", { coreRefs: ["数据隐私"] }),
      rec("prot-person", { personRefs: ["闺女"] }),
      rec("prot-identity", { identityRefs: ["用户每周日陪女儿去图书馆"] }),
      rec("dangling-core", { coreRefs: ["已退休锚"] }),
      rec("dangling-identity", { identityRefs: ["已被替换的旧事实"] }),
      rec("no-refs"),
    ];
  }
  function makeStore() {
    return {
      listValues: async () => [
        // listValues 契约=仅 active（已退休锚不在保护名集 → 悬空 refs 不保护）
        { value_id: "v1", label: "数据隐私", weight: 0.5, node_type: "theme", attrs_json: "{}" },
        { value_id: "v2", label: "女儿", weight: 0.6, node_type: "person", attrs_json: '{"role":"家人","aliases":["闺女"]}' },
      ],
      archiveL1: vi.fn(() => true),
      readCore: async () => [{ slot: "identity", content: "- 用户每周日陪女儿去图书馆" }],
    };
  }

  it("refProtection=true：受保护记录不归档；悬空/无 refs 照常归档", async () => {
    const store = makeStore();
    const res = await runForgetting({
      queryL1: () => makeRows(),
      config: { ...DEFAULT_FORGETTING_CONFIG, refProtection: true },
      store: store as never,
      identitySlices: ["用户每周日陪女儿去图书馆"],
    });
    expect(res.candidates.sort()).toEqual(["dangling-core", "dangling-identity", "no-refs"]);
    expect((store as unknown as { archiveL1: ReturnType<typeof vi.fn> }).archiveL1).toHaveBeenCalledTimes(3);
  });

  it("refProtection 缺省 false = 逐位现状（受保护记录也归档）", async () => {
    const store = makeStore();
    const res = await runForgetting({
      queryL1: () => makeRows(),
      store: store as never,
    });
    expect(res.candidates.length).toBe(6);
  });
});
