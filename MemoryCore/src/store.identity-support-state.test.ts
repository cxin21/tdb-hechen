/**
 * A-7b store 层 RED→GREEN：identity 状态 kv 必须持久化 supportMap。
 * 旧 setIdentityDiscoveryState 只写两键、getIdentityDiscoveryState 只读两键——
 * 写入侧 supportMap 被静默丢弃（ev15 实证：adoption 侧写了、MAINT 读不到 → 回退滑窗假阳）。
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VectorStore } from "./core/store/sqlite.js";
import type { CoreTenant } from "./core/store/types.js";

const cleanup: string[] = [];
afterEach(() => { while (cleanup.length) rmSync(cleanup.pop()!, { recursive: true, force: true }); });

async function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "a7b-state-"));
  cleanup.push(dir);
  const s = new VectorStore(join(dir, "v.db"), 0);
  await s.init();
  return s;
}
const T: CoreTenant = { teamId: "ev15-team", userId: "ev15-user-a", agentId: "ev15-agent-a" };

describe("A-7b identity 状态 kv 持久化 supportMap", () => {
  it("set→get roundtrip 保留 supportMap（RED：旧实现静默丢弃）", async () => {
    const s = await makeStore();
    s.setIdentityDiscoveryState({ lastAttemptAt: "2026-09-20T14:00:00Z", lastCorpusCount: 5, supportMap: { "事实A": ["m1", "m2"] } }, T);
    const st = s.getIdentityDiscoveryState(T);
    expect(st.lastAttemptAt).toBe("2026-09-20T14:00:00Z");
    expect(st.lastCorpusCount).toBe(5);
    expect(st.supportMap?.["事实A"]).toEqual(["m1", "m2"]);
  });

  it("不带 supportMap 的旧形状写入照常（回归控制）", async () => {
    const s = await makeStore();
    s.setIdentityDiscoveryState({ lastAttemptAt: "2026-09-20T15:00:00Z", lastCorpusCount: 3 }, T);
    const st = s.getIdentityDiscoveryState(T);
    expect(st.lastAttemptAt).toBe("2026-09-20T15:00:00Z");
    expect(st.supportMap).toBeUndefined();
  });
});
