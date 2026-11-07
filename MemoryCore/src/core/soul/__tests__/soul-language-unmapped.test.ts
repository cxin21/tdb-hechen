/**
 * 语言覆盖告警（L3，临时库）：语料一个汉字都没有且本轮零生长时必须告警 + 落账本，
 * 不允许「换了语言就静默不长人格」。中文语料同条件不告警。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../../store/sqlite.js";
import type { L0Record } from "../../store/types.js";
import { runSoulMaintenance } from "../worker.js";

const T = { teamId: "t-lang", userId: "u-lang", agentId: "a-lang" };
const NOW = "2026-11-06T12:00:00.000Z";

function rows(lines: string[]): L0Record[] {
  return lines.map((text, i) => ({
    id: `m-${i}`,
    sessionKey: "s-lang",
    sessionId: "s-lang",
    taskId: "task-lang",
    role: i % 2 === 0 ? "user" : "assistant",
    messageText: text,
    recordedAt: `2026-11-06T0${(i % 9) + 1}:00:00.000Z`,
    timestamp: Date.parse(NOW) - (lines.length - i) * 60_000,
    ...T,
  }));
}

async function run(lines: string[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "soul-lang-"));
  const store = new VectorStore(path.join(dir, "vectors.db"), 0);
  try {
    store.init();
    if (store.isDegraded()) throw new Error("临时库初始化降级");
    for (const r of rows(lines)) store.upsertL0(r, undefined);
    const report = await runSoulMaintenance({
      store,
      tenant: T,
      now: NOW,
      config: { enabled: true, episodeWindowDays: 30, updateIntervalHours: 0 },
      trigger: "manual",
      llmCallBudget: 0,
      recentRecords: async () => rows(lines).map((r) => ({ id: r.id, content: r.messageText, occurredAt: r.recordedAt })),
    });
    const ledger = await store.listSoulLedger(T, 50);
    return { report, ledger };
  } finally {
    try { store.close(); } catch { /* 已关闭 */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("语料语言未覆盖", () => {
  it("全英文语料零生长：language_unmapped 告警 + 账本可查", async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `This is English line number ${i} about the weather and lunch.`);
    const { report, ledger } = await run(lines);
    expect(report.admitted).toBe(0);
    expect(report.alerts?.[0]?.code).toBe("language_unmapped");
    expect(report.alerts?.[0]?.records).toBe(20);
    expect(ledger.some((e) => e.action === "alert" && (e.gates ?? []).includes("language_unmapped"))).toBe(true);
  });

  it("日文语料（含汉字）也必须告警：不能因为夹着汉字就当中文放过", async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `今日は ${i} 回目の確認です。この変更はまだ終わっていません。`);
    const { report } = await run(lines);
    const alert = (report.alerts ?? []).find((a) => a.code === "language_unmapped");
    expect(alert).toBeTruthy();
    expect(String(alert!.detail)).toContain("假名");
  });

  it("韩文语料必须告警：谚文不属于已覆盖文字", async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `오늘 ${i} 번째 확인입니다. 이 변경은 아직 끝나지 않았습니다.`);
    const { report } = await run(lines);
    const alert = (report.alerts ?? []).find((a) => a.code === "language_unmapped");
    expect(alert).toBeTruthy();
    expect(String(alert!.detail)).toContain("谚文");
  });

  it("中文语料同条件不告警（告警不误报）", async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `今天第 ${i} 次核对生产库的字节数，先备份再改。`);
    const { report } = await run(lines);
    expect((report.alerts ?? []).some((a) => a.code === "language_unmapped")).toBe(false);
  });
});
