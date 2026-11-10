/**
 * A10（§13）：接线回归——不传 `personProfiler` 时，这一轮必须和没加这功能时一模一样。
 *
 * 三条可执行断言（原文口径）：
 *   ① `report.personProfile` 是 undefined（不是 {}、不是空报告）；
 *   ② `human` 层行数与关系边行数都不增（档案通道不能从别的入口漏写）；
 *   ③ `soul_person.profile_at` 全为 NULL（水位只有提炼成功才写）。
 *
 * 另测「传了就真调」：每 tick 一次、人数上限走 A12 的 min(8, maxUpdatedPerCycle*2)、
 * 显式 `personProfileMaxPersons` 覆盖之。只用临时 sqlite，不调真实模型。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../../store/sqlite.js";
import type { L0Record } from "../../store/types.js";
import { runSoulMaintenance } from "../worker.js";
import {
  personProfileMaxPerTick,
  type PersonProfileReport,
  type PersonProfileRunInput,
} from "../../person/profile-distiller.js";

const T = { teamId: "t-wire", userId: "u-wire", agentId: "a-wire" };
const NOW = "2027-01-01T00:00:00.000Z";

function l0(id: string, role: string, text: string, at: string): L0Record {
  return {
    id,
    sessionKey: "s-wire-1",
    sessionId: "s-wire-1",
    taskId: "task-wire",
    role,
    messageText: text,
    recordedAt: at,
    timestamp: Date.parse(at),
    ...T,
  };
}

function emptyReport(): PersonProfileReport {
  return {
    candidates: 0,
    attempted: 0,
    deferred: 0,
    completed: 0,
    failed: 0,
    fields: 0,
    relations: 0,
    outdated: 0,
    dropped: 0,
    byReason: {},
    persons: [],
  };
}

function openStore(): { store: VectorStore; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "soul-wire-"));
  const store = new VectorStore(path.join(dir, "vectors.db"), 0);
  store.init();
  if (store.isDegraded()) throw new Error("临时库初始化降级");
  // 两轮对话：给维护轮次足够素材，避免「没东西可做」提前返回把接线断言变成空跑。
  store.upsertL0(l0("u1", "user", "这处不对，是不是你改坏的", "2026-12-30T03:00:00.000Z"), undefined);
  store.upsertL0(l0("a1", "assistant", "不是我造成的：这行我这一轮没动过", "2026-12-30T03:01:00.000Z"), undefined);
  store.upsertL0(l0("u2", "user", "记一下：我负责发布流程", "2026-12-31T03:00:00.000Z"), undefined);
  store.upsertL0(l0("a2", "assistant", "记下了", "2026-12-31T03:01:00.000Z"), undefined);
  return { store, dir };
}

async function counts(store: VectorStore): Promise<{
  human: number;
  relations: number;
  watermarks: Array<{ personKey: string; profileAt: string | null }>;
}> {
  const items = (await store.listSoulPersona(T)) ?? [];
  const human = items.filter((it) => it.layer === "human").length;
  const rels = (await store.listSoulPersonRelations?.(T, {})) ?? [];
  const watermarks = (await store.listSoulPersonProfileWatermarks?.(T)) ?? [];
  return { human, relations: rels.length, watermarks };
}

describe("A10：不传 personProfiler 时本轮不产生任何档案副作用", () => {
  it("report.personProfile 为 undefined，human 行/关系边/水位都不增", async () => {
    const { store, dir } = openStore();
    try {
      const before = await counts(store);
      const report = await runSoulMaintenance({
        store,
        tenant: T,
        now: NOW,
        config: { episodeWindowDays: 30, updateIntervalHours: 0 },
        trigger: "manual",
        llmCallBudget: 0,
      });
      // ① 字段不出现（undefined，而不是空报告）——这是「没接线」的判据。
      expect("personProfile" in report).toBe(false);
      expect(report.personProfile).toBeUndefined();
      // ② human 行 / 关系边都没增
      const after = await counts(store);
      expect(after.human).toBe(before.human);
      expect(after.relations).toBe(before.relations);
      // ③ 水位全 NULL（A8：只有提炼成功才写）
      // 注意：soul_person 行本身可能被身份层（P2-G 兜底）写入，那不是档案通道；
      // A10 只要求档案侧一行不写、水位不盖。
      expect(after.watermarks.every((w) => w.profileAt === null)).toBe(true);
    } finally {
      try {
        store.close();
      } catch {
        /* 已关闭 */
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("A12：接线后每 tick 调一次、人数上限 = min(8, maxUpdatedPerCycle*2)", () => {
  it("默认配置（maxUpdatedPerCycle=3）→ maxPersons=6；报告原样挂在 report 上", async () => {
    const { store, dir } = openStore();
    const seen: Array<Pick<PersonProfileRunInput, "tenant" | "now" | "maxPersons" | "trigger">> = [];
    try {
      const report = await runSoulMaintenance({
        store,
        tenant: T,
        now: NOW,
        config: { episodeWindowDays: 30, updateIntervalHours: 0 },
        trigger: "manual",
        llmCallBudget: 0,
        personProfiler: async (input) => {
          seen.push({ tenant: input.tenant, now: input.now, maxPersons: input.maxPersons, trigger: input.trigger });
          return { ...emptyReport(), candidates: 2, attempted: 0, deferred: 2 };
        },
      });
      expect(seen).toHaveLength(1);
      expect(seen[0]!.maxPersons).toBe(6);
      expect(seen[0]!.maxPersons).toBe(personProfileMaxPerTick(3));
      expect(seen[0]!.now).toBe(NOW);
      expect(seen[0]!.trigger).toBe("manual");
      expect(seen[0]!.tenant).toEqual(T);
      expect(report.personProfile?.candidates).toBe(2);
      expect(report.personProfile?.deferred).toBe(2);
      // 桩里没写库：没有任何人被盖上水位。
      const watermarks = (await store.listSoulPersonProfileWatermarks?.(T)) ?? [];
      expect(watermarks.every((w) => w.profileAt === null)).toBe(true);
    } finally {
      try {
        store.close();
      } catch {
        /* 已关闭 */
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("显式 personProfileMaxPersons 覆盖默认上限（且仍受 8 的上界约束）", async () => {
    const { store, dir } = openStore();
    const seen: number[] = [];
    try {
      await runSoulMaintenance({
        store,
        tenant: T,
        now: NOW,
        config: { episodeWindowDays: 30, updateIntervalHours: 0 },
        trigger: "manual",
        llmCallBudget: 0,
        personProfileMaxPersons: 2,
        personProfiler: async (input) => {
          seen.push(input.maxPersons);
          return emptyReport();
        },
      });
      expect(seen).toEqual([2]);
      expect(personProfileMaxPerTick(10)).toBe(8);
    } finally {
      try {
        store.close();
      } catch {
        /* 已关闭 */
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("profiler 抛错不影响本轮其它产出（失败只吞这一路）", async () => {
    const { store, dir } = openStore();
    try {
      const report = await runSoulMaintenance({
        store,
        tenant: T,
        now: NOW,
        config: { episodeWindowDays: 30, updateIntervalHours: 0 },
        trigger: "manual",
        llmCallBudget: 0,
        personProfiler: async () => {
          throw new Error("model 500");
        },
      });
      expect(report.personProfile).toBeUndefined();
      // 主流程仍跑完了（事件挖掘照旧）
      expect(report.at).toBe(NOW);
      expect(report.skipped).toBeUndefined();
    } finally {
      try {
        store.close();
      } catch {
        /* 已关闭 */
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
