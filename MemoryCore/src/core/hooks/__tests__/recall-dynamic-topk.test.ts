/**
 * #54（2026-10-19）召回注入动态 topK —— RED 套件。
 *
 * 痛点：R7 经验层按固定条数（maxResults/预算切分）注入，对分数分布里的断崖
 * （top 强相关 vs 长尾弱相关）不感知 → 长尾弱相关占满注入预算、稀释下游注意力。
 *
 * 契约（dynamicTopKCount 确定性纯函数）：
 *   - 只缩不扩：返回值 ∈ [0, pool.length]（pool=scores 前 maxK 项）；
 *   - 刻度无关：纯相对落差判定（兼容 cosine ~0.x 与 RRF ~0.0x 两种刻度）；
 *   - span<=0（全同分/非降序）不切 = 逐位现状；空池返回 0；
 *   - elbow：候选切点 k ∈ [minTopK, pool.length-1]，落差 d(k)=pool[k-1]-pool[k]，
 *     k*=argmax（平手取最小 k=最先出现）；d(k*) ≥ dropRatio×(首分-末分) 才切，
 *     否则返回 pool.length（不切）。
 *   - config：recall.dynamicTopK{enabled,minTopK,dropRatio}，缺省 false=逐位现状。
 */
import { describe, expect, it } from "vitest";
import { dynamicTopKCount } from "../recall-dynamic-topk.js";
import { parseConfig } from "../../../config.js";

describe("#54 dynamicTopKCount（分数分布 elbow 纯函数）", () => {
  it("断崖处收缩：top 强相关与长尾弱相关之间的最大落差", () => {
    expect(dynamicTopKCount([0.9, 0.85, 0.4, 0.38, 0.36], 5)).toBe(2);
  });

  it("平滑缓降不切：无显著落差 → 全额（pool.length）", () => {
    expect(dynamicTopKCount([0.9, 0.88, 0.86, 0.84, 0.82], 5)).toBe(5);
  });

  it("minTopK 保底：断崖在首项后也不得低于保底条数", () => {
    expect(dynamicTopKCount([0.9, 0.1, 0.09, 0.08], 4)).toBe(2);
  });

  it("minTopK 抬高把切点顶到保底：断崖在首项后 + minTopK=3 → 注入 3", () => {
    expect(dynamicTopKCount([0.9, 0.1, 0.09, 0.08], 4, { minTopK: 3 })).toBe(3);
  });

  it("全同分（span<=0）不切", () => {
    expect(dynamicTopKCount([0.5, 0.5, 0.5, 0.5], 4)).toBe(4);
  });

  it("非降序（span<=0）不切：scores 与注入序不一致时不做假设", () => {
    expect(dynamicTopKCount([0.1, 0.9, 0.2], 3)).toBe(3);
  });

  it("空池返回 0；maxK=0 返回 0", () => {
    expect(dynamicTopKCount([], 5)).toBe(0);
    expect(dynamicTopKCount([0.9, 0.4], 0)).toBe(0);
  });

  it("pool 短于 maxK：按实际长度判定", () => {
    expect(dynamicTopKCount([0.9, 0.5, 0.4], 5)).toBe(2);
  });

  it("maxK 截池：断崖落在池内照常切（0.85→0.4 为最大落差）", () => {
    expect(dynamicTopKCount([0.9, 0.85, 0.4, 0.38, 0.36], 3)).toBe(2);
  });

  it("非有限分（NaN/±Inf）按 0 参与分布，不产生异常切点", () => {
    expect(dynamicTopKCount([0.9, 0.88, 0.4, Number.NaN], 4)).toBe(2);
  });

  it("刻度无关：RRF 小分量级同样生效", () => {
    expect(dynamicTopKCount([0.033, 0.032, 0.016, 0.016], 4)).toBe(2);
  });

  it("dropRatio 调门槛：默认 0.5 切，放宽 0.7 不切", () => {
    expect(dynamicTopKCount([0.8, 0.5, 0.3], 3)).toBe(2);
    expect(dynamicTopKCount([0.8, 0.5, 0.3], 3, { dropRatio: 0.7 })).toBe(3);
  });

  it("minTopK clamp 下限 1：显式 0/负值按 1（允许切到 1 条）", () => {
    expect(dynamicTopKCount([0.9, 0.1], 2, { minTopK: 0 })).toBe(1);
    expect(dynamicTopKCount([0.9, 0.1], 2, { minTopK: -3 })).toBe(1);
  });
});

describe("#54 config：recall.dynamicTopK 解析（缺省 false=逐位现状）", () => {
  it("缺省：enabled=false / minTopK=2 / dropRatio=0.5", () => {
    const cfg = parseConfig({ recall: { enabled: true } });
    expect(cfg.recall.dynamicTopK.enabled).toBe(false);
    expect(cfg.recall.dynamicTopK.minTopK).toBe(2);
    expect(cfg.recall.dynamicTopK.dropRatio).toBe(0.5);
  });

  it("显式开启：三键透传", () => {
    const cfg = parseConfig({ recall: { dynamicTopK: { enabled: true, minTopK: 5, dropRatio: 0.7 } } });
    expect(cfg.recall.dynamicTopK.enabled).toBe(true);
    expect(cfg.recall.dynamicTopK.minTopK).toBe(5);
    expect(cfg.recall.dynamicTopK.dropRatio).toBe(0.7);
  });

  it("clamp：minTopK [1,50]（先 floor）；dropRatio [0.01,1]", () => {
    const cfg = parseConfig({ recall: { dynamicTopK: { enabled: true, minTopK: -2, dropRatio: 0 } } });
    expect(cfg.recall.dynamicTopK.minTopK).toBe(1);
    expect(cfg.recall.dynamicTopK.dropRatio).toBe(0.01);
    const hi = parseConfig({ recall: { dynamicTopK: { enabled: true, minTopK: 99, dropRatio: 2 } } });
    expect(hi.recall.dynamicTopK.minTopK).toBe(50);
    expect(hi.recall.dynamicTopK.dropRatio).toBe(1);
  });
});

// ═══════════════ #54 接线 · auto-recall R7 经验层动态 topK（performAutoRecall 真链路 fake store） ═══════════════

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performAutoRecall } from "../auto-recall.js";
import type { IMemoryStore, L1SearchResult } from "../../store/types.js";
import type { EmbeddingService } from "../../store/embedding.js";

describe("#54 接线 · R7 经验层动态 topK（performAutoRecall 真链路）", () => {
  // 分数分布：top-2 强相关（0.9/0.85）+ 长尾弱相关（0.4/0.38/0.36）——elbow 在保留 2 条处。
  const SCORES54 = [0.9, 0.85, 0.4, 0.38, 0.36];
  const CONTENTS54 = [
    "索引设计评审完成：本次分片键选择结合热点访问路径的冲突概率评估与容量推演记录已全部归档备查（54-a）",
    "缓存策略压测报告定稿：命中率曲线在峰值并发下的衰减拐点与失效风暴应对开关已完成评审签发（54-b）",
    "回滚方案演练日志归档：双写切换与数据对账步骤全部通过验证，残留风险项已登记进跟进清单（54-c）",
    "监控告警阈值调整生效：分级通知策略与静默窗口的配置说明已写入运行手册并同步到值班表（54-d）",
    "容量推演专项收尾：读写配比与副本放置的最终参数已固化进部署清单并完成评审签字（54-e）",
  ];
  const row54 = (i: number): L1SearchResult =>
    ({
      record_id: "exp-" + (i + 1),
      content: CONTENTS54[i],
      type: "episodic",
      priority: 0,
      scene_name: "",
      score: SCORES54[i],
      timestamp_str: "", timestamp_start: "", timestamp_end: "",
      version: 1, session_key: "sk", session_id: "s",
      team_id: "t", task_id: "", user_id: "u", agent_id: "a",
      metadata_json: "",
    }) as L1SearchResult;
  const store54 = {
    isFtsAvailable: () => true,
    getCapabilities: () => ({ nativeHybridSearch: true }),
    searchL1Fts: async () => [],
    searchL1Hybrid: async () => SCORES54.map((_, i) => row54(i)),
  } as unknown as IMemoryStore;
  const embedding54 = { embed: async () => new Float32Array(4) } as unknown as EmbeddingService;

  async function recall54(cfgOverrides: Record<string, unknown>, tag: string) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dtk54-"));
    try {
      return await performAutoRecall({
        userText: "动态 topK 探针查询",
        actorId: "dtk54-" + tag,
        sessionKey: "sk-dtk54-" + tag,
        cfg: parseConfig({ recall: { strategy: "hybrid", maxResults: 5, ...cfgOverrides } }),
        pluginDataDir: dataDir,
        vectorStore: store54,
        embeddingService: embedding54,
      });
    } finally {
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 无害 */ }
    }
  }

  it("缺省关：5 条经验全额注入，scores 逐位现状", async () => {
    const memories = (await recall54({}, "off"))?.recalledL1Memories ?? [];
    expect(memories).toHaveLength(5);
    expect(memories.map((m) => m.score)).toEqual([0.9, 0.85, 0.4, 0.38, 0.36]);
  });

  it("开启：elbow 断崖收缩到 2 条，内容为 top-2，metric scores 同步对齐", async () => {
    const memories = (await recall54({ dynamicTopK: { enabled: true } }, "on"))?.recalledL1Memories ?? [];
    expect(memories).toHaveLength(2);
    expect(memories[0]?.content).toContain("54-a");
    expect(memories[1]?.content).toContain("54-b");
    expect(memories.map((m) => m.score)).toEqual([0.9, 0.85]);
  });

  it("minTopK 保底接线：断崖在 2 但 minTopK=4 → 注入 4 条", async () => {
    const memories = (await recall54({ dynamicTopK: { enabled: true, minTopK: 4 } }, "min4"))?.recalledL1Memories ?? [];
    expect(memories.map((m) => m.score)).toEqual([0.9, 0.85, 0.4, 0.38]);
  });
});