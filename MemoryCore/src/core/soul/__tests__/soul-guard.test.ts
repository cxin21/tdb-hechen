import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireProcessLock, chargeCall, openCostBudget, planItemRollback, redactSecrets } from "../guard.js";

describe("生产护栏", () => {
  it("第二个进程拿不到锁", () => {
    const dir = mkdtempSync(join(tmpdir(), "soul-lock-"));
    const path = join(dir, "soul.lock");
    const a = acquireProcessLock(path, "2026-11-06T01:00:00.000Z");
    expect(existsSync(path)).toBe(true);
    expect(() => acquireProcessLock(path)).toThrow(/soul lock held/);
    a.release();
    const b = acquireProcessLock(path);
    b.release();
  });

  it("LLM 调用超过预算就拒绝，不靠模型自己停", () => {
    const b = openCostBudget(1);
    expect(chargeCall(b)).toBe(true);
    expect(chargeCall(b)).toBe(false);
    expect(openCostBudget(0).maxCalls).toBe(0);
    expect(chargeCall(openCostBudget(0))).toBe(false);
  });

  it("密钥进 prompt 前被换成占位", () => {
    const raw = "token: sk-abcDEF12345678 以及 Bearer xyz.abc.tokenvalue api_key=supersecret";
    const out = redactSecrets(raw);
    expect(out).not.toContain("sk-abc");
    expect(out).not.toContain("supersecret");
    expect(out).toContain("[REDACTED]");
  });

  it("条目回滚只动点名的，坏 JSON 不猜测", () => {
    const plan = planItemRollback(
      [{ itemId: "a" }, { itemId: "b" }],
      [
        { itemId: "a", beforeJson: JSON.stringify({ itemId: "a", text: "旧" }) },
        { itemId: "b", beforeJson: null },
        { itemId: "c", beforeJson: "{bad" },
      ],
    );
    expect(plan.restore).toEqual([{ itemId: "a", text: "旧" }]);
    expect(plan.remove).toEqual(["b"]);
    expect(plan.skipped).toEqual(["c"]);
  });
});
