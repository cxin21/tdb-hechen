/**
 * #81：self_identity 提案相似门 + 生成端抑制（拍板：阈值 0.65 config 可配；闸门缺省开；抑制缺省开）。
 *
 * 合同：
 * 1. similarSelfIdentityProposalExists：候选=core_pending(slot=self_identity,state=pending) + core 槽行(identity/self_identity)；
 *    cosine >= threshold -> true；无候选或降级（embedder 缺席/抛错、store 缺方法）-> false 放行（宁漏勿误，镜像 embed-helpers）。
 * 2. 精确重复短路：normalizeProposalText 全等 -> true（embedder 缺席也不漏精确重复）。
 * 3. buildSelfIdentitySuppressionLines：装配「已有身份认知」抑制段；store 缺方法/抛错 -> []。
 * 4. runReflection 接线：闸门默认开 -> 同构提案不 upsertPendingCore；抑制默认开 -> prompt 注入抑制段。
 * 5. 真实 SQLite（临时目录）：rejected 行不再拦截（decidePendingCore 后 gate false）。
 * 6. 向量缓存 + 429 退避 + 块间 pacing（生产实锚 2026-10-22）：每提案重嵌全量 corpus≈23 次 API，
 *    beat 连发触发 ark AccountRateLimitExceeded(HTTP 429) -> 降级放行洪泛续命。同 embedder 实例
 *    corpus 向量进程内缓存（只嵌新候选）；embedBatch 对 429 有界退避重试（1s/3/6/12s）；
 *    冷启动多块间 pacing 400ms 打散突发；持续失败仍降级放行。
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { similarSelfIdentityProposalExists, buildSelfIdentitySuppressionLines, SIM_GATE_DEFAULT_THRESHOLD } from "./proposal-sim-gate.js";
import { runReflection } from "./reflection.js";
import { VectorStore } from "../store/sqlite.js";

const NOW = "2026-09-18T00:00:00.000Z";
const LOG = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };

// 确定性向量（零 LLM）：dup×dupTwin cos=0.90；dup×mid cos=0.66；dup×other cos=0
const VEC = {
  dup: [1, 0, 0],
  dupTwin: [0.9, 0.436, 0],
  mid: [0.66, 0.751, 0],
  other: [0, 1, 0],
};

function embedder(map: Record<string, number[]>, fallback: number[] = VEC.other) {
  const pick = (t: string): number[] => map[t] ?? fallback;
  return {
    embed: async (t: string) => new Float32Array(pick(t)),
    embedBatch: async (ts: string[]) => ts.map((t) => new Float32Array(pick(t))),
  };
}

type FakePending = { slot: string; content: string; state?: string };
type FakeCore = { slot: string; content: string };
function fakeStore(opts: { pending?: FakePending[]; core?: FakeCore[]; throwOn?: string } = {}) {
  return {
    upsertL1: vi.fn(async () => true),
    upsertPendingCore: vi.fn(async () => true),
    listPendingCore: vi.fn(async (_t?: unknown, _o?: { includeDecided?: boolean }) => {
      if (opts.throwOn === "listPendingCore") throw new Error("boom");
      return (opts.pending ?? []).map((p, i) => ({ pending_id: "pd" + i, slot: p.slot, content: p.content, state: p.state ?? "pending", evidence: 1, created_at: NOW }));
    }),
    readCore: vi.fn(async () => {
      if (opts.throwOn === "readCore") throw new Error("boom");
      return opts.core ?? [];
    }),
  };
}

const CONTENT_A = "要求所有报告先给结论再给细节"; // rows() 内容的 14 字逐字片段（过 vet verbatim 门）
const PENDING_A = "用户喜欢先看结论后看细节";
const T = { teamId: "t81", userId: "u81", agentId: "a81" };

describe("#81 相似门 · similarSelfIdentityProposalExists", () => {
  it("缺省阈值 0.65（拍板①）", () => {
    expect(SIM_GATE_DEFAULT_THRESHOLD).toBe(0.65);
  });

  it("语义同构 pending（cos 0.90）-> true", async () => {
    const st = fakeStore({ pending: [{ slot: "self_identity", content: PENDING_A }] });
    const emb = embedder({ [PENDING_A]: VEC.dup, [CONTENT_A]: VEC.dupTwin });
    await expect(similarSelfIdentityProposalExists({ store: st, tenant: T, content: CONTENT_A, embeddingService: emb })).resolves.toBe(true);
  });

  it("无关 pending（cos 0）-> false，且不误伤", async () => {
    const st = fakeStore({ pending: [{ slot: "self_identity", content: PENDING_A }] });
    const emb = embedder({ [PENDING_A]: VEC.dup, [CONTENT_A]: VEC.other });
    await expect(similarSelfIdentityProposalExists({ store: st, tenant: T, content: CONTENT_A, embeddingService: emb })).resolves.toBe(false);
  });

  it("无候选 -> false 且零 embed 调用（不白烧 API）", async () => {
    const st = fakeStore({});
    const emb = { embed: vi.fn(), embedBatch: vi.fn() };
    await expect(similarSelfIdentityProposalExists({ store: st, tenant: T, content: CONTENT_A, embeddingService: emb })).resolves.toBe(false);
    expect(emb.embedBatch).not.toHaveBeenCalled();
    expect(emb.embed).not.toHaveBeenCalled();
  });

  it("core 槽行（identity/self_identity）算候选；其它 slot 的 pending 不算", async () => {
    const st1 = fakeStore({ core: [{ slot: "self_identity", content: PENDING_A }] });
    const emb1 = embedder({ [PENDING_A]: VEC.dup, [CONTENT_A]: VEC.dupTwin });
    await expect(similarSelfIdentityProposalExists({ store: st1, tenant: T, content: CONTENT_A, embeddingService: emb1 })).resolves.toBe(true);
    const st2 = fakeStore({ pending: [{ slot: "core_value", content: PENDING_A }] });
    const emb2 = embedder({ [PENDING_A]: VEC.dup, [CONTENT_A]: VEC.dupTwin });
    await expect(similarSelfIdentityProposalExists({ store: st2, tenant: T, content: CONTENT_A, embeddingService: emb2 })).resolves.toBe(false);
  });

  it("阈值可配：0.7 时 cos 0.66 对放行；0.65 时拦截", async () => {
    const st = fakeStore({ pending: [{ slot: "self_identity", content: PENDING_A }] });
    const emb = embedder({ [PENDING_A]: VEC.dup, [CONTENT_A]: VEC.mid });
    await expect(similarSelfIdentityProposalExists({ store: st, tenant: T, content: CONTENT_A, threshold: 0.7, embeddingService: emb })).resolves.toBe(false);
    await expect(similarSelfIdentityProposalExists({ store: st, tenant: T, content: CONTENT_A, threshold: 0.65, embeddingService: emb })).resolves.toBe(true);
  });

  it("精确重复短路：embedder 缺席也不漏精确重复", async () => {
    const st = fakeStore({ pending: [{ slot: "self_identity", content: CONTENT_A }] });
    await expect(similarSelfIdentityProposalExists({ store: st, tenant: T, content: CONTENT_A })).resolves.toBe(true);
  });

  it("降级-抛错：embedBatch 抛 -> false 放行不抛出（宁漏勿误）", async () => {
    const st = fakeStore({ pending: [{ slot: "self_identity", content: PENDING_A }] });
    const emb = { embedBatch: async () => { throw new Error("api down"); } };
    await expect(similarSelfIdentityProposalExists({ store: st, tenant: T, content: CONTENT_A, embeddingService: emb })).resolves.toBe(false);
  });

  it("回归(生产实锚 2026-10-22): embedBatch 单批 ≤10（ark 上限），分块后拦截仍生效", async () => {
    const filler = Array.from({ length: 15 }, (_, i) => `无关候选第${i}号：与身份认知无关的占位内容`);
    const st = fakeStore({ pending: [...filler.map((c) => ({ slot: "self_identity", content: c })), { slot: "self_identity", content: PENDING_A }] });
    const batches: number[] = [];
    const pick = (t: string): number[] => (t === PENDING_A ? VEC.dup : t === CONTENT_A ? VEC.dupTwin : VEC.other);
    const emb = {
      embedBatch: async (ts: string[]) => {
        batches.push(ts.length);
        if (ts.length > 10) throw new Error("Embeddings API input limit exceeded: max 10, got " + ts.length);
        return ts.map((t) => new Float32Array(pick(t)));
      },
    };
    await expect(similarSelfIdentityProposalExists({ store: st, tenant: T, content: CONTENT_A, embeddingService: emb })).resolves.toBe(true);
    expect(batches.length).toBeGreaterThan(0);
    for (const b of batches) expect(b).toBeLessThanOrEqual(10);
  });

  it("向量缓存：同 embedder 二次调用只嵌新候选（RED：现状每提案重嵌全量 corpus 触发 ark 429）", async () => {
    const filler = Array.from({ length: 15 }, (_, i) => `无关候选第${i}号：与身份认知无关的占位内容`);
    const st = fakeStore({ pending: [...filler.map((c) => ({ slot: "self_identity", content: c })), { slot: "self_identity", content: PENDING_A }] });
    const batches: string[][] = [];
    const emb = { embedBatch: async (ts: string[]) => { batches.push([...ts]); return ts.map(() => new Float32Array(VEC.other)); } };
    await similarSelfIdentityProposalExists({ store: st, tenant: T, content: CONTENT_A, embeddingService: emb });
    expect(batches.flat().length).toBe(17); // 首次全量：1 候选 + 16 corpus
    batches.length = 0;
    await similarSelfIdentityProposalExists({ store: st, tenant: T, content: "全新的候选内容从未出现过", embeddingService: emb });
    expect(batches.flat()).toEqual(["全新的候选内容从未出现过"]); // corpus 全命中缓存
  });

  it("429 退避重试：429×2 后成功 -> 不降级结果正确（RED：现状一次 429 即降级放行）", async () => {
    const st = fakeStore({ pending: [{ slot: "self_identity", content: PENDING_A }] });
    let calls = 0;
    const emb = {
      embedBatch: async (ts: string[]) => {
        calls++;
        if (calls <= 2) throw new Error("Embedding API error: HTTP 429 Too Many Requests — AccountRateLimitExceeded");
        return ts.map((t) => new Float32Array(t === PENDING_A ? VEC.dup : VEC.dupTwin));
      },
    };
    await expect(similarSelfIdentityProposalExists({ store: st, tenant: T, content: CONTENT_A, embeddingService: emb })).resolves.toBe(true);
    expect(calls).toBe(3);
  });

  it("块间 pacing：冷启动多块不背靠背突发（RED：现状块间零间隔，ark 429 冷启动根因）", async () => {
    const filler = Array.from({ length: 24 }, (_, i) => `占位候选第${i}号：内容互异的长尾占位文本`);
    const st = fakeStore({ pending: filler.map((c) => ({ slot: "self_identity", content: c })) });
    const stamps: number[] = [];
    const emb = { embedBatch: async (ts: string[]) => { stamps.push(Date.now()); return ts.map(() => new Float32Array(VEC.other)); } };
    await similarSelfIdentityProposalExists({ store: st, tenant: T, content: CONTENT_A, embeddingService: emb });
    expect(stamps.length).toBe(3); // 25 文本 -> 10+10+5 三块
    expect(stamps[1]! - stamps[0]!).toBeGreaterThanOrEqual(300);
    expect(stamps[2]! - stamps[1]!).toBeGreaterThanOrEqual(300);
  });

  it("429 重试耗尽：5 次尝试后仍 429 -> 有界退避后降级放行（RED：现状 3 次即弃）", async () => {
    vi.useFakeTimers();
    try {
      const st = fakeStore({ pending: [{ slot: "self_identity", content: PENDING_A }] });
      let calls = 0;
      const emb = {
        embedBatch: async () => {
          calls++;
          throw new Error("Embedding API error: HTTP 429 Too Many Requests — AccountRateLimitExceeded");
        },
      };
      const p = similarSelfIdentityProposalExists({ store: st, tenant: T, content: CONTENT_A, embeddingService: emb });
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(p).resolves.toBe(false);
      expect(calls).toBe(5); // [1,3,6,12]s 有界退避 = 1+4 次尝试
    } finally {
      vi.useRealTimers();
    }
  });

  it("降级-仅 embed：无 embedBatch -> 逐条回退仍生效", async () => {
    const st = fakeStore({ pending: [{ slot: "self_identity", content: PENDING_A }] });
    const pick = (t: string): number[] => (t === PENDING_A ? VEC.dup : t === CONTENT_A ? VEC.dupTwin : VEC.other);
    const emb = { embed: async (t: string) => new Float32Array(pick(t)) };
    await expect(similarSelfIdentityProposalExists({ store: st, tenant: T, content: CONTENT_A, embeddingService: emb })).resolves.toBe(true);
  });

  it("store 缺方法 -> false 放行不崩", async () => {
    await expect(similarSelfIdentityProposalExists({ store: {}, tenant: T, content: CONTENT_A })).resolves.toBe(false);
  });
});

describe("#81 生成端抑制 · buildSelfIdentitySuppressionLines", () => {
  it("store 缺方法 -> []（降级不注入）", async () => {
    await expect(buildSelfIdentitySuppressionLines({ store: {}, tenant: T })).resolves.toEqual([]);
  });

  it("readCore 抛错 -> []（降级）", async () => {
    const st = fakeStore({ throwOn: "readCore" });
    await expect(buildSelfIdentitySuppressionLines({ store: st, tenant: T })).resolves.toEqual([]);
  });

  it("正常装配：含标记 + 槽行 + pending 内容，且 maxPending 截断", async () => {
    const st = fakeStore({
      core: [{ slot: "self_identity", content: "用户是克制的工程师" }],
      pending: [1, 2, 3].map((i) => ({ slot: "self_identity", content: "待裁决条目" + i })),
    });
    const lines2 = await buildSelfIdentitySuppressionLines({ store: st, tenant: T, maxPending: 2 });
    const joined = lines2.join("\n");
    expect(joined).toContain("已有身份认知");
    expect(joined).toContain("用户是克制的工程师");
    expect(joined).toContain("待裁决条目1");
    expect(joined).not.toContain("待裁决条目3");
  });

  it("超长内容截断 160 字符", async () => {
    const long = "长".repeat(300);
    const st = fakeStore({ core: [{ slot: "self_identity", content: long }] });
    const lines2 = await buildSelfIdentitySuppressionLines({ store: st, tenant: T });
    const joined = lines2.join("\n");
    expect(joined).toContain("长".repeat(160));
    expect(joined).not.toContain("长".repeat(161));
  });
});

describe("#81 runReflection 接线", () => {
  const rows = () => [{ id: "r1", content: "用户要求所有报告先给结论再给细节", type: "episodic", significance: 0.9, createdAt: NOW, updatedAt: NOW, teamId: "t1", userId: "u1", agentId: "a1", metadata: {} }];
  const llm = (out: string) => ({ run: vi.fn(async () => out) });
  const PROPOSAL = JSON.stringify([{ question: "q", conclusion: CONTENT_A, evidence: ["r1"] }]);
  const baseCfg = { enabled: true, rRef: 0.5, soulProposals: { enabled: true, shadowCalibration: { enabled: false } } };

  it("闸门默认开：同构 pending 在途 -> 不再 upsertPendingCore（RED：现状直接 upsert）", async () => {
    const st = fakeStore({ pending: [{ slot: "self_identity", content: PENDING_A }] });
    const emb = embedder({ [PENDING_A]: VEC.dup, [CONTENT_A]: VEC.dupTwin });
    const runner = llm(PROPOSAL);
    await runReflection({ queryL1: async () => rows() as never, config: baseCfg, store: st, llmRunner: runner, logger: LOG, embeddingService: emb as never });
    expect(st.upsertPendingCore).not.toHaveBeenCalled();
  });

  it("闸门 off：selfIdentityGate.enabled=false -> upsertPendingCore 照旧", async () => {
    const st = fakeStore({ pending: [{ slot: "self_identity", content: PENDING_A }] });
    const emb = embedder({ [PENDING_A]: VEC.dup, [CONTENT_A]: VEC.dupTwin });
    const runner = llm(PROPOSAL);
    await runReflection({ queryL1: async () => rows() as never, config: { ...baseCfg, selfIdentityGate: { enabled: false } }, store: st, llmRunner: runner, logger: LOG, embeddingService: emb as never });
    expect(st.upsertPendingCore).toHaveBeenCalled();
  });

  it("抑制默认开：prompt 注入「已有身份认知」段（含槽行与 pending 内容）", async () => {
    const st = fakeStore({ core: [{ slot: "self_identity", content: "用户是克制的工程师" }], pending: [{ slot: "self_identity", content: "零删除零注入是记忆红线" }] });
    const runner = llm("[]");
    await runReflection({ queryL1: async () => rows() as never, config: baseCfg, store: st, llmRunner: runner, logger: LOG });
    const prompt = ((runner.run.mock.calls[0] as unknown[])[0] as { prompt?: string }).prompt ?? "";
    expect(prompt).toContain("已有身份认知");
    expect(prompt).toContain("用户是克制的工程师");
    expect(prompt).toContain("零删除零注入是记忆红线");
  });

  it("抑制 off：selfIdentityGate.suppression.enabled=false -> prompt 不注入", async () => {
    const st = fakeStore({ core: [{ slot: "self_identity", content: "用户是克制的工程师" }] });
    const runner = llm("[]");
    await runReflection({ queryL1: async () => rows() as never, config: { ...baseCfg, selfIdentityGate: { suppression: { enabled: false } } }, store: st, llmRunner: runner, logger: LOG });
    const prompt = ((runner.run.mock.calls[0] as unknown[])[0] as { prompt?: string }).prompt ?? "";
    expect(prompt).not.toContain("已有身份认知");
  });
});

describe("#81 真实 SQLite 集成（临时目录）", () => {
  let store: InstanceType<typeof VectorStore>;
  let dir: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "tdb-simgate-81-"));
    store = new VectorStore(join(dir, "v.db"), 0);
    await store.init();
  });
  afterAll(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* cleanup */ }
  });

  it("pending 在途拦截 -> rejected 后放行（state 语义正确）", async () => {
    const st = store as unknown as {
      upsertPendingCore: (slot: string, content: string, evidence: number, tenant?: Record<string, string>) => boolean;
      listPendingCore: (tenant?: Record<string, string>) => Array<{ pending_id: string; state: string }>;
      decidePendingCore: (pendingId: string, decision: "adopted" | "rejected", tenant?: Record<string, string>) => unknown;
    };
    st.upsertPendingCore("self_identity", PENDING_A, 2, T);
    const emb = embedder({ [PENDING_A]: VEC.dup, [CONTENT_A]: VEC.dupTwin });
    await expect(similarSelfIdentityProposalExists({ store: st, tenant: T, content: CONTENT_A, embeddingService: emb })).resolves.toBe(true);
    const row = st.listPendingCore(T)[0]!;
    expect(st.decidePendingCore(row.pending_id, "rejected", T)).not.toBeNull();
    await expect(similarSelfIdentityProposalExists({ store: st, tenant: T, content: CONTENT_A, embeddingService: emb })).resolves.toBe(false);
  });
});
