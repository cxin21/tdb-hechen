/**
 * 判据 9 的写侧验收（spec §5 超限处理① ②）：
 * 红线 active 100% 进 strict_rule；相似行合并（不新增行、保留更早 createdAt）；
 * 仍超 30 行/2600 字 → 按「最近追加优先」截断渲染并记账本，绝不物理删除；
 * 同一份超限输入连续 tick 不重复刷账本（按合并签名去重）。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseConfig } from "../../../config.js";
import { createStoreBundle } from "../../store/factory.js";
import { clampRedlines, mergeDuplicateRedlines, redlineSimilarity } from "../card.js";
import { resolveSoulConfig } from "../types.js";
import { runSoulMaintenance } from "../worker.js";

const TENANT = { teamId: "t9", userId: "u9", agentId: "a9" };

describe("红线合并纯函数", () => {
  it("去标点后相等 / 二元组相似 ≥0.85 / 互为连续子串 → 只留更早一条，保留更早 createdAt", () => {
    const rows = [
      { text: "绝不可删除任何生产记忆记录", active: true, createdAt: "2026-10-01T00:00:00.000Z" },
      { text: "绝不可删除任何生产记忆记录。", active: true, createdAt: "2026-11-01T00:00:00.000Z" },
      { text: "绝不可删除任何生产记忆记录，包括备份", active: true, createdAt: "2026-11-02T00:00:00.000Z" },
      { text: "不许把密钥写进日志", active: true, createdAt: "2026-11-03T00:00:00.000Z" },
    ];
    expect(redlineSimilarity(rows[0].text, rows[1].text)).toBe(1);
    const out = mergeDuplicateRedlines(rows);
    expect(out.rows.map((r) => r.text)).toEqual(["绝不可删除任何生产记忆记录", "不许把密钥写进日志"]);
    expect(out.merged).toHaveLength(2);
    expect(out.rows[0].createdAt).toBe("2026-10-01T00:00:00.000Z");
  });

  it("被置 active=false 的旧行不参与合并、也不进 strict_rule", () => {
    const out = mergeDuplicateRedlines([
      { text: "不虚报", active: false, createdAt: "2026-09-01T00:00:00.000Z" },
      { text: "不虚报进度", active: true, createdAt: "2026-10-01T00:00:00.000Z" },
    ]);
    expect(out.rows.map((r) => r.text)).toEqual(["不虚报进度"]);
  });
});

describe("红线超限只有截断渲染 + 告警，不删行（判据 9）", () => {
  it("31 行 → 30 行、告警 1 条；总字符超 2600 → 拒收最新一条渲染", () => {
    const rows = Array.from({ length: 31 }, (_, i) => ({ text: `第 ${i + 1} 条红线：不做没有人复核的破坏性操作。`, active: true, createdAt: "2026-11-01T00:00:00.000Z" }));
    const warnings: string[] = [];
    const lines = clampRedlines(rows, warnings);
    expect(lines).toHaveLength(30);
    // 声明优先：用户最早立的边界排在最前，超限时被拒收的是最新追加的那条。
    expect(lines[0]).toContain("第 1 条红线");
    expect(lines[29]).toContain("第 30 条红线");
    expect(warnings.some((w) => w.includes("超过 30 行"))).toBe(true);

    // 40 条：只丢最新 10 条（#31..#40），#1..#30 逐条保留。
    const forty = Array.from({ length: 40 }, (_, i) => ({ text: `第 ${i + 1} 条红线：不做没有人复核的破坏性操作。`, active: true, createdAt: "2026-11-01T00:00:00.000Z" }));
    const w40: string[] = [];
    const kept40 = clampRedlines(forty, w40);
    expect(kept40).toHaveLength(30);
    expect(kept40[0]).toContain("第 1 条红线");
    expect(kept40[29]).toContain("第 30 条红线");
    expect(kept40.some((t) => /第 (3[1-9]|40) 条红线/u.test(t))).toBe(false);
    expect(w40.some((w) => w.includes("拒收最新 10 行"))).toBe(true);

    // 总字符超限同样从尾巴拒收：更早的（甲）留、最新的（丙）先让。
    const long = [
      { text: "甲".repeat(1000), active: true, createdAt: "2026-11-01T00:00:00.000Z" },
      { text: "乙".repeat(1000), active: true, createdAt: "2026-11-02T00:00:00.000Z" },
      { text: "丙".repeat(1000), active: true, createdAt: "2026-11-03T00:00:00.000Z" },
    ];
    const w2: string[] = [];
    const kept = clampRedlines(long, w2);
    expect(kept.length).toBeLessThan(3);
    expect(kept[0]!.startsWith("甲")).toBe(true);
    expect(w2.some((w) => w.includes("总字符超过"))).toBe(true);
  });
});

describe("worker 投影：32 条红线 → strict_rule 30 行 + 账本可追（S6 判据 9）", () => {
  let dataDir: string;
  let bundle: Awaited<ReturnType<typeof createStoreBundle>>;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "tdai-soul-redline-"));
    bundle = createStoreBundle(parseConfig({}), { dataDir });
    (bundle.store as unknown as { init?: () => unknown }).init?.();
  });

  afterEach(async () => {
    await bundle.store.close?.();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("超出上限时记账本、可回放，第二 tick 不重复刷；strict_rule 不物理删除任何行", async () => {
    // 32 条互不相似的线（各带独有字，避免被合并门吃掉），只测行数上限。
    const uniq = (i: number) => String.fromCharCode(0x4e00 + i * 3, 0x4e00 + i * 7, 0x4e00 + i * 11);
    const redlines = Array.from({ length: 32 }, (_, i) => ({
      text: `${uniq(i)}${uniq(i + 1)}：做没做都说实话`,
      active: true,
      createdAt: `2026-11-0${(i % 9) + 1}T00:00:00.000Z`,
    }));
    const deps = {
      store: bundle.store,
      tenant: TENANT,
      config: resolveSoulConfig({}),
      trigger: "lifecycle" as const,
      now: "2026-11-07T06:00:00.000Z",
      llmCallBudget: 0,
      readAgentProfile: async () => ({ name: "何晨", redlines }),
    };
    const first = await runSoulMaintenance(deps as never);
    expect(first.redlines).toMatchObject({ active: 32, projected: 30, retired: 1 });
    const slots = await Promise.resolve(bundle.store.readCore!(TENANT));
    const strict = slots.find((s) => s.slot === "strict_rule");
    expect(strict?.content.split("\n")).toHaveLength(30);
    // 声明优先：32 → 30 时拒收最新两条（#31/#32），最早立的 #1/#2 必须还在。
    expect(strict?.content).toContain(`${uniq(0)}${uniq(1)}`);
    expect(strict?.content).not.toContain(`${uniq(30)}${uniq(31)}`);

    const ledger1 = await Promise.resolve(bundle.store.listSoulLedger!(TENANT, 200));
    expect(ledger1.filter((e) => e.action === "budget_omit").length).toBe(1);
    expect(ledger1.find((e) => e.action === "budget_omit")?.reason).toContain("不物理删除");

    const second = await runSoulMaintenance({ ...deps, now: "2026-11-07T06:05:00.000Z" } as never);
    expect(second.redlines).toMatchObject({ active: 32, projected: 30 });
    const ledger2 = await Promise.resolve(bundle.store.listSoulLedger!(TENANT, 200));
    expect(ledger2.filter((e) => e.action === "budget_omit").length).toBe(1);
  });
});
