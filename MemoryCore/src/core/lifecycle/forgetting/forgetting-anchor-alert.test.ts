/**
 * P0-C（2026-11-07）：遗忘的锚保护源不能静默降级。
 *
 * 背景：core_values 删表后 valuesAnchor 恒 0，生产日志只剩
 * `[forgetting] ran: ... valuesAnchor=0`，看上去像「保护正常、命中 0」，实际是来源不存在。
 * 现在：① 锚名来源改用 soul_persona 的对象名（personaAnchor）；② 一个都取不到时
 * 一次 warn + 一条 soul_ledger alert（code=forgetting_values_protection_unavailable，6h 抑制）。
 */
import { describe, expect, it, vi } from "vitest";
import { FORGETTING_ANCHOR_ALERT, runForgetting } from "./forgetting-worker.js";
import { DEFAULT_FORGETTING_CONFIG } from "./scorer.js";

const NOW_MS = Date.now();
const RECENT = new Date(NOW_MS - 3_600_000).toISOString();
const STALE = new Date(NOW_MS - 7 * 3_600_000).toISOString();

function rec(id: string, refs: Record<string, unknown> = {}) {
  return {
    id,
    record_id: id,
    priority: 0,
    metadata: refs,
    timestamps: ["2026-01-01T00:00:00Z"],
    certainty: "observed",
    content: "x",
  };
}

type Ledger = { action: string; at: string; gates: string[]; entryId: string; reason: string };

function makeStore(opts: { ledger?: Ledger[]; persona?: Array<{ meta?: Record<string, unknown> }> } = {}) {
  const writes: Array<{ upsert: unknown[]; ledger: Ledger[] }> = [];
  const store = {
    archiveL1: vi.fn(() => true),
    readCore: async () => [],
    listSoulPersona: async () => opts.persona ?? [],
    listSoulLedger: async () => opts.ledger ?? [],
    commitSoulPersona: vi.fn(async (_t: unknown, plan: { upsert: unknown[]; ledger: Ledger[] }) => {
      writes.push(plan);
      return { upserted: 0, ledgered: plan.ledger.length };
    }),
  };
  return { store, writes };
}

describe("P0-C 锚保护源不可用时必须显式告警", () => {
  it("personaAnchor=0 → 一次 warn + 一条 soul_ledger alert（同 6h 窗口不重复写）", async () => {
    const { store, writes } = makeStore();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await runForgetting({
      queryL1: () => [rec("r1")],
      config: { ...DEFAULT_FORGETTING_CONFIG, refProtection: true },
      store: store as never,
      logger,
    });

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0]![0])).toContain("锚保护源不可用");
    expect(String(logger.warn.mock.calls[0]![0])).toContain("personaAnchor=0");

    expect(writes).toHaveLength(1);
    const entry = writes[0]!.ledger[0]!;
    expect(entry.action).toBe("alert");
    expect(entry.gates).toEqual([FORGETTING_ANCHOR_ALERT]);
    expect(store.commitSoulPersona).toHaveBeenCalledTimes(1);
  });

  it("近 6h 已写过同 code 的 alert → 不再 warn、不再写账本", async () => {
    const { store, writes } = makeStore({
      ledger: [
        {
          entryId: "alert-forgetting-anchor-x",
          at: RECENT,
          action: "alert",
          gates: [FORGETTING_ANCHOR_ALERT],
          reason: "previous",
        },
      ],
    });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await runForgetting({
      queryL1: () => [rec("r1")],
      config: { ...DEFAULT_FORGETTING_CONFIG, refProtection: true },
      store: store as never,
      logger,
    });
    expect(logger.warn).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it("6h 之前的旧 alert 已经不抑制 → 重新告警一次", async () => {
    const { store, writes } = makeStore({
      ledger: [
        {
          entryId: "alert-forgetting-anchor-old",
          at: STALE,
          action: "alert",
          gates: [FORGETTING_ANCHOR_ALERT],
          reason: "old",
        },
      ],
    });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await runForgetting({
      queryL1: () => [rec("r1")],
      config: { ...DEFAULT_FORGETTING_CONFIG, refProtection: true },
      store: store as never,
      logger,
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(writes).toHaveLength(1);
  });

  it("soul_persona 提供对象名 → personaAnchor 生效，coreRefs 命中即不归档", async () => {
    const { store, writes } = makeStore({ persona: [{ meta: { object: "数据隐私" } }, { meta: { object: "他" } }] });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const res = await runForgetting({
      queryL1: () => [rec("protected", { coreRefs: ["数据隐私"] }), rec("dangling", { coreRefs: ["已退休锚"] })],
      config: { ...DEFAULT_FORGETTING_CONFIG, refProtection: true },
      store: store as never,
      logger,
    });
    expect(res.candidates).toEqual(["dangling"]);
    // 有锚名 = 保护可用：既不告警也不写 alert，日志字段报 personaAnchor=1（「他」太短被拒）。
    expect(logger.warn).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
    expect(String(logger.info.mock.calls[0]![0])).toContain("personaAnchor=1");
  });

  it("日志字段改名：不再出现 valuesAnchor=", async () => {
    const { store } = makeStore({ persona: [{ meta: { object: "数据隐私" } }] });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await runForgetting({
      queryL1: () => [rec("r1")],
      config: { ...DEFAULT_FORGETTING_CONFIG, refProtection: true },
      store: store as never,
      logger,
    });
    const line = String(logger.info.mock.calls[0]![0]);
    expect(line).toContain("personaAnchor=");
    expect(line).not.toContain("valuesAnchor=");
  });
});
