/**
 * #179 接线层合同：provider 单请求输入上限（doubao-embedding-vision 实测 max 10）
 * —— 超限必须分片，否则整个名次尺/地板在生产恒 bypass（2026-11-02 实测 HTTP 400）。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseConfig } from "../../../../config.js";
import type { EmbeddingService } from "../../../store/embedding.js";
import { clearEmbeddingCache, embeddingCacheSize, runInjectionSelection } from "../injection-wiring.js";

function fakeSvc(callSizes: number[]): EmbeddingService {
  return {
    embed: async () => new Float32Array([1, 0, 0]),
    embedBatch: async (texts: string[]) => {
      callSizes.push(texts.length);
      return texts.map(() => new Float32Array([1, 0, 0]));
    },
    getDimensions: () => 3,
    getProviderInfo: () => ({ provider: "fake", model: "fake-embed" }),
    isReady: () => true,
    startWarmup: () => {
      /* noop */
    },
    close: async () => {
      /* noop */
    },
  } as unknown as EmbeddingService;
}

const lines = Array.from({ length: 12 }, (_, i) => `- [episodic|s] 行 ${i}`);

describe("#179 接线：embedding 单请求分片", () => {
  it("12 行 + 查询 → 分片到每请求 ≤10 条，且每条候选都拿到 scoreQ", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sel-wiring-"));
    const sizes: number[] = [];
    try {
      const out = await runInjectionSelection({
        lines,
        query: "采购单据",
        cfg: parseConfig({ recall: { layerRuler: { mode: "shadow", keepRatio: 1, minPerLayer: 1, floor: null } } })
          .recall,
        pluginDataDir: dataDir,
        embeddingService: fakeSvc(sizes),
      });
      expect(Math.max(...sizes)).toBeLessThanOrEqual(10);
      expect(sizes.reduce((a, b) => a + b, 0)).toBe(lines.length + 1);
      expect(out.ruler.bypass).toBeUndefined();
      const scored = out.candidates.lines.filter((l) => typeof l.scoreQ === "number");
      expect(scored.length).toBe(lines.length);
      expect(out.lines).toEqual(lines); // shadow：不裁剪
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("#179 接线：嵌入内容寻址缓存（跨轮复用，压 300ms 预算）", () => {
  const small = ["- [conclusion|s] 甲", "- [work_fact|s] 乙", "- [episodic|s] 丙"];

  function cfg() {
    return parseConfig({ recall: { layerRuler: { mode: "shadow", keepRatio: 1, minPerLayer: 1, floor: null } } })
      .recall;
  }

  it("同一批行 + 同一查询重复出现 → 第二轮零请求（全部命中缓存）", async () => {
    clearEmbeddingCache();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sel-cache-"));
    const sizes: number[] = [];
    const svc = fakeSvc(sizes);
    try {
      await runInjectionSelection({
        lines: small,
        query: "采购单据",
        cfg: cfg(),
        pluginDataDir: dataDir,
        embeddingService: svc,
      });
      expect(sizes.reduce((a, b) => a + b, 0)).toBe(small.length + 1);
      expect(embeddingCacheSize()).toBe(small.length + 1); // 查询 + 每行各一条
      sizes.length = 0;

      const out = await runInjectionSelection({
        lines: small,
        query: "采购单据",
        cfg: cfg(),
        pluginDataDir: dataDir,
        embeddingService: svc,
      });
      expect(sizes.reduce((a, b) => a + b, 0)).toBe(0);
      expect(out.candidates.lines.every((l) => typeof l.scoreQ === "number")).toBe(true);
      expect(out.ruler.bypass).toBeUndefined();
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
      clearEmbeddingCache();
    }
  });

  it("出现新行时只嵌新增内容（已缓存的不重复请求）", async () => {
    clearEmbeddingCache();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sel-cache-"));
    const sizes: number[] = [];
    const svc = fakeSvc(sizes);
    try {
      await runInjectionSelection({
        lines: small,
        query: "采购单据",
        cfg: cfg(),
        pluginDataDir: dataDir,
        embeddingService: svc,
      });
      sizes.length = 0;

      await runInjectionSelection({
        lines: [...small, "- [persona|s] 丁"],
        query: "采购单据",
        cfg: cfg(),
        pluginDataDir: dataDir,
        embeddingService: svc,
      });
      expect(sizes.reduce((a, b) => a + b, 0)).toBe(1);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
      clearEmbeddingCache();
    }
  });
});
