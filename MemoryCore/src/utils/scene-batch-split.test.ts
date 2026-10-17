/**
 * #46 毒批拆分+批次上限（scene 抽取螺旋修复，用户拍板 A 方案）：
 * - estimateSceneMemoriesChars：镜像 scene-extractor.ts:259-267 memoriesJson 构造估长；
 * - splitMemoriesByChars：按估长贪心分批（单条超限独占一批）；maxChars<=0 = 关（单批）；
 * - extractSceneBatches：chars 预分批 × 毒批对半递归（镜像 pipeline-factory.ts:603-669
 *   extractGroupWithSplit 先例：单条失败让步、部分成功产出保留、聚合语义同 L1）。
 * config-first：batchMaxChars<=0 且 poisonSplit=false ⇒ 单调用原样透传（逐位现状）。
 */
import { describe, expect, it } from "vitest";
import {
  estimateSceneMemoriesChars,
  extractSceneBatches,
  splitMemoriesByChars,
  type SceneExtractOutcome,
  type SceneMemoryInput,
} from "./scene-batch-split.js";

const rec = (id: string, contentLen: number): SceneMemoryInput => ({
  id,
  created_at: "2026-10-17T00:00:00Z",
  content: "字".repeat(contentLen),
});
type FakeResult = SceneExtractOutcome;
const ok = (n: number, files: string[] = []): FakeResult => ({
  success: true,
  memoriesProcessed: n,
  changedSceneFiles: files,
});
const fail = (msg = "boom"): FakeResult => ({ success: false, memoriesProcessed: 0, error: msg });

describe("estimateSceneMemoriesChars（#46 批次上限估长）", () => {
  it("与 scene-extractor memoriesJson 构造逐位一致（id ?? \"\" 回退）", () => {
    const memories = [rec("a", 10), { created_at: "2026-10-17T00:00:00Z", content: "无 id" }];
    expect(estimateSceneMemoriesChars(memories)).toBe(
      JSON.stringify(
        memories.map((m) => ({ content: m.content, created_at: m.created_at, id: m.id ?? "" })),
        null,
        2,
      ).length,
    );
  });

  it("空输入估长=2（\"[]\"）", () => {
    expect(estimateSceneMemoriesChars([])).toBe(2);
  });
});

describe("splitMemoriesByChars（#46 批次上限贪心分批）", () => {
  it("maxChars<=0 ⇒ 单批返回（关语义）", () => {
    const memories = [rec("a", 5), rec("b", 5)];
    expect(splitMemoriesByChars(memories, 0)).toEqual([memories]);
    expect(splitMemoriesByChars(memories, -1)).toEqual([memories]);
  });

  it("按估长贪心分批：每批 ≤ 阈值、顺序保持、零丢失", () => {
    const memories = [rec("a", 100), rec("b", 100), rec("c", 100), rec("d", 100)];
    const chunks = splitMemoriesByChars(memories, 400);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const c of chunks) expect(estimateSceneMemoriesChars(c)).toBeLessThanOrEqual(400);
    expect(chunks.flat().map((m) => m.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("单条超限独占一批（不丢、不切单条）", () => {
    const memories = [rec("big", 1000), rec("s", 1)];
    const chunks = splitMemoriesByChars(memories, 100);
    expect(chunks.length).toBe(2);
    expect(chunks.flat().map((m) => m.id)).toEqual(["big", "s"]);
  });
});

describe("extractSceneBatches（#46 预分批 × 毒批对半递归）", () => {
  it("缺省关：单调用原样透传（含额外字段）", async () => {
    const memories = [rec("a", 1), rec("b", 1)];
    const calls: string[][] = [];
    const sentinel: FakeResult = { success: true, memoriesProcessed: 2 };
    const r = await extractSceneBatches({
      extract: async (ms) => {
        calls.push(ms.map((m) => m.id!));
        return sentinel;
      },
      memories,
    });
    expect(calls).toEqual([["a", "b"]]);
    expect(r).toBe(sentinel);
  });

  it("空输入 ⇒ 仍单调用 extract([])（现状）", async () => {
    const calls: string[][] = [];
    await extractSceneBatches({
      extract: async (ms) => {
        calls.push(ms.map((m) => m.id!));
        return ok(0);
      },
      memories: [] as SceneMemoryInput[],
    });
    expect(calls).toEqual([[]]);
  });

  it("空输入+批次上限开启 ⇒ 仍单调用 extract([])（batches.length===0 守卫）", async () => {
    const calls: string[][] = [];
    const r = await extractSceneBatches({
      extract: async (ms) => {
        calls.push(ms.map((m) => m.id!));
        return ok(0);
      },
      memories: [] as SceneMemoryInput[],
      batchMaxChars: 400,
    });
    expect(calls).toEqual([[]]);
    expect(r.success).toBe(true);
  });

  it("毒批拆分：4 条失败→对半 [2,2] 成功（first→second 顺序，聚合成功）", async () => {
    const memories = [rec("a", 1), rec("b", 1), rec("c", 1), rec("d", 1)];
    const calls: string[][] = [];
    const r = await extractSceneBatches({
      extract: async (ms) => {
        calls.push(ms.map((m) => m.id!));
        return ms.length >= 4 ? fail() : ok(ms.length, [`s${ms.length}.md`]);
      },
      memories,
      poisonSplit: true,
    });
    expect(calls).toEqual([["a", "b", "c", "d"], ["a", "b"], ["c", "d"]]);
    expect(r.success).toBe(true);
    expect(r.memoriesProcessed).toBe(4);
    expect(r.changedSceneFiles).toEqual(["s2.md", "s2.md"]);
  });

  it("毒批关闭：失败原样返回，仅一次调用", async () => {
    const calls: string[][] = [];
    const r = await extractSceneBatches({
      extract: async (ms) => {
        calls.push(ms.map((m) => m.id!));
        return fail();
      },
      memories: [rec("a", 1), rec("b", 1)],
    });
    expect(calls.length).toBe(1);
    expect(r.success).toBe(false);
    expect(r.error).toBe("boom");
  });

  it("单条失败=让步：原样返回失败（游标/requeue 语义交上层）", async () => {
    const calls: string[][] = [];
    const r = await extractSceneBatches({
      extract: async (ms) => {
        calls.push(ms.map((m) => m.id!));
        return fail();
      },
      memories: [rec("a", 1)],
      poisonSplit: true,
    });
    expect(calls).toEqual([["a"]]);
    expect(r.success).toBe(false);
  });

  it("部分成功：首半成功+次半失败 ⇒ success=false、计数保留（L1 先例语义）", async () => {
    const calls: string[][] = [];
    const r = await extractSceneBatches({
      extract: async (ms) => {
        calls.push(ms.map((m) => m.id!));
        return ms.length === 2 ? ok(2) : fail();
      },
      memories: [rec("a", 1), rec("b", 1), rec("c", 1)],
      poisonSplit: true,
    });
    // mid=floor(3/2)=1（镜像 L1 :658）：首半 [a] 单条、次半 [b,c]
    expect(calls).toEqual([["a", "b", "c"], ["a"], ["b", "c"]]);
    expect(r.success).toBe(false);
    expect(r.memoriesProcessed).toBe(2);
  });

  it("拆分时经 warnLog 告警（工厂 logger 接线点）", async () => {
    const warns: string[] = [];
    await extractSceneBatches({
      extract: async (ms) => (ms.length >= 4 ? fail() : ok(ms.length)),
      memories: [rec("a", 1), rec("b", 1), rec("c", 1), rec("d", 1)],
      poisonSplit: true,
      warnLog: (m) => warns.push(m),
    });
    expect(warns.length).toBe(1);
    expect(warns[0]).toContain("poison-batch guard");
  });

  it("批次上限：多批顺序抽取，聚合成功+顺序零丢失", async () => {
    const memories = Array.from({ length: 8 }, (_, i) => rec(`m${i}`, 100));
    const calls: string[][] = [];
    const r = await extractSceneBatches({
      extract: async (ms) => {
        calls.push(ms.map((m) => m.id!));
        return ok(ms.length);
      },
      memories,
      batchMaxChars: 400,
    });
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.flat()).toEqual(memories.map((m) => m.id!));
    expect(r.success).toBe(true);
    expect(r.memoriesProcessed).toBe(8);
  });

  it("批次上限+毒批叠加：计划批(4)失败→批内对半(2+2)重试救回", async () => {
    const memories = Array.from({ length: 12 }, (_, i) => rec(`m${i}`, 100));
    const calls: string[][] = [];
    const r = await extractSceneBatches({
      extract: async (ms) => {
        calls.push(ms.map((m) => m.id!));
        return ms.length > 2 ? fail() : ok(ms.length);
      },
      memories,
      batchMaxChars: 800,
      poisonSplit: true,
    });
    // 计划批 4 条（估长~741≤800）→ 每批毒批对半 2+2 全部救回：3 计划批 × [4,2,2]
    expect(calls.length).toBe(9);
    expect(calls.filter((c) => c.length === 4).length).toBe(3);
    expect(calls.filter((c) => c.length === 2).length).toBe(6);
    expect(r.success).toBe(true);
    expect(r.memoriesProcessed).toBe(12);
  });

  it("跨批聚合：error=首个失败；失败批后其余批仍尝试（镜像 L1 继续语义）", async () => {
    const memories = [rec("a", 100), rec("b", 100), rec("c", 100)];
    const calls: string[][] = [];
    const r = await extractSceneBatches({
      extract: async (ms) => {
        calls.push(ms.map((m) => m.id!));
        return ms[0]!.id === "b" ? fail("mid") : ok(ms.length, [`f${ms[0]!.id}`]);
      },
      memories,
      batchMaxChars: 1,
    });
    expect(calls).toEqual([["a"], ["b"], ["c"]]);
    expect(r.success).toBe(false);
    expect(r.memoriesProcessed).toBe(2);
    expect(r.error).toBe("mid");
    expect(r.changedSceneFiles).toEqual(["fa", "fc"]);
  });

  it("跨批聚合：emptyExtraction/noOpIntegrated 全真才真", async () => {
    const memories = [rec("a", 1), rec("b", 1)];
    const r1 = await extractSceneBatches({
      extract: async () => ({ success: true, memoriesProcessed: 1, emptyExtraction: true, noOpIntegrated: true }),
      memories,
      batchMaxChars: 1,
    });
    expect(r1.emptyExtraction).toBe(true);
    expect(r1.noOpIntegrated).toBe(true);
    const r2 = await extractSceneBatches({
      extract: async (ms) =>
        ms[0]!.id === "a"
          ? { success: true, memoriesProcessed: 1, emptyExtraction: true, noOpIntegrated: true }
          : { success: true, memoriesProcessed: 1, emptyExtraction: false, noOpIntegrated: false },
      memories,
      batchMaxChars: 1,
    });
    expect(r2.emptyExtraction).toBe(false);
    expect(r2.noOpIntegrated).toBe(false);
  });
});
