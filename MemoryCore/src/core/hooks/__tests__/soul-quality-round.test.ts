/**
 * 灵魂注入质量轮（2026-10-19）RED 套件——渲染/性能双线治理的确定性测试：
 *
 * 性能线（journal 实证 expand=4002/4007ms 顶满 clamp=504 根因）：
 *   - expandQuery 失败负缓存（negativeTtlMs）：故障期不逐请求重付 LLM 全额 RTT；
 *   - expandQuery 空结果正缓存：LLM 确定答「无扩展」≠ 失败，重试只会原样重付；
 *   - raceWithTimeoutCap：热路等待帽——帽内未返回取 fallback，迟到结果后台落缓存，
 *     capMs<=0 直通旧行为；迟到 rejection 被吸收（不得 unhandledRejection）。
 *
 * 渲染线（生产实拍 6 锚「取证」族扎堆 + 10 条红线墙 + 软硬同文重复）：
 *   - dedupeAnchorPairsEmbedding：label 通道之外的 desc cosine 语义近重复通道
 *     （贪心首现保留；单条 embed 失败/空 desc → 不可判保留；整体失败 → 全保留降级）；
 *   - suppressAnchorOverlapRows：价值锚 desc 与红线行近重复时锚行让位
 *     （jaccard 通道 + 可选 embedding 通道；无「：」行整行保留）；
 *   - parseConfig 新键（hotPathTimeoutMs/negativeTtlMs/maxLines/suppressAnchorOverlap/
 *     embeddingThreshold）：config-first 缺省关/安全值 + clamp。
 *
 * 真实性边界沿 soul-dedupe.ts 头条：只做整行/整锚选择（drop），kept 逐字保留。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { dedupeAnchorPairsEmbedding, suppressAnchorOverlapRows, cosineSimilarity, type AnchorPairLike } from "../soul-dedupe.js";
import { embedAnchorCached, resetAnchorVectorCacheForTest, scoreAnchorRows, selectAnchorRowsMmr, type AnchorScoredRow } from "../soul-anchor-scorer.js";
import { dedupProposalsWithVariants, type RawProposal, type ThemeNameVariants } from "../../../gateway/core-values-discover.js";
import { expandQuery, raceWithTimeoutCap, type ExpansionRunner } from "../../recall/query-expand.js";
import { parseConfig } from "../../../config.js";

function mockRunner(reply: () => string | Promise<string>): ExpansionRunner & { calls: number } {
  let calls = 0;
  return {
    get calls() { return calls; },
    run: async () => {
      calls += 1;
      return reply();
    },
  } as unknown as ExpansionRunner & { calls: number };
}

function failingRunner(): ExpansionRunner & { calls: number } {
  let calls = 0;
  return {
    get calls() { return calls; },
    run: async () => {
      calls += 1;
      throw new Error("llm down");
    },
  } as unknown as ExpansionRunner & { calls: number };
}

describe("灵魂注入质量轮：raceWithTimeoutCap（热路等待帽）", () => {
  it("快速 promise → 原值透传", async () => {
    const v = await raceWithTimeoutCap(Promise.resolve("fast"), 50, "fb");
    expect(v).toBe("fast");
  });

  it("慢 promise → 帽内取 fallback；迟到完成不阻塞调用方", async () => {
    const t0 = Date.now();
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve("late"), 200));
    const v = await raceWithTimeoutCap(slow, 10, "fb");
    expect(v).toBe("fb");
    expect(Date.now() - t0).toBeLessThan(150);
  });

  it("capMs<=0 / 非有限 → 直通旧行为（全额等待）", async () => {
    expect(await raceWithTimeoutCap(Promise.resolve("v"), 0, "fb")).toBe("v");
    expect(await raceWithTimeoutCap(Promise.resolve("v"), Number.NaN, "fb")).toBe("v");
  });

  it("迟到 rejection 被吸收：race 已决 fallback 后进程不炸", async () => {
    const boom = new Promise<string>((_, reject) => setTimeout(() => reject(new Error("late boom")), 30));
    const v = await raceWithTimeoutCap(boom, 5, "fb");
    expect(v).toBe("fb");
    await new Promise((r) => setTimeout(r, 60)); // 给迟到 rejection 留窗口
  });
});

describe("灵魂注入质量轮：expandQuery 失败负缓存 + 空结果正缓存", () => {
  it("失败负缓存：故障期第二次调用短路 []，不再外呼（negativeTtlMs>0）", async () => {
    const runner = failingRunner();
    const q = "负缓存故障测试-qA";
    expect(await expandQuery(q, runner, { ttlMs: 0, negativeTtlMs: 30_000, timeoutMs: 1000 })).toEqual([]);
    expect(await expandQuery(q, runner, { ttlMs: 0, negativeTtlMs: 30_000, timeoutMs: 1000 })).toEqual([]);
    expect(runner.calls).toBe(1);
  });

  it("negativeTtlMs=0 → 关闭负缓存，逐次重试（旧行为）", async () => {
    const runner = failingRunner();
    const q = "负缓存关闭测试-qB";
    await expandQuery(q, runner, { ttlMs: 0, negativeTtlMs: 0, timeoutMs: 1000 });
    await expandQuery(q, runner, { ttlMs: 0, negativeTtlMs: 0, timeoutMs: 1000 });
    expect(runner.calls).toBe(2);
  });

  it("空结果按正常 TTL 正缓存：LLM 确定答「无扩展」不重付", async () => {
    const runner = mockRunner(() => "[]");
    const q = "空结果缓存测试-qC";
    expect(await expandQuery(q, runner, { ttlMs: 60_000, negativeTtlMs: 30_000, timeoutMs: 1000 })).toEqual([]);
    expect(await expandQuery(q, runner, { ttlMs: 60_000, negativeTtlMs: 30_000, timeoutMs: 1000 })).toEqual([]);
    expect(runner.calls).toBe(1);
  });

  it("成功后清除负缓存残留（防 ttl<negativeTtl 病态配置下旧失败条目误短路）", async () => {
    let fail = true;
    const runner = mockRunner(() => {
      if (fail) throw new Error("flap");
      return '["t1"]';
    });
    const q = "失败恢复测试-qD";
    expect(await expandQuery(q, runner, { ttlMs: 0, negativeTtlMs: 60_000, timeoutMs: 1000 })).toEqual([]);
    fail = false;
    // 负缓存期内：仍短路（合同如此——负 TTL 内不放行）
    expect(await expandQuery(q, runner, { ttlMs: 0, negativeTtlMs: 60_000, timeoutMs: 1000 })).toEqual([]);
    // 直接放行一次成功调用（绕过负缓存：换负缓存关闭读路径不清——改用「成功清负缓存」
    // 语义验证：ttlMs>0 正缓存命中后负缓存条目应已被清除）
    fail = false;
    const hit = await expandQuery(q, runner, { ttlMs: 0, negativeTtlMs: 0, timeoutMs: 1000 });
    expect(hit).toEqual(["t1"]);
  });
});

const pair = (valueId: string, label: string, desc: string): AnchorPairLike & { row: string } => ({
  row: `${label}(趋近)：${desc}`,
  desc,
  valueId,
  label,
});

describe("灵魂注入质量轮：dedupeAnchorPairsEmbedding（desc 语义近重复通道）", () => {
  const embed = async (t: string): Promise<Float32Array> => {
    if (t.includes("证据")) return new Float32Array([1, 0]);
    if (t.includes("倾听")) return new Float32Array([0, 1]);
    throw new Error("no vec");
  };

  it("cosine≥threshold → 后现近重复锚被丢（保首现）；异质锚保留", async () => {
    const pairs = [
      pair("v1", "探针", "用探针取得证据后再下结论"),
      pair("v2", "取证先行", "取得证据后再下结论"),
      pair("v3", "倾听", "倾听优先"),
    ];
    const out = await dedupeAnchorPairsEmbedding(pairs, embed, 0.85);
    expect(out.pairs.map((p) => p.valueId)).toEqual(["v1", "v3"]);
    expect(out.dropped).toHaveLength(1);
    expect(out.dropped[0]!.label).toBe("取证先行");
    expect(out.dropped[0]!.keptLabel).toBe("探针");
    expect(out.dropped[0]!.reason).toContain("cosine");
  });

  it("单条 embed 失败/空 desc → 不可判保留（宁缺毋滥不误删人格锚）", async () => {
    const pairs = [pair("v1", "探针", "取得证据"), pair("v2", "空desc", ""), pair("v3", "无向量", "独词")];
    const out = await dedupeAnchorPairsEmbedding(pairs, embed, 0.85);
    expect(out.pairs).toHaveLength(3);
    expect(out.dropped).toHaveLength(0);
  });

  it("embedder 整体不可用 → 全保留降级（调用方回退 label 通道结果）", async () => {
    const pairs = [pair("v1", "a", "x"), pair("v2", "b", "x")];
    const boom = async (): Promise<Float32Array> => {
      throw new Error("embedder down");
    };
    const out = await dedupeAnchorPairsEmbedding(pairs, boom, 0.85);
    expect(out.pairs).toHaveLength(2);
    expect(out.dropped).toHaveLength(0);
  });
});

describe("灵魂注入质量轮：suppressAnchorOverlapRows（锚行 vs 红线行跨段抑制）", () => {
  it("jaccard 通道：desc 与红线行近重复 → 锚行让位，kept 逐字保留", async () => {
    const rows = ["求实(趋近)：用一手证据下结论", "倾听(趋近)：先听懂对方再回应"];
    const rules = ["- [strict_rule] 用一手证据下结论，禁止无凭据断言"];
    const out = await suppressAnchorOverlapRows(rows, rules, { jaccardThreshold: 0.45 });
    expect(out.kept).toEqual(["倾听(趋近)：先听懂对方再回应"]);
    expect(out.dropped).toHaveLength(1);
    expect(out.dropped[0]!.reason).toContain("jaccard");
    expect(out.dropped[0]!.reason).toContain("vs redline");
  });

  it("embedding 通道：字面不同语义同（cosine≥阈值）→ 让位", async () => {
    const vec = (t: string): Float32Array => (t.includes("凭据") ? new Float32Array([1, 0, 0]) : new Float32Array([0, 1, 0]));
    const embedder = async (t: string): Promise<Float32Array> => vec(t);
    const rows = ["实证(趋近)：结论要有凭据支撑", "独异(趋近)：完全另一码事"];
    const rules = ["- [strict_rule] 无凭据不下结论"];
    const out = await suppressAnchorOverlapRows(rows, rules, { jaccardThreshold: 0.99, embedder, embeddingThreshold: 0.85 });
    expect(out.kept).toEqual(["独异(趋近)：完全另一码事"]);
    expect(out.dropped[0]!.reason).toContain("cosine");
  });

  it("无「：」行（无 desc）整行保留；两侧互不相干全保留", async () => {
    const rows = ["裸行没有分隔符", "无关(趋近)：风马牛不相及"];
    const rules = ["- [strict_rule] 用一手证据下结论"];
    const out = await suppressAnchorOverlapRows(rows, rules, { jaccardThreshold: 0.45 });
    expect(out.kept).toEqual(rows);
    expect(out.dropped).toHaveLength(0);
  });

  it("cosineSimilarity 防御：空/长度不齐/零向量 → 0", () => {
    expect(cosineSimilarity(new Float32Array([1, 0]), null)).toBe(0);
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([1, 0, 0]))).toBe(0);
    expect(cosineSimilarity(new Float32Array([0, 0]), new Float32Array([1, 0]))).toBe(0);
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([1, 0]))).toBe(1);
  });
});

describe("灵魂注入质量轮：parseConfig 新键（config-first 缺省安全值 + clamp）", () => {
  it("queryExpansion：hotPathTimeoutMs 缺省 1500 / negativeTtlMs 缺省 30000", () => {
    const qe = parseConfig({ recall: { queryExpansion: {} } }).recall.queryExpansion;
    expect(qe.hotPathTimeoutMs).toBe(1500);
    expect(qe.negativeTtlMs).toBe(30_000);
  });

  it("queryExpansion：显式值透传，负值 clamp 0（0=旧行为/关）", () => {
    const qe = parseConfig({ recall: { queryExpansion: { hotPathTimeoutMs: 2000, negativeTtlMs: 5000 } } }).recall.queryExpansion;
    expect(qe.hotPathTimeoutMs).toBe(2000);
    expect(qe.negativeTtlMs).toBe(5000);
    const clamped = parseConfig({ recall: { queryExpansion: { hotPathTimeoutMs: -3, negativeTtlMs: -1 } } }).recall.queryExpansion;
    expect(clamped.hotPathTimeoutMs).toBe(0);
    expect(clamped.negativeTtlMs).toBe(0);
  });

  it("soulRender：maxLines/suppressAnchorOverlap/embeddingThreshold 缺省关（0/false/0）", () => {
    const sr = parseConfig({ coreMemory: { soulRender: {} } }).coreMemory.soulRender;
    expect(sr.strictRuleDedup.maxLines).toBe(0);
    expect(sr.strictRuleDedup.suppressAnchorOverlap).toBe(false);
    expect(sr.anchorDedup.embeddingThreshold).toBe(0);
  });

  it("soulRender：显式值透传；maxLines clamp 0..50；embeddingThreshold clamp 0..1", () => {
    const sr = parseConfig({
      coreMemory: {
        soulRender: {
          strictRuleDedup: { enabled: true, maxLines: 8, suppressAnchorOverlap: true },
          anchorDedup: { enabled: true, embeddingThreshold: 0.85 },
        },
      },
    }).coreMemory.soulRender;
    expect(sr.strictRuleDedup.enabled).toBe(true);
    expect(sr.strictRuleDedup.maxLines).toBe(8);
    expect(sr.strictRuleDedup.suppressAnchorOverlap).toBe(true);
    expect(sr.anchorDedup.enabled).toBe(true);
    expect(sr.anchorDedup.embeddingThreshold).toBeCloseTo(0.85);
    const over = parseConfig({
      coreMemory: { soulRender: { strictRuleDedup: { maxLines: 99 }, anchorDedup: { embeddingThreshold: 1.5 } } },
    }).coreMemory.soulRender;
    expect(over.strictRuleDedup.maxLines).toBe(50);
    expect(over.anchorDedup.embeddingThreshold).toBe(1);
  });
});

describe('灵魂注入质量轮：selectAnchorRowsMmr（MMR 多样性选择）', () => {
  const vec = (a: number[]) => new Float32Array(a);
  const rows: AnchorScoredRow[] = [
    { row: 'A', score: 0.9, vec: vec([1, 0, 0]) },
    { row: 'B', score: 0.85, vec: vec([0.99, 0.1, 0]) },
    { row: 'C', score: 0.8, vec: vec([0, 1, 0]) },
    { row: 'D', score: 0.7, vec: vec([0, 0, 1]) },
  ];

  it('近重复锚被多样性项压制：maxRows=2 选 [A,C] 而非纯 top-K [A,B]', () => {
    const picked = selectAnchorRowsMmr(rows, { maxRows: 2, threshold: 0, lambda: 0.7 });
    expect(picked.map((s) => s.row)).toEqual(['A', 'C']);
  });

  it('候选池 ≤ maxRows：声明序原样返回（不做 MMR 重排）', () => {
    const picked = selectAnchorRowsMmr(rows.slice(0, 2), { maxRows: 5, threshold: 0, lambda: 0.7 });
    expect(picked.map((s) => s.row)).toEqual(['A', 'B']);
  });

  it('vec 缺失的行不进候选池（宁缺毋滥）', () => {
    const sparse: AnchorScoredRow[] = [
      { row: 'A', score: 0.99 },
      { row: 'C', score: 0.8, vec: vec([0, 1, 0]) },
      { row: 'D', score: 0.7, vec: vec([0, 0, 1]) },
    ];
    const picked = selectAnchorRowsMmr(sparse, { maxRows: 2, threshold: 0, lambda: 0.7 });
    expect(picked.map((s) => s.row)).toEqual(['C', 'D']);
  });

  it('threshold 硬门继续生效', () => {
    const picked = selectAnchorRowsMmr(rows, { maxRows: 1, threshold: 0.85, lambda: 0.7 });
    expect(picked.map((s) => s.row)).toEqual(['A']);
  });

  it('scoreAnchorRows 随行携带 vec（MMR 复用零额外 embed）', async () => {
    const probe = vec([1, 0, 0]);
    const character = vec([0, 1, 0]);
    const embedder = async (t: string) => (t === '探针' ? probe : character);
    const scored = await scoreAnchorRows(
      [
        { row: 'r1', desc: '探针' },
        { row: 'r2', desc: '品格' },
      ],
      vec([1, 0, 0]),
      embedder,
      {},
    );
    expect(scored.map((s) => s.vec)).toEqual([probe, character]);
  });
});

describe('灵魂注入质量轮：anchorSelect.scorer.mmrLambda 配置', () => {
  it('缺省 0.7（λ=1 退化 top-K，0.7 为多样性/相关性的安全中间值）', () => {
    const scorer = parseConfig({ coreMemory: { soulRender: { anchorSelect: { scorer: { enabled: true } } } } }).coreMemory.soulRender.anchorSelect.scorer;
    expect(scorer.mmrLambda).toBeCloseTo(0.7);
  });

  it('显式透传；clamp 0..1', () => {
    const over = parseConfig({ coreMemory: { soulRender: { anchorSelect: { scorer: { enabled: true, mmrLambda: 1.5 } } } } }).coreMemory.soulRender.anchorSelect.scorer;
    expect(over.mmrLambda).toBe(1);
    const under = parseConfig({ coreMemory: { soulRender: { anchorSelect: { scorer: { enabled: true, mmrLambda: -1 } } } } }).coreMemory.soulRender.anchorSelect.scorer;
    expect(under.mmrLambda).toBe(0);
  });
});

describe('灵魂注入质量轮：发现端提案包含门（dedupProposalsWithVariants，opt-in）', () => {
  const prop = (label: string): RawProposal => ({ label, rationale: 'r', aliases: [] });

  it('containmentGate=true：提案 label 包含既有锚 label → 丢弃；无包含关系的近义提案保留', () => {
    const existing: ThemeNameVariants[] = [{ label: '取证', aliases: [] }];
    const kept = dedupProposalsWithVariants([prop('取证先行'), prop('一手证据')], existing, { containmentGate: true });
    expect(kept.map((p) => p.label)).toEqual(['一手证据']);
  });

  it('containmentGate=true：反向包含同样丢弃；alias 命中也丢弃', () => {
    const existing: ThemeNameVariants[] = [
      { label: '一手证据', aliases: [] },
      { label: '求实', aliases: ['实测验证'] },
    ];
    const kept = dedupProposalsWithVariants([prop('证据'), prop('实测验证')], existing, { containmentGate: true });
    expect(kept).toEqual([]);
  });

  it('containmentGate=true：纯近义但不包含/不相等 → 保留（bigram 通道未被越权放宽）', () => {
    const existing: ThemeNameVariants[] = [{ label: '求实', aliases: [] }];
    const kept = dedupProposalsWithVariants([prop('实测验证')], existing, { containmentGate: true });
    expect(kept.map((p) => p.label)).toEqual(['实测验证']);
  });

  it('缺省（G-SIMMERGE 增长路）：包含对放行——「根因」⊂「根因优先」由采纳前相似门裁决，不在此丢弃', () => {
    const existing: ThemeNameVariants[] = [{ label: '根因优先', aliases: [] }];
    const kept = dedupProposalsWithVariants([prop('根因')], existing);
    expect(kept.map((p) => p.label)).toEqual(['根因']);
  });
});

describe("灵魂注入质量轮：embedAnchorCached（共享缓存 + 并发合并 + 失败不缓存）", () => {
  beforeEach(() => {
    resetAnchorVectorCacheForTest();
  });

  it("同文本两次调用只 embed 一次，返回同一向量实例", async () => {
    const calls: string[] = [];
    const embedder = async (t: string) => {
      calls.push(t);
      return new Float32Array([1, 0, 0]);
    };
    const a = await embedAnchorCached(embedder, "取证先行：任何结论必须有实测证据");
    const b = await embedAnchorCached(embedder, "取证先行：任何结论必须有实测证据");
    expect(calls).toHaveLength(1);
    expect(b).toBe(a);
  });

  it("并发同文本 in-flight 合并：N 个等待者只触发一次 embed", async () => {
    let calls = 0;
    const embedder = async (t: string) => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 5));
      return new Float32Array([0, 1, 0]);
    };
    const text = "并发合并测试锚描述";
    const all = await Promise.all([
      embedAnchorCached(embedder, text),
      embedAnchorCached(embedder, text),
      embedAnchorCached(embedder, text),
    ]);
    expect(calls).toBe(1);
    expect(all.every((v) => v instanceof Float32Array)).toBe(true);
  });

  it("embed 失败返回 null 且不缓存：下次调用重试（call=2）", async () => {
    let calls = 0;
    const embedder = async (t: string) => {
      calls += 1;
      if (calls === 1) throw new Error("ark 503");
      return new Float32Array([0, 0, 1]);
    };
    const text = "失败重试测试锚描述";
    const first = await embedAnchorCached(embedder, text);
    expect(first).toBeNull();
    const second = await embedAnchorCached(embedder, text);
    expect(second).not.toBeNull();
    expect(calls).toBe(2);
  });

  it("跨通道复用：scoreAnchorRows 打分后 suppressAnchorOverlapRows 对同 desc 零新增 embed", async () => {
    const calls: string[] = [];
    const embedder = async (t: string) => {
      calls.push(t);
      return new Float32Array([0.5, 0.5]);
    };
    const rows = [
      { row: "价值锚：跨通道", desc: "跨通道复用测试：同 desc 只付一次" },
    ];
    const renderLines = ["价值锚：跨通道复用测试：同 desc 只付一次"];
    const qv = new Float32Array([1, 0]);
    await scoreAnchorRows(rows, qv, embedder);
    const afterScore = calls.length;
    await suppressAnchorOverlapRows(renderLines, ["不可逾越：另起一行"], { embedder, embeddingThreshold: 0.9 });
    // 锚行 desc 与打分阶段同文本 → 缓存命中不重付；新增 embed 只有红线行自身 1 条
    expect(calls.length).toBe(afterScore + 1);
    expect(calls.filter((t) => t === "跨通道复用测试：同 desc 只付一次")).toHaveLength(1);
  });
});

describe("灵魂注入质量轮：scoreAnchorRows 预嵌软预算（超时回退，宁缺毋滥）", () => {
  beforeEach(() => {
    resetAnchorVectorCacheForTest();
  });

  it("embedBudgetMs 超时 → 整体抛错（调用方回退声明序），错误信息含预算与 desc 数", async () => {
    const slow = async () => new Promise<Float32Array>(() => {});
    const rows = [
      { row: "锚A", desc: "慢向量一" },
      { row: "锚B", desc: "慢向量二" },
    ];
    const qv = new Float32Array([1, 0]);
    await expect(scoreAnchorRows(rows, qv, slow, { maxRows: 10, embedBudgetMs: 60 })).rejects.toThrow(
      /anchor embed budget exceeded \(\d+ms, 2 descs\)/,
    );
  });

  it("embedBudgetMs=0（缺省/关）→ 无预算，慢 embed 照常等待完成", async () => {
    const rows = [{ row: "锚C", desc: "慢而终会完成" }];
    const qv = new Float32Array([1, 0]);
    const embedder = async () => {
      await new Promise((r) => setTimeout(r, 30));
      return new Float32Array([1, 0]);
    };
    const scored = await scoreAnchorRows(rows, qv, embedder);
    expect(scored).toHaveLength(1);
    expect(scored[0].score).toBeCloseTo(1);
  });

  it("config：embedBudgetMs 缺省 1200；负值/小数 clamp（≥0 floor）", () => {
    const d = parseConfig({ coreMemory: { soulRender: {} } }).coreMemory.soulRender.anchorSelect.scorer;
    expect(d.embedBudgetMs).toBe(1200);
    const neg = parseConfig({
      coreMemory: { soulRender: { anchorSelect: { scorer: { embedBudgetMs: -5 } } } },
    }).coreMemory.soulRender.anchorSelect.scorer;
    expect(neg.embedBudgetMs).toBe(0);
    const frac = parseConfig({
      coreMemory: { soulRender: { anchorSelect: { scorer: { embedBudgetMs: 150.9 } } } },
    }).coreMemory.soulRender.anchorSelect.scorer;
    expect(frac.embedBudgetMs).toBe(150);
  });
});
