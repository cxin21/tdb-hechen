import { test, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWikiSourceManager } from "../src/engines/wiki/manager.js";

/** FTS-only manager（embedding=null）：register 后轮询直至检索到期望条数。 */
async function makeManager(dir: string, reranker?: unknown, pollCount = 3) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mgr = (createWikiSourceManager as any)(join(dir, "_engine"), null, reranker ? { reranker } : undefined);
  const wikiId = "wk-rr-" + Math.random().toString(36).slice(2);
  mgr.register({ name: wikiId, path: dir });
  const deadline = Date.now() + 4000;
  let baseline: any[] = [];
  while (Date.now() < deadline) {
    const r = await mgr.search(wikiId, "燕京", 10);
    if (r.results.length >= pollCount) { baseline = r.results; break; }
    await new Promise((r) => setTimeout(r, 40));
  }
  return { mgr, wikiId, baseline };
}

async function safeRemove(mgr: any, wikiId: string) {
  try { mgr?.remove(wikiId); } catch { /* best-effort 释放连接 */ }
}

function seedWiki(dir: string) {
  mkdirSync(join(dir, "wiki"), { recursive: true });
  writeFileSync(join(dir, "wiki", "a.md"), "# 燕京库存规范\n\n燕京啤酒库存管理规范：出入库流程与库存盘点要求。", "utf-8");
  writeFileSync(join(dir, "wiki", "b.md"), "# 燕京订单规范\n\n燕京啤酒订单管理规范：下单、审单与订单关闭。", "utf-8");
  writeFileSync(join(dir, "wiki", "c.md"), "# 燕京报表规范\n\n燕京啤酒报表规范：报表口径与导出要求。", "utf-8");
}

async function rmSyncRetry(dir: string, tries = 20): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try { rmSync(dir, { recursive: true, force: true }); return; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "EBUSY" || i === tries - 1) throw e; }
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** 固定目标序 fake：按 doc 首行标题映射到期望排名，分数降序。 */
function fixedOrderReranker(desiredTitles: string[], calls: string[][]) {
  return {
    rerank: async (_q: string, docs: string[]) => {
      calls.push([...docs]);
      return docs.map((d, i) => {
        const title = d.split("\n")[0];
        const rank = desiredTitles.indexOf(title);
        return { index: i, score: rank >= 0 ? desiredTitles.length - rank : -1 };
      });
    },
  };
}

async function makePair(reranker?: unknown) {
  const dirA = mkdtempSync(join(tmpdir(), "wikirr-a-"));
  const dirB = mkdtempSync(join(tmpdir(), "wikirr-b-"));
  seedWiki(dirA);
  seedWiki(dirB);
  const ctrl = await makeManager(dirA); // 无 reranker 基线
  const test = await makeManager(dirB, reranker);
  const cleanup = async () => {
    await safeRemove(ctrl.mgr, ctrl.wikiId);
    await safeRemove(test.mgr, test.wikiId);
    await rmSyncRetry(dirA);
    await rmSyncRetry(dirB);
  };
  return { ctrl, test, cleanup };
}

test("rerank 注入：重排生效、rerankScore 附加、score 保留原融合分、docs 传 title+snippet", async () => {
  const calls: string[][] = [];
  const { ctrl, test: t, cleanup } = await makePair(fixedOrderReranker(["燕京订单规范", "燕京库存规范", "燕京报表规范"], calls));
  try {
    expect(ctrl.baseline).toHaveLength(3);
    const baseTitles = ctrl.baseline.map((r: any) => r.title);
    const out = await t.mgr.search(t.wikiId, "燕京", 10);
    expect(out.results.map((r: any) => r.title)).toEqual(["燕京订单规范", "燕京库存规范", "燕京报表规范"]);
    // docs 喂给 reranker：首行是标题（title + snippet）；docs 顺序=融合序（按 title 映射得分）
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[calls.length - 1]).toHaveLength(3);
    expect(calls[calls.length - 1][0]).toMatch(/^燕京(订单|库存|报表)规范\n/);
    // rerankScore 附加 + score 保留原分
    const baseScore = new Map(ctrl.baseline.map((r: any) => [r.title, r.score]));
    for (const r of out.results) {
      expect(typeof r.rerankScore).toBe("number");
      expect(r.score).toBe(baseScore.get(r.title));
    }
    // 基线顺序 != 结果顺序（证明真的发生了重排，而非巧合同序）
    expect(baseTitles).not.toEqual(out.results.map((r: any) => r.title));
  } finally { await cleanup(); }
});

test("rerank 返回乱序结果（未按分降序）→ manager 侧重排为分降序", async () => {
  const rr = { rerank: async () => [{ index: 2, score: 1 }, { index: 0, score: 9 }, { index: 1, score: 5 }] };
  const { ctrl, test: t, cleanup } = await makePair(rr);
  try {
    const baseTitles = ctrl.baseline.map((r: any) => r.title);
    const out = await t.mgr.search(t.wikiId, "燕京", 10);
    expect(out.results.map((r: any) => r.title)).toEqual([baseTitles[0], baseTitles[1], baseTitles[2]]);
  } finally { await cleanup(); }
});

test("rerank 返回 null（降级）→ 顺序与无 reranker 基线一致", async () => {
  const rr = { rerank: async () => null };
  const { ctrl, test: t, cleanup } = await makePair(rr);
  try {
    const out = await t.mgr.search(t.wikiId, "燕京", 10);
    expect(out.results.map((r: any) => r.title)).toEqual(ctrl.baseline.map((r: any) => r.title));
    expect(out.results.every((r: any) => r.rerankScore === undefined)).toBe(true);
  } finally { await cleanup(); }
});

test("rerank 抛错 → 降级原序，不炸检索", async () => {
  const rr = { rerank: async () => { throw new Error("boom"); } };
  const { ctrl, test: t, cleanup } = await makePair(rr);
  try {
    const out = await t.mgr.search(t.wikiId, "燕京", 10);
    expect(out.results.map((r: any) => r.title)).toEqual(ctrl.baseline.map((r: any) => r.title));
  } finally { await cleanup(); }
});

test("单结果检索 → 不触发 rerank（guard: results.length>1）", async () => {
  const calls: string[][] = [];
  const rr = { rerank: async (_q: string, docs: string[]) => { calls.push([...docs]); return docs.map((d, i) => ({ index: i, score: docs.length - i })); } };
  const dir = mkdtempSync(join(tmpdir(), "wikirr-c-"));
  let mgr: any; let wikiId = "";
  try {
    mkdirSync(join(dir, "wiki"), { recursive: true });
    writeFileSync(join(dir, "wiki", "a.md"), "# 燕京库存规范\n\n燕京库存。", "utf-8");
    writeFileSync(join(dir, "wiki", "b.md"), "# 无关主题\n\n完全不相关的内容词汇。", "utf-8");
    const m = await makeManager(dir, rr, 1);
    mgr = m.mgr; wikiId = m.wikiId;
    await m.mgr.search(m.wikiId, "库存", 10);
    // 等一拍防异步迟到调用
    await new Promise((r) => setTimeout(r, 100));
    expect(calls).toHaveLength(0);
  } finally {
    await safeRemove(mgr, wikiId);
    await rmSyncRetry(dir);
  }
});
