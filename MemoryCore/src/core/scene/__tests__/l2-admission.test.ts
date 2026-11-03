/**
 * F2 · 全局速率门账本（l2-admission）RED 套件。
 *
 * 缺陷（m01638 F2）：生产 L2 走 state-backend timer → pipeline-worker →
 * executor.executeL2 → core.runL2WithStore，**不经过** MemoryPipelineManager
 * 的 timer 路径，所以 manager 里的全局门在生产上从未被调用：2026-11-02
 * 17:37 重启后 4 小时内出现 112 个 distinct scene-extract、44047 条 lock
 * conflict、0 条 `(reason=l2-throttle)`。
 *
 * 账本语义（票面要求）：
 *  - 滑动窗口（maxRunsPerHour）只记**真实运行**（records 被消费的轮次）；
 *  - 单轮桶（maxSessionsPerRound）记放行次数，被 skip 的放行要退还额度，
 *    否则无效放行会把桶长期占满、真活跑不进去；
 *  - 两个上限都 <=0 ⇒ 永远放行（逐位等于加门之前）。
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, beforeEach, vi } from "vitest";
import {
  admitL2Run,
  configureL2AdmissionPersistence,
  settleL2Run,
  getL2AdmissionSnapshot,
  resetL2Admission,
  isL2AdmissionEnabled,
  bootRecoveryWarnLine,
} from "../l2-admission.js";
import { L2_RUN_WINDOW_MS, L2_THROTTLE_ROUND_MS } from "../l2-gate.js";

const T0 = 1_800_000_000_000;

describe("F2 · l2-admission 账本", () => {
  beforeEach(() => resetL2Admission());

  it("两个上限都为 0 / 缺省 ⇒ 永远放行，且不记任何东西", () => {
    expect(isL2AdmissionEnabled(undefined)).toBe(false);
    expect(isL2AdmissionEnabled({})).toBe(false);
    expect(isL2AdmissionEnabled({ maxRunsPerHour: 0, maxSessionsPerRound: 0 })).toBe(false);

    for (let i = 0; i < 5; i++) {
      const d = admitL2Run({ maxRunsPerHour: 0, maxSessionsPerRound: 0 }, T0 + i);
      expect(d.admit).toBe(true);
      settleL2Run(true, T0 + i);
    }
    // 不限 = 不关心账本内容，但放行语义必须逐次成立
    expect(getL2AdmissionSnapshot().inFlight).toBe(0);
  });

  it("单轮桶：maxSessionsPerRound=2 时第 3 个被拦，且带 nextSlot/round 信息", () => {
    const limits = { maxSessionsPerRound: 2 };
    expect(admitL2Run(limits, T0).admit).toBe(true);
    expect(admitL2Run(limits, T0 + 1).admit).toBe(true);
    const denied = admitL2Run(limits, T0 + 2);
    expect(denied.admit).toBe(false);
    expect(denied.reason).toBe("l2-throttle");
    expect(denied.roundAdmitted).toBe(2);
    expect(denied.roundRemaining).toBe(0);
    expect(denied.roundStartedAtMs).toBe(T0);
  });

  it("单轮桶：被拦/跳过（settle(false)）的放行退还额度，下一轮桶外不可借、轮内可再放行", () => {
    const limits = { maxSessionsPerRound: 1 };
    expect(admitL2Run(limits, T0).admit).toBe(true);
    expect(admitL2Run(limits, T0 + 1).admit).toBe(false);
    settleL2Run(false, T0 + 2); // 本次放行其实没消费 records（被 A1 门 skip）
    expect(admitL2Run(limits, T0 + 3).admit).toBe(true);
    // 桶滚动后重新计数（新一轮从 0 开始，所以又能放行一个）
    expect(admitL2Run(limits, T0 + L2_THROTTLE_ROUND_MS + 1).admit).toBe(true);
    expect(admitL2Run(limits, T0 + L2_THROTTLE_ROUND_MS + 2).admit).toBe(false);
  });

  it("滑动窗口：maxRunsPerHour=1 时，settle(false) 不占窗口，settle(true) 占满", () => {
    const limits = { maxRunsPerHour: 1 };

    // 第一次放行但没真跑 → 退还，下一次仍可放行
    expect(admitL2Run(limits, T0).admit).toBe(true);
    settleL2Run(false, T0 + 10);
    expect(admitL2Run(limits, T0 + 20).admit).toBe(true);

    // 这次真跑 → 窗口占满
    settleL2Run(true, T0 + 30);
    const denied = admitL2Run(limits, T0 + 40);
    expect(denied.admit).toBe(false);
    expect(denied.windowUsed).toBe(1);
    expect(denied.nextSlotAtMs).toBe(T0 + 30 + L2_RUN_WINDOW_MS);

    // 窗口滚动后恢复
    expect(admitL2Run(limits, T0 + 30 + L2_RUN_WINDOW_MS + 1).admit).toBe(true);
  });

  it("in-flight 保守计入窗口：未结算的放行不能穿透额度", () => {
    const limits = { maxRunsPerHour: 1 };
    expect(admitL2Run(limits, T0).admit).toBe(true);
    const second = admitL2Run(limits, T0 + 1);
    expect(second.admit).toBe(false);
    expect(second.windowUsed).toBe(1);
    settleL2Run(false, T0 + 2);
  });

  it("快照是拷贝：外部改动不影响账本", () => {
    const limits = { maxRunsPerHour: 5 };
    admitL2Run(limits, T0);
    settleL2Run(true, T0 + 1);
    const snap = getL2AdmissionSnapshot();
    snap.runTimestamps.push(999);
    expect(getL2AdmissionSnapshot().runTimestamps).toHaveLength(1);
  });

  it("resetL2Admission 清空账本（测试间隔离）", () => {
    const limits = { maxRunsPerHour: 1 };
    admitL2Run(limits, T0);
    settleL2Run(true, T0 + 1);
    expect(admitL2Run(limits, T0 + 2).admit).toBe(false);
    resetL2Admission();
    expect(getL2AdmissionSnapshot()).toMatchObject({
      runTimestamps: [],
      inFlight: 0,
      roundAdmitted: 0,
      roundStartedAtMs: 0,
    });
    expect(admitL2Run(limits, T0 + 3).admit).toBe(true);
  });
});

describe("F2 · boot recovery 会话数告警（生产 live 路径）", () => {
  const limits = { maxRunsPerHour: 1, maxSessionsPerRound: 2, bootRecoveryWarnSessions: 50 };

  it("recovered 超过阈值 ⇒ 返回 WARN 行，含会话数/阈值/上限，能看出本次重启最多放行几次", () => {
    const line = bootRecoveryWarnLine(274, limits);
    expect(line).toBeTruthy();
    expect(line).toContain("274");
    expect(line).toContain("50");
    expect(line).toContain("maxRunsPerHour=1");
    expect(line).toContain("maxSessionsPerRound=2");
    expect(line).toContain("1 次/小时");
  });

  it("recovered 等于阈值 ⇒ 不告警（严格大于才告警）", () => {
    expect(bootRecoveryWarnLine(50, limits)).toBeNull();
    expect(bootRecoveryWarnLine(51, limits)).toBeTruthy();
  });

  it("上限全 0（门未开）时仍告警，但文案标明不限", () => {
    const line = bootRecoveryWarnLine(274, { ...limits, maxRunsPerHour: 0, maxSessionsPerRound: 0 });
    expect(line).toContain("274");
    expect(line).toContain("不限");
  });
});

describe("F2 · 账本持久化（重启后已消费的额度不丢）", () => {
  const dirs: string[] = [];

  function tmpLedgerFile(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "l2-ledger-"));
    dirs.push(dir);
    return path.join(dir, "l2-admission.json");
  }

  beforeEach(() => {
    resetL2Admission();
    configureL2AdmissionPersistence({ filePath: null });
  });

  afterEach(() => {
    configureL2AdmissionPersistence({ filePath: null });
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("重启后窗口内 runTimestamps 仍算已消费：重新注入路径即惰性加载，窗口立刻满", () => {
    const filePath = tmpLedgerFile();
    configureL2AdmissionPersistence({ filePath });
    expect(admitL2Run({ maxRunsPerHour: 1 }, T0).admit).toBe(true);
    settleL2Run(true, T0 + 10);

    // 模拟进程重启：内存清空（reset），再由调用方重新注入同一路径。
    resetL2Admission();
    configureL2AdmissionPersistence({ filePath });

    // 下一次使用时惰性加载：重启后的第一次 admit 必须看到重启前那次运行
    expect(admitL2Run({ maxRunsPerHour: 1 }, T0 + 20).admit).toBe(false);
    expect(getL2AdmissionSnapshot().runTimestamps).toEqual([T0 + 10]);
  });

  it("inFlight 不持久化：重启后账本 inFlight 归 0，未结算的放行不再占额度", () => {
    const filePath = tmpLedgerFile();
    configureL2AdmissionPersistence({ filePath });
    expect(admitL2Run({ maxRunsPerHour: 1 }, T0).admit).toBe(true);
    expect(getL2AdmissionSnapshot().inFlight).toBe(1);

    resetL2Admission();
    configureL2AdmissionPersistence({ filePath });
    expect(getL2AdmissionSnapshot().inFlight).toBe(0);
    expect(admitL2Run({ maxRunsPerHour: 1 }, T0 + 20).admit).toBe(true);
  });

  it("文件缺失 ⇒ 容错：不抛、从空账本起，且首次放行后自动建文件", () => {
    const filePath = tmpLedgerFile();
    configureL2AdmissionPersistence({ filePath });
    expect(admitL2Run({ maxRunsPerHour: 2 }, T0).admit).toBe(true);
    settleL2Run(true, T0 + 1);
    const persisted = JSON.parse(readFileSync(filePath, "utf8")) as { runTimestamps: number[] };
    expect(persisted.runTimestamps).toEqual([T0 + 1]);
  });

  it("JSON 损坏 ⇒ warn 后从空账本起，绝不抛", () => {
    const filePath = tmpLedgerFile();
    writeFileSync(filePath, "{ 这不是 JSON", "utf8");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    configureL2AdmissionPersistence({ filePath });

    expect(admitL2Run({ maxRunsPerHour: 1 }, T0).admit).toBe(true);
    expect(warn.mock.calls.some((call) => String(call[0]).includes("l2-admission"))).toBe(true);
  });

  it("未配任何上限（两个 limit 都 <=0）⇒ 完全不落盘（连目录都不碰）", () => {
    const filePath = tmpLedgerFile();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    configureL2AdmissionPersistence({ filePath });

    expect(admitL2Run({ maxRunsPerHour: 0, maxSessionsPerRound: 0 }, T0).admit).toBe(true);
    settleL2Run(true, T0 + 1);
    expect(admitL2Run(undefined, T0 + 2).admit).toBe(true);
    settleL2Run(true, T0 + 3);

    expect(() => readFileSync(filePath, "utf8")).toThrow();
    // 整个目录保持空 —— 连 tmp 文件都没有
    expect(readdirSync(path.dirname(filePath))).toEqual([]);
  });

  it("原子写：落盘只留 JSON 文件，不留 tmp 残片，且内容可解析", () => {
    const filePath = tmpLedgerFile();
    configureL2AdmissionPersistence({ filePath });
    admitL2Run({ maxRunsPerHour: 3 }, T0);
    settleL2Run(true, T0 + 1);
    settleL2Run(false, T0 + 2);

    expect(readdirSync(path.dirname(filePath))).toEqual(["l2-admission.json"]);
    const persisted = JSON.parse(readFileSync(filePath, "utf8")) as { version: number; runTimestamps: number[] };
    expect(persisted.version).toBe(1);
    expect(persisted.runTimestamps).toEqual([T0 + 1]);
  });
});
