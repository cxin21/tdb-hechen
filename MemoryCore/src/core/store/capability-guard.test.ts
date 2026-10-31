/**
 * #152 ①：store 能力位（l1_fact_vec）+ WARN-once 守卫。
 *
 * 合同：
 *   C1 sqlite 声明 l1FactVec=true（有 upsertL1FactVector/searchL1FactVector）；tcvdb 声明 false；
 *   C2 能力位为 true 才算可用；undefined（老 store/mock）按不可用处理（fail-closed）；
 *   C3 不可用时 WARN 一次（同 capability+impact 不重复刷屏），返回 false → 调用点显式跳过；
 *   C4 getCapabilities 抛错不炸调用方（按不可用处理）。
 */
import { describe, it, expect, vi, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VectorStore } from "./sqlite.js";
import { TcvdbMemoryStore } from "./tcvdb.js";
import { ensureCapability, ensureL1FactVec, __resetCapabilityWarnings } from "./capability-guard.js";

const dirs: string[] = [];
async function mkStore(): Promise<VectorStore> {
  const dir = mkdtempSync(join(tmpdir(), "tdb-capability-152-"));
  dirs.push(dir);
  const st = new VectorStore(join(dir, "v.db"), 0);
  await st.init();
  return st;
}
afterAll(() => {
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* 临时目录清理尽力而为 */ }
  }
});

describe("#152 ① 能力位声明", () => {
  it("C1 sqlite l1FactVec=true；事实向量方法真实存在（能力位不撒谎）", async () => {
    const st = await mkStore();
    const caps = st.getCapabilities();
    expect(caps.l1FactVec).toBe(true);
    expect(typeof st.upsertL1FactVector).toBe("function");
    expect(typeof st.searchL1FactVector).toBe("function");
  });

  it("C1b tcvdb l1FactVec=false；且确实没有事实向量方法（对照）", () => {
    const fake = { bm25Encoder: null, embeddingEnabled: true, degraded: false };
    const caps = TcvdbMemoryStore.prototype.getCapabilities.call(fake as never);
    expect(caps.l1FactVec).toBe(false);
    expect(typeof (TcvdbMemoryStore.prototype as unknown as Record<string, unknown>).upsertL1FactVector).toBe("undefined");
    expect(typeof (TcvdbMemoryStore.prototype as unknown as Record<string, unknown>).searchL1FactVector).toBe("undefined");
  });
});

describe("#152 ① WARN-once 守卫", () => {
  it("C2 能力位 true → 可用且零告警；false/undefined → 不可用（fail-closed）", () => {
    __resetCapabilityWarnings();
    const warn = vi.fn();
    expect(ensureCapability({ vectorSearch: true, ftsSearch: true, nativeHybridSearch: false, sparseVectors: false, l1FactVec: true }, "l1FactVec", "skip", { warn })).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    expect(ensureCapability({ vectorSearch: true, ftsSearch: true, nativeHybridSearch: false, sparseVectors: false, l1FactVec: false }, "l1FactVec", "skip", { warn })).toBe(false);
    expect(ensureCapability({ vectorSearch: true, ftsSearch: true, nativeHybridSearch: false, sparseVectors: false }, "l1FactVec", "skip", { warn })).toBe(false);
    expect(ensureCapability(undefined, "l1FactVec", "skip", { warn })).toBe(false);
  });

  it("C3 同一能力+后果只 WARN 一次（每轮 recall 不刷屏）", () => {
    __resetCapabilityWarnings();
    const warn = vi.fn();
    const store = { getCapabilities: () => ({ vectorSearch: true, ftsSearch: true, nativeHybridSearch: false, sparseVectors: false, l1FactVec: false }) };
    expect(ensureL1FactVec(store, { warn })).toBe(false);
    expect(ensureL1FactVec(store, { warn })).toBe(false);
    expect(ensureL1FactVec(store, { warn })).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("l1FactVec");
  });

  it("C4 getCapabilities 缺失/抛错 → 不可用且不炸调用方（WARN 说明后果）", () => {
    __resetCapabilityWarnings();
    const warn = vi.fn();
    expect(ensureL1FactVec(undefined, { warn })).toBe(false);
    expect(ensureL1FactVec({}, { warn })).toBe(false);
    expect(ensureL1FactVec({ getCapabilities: () => { throw new Error("boom"); } }, { warn })).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1); // 三次都是同一 capability+impact → 只一条
    expect(String(warn.mock.calls[0][0])).toContain("l1_fact_vec");
  });
});
