/**
 * #61（2026-10-18）performLayeredRecall 分段计时 —— RED 套件。
 *
 * 痛点：/v3/recall v2 路由 5000ms 硬超时贴脸（生产 504），而 journal 时间线显示
 * L1 hybrid 检索 ~70ms、soul 渲染 ~130ms，其余时间为完全静默（无任何日志）——
 * v3 端点路（performLayeredRecall）不打钩子路的 ⏱ Recall timing 行，分段黑洞无法定位。
 *
 * 契约：
 *   - outcome.perfMs = { total, scene, l2, l1, soul }，全部非负有限数；
 *   - logger.info 恰有一次 [recall-perf] 行（含 total=/scene=/l2=/l1=/soul= 字段）；
 *   - recallJournal enabled 时 jsonl 行带 perfMs 键（证据链落盘）；
 *   - 空 userText 分支同样出 perfMs（l1=0），零分支例外。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { performLayeredRecall } from "../auto-recall.js";
import type { IMemoryStore, L1SearchResult } from "../../store/types.js";
import type { EmbeddingService } from "../../store/embedding.js";
import { parseConfig } from "../../../config.js";
import type { Logger } from "../../types.js";

const SCORES61 = [0.9, 0.5, 0.2];
const CONTENTS61 = [
  "索引分片键评审归档：热点路径冲突概率与容量推演记录全部落库（61-a）",
  "缓存命中率压测定稿：峰值并发衰减拐点与失效开关已评审签发（61-b）",
  "回滚演练日志归档：双写切换与对账步骤全部通过验证（61-c）",
];
const row61 = (i: number): L1SearchResult =>
  ({
    record_id: "exp-" + (i + 1),
    content: CONTENTS61[i],
    type: "episodic",
    priority: 0,
    scene_name: "",
    score: SCORES61[i],
    timestamp_str: "", timestamp_start: "", timestamp_end: "",
    version: 1, session_key: "sk", session_id: "s",
    team_id: "t", task_id: "", user_id: "u", agent_id: "a",
    metadata_json: "",
  }) as L1SearchResult;

function mkStore61() {
  return {
    isFtsAvailable: () => true,
    getCapabilities: () => ({ nativeHybridSearch: true }),
    searchL1Fts: async () => [],
    searchL1Hybrid: async () => SCORES61.map((_, i) => row61(i)),
    readCore: async () => [],
  } as unknown as IMemoryStore;
}
const embedding61 = { embed: async () => new Float32Array(4) } as unknown as EmbeddingService;

function mkLogger61() {
  return { info: vi.fn(), warn: vi.fn(), debug: vi.fn() } as unknown as Logger & { info: ReturnType<typeof vi.fn> };
}

async function recall61(opts?: { userText?: string; journal?: boolean; tag?: string }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "perf61-"));
  const logger = mkLogger61();
  try {
    const outcome = await performLayeredRecall({
      userText: opts?.userText ?? "分段计时探针查询",
      sessionKey: "sk-perf61-" + (opts?.tag ?? "t"),
      cfg: parseConfig({
        recall: { strategy: "hybrid", maxResults: 5 },
        ...(opts?.journal ? { recallJournal: { enabled: true, rotationSizeMB: 5, maxFiles: 5 } } : {}),
      }),
      pluginDataDir: dataDir,
      logger,
      vectorStore: mkStore61(),
      embeddingService: embedding61,
      profileIsolation: { teamId: "t", userId: "u", agentId: "a" },
      isolationFilter: { teamId: "t", userId: "u", agentId: "a" },
    });
    return { outcome, logger, dataDir };
  } catch (err) {
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 无害 */ }
    throw err;
  }
}

function cleanup61(dir: string) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 无害 */ }
}

describe("#61 分段计时 · performLayeredRecall perfMs（v3 端点路观测）", () => {
  it("outcome.perfMs 存在：total/scene/l2/l1/soul 全为非负有限数且 total>=各段", async () => {
    const { outcome, dataDir } = await recall61({ tag: "basic" });
    cleanup61(dataDir);
    expect(outcome.perfMs).toBeDefined();
    const p = outcome.perfMs!;
    for (const v of [p.total, p.scene, p.l2, p.l1, p.soul]) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
    }
    expect(p.total).toBeGreaterThanOrEqual(p.scene);
    expect(p.total).toBeGreaterThanOrEqual(p.l2);
    expect(p.total).toBeGreaterThanOrEqual(p.l1);
    expect(p.total).toBeGreaterThanOrEqual(p.soul);
  });

  it("logger.info 恰一次 [recall-perf] 行：含 total=/scene=/l2=/l1=/soul= 与 strategy", async () => {
    const { outcome, logger, dataDir } = await recall61({ tag: "log" });
    cleanup61(dataDir);
    expect(outcome.perfMs).toBeDefined();
    const perfLines = (logger.info as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => String(c[0]))
      .filter((s: string) => s.includes("[recall-perf]"));
    expect(perfLines).toHaveLength(1);
    expect(perfLines[0]).toContain("total=");
    expect(perfLines[0]).toContain("scene=");
    expect(perfLines[0]).toContain("l2=");
    expect(perfLines[0]).toContain("l1=");
    expect(perfLines[0]).toContain("soul=");
    expect(perfLines[0]).toContain("strategy=");
  });

  it("recallJournal enabled：jsonl 行带 perfMs 键（证据链落盘）", async () => {
    const { outcome, dataDir } = await recall61({ journal: true, tag: "jr" });
    try {
      expect(outcome.perfMs).toBeDefined();
      const recallDir = path.join(dataDir, "logs", "recall");
      const files = fs.existsSync(recallDir) ? fs.readdirSync(recallDir).filter((f) => f.endsWith(".jsonl")) : [];
      expect(files.length).toBeGreaterThan(0);
      const lines = files.flatMap((f) => fs.readFileSync(path.join(recallDir, f), "utf8").split("\n").filter(Boolean));
      const rows = lines.map((l) => JSON.parse(l) as { perfMs?: unknown });
      expect(rows.some((r) => r.perfMs && typeof r.perfMs === "object" && "total" in (r.perfMs as object))).toBe(true);
    } finally {
      cleanup61(dataDir);
    }
  });

  it("空 userText：perfMs 仍存在（l1=0），无分支例外", async () => {
    const { outcome, dataDir } = await recall61({ userText: "", tag: "empty" });
    cleanup61(dataDir);
    expect(outcome.perfMs).toBeDefined();
    expect(outcome.perfMs!.total).toBeGreaterThanOrEqual(0);
  });
});