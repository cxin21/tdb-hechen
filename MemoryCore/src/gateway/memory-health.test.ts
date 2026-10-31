/**
 * EMBED-BACKFILL R2-2（口径根治）：buildMemoryHealth vectorCoverage 条数口径测试。
 * 旧行为=vecRows(向量行数,多 chunk 虚增)/metaRows——补齐后 1.197、部分覆盖时高估。
 * 新行为=coveredRows(有向量 L1 条数)/metaRows——恒 ≤1。
 */
import { describe, it, expect } from "vitest";
import { buildMemoryHealth, type MemoryHealthStats } from "./server.js";

function mkStats(over: Partial<MemoryHealthStats> = {}): MemoryHealthStats {
  return {
    vecRows: 0,
    metaRows: 0,
    coveredRows: 0,
    lastVecWriteAt: null,
    embeddingStatus: "ok",
    degradedSince: null,
    // 缺省=真 provider + 探针 ok（旧用例意图；#123 字段见下方 T5-T8）
    embeddingProvider: "local",
    embeddingConfigured: true,
    ...over,
  } as MemoryHealthStats;
}

describe("buildMemoryHealth（vectorCoverage 条数口径）", () => {
  it("T1 半覆盖：coveredRows=2 metaRows=4 → 0.5（不受 vecRows 影响）", () => {
    const r = buildMemoryHealth(mkStats({ vecRows: 5, metaRows: 4, coveredRows: 2 }));
    expect(r.vectorCoverage).toBeCloseTo(0.5);
  });

  it("T2 全覆盖=1.0；多 chunk 场景 vecRows>metaRows 也不超 1", () => {
    const r = buildMemoryHealth(mkStats({ vecRows: 1124, metaRows: 938, coveredRows: 938 }));
    expect(r.vectorCoverage).toBe(1);
  });

  it("T3 空库：metaRows=0 → 0（除零保护）", () => {
    const r = buildMemoryHealth(mkStats({ vecRows: 0, metaRows: 0, coveredRows: 0 }));
    expect(r.vectorCoverage).toBe(0);
  });

  it("T4 信息字段透传：vecRows/metaRows 原始计数保留", () => {
    const r = buildMemoryHealth(mkStats({ vecRows: 7, metaRows: 10, coveredRows: 6 }));
    expect(r.vecRows).toBe(7);
    expect(r.metaRows).toBe(10);
  });
});

/**
 * #123（P0 静默空转）：payload 必须透出 provider/configured，且 noop / 未配置时不能报 ok。
 * 旧行为：embedding 直接透传探针状态，而 noop embedder 让探针恒 ok + 未配置时探针直接 return
 * ⇒ Panel 侧 health-utils 只看 embedding==='ok' 恒绿（false-green）。
 */
describe("buildMemoryHealth（#123 embedding 判活降档）", () => {
  it("T5 真 provider + 探针 ok → ok（不误降档）", () => {
    const r = buildMemoryHealth(mkStats({ embeddingProvider: "openai", embeddingConfigured: true }));
    expect(r.embedding).toBe("ok");
    expect(r.embeddingProvider).toBe("openai");
    expect(r.embeddingConfigured).toBe(true);
  });

  it("T6 provider='noop' → degraded（即使探针 status=ok —— Noop embed() 恒不抛错）", () => {
    const r = buildMemoryHealth(
      mkStats({ embeddingProvider: "noop", embeddingConfigured: false, embeddingStatus: "ok" }),
    );
    expect(r.embedding).toBe("degraded");
    expect(r.embeddingProvider).toBe("noop");
    expect(r.embeddingConfigured).toBe(false);
  });

  it("T7 未配置（provider=null / configured=false）→ degraded，不再是缺省 ok", () => {
    const r = buildMemoryHealth(
      mkStats({ embeddingProvider: null, embeddingConfigured: false, embeddingStatus: "ok" }),
    );
    expect(r.embedding).toBe("degraded");
    expect(r.embeddingProvider).toBeNull();
    expect(r.embeddingConfigured).toBe(false);
  });

  it("T8 探针失败（probe-failed）→ degraded，degradedSince 透传", () => {
    const since = "2026-10-31T10:00:00.000Z";
    const r = buildMemoryHealth(mkStats({ embeddingStatus: "degraded", degradedSince: since }));
    expect(r.embedding).toBe("degraded");
    expect(r.degradedSince).toBe(since);
  });
});
