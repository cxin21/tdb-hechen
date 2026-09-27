/**
 * R1（09-27 源头嵌入）RED：生命周期产物写入即带向量。
 * 根因：reflection/consolidation/evolution 三写链 upsertL1 不传 embedding → 产物结构性无向量。
 * embedForLifecycle：单一源 helper——embed 失败回退 metadata-only（补偿器兜底），不阻塞写链。
 */
import { describe, it, expect } from "vitest";
import { embedForLifecycle } from "./embed-helpers.js";
import { runReflection } from "./reflection.js";

const svc = () => ({ embed: async (t: string) => Float32Array.from([0.1, 0.2, 0.3, t.length % 7]) });

describe("embedForLifecycle（R1 单一源 helper）", () => {
  it("T1 嵌入成功返回向量", async () => {
    const v = await embedForLifecycle(svc(), "内容", "[t]", undefined);
    expect(v).toBeInstanceOf(Float32Array);
  });
  it("T2 embed 抛错回退 undefined（不阻塞写链）", async () => {
    const bad = { embed: async () => { throw new Error("429"); } };
    const v = await embedForLifecycle(bad, "内容", "[t]", undefined);
    expect(v).toBeUndefined();
  });
  it("T3 无 service 返回 undefined", async () => {
    const v = await embedForLifecycle(undefined, "内容", "[t]", undefined);
    expect(v).toBeUndefined();
  });
});

describe("runReflection 源头嵌入（R1）", () => {
  const baseDeps = (upsertL1: (r: unknown, e: unknown) => boolean, embedSvc: { embed(t: string): Promise<Float32Array> } | undefined) => ({
    queryL1: async () => [
      { id: "m1", type: "episodic", significance: 200, content: "样本内容", updatedAt: "2026-09-27T10:00:00Z", teamId: "t", userId: "u", agentId: "a" },
    ] as never[],
    llmRunner: { run: async () => JSON.stringify([{ question: "Q?", conclusion: "反思结论内容", evidence: ["m1"] }]) },
    config: { enabled: true, rRef: 150 },
    store: { upsertL1 },
    embeddingService: embedSvc,
    logger: undefined,
  } as never);

  it("T4 写入时第二参携带向量（源头嵌入）", async () => {
    let captured: unknown = "sentinel";
    const res = await runReflection(baseDeps((_r, e) => { captured = e; return true; }, svc()));
    expect(res.cardsWritten).toBe(1);
    expect(captured).toBeInstanceOf(Float32Array);
  });

  it("T5 embed 失败仍写入（第二参 undefined，产物不丢）", async () => {
    let captured: unknown = "sentinel";
    let wrote = false;
    const bad = { embed: async () => { throw new Error("quota"); } };
    const res = await runReflection(baseDeps((_r, e) => { captured = e; wrote = true; return true; }, bad));
    expect(res.cardsWritten).toBe(1);
    expect(wrote).toBe(true);
    expect(captured).toBeUndefined();
  });
});
