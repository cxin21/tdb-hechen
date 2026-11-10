/**
 * P0-2（2026-11-08 v4）：门拒计数与告警抑制。
 *
 * 生产实测（24h）：soul_ledger 785 行，其中 reject 704 行；告警抑制读
 * listSoulLedger(200) 只覆盖约 3.6h < 6h 抑制窗，同一 code 13h 落 14 条。
 *
 * 这批用例锁三件事：
 *  1) 同一候选连续 3 tick 被门拒 → 账本 reject 行 0、soul_gate_stats 该 (day,code,layer) 计 3；
 *  2) 先写一条 alert、再插 700 条其它账本行，同 code 的 6h 判定仍为「已发」，不再写第二条；
 *  3) 统计口径与内存 rejections 完全一致（不是「大概写了点东西」）。
 *
 * 只碰临时目录里的临时 SQLite（禁用生产库）。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseConfig } from "../../../config.js";
import { createStoreBundle } from "../../store/factory.js";
import { resolveSoulConfig, type SoulLedgerEntry } from "../types.js";
import { runSoulMaintenance, type SoulEvidenceRecord } from "../worker.js";

const TENANT = { teamId: "t-gate", userId: "u-gate", agentId: "a-gate" };

let dataDir: string;
let bundle: Awaited<ReturnType<typeof createStoreBundle>>;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "tdai-soul-gate-"));
  bundle = createStoreBundle(parseConfig({}), { dataDir });
  (bundle.store as unknown as { init?: () => unknown }).init?.();
});

afterEach(async () => {
  await bundle.store.close?.();
  await rm(dataDir, { recursive: true, force: true });
});

const RECORDS: SoulEvidenceRecord[] = [
  { id: "r1", content: "我把召回链路的空结果定位到投影漏列，先取证再改代码。", valence: -0.2, arousal: 0.4 },
  { id: "r2", content: "评审被打回时我没有辩解，直接认领笔误并重跑门禁。", valence: -0.3, arousal: 0.3 },
];

function tick(now: string) {
  return runSoulMaintenance({
    store: bundle.store,
    tenant: TENANT,
    now,
    trigger: "manual",
    config: resolveSoulConfig({ updateIntervalHours: 0 }),
    recentRecords: async () => RECORDS,
    // 有立场（我认为），但没有任何 ep-* 出处 → 正向判据必须拦下。
    rewriter: async () => [{ layer: "identity", text: "我认为证据比速度重要", evidenceIds: ["r1", "r2", "r3"] }],
  });
}

describe("门拒计数（P0-2）", () => {
  it("同一候选连续 3 tick 被拒：账本 reject 行 0，soul_gate_stats 计数 3", async () => {
    const ticks = ["2026-11-08T01:00:00.000Z", "2026-11-08T02:00:00.000Z", "2026-11-08T03:00:00.000Z"];
    // 内存侧聚合（判据：统计必须与真实 rejections 逐 code 对齐，不能只写「有点数」）。
    const expected = new Map<string, number>();
    let targetCode = "";
    for (const now of ticks) {
      const rep = await tick(now);
      expect(rep.admitted).toBe(0);
      const rej = rep.rejections.find((r) => r.layer === "identity" && r.text.includes("证据比速度重要"));
      expect(rej).toBeTruthy();
      expect(rej!.codes.length).toBeGreaterThan(0);
      // 同一候选 3 轮都命中同一个门（否则计数会落到不同 code 上，无法复验）。
      if (targetCode === "") targetCode = rej!.codes[0];
      expect(rej!.codes).toContain(targetCode);
      for (const r of rep.rejections) {
        for (const code of r.codes.length > 0 ? r.codes : ["unknown"]) {
          const key = `${r.layer}|${code}`;
          expected.set(key, (expected.get(key) ?? 0) + 1);
        }
      }
    }

    // ① 账本里不再有 reject 行（P0-2 的核心断言）。
    const ledger = await bundle.store.listSoulLedger!(TENANT, 1000);
    expect(ledger.some((e) => e.action === "reject")).toBe(false);

    // ② gate_stats 的每一行都等于内存 rejections 的聚合。
    const stats = await bundle.store.listSoulGateStats!(TENANT, { sinceDay: "2026-11-08" });
    expect(stats.length).toBe(expected.size);
    for (const [key, count] of expected) {
      const [layer, code] = key.split("|");
      const row = stats.find((s) => s.layer === layer && s.code === code && s.day === "2026-11-08");
      expect(row, `缺少 ${key} 的统计行`).toBeTruthy();
      expect(row!.count).toBe(count);
    }

    // ③ 该候选自己的 (day, code, layer) 恰好计 3（3 tick × 1 次）。
    const target = stats.find((s) => s.layer === "identity" && s.code === targetCode && s.day === "2026-11-08");
    expect(target?.count).toBe(3);
    // 跨轮拒绝分布读的是这张表：soulRejectionStats 必须能看到同一个 code。
    const history = await bundle.store.soulRejectionStats!(TENANT, { sinceDays: 30 });
    expect(history.find((h) => h.code === targetCode)?.count).toBeGreaterThanOrEqual(3);
  });
});

function ledgerRow(id: string, at: string): SoulLedgerEntry {
  return {
    entryId: id,
    at,
    trigger: "manual",
    layer: "all",
    action: "admit",
    gates: ["ok"],
    reason: "噪声行",
    evidenceIds: [],
  };
}

describe("告警抑制（P0-2）", () => {
  const lines = Array.from(
    { length: 20 },
    (_, i) => `This is English line number ${i} about the weather and lunch.`,
  );

  function runLang(now: string) {
    return runSoulMaintenance({
      store: bundle.store,
      tenant: TENANT,
      now,
      trigger: "manual",
      config: resolveSoulConfig({ episodeWindowDays: 30, updateIntervalHours: 0 }),
      llmCallBudget: 0,
      recentRecords: async () => lines.map((text, i) => ({ id: `r-${i}`, content: text })),
    });
  }

  it("700 条其它账本行之后，同 code 的 alert 仍判「6h 内已发」→ 不写第二条", async () => {
    const firstAt = "2026-11-08T01:00:00.000Z";
    const first = await runLang(firstAt);
    expect((first.alerts ?? []).find((a) => a.code === "language_unmapped")).toBeTruthy();

    // 插 700 条噪声账本（模拟生产：reject 行曾把 200 行窗口挤出真实告警）。
    const noise = Array.from({ length: 700 }, (_, i) =>
      ledgerRow(`noise-${i}`, new Date(Date.parse(firstAt) + (i + 1) * 1000).toISOString()),
    );
    await bundle.store.commitSoulPersona!(TENANT, { upsert: [], ledger: noise });

    // 抑制判据直接查库，不再受 200 行窗口限制。
    const since = new Date(Date.parse(firstAt) + 30 * 60_000 - 6 * 3_600_000).toISOString();
    expect(await bundle.store.hasSoulAlertSince!(TENANT, "language_unmapped", since)).toBe(true);
    expect(await bundle.store.hasSoulAlertSince!(TENANT, "no_such_code", since)).toBe(false);

    // 30 分钟后同 code 再 tick：report 仍如实给出告警，但账本不追加第二条。
    const second = await runLang("2026-11-08T01:30:00.000Z");
    expect((second.alerts ?? []).find((a) => a.code === "language_unmapped")).toBeTruthy();
    const ledger = await bundle.store.listSoulLedger!(TENANT, 1000);
    const alerts = ledger.filter(
      (e) => e.action === "alert" && Array.isArray(e.gates) && e.gates.includes("language_unmapped"),
    );
    expect(alerts).toHaveLength(1);
  });
});
