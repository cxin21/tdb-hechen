/**
 * WP1b 缺省档行为契约（钩子路全链 performLayeredRecall）：
 *  ① #173-B 删键安全：cfg 里没有三通道键 ≡ 显式 0（block / memoryLines / 图通道调用次数逐位相同）；
 *  ② validity.mode 缺省 soft：过期行降权保留；显式 hard 才硬丢；excludeInvalidated=false 原样保留；
 *  ③ injectWrapper 缺省 calibrated：包裹语生效，显式 legacy 可回滚（缺省翻转不改可配性）。
 *
 * 铁律：不 mock 被测函数内部；全链走 performLayeredRecall 的 sqlite fallback 路径。
 */
import { describe, expect, it, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MEMORY_TOOLS_GUIDE, performLayeredRecall, resetRerankBreakerForTests } from "../auto-recall.js";
import { parseConfig, type MemoryTdaiConfig } from "../../../config.js";
import type { IMemoryStore, L1FtsResult } from "../../store/types.js";
import type { EmbeddingService } from "../../store/embedding.js";

type PLRParams = Parameters<typeof performLayeredRecall>[0];

const KW = "E1WpbProbe";
const SID = "sess-wp1b";

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function ftsRow(id: string, content: string, over: Partial<L1FtsResult> = {}): L1FtsResult {
  return {
    record_id: id,
    content,
    type: "episodic",
    priority: 0,
    scene_name: "项目重构",
    score: 0.9,
    timestamp_str: iso(Date.parse("2026-10-01T10:00:00Z")),
    timestamp_start: "",
    timestamp_end: "",
    version: 1,
    session_key: "sk-wp1b",
    session_id: SID,
    team_id: "t",
    task_id: "",
    user_id: "u",
    agent_id: "a",
    metadata_json: "",
    ...over,
  };
}

interface SpyStore {
  store: IMemoryStore;
  graphCalls: () => number;
}

function spyStore(rows: L1FtsResult[]): SpyStore {
  let graphCalls = 0;
  const base: Record<string, unknown> = {
    isFtsAvailable: () => true,
    getCapabilities: () => ({ nativeHybridSearch: false }),
    searchL1Fts: async (_q: string, k: number) => rows.slice(0, k),
    searchL1Vector: async () => [],
    getNeighbors: () => {
      graphCalls += 1;
      return [];
    },
  };
  return { store: base as unknown as IMemoryStore, graphCalls: () => graphCalls };
}

function mockEmbedding(): EmbeddingService {
  return { embed: async () => new Float32Array(4) } as unknown as EmbeddingService;
}

/** 用 parseConfig({}) 产出真缺省档（validity soft / injectWrapper calibrated / maxResults 10），再压到可测的最小 recall 面。 */
function makeCfg(mut: (recall: Record<string, unknown>) => void = () => {}): MemoryTdaiConfig {
  const c = parseConfig({}) as unknown as Record<string, any>;
  c.recallJournal = { enabled: false, rotationSizeMB: 5, maxFiles: 5 };
  c.recall.strategy = "hybrid";
  c.recall.rerankWeights = { relevance: 1, timeProx: 0, significance: 0, coreRef: 0 };
  c.recall.queryEmbeddingCacheTtlMs = 0;
  c.recall.sessionReuseTtlMs = 0;
  c.recall.maxResults = 5;
  mut(c.recall as Record<string, unknown>);
  return c as unknown as MemoryTdaiConfig;
}

async function runWith(
  cfg: MemoryTdaiConfig,
  rows: L1FtsResult[],
): Promise<{ res: Awaited<ReturnType<typeof performLayeredRecall>>; graphCalls: number }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wp1b-"));
  try {
    const s = spyStore(rows);
    const params: PLRParams = {
      userText: KW + " 项目进展如何",
      sessionKey: "",
      cfg,
      pluginDataDir: dir,
      vectorStore: s.store,
      embeddingService: mockEmbedding(),
    };
    const res = await performLayeredRecall(params);
    return { res, graphCalls: s.graphCalls() };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

beforeEach(() => {
  resetRerankBreakerForTests();
});

describe("WP1b 缺省档：删键安全（#173-B）", () => {
  it("① 无三键 ≡ 显式 0：block / memoryLines 逐位相同、图通道零调用", async () => {
    const rows = [ftsRow("r1", KW + " 命中行")];
    const deleted = await runWith(makeCfg(), rows);
    const explicit = await runWith(
      makeCfg((r) => {
        r.coreRefBoost = 0;
        r.graphDiscount = 0;
        r.sceneBoost = 0;
      }),
      rows,
    );
    expect(deleted.res.block).toBe(explicit.res.block);
    expect(deleted.res.memoryLines).toEqual(explicit.res.memoryLines);
    expect(deleted.res.block).toContain(KW);
    // 三通道全 0 ⇒ 候选池门不开，图/场景信号一次都不查
    expect(deleted.graphCalls).toBe(0);
    expect(explicit.graphCalls).toBe(0);
  });
});

describe("WP1b 缺省档：validity soft 与 injectWrapper calibrated", () => {
  const expiredOver: Partial<L1FtsResult> = {
    valid_start: "2019-01-01T00:00:00Z",
    valid_end: "2020-01-01T00:00:00Z",
  };

  it("② 缺省（validity.mode=soft）保留过期行；显式 hard 硬丢；false 原样保留", async () => {
    const rows = [ftsRow("r1", KW + " 过期行", expiredOver)];
    const soft = await runWith(makeCfg(), rows);
    expect(soft.res.memoryLines.some((l) => l.includes(KW))).toBe(true);

    const hard = await runWith(makeCfg((r) => { r.validity = { ...(r.validity as object), mode: "hard" }; }), rows);
    expect(hard.res.memoryLines.some((l) => l.includes(KW))).toBe(false);

    const off = await runWith(makeCfg((r) => { r.excludeInvalidated = false; }), rows);
    expect(off.res.memoryLines.some((l) => l.includes(KW))).toBe(true);
  });

  it("④ 注入块含答案口径两段（P0：与 bench tuned 同源，不诱导拒答）", async () => {
    const rows = [ftsRow("r1", KW + " 命中行")];
    const res = await runWith(makeCfg(), rows);
    expect(res.res.block).toContain("【币值判定规则（重要）】");
    expect(res.res.block).toContain("【建议类问题口径（重要）】");
    expect(res.res.block).toContain("只有当记忆里完全没有与该问题相关的内容时才拒答");
    expect(res.res.block).toContain("有相关记录（哪怕是较早的）就必须给出答案，并注明该记录的时间");
  });

  it("⑤ 记忆工具指南不再是否决式措辞（P0：工具是补充手段，不是放弃回答的理由）", () => {
    expect(MEMORY_TOOLS_GUIDE).not.toContain("不足以回答用户问题时，可主动调用");
    expect(MEMORY_TOOLS_GUIDE).not.toContain("说明该信息不在记忆中");
    // 单一源：core/prompts/memory-tools-guide.ts（本文件只经 auto-recall re-export 拿到正文）
    expect(MEMORY_TOOLS_GUIDE).toContain("只要其中有与该问题相关的内容，就直接据此作答");
    expect(MEMORY_TOOLS_GUIDE).toContain("不要因为记忆不完整而拒答");
    expect(MEMORY_TOOLS_GUIDE).toContain("只有已注入的记忆也完全没有相关线索时才说明无法确定");
  });

  it("③ injectWrapper 缺省 calibrated 生效；显式 legacy 可回滚", async () => {
    const rows = [ftsRow("r1", KW + " 命中行")];
    const calibrated = await runWith(makeCfg(), rows);
    expect(calibrated.res.block).toContain("以下是与问题相关的历史记忆，请据此回答");
    expect(calibrated.res.block).not.toContain("仅作为参考");

    const legacy = await runWith(makeCfg((r) => { r.injectWrapper = "legacy"; }), rows);
    expect(legacy.res.block).toContain("仅作为参考");
    expect(legacy.res.block).not.toContain("以下是与问题相关的历史记忆，请据此回答");
  });
});
