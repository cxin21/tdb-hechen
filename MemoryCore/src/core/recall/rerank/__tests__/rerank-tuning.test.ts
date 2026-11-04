/**
 * 本地精排推理参数与硬预算（2026-11-04）。
 *
 * 为什么钉这些数：2026-11-03/04 两次 rerank-on 完整臂撞 60s recall timeout，
 * 根因是「32 候选 × 生产行长 × 1 线程」≈4.5s/题 + 旧 `inferTimeoutMs=30_000` 假死窗口。
 * 实测（16 核 / onnxruntime-node q8 / bge-reranker-base）：
 * - 32 候选 × 400 字符：1 线程 3257ms、**2 线程 1939ms**、4 线程 3245ms、8 线程 3850ms；
 * - 单条长度 200/400/800/1200/2000 字符 = 1680/3441/6546/7770/6816ms（≥1200 撞 512-token 截断）；
 * - batch 推理无收益（400 字符 3564ms vs 单条 3175ms）→ 不采用。
 *
 * 用例锁的是「缺省即最优」：生产不配任何键也该拿到 2 线程 / 320 字符 / 4s 硬预算。
 */
import { describe, expect, it } from "vitest";

import { buildRerankWorkerData } from "../local.js";
import {
  DEFAULT_RERANK_DOC_CAP,
  DEFAULT_RERANK_INFER_TIMEOUT_MS,
  DEFAULT_RERANK_THREADS,
  resolveRerankInferTimeoutMs,
  resolveRerankTuning,
} from "../tuning.js";

describe("rerank tuning：实测最优点必须是代码缺省（零配置）", () => {
  it("① 常量 = 实测最优：threads 2 / docCap 320 / 硬预算 6s（争抢实测 3.81s 的 1.57×）", () => {
    expect(DEFAULT_RERANK_THREADS).toBe(2);
    expect(DEFAULT_RERANK_DOC_CAP).toBe(320);
    expect(DEFAULT_RERANK_INFER_TIMEOUT_MS).toBe(6000);
  });

  it("② 空 env → 缺省值（生产不配任何键即最优点）", () => {
    expect(resolveRerankTuning({})).toEqual({ threads: 2, docCap: 320 });
    expect(resolveRerankInferTimeoutMs({})).toBe(6000);
  });

  it("③ env 可覆盖（只给 A/B 与故障复现用）", () => {
    expect(resolveRerankTuning({ RERANK_THREADS: "1", RERANK_DOC_CAP: "0" })).toEqual({
      threads: 1,
      docCap: 320, // 0/非正 → 回落缺省，而不是「关闭截断」
    });
    expect(resolveRerankTuning({ RERANK_THREADS: "8", RERANK_DOC_CAP: "512" })).toEqual({ threads: 8, docCap: 512 });
    expect(resolveRerankInferTimeoutMs({ TDAI_RERANK_INFER_TIMEOUT_MS: "120000" })).toBe(120000);
  });

  it("④ 脏值回落缺省（abc / 负数 / 0 / 空串 不得变成 0 线程或 0 预算）", () => {
    expect(resolveRerankTuning({ RERANK_THREADS: "abc", RERANK_DOC_CAP: "-5" })).toEqual({ threads: 2, docCap: 320 });
    expect(resolveRerankTuning({ RERANK_THREADS: "0", RERANK_DOC_CAP: "" })).toEqual({ threads: 2, docCap: 320 });
    expect(resolveRerankInferTimeoutMs({ TDAI_RERANK_INFER_TIMEOUT_MS: "0" })).toBe(6000);
    expect(resolveRerankInferTimeoutMs({ TDAI_RERANK_INFER_TIMEOUT_MS: "NaN" })).toBe(6000);
  });

  it("⑤ worker 启动数据携带 tuning（worker 侧不再自带第二份缺省）", () => {
    expect(buildRerankWorkerData({ modelDir: "/m/bge" })).toEqual({
      modelDir: "/m/bge",
      transformersEntryUrl: undefined,
      tuning: { threads: 2, docCap: 320 },
    });
    expect(buildRerankWorkerData({ modelDir: "/m/bge", tuning: { threads: 1, docCap: 128 } }).tuning).toEqual({
      threads: 1,
      docCap: 128,
    });
  });
});
