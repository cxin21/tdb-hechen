/**
 * P0-1（2026-11-04 L1 属性复核）：结论层敏感门 · 端到端套件。
 *
 * 缺陷背景（复核实测）：经验行在 searchHybrid 池内有 sensitivity 门（auto-recall.ts
 * 行级门）、自述行有 filterSelfNarrationLines，而**结论行在两道门之后才拼进注入块**，
 * 且 work_fact 是原文直出、scene_block 是摘要直出 ⇒ 这是第三条绕过门的通道。生产库
 * 实证：16 个在场场景块里 4 个含敏感派生行（health/finance/relationship）。
 *
 * 合同（本套件钉死）：
 *  1. work_fact 结论 = 单行原文 ⇒ 与经验行同一谓词（decideSensitivityInjection）：
 *     敏感行只在 private 上下文注入，undeclared/group/shared/external 一律不注入；
 *     且**经验通道同样拦**（同一谓词、同一上下文推导），不存在"结论被拦、经验漏回"。
 *  2. scene_block 结论 = N 行蒸馏聚合 ⇒ 按派生来源判（store.getDerivedSensitivityStats
 *     一次 GROUP BY）：来源含敏感行 ⇒ 非 private 不注入（derived-sensitive）；
 *     溯源不可判定（无该方法 / 无溯源边 / 来源全归档）⇒ 非 private 不注入（derived-unknown）。
 *  3. 观测：只在真拦下东西时写 journal gates.sensitivityConclusions（全放行不塞噪声）。
 *  4. 上下文推导只有一条：audienceOfOwnerScope —— 池按 user_id 收窄且非 default 兜底桶
 *     ⇒ private；其余 ⇒ undeclared（fail-closed）。
 *
 * 全链走 sqlite fallback 形态 mock store（与 auto-recall-conclusion-gate.test.ts 同款
 * harness），不 mock 被测函数内部。
 */
import { describe, expect, it, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { performLayeredRecall, resetRerankBreakerForTests } from "../auto-recall.js";
import type { IMemoryStore, L1FtsResult } from "../../store/types.js";
import type { EmbeddingService } from "../../store/embedding.js";
import type { MemoryTdaiConfig } from "../../../config.js";
import {
  buildProfileIsolationScope,
  buildProfileStableId,
  DEFAULT_PROFILE_SCOPE,
} from "../../profile/profile-sync.js";
import { writeSceneIndex } from "../../scene/scene-index.js";

type PLRParams = Parameters<typeof performLayeredRecall>[0];

const KW = "SensProbekw";
/** 共享兜底桶 id（store/isolation.ts DEFAULT_ISOLATION_ID 的同一字面值）——不可当私有。 */
const SHARED_BUCKET = "default";

// ═══════════════ harness ═══════════════

function ftsRow(id: string, content: string, score: number, over: Partial<L1FtsResult> = {}): L1FtsResult {
  return {
    record_id: id,
    content,
    type: "episodic",
    priority: 0,
    scene_name: "",
    score,
    timestamp_str: "",
    timestamp_start: "",
    timestamp_end: "",
    version: 1,
    session_key: "sk",
    session_id: "s",
    team_id: "t",
    task_id: "",
    user_id: "u",
    agent_id: "a",
    metadata_json: "",
    ...over,
  };
}

/** work_fact 结论行厂：content 含 KW（textHit 源）+ 唯一 marker。 */
function wfRow(id: string, marker: string, over: Partial<L1FtsResult> = {}): L1FtsResult {
  return ftsRow(id, KW + " " + marker + "：交付节奏承诺持续兑现，当前状态健康。", 0.99, {
    type: "work_fact",
    ...over,
  });
}

const PHRASES = [
  "交付节奏承诺：每周三同步部署窗口并回写验收结论",
  "用户偏好明细：回复保持中文简洁且先给结论再列证据",
] as const;

function episodicRows(n: number): L1FtsResult[] {
  const rows: L1FtsResult[] = [];
  for (let i = 0; i < n; i++) rows.push(ftsRow("rec-" + (i + 1), "标记" + (i + 1) + "·" + PHRASES[i % PHRASES.length], 0.9));
  return rows;
}

interface StoreOpts {
  /** 不提供 getDerivedSensitivityStats（模拟旧后端）。 */
  withoutDerivedStats?: boolean;
  /** 块 id → 派生画像；记录被调用时收到的 id 列表供断言接线。 */
  derivedStats?: Record<string, { targets: number; sensitive: number }>;
  seenDerivedIds?: string[][];
}

function fallbackStore(rows: L1FtsResult[], opts: StoreOpts = {}): IMemoryStore {
  const store: Record<string, unknown> = {
    isFtsAvailable: () => true,
    getCapabilities: () => ({ nativeHybridSearch: false }),
    searchL1Fts: async (_q: string, k: number) => rows.slice(0, k),
    searchL1Vector: async () => [],
  };
  if (!opts.withoutDerivedStats) {
    store.getDerivedSensitivityStats = (ids: string[]) => {
      opts.seenDerivedIds?.push([...ids]);
      const out: Record<string, { targets: number; sensitive: number }> = {};
      for (const id of ids) {
        const stat = opts.derivedStats?.[id];
        if (stat) out[id] = stat;
      }
      return out;
    };
  }
  return store as unknown as IMemoryStore;
}

function mockEmbedding(): EmbeddingService {
  return { embed: async () => new Float32Array(4) } as unknown as EmbeddingService;
}

function makeCfg(over: Record<string, unknown> = {}): MemoryTdaiConfig {
  return {
    recall: {
      enabled: true,
      strategy: "hybrid",
      timeoutMs: 5000,
      maxResults: 5,
      scoreThreshold: 0.3,
      exploreSlot: false,
      rerankWeights: { relevance: 1, timeProx: 0, significance: 0, coreRef: 0 },
      queryEmbeddingCacheTtlMs: 0,
      sessionReuseTtlMs: 300_000,
      ...over,
    },
    recallJournal: { enabled: true, rotationSizeMB: 5, maxFiles: 5 },
  } as unknown as MemoryTdaiConfig;
}

function paramsFor(
  dir: string,
  store: IMemoryStore,
  userText: string,
  cfg: MemoryTdaiConfig,
  opts: { userId?: string } = {},
): PLRParams {
  return {
    userText,
    sessionKey: "", // 空 sessionKey → 复用缓存整体关断（每调用全新检索）
    cfg,
    pluginDataDir: dir,
    vectorStore: store,
    embeddingService: mockEmbedding(),
    ...(opts.userId !== undefined ? { isolationFilter: { userId: opts.userId } } : {}),
  };
}

function readJournal(dir: string): Array<Record<string, unknown>> {
  const file = path.join(dir, "logs", "recall", "recall-journal-default-default.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function sensGateOf(dir: string): Record<string, unknown> | undefined {
  const entry = readJournal(dir).at(-1);
  return (entry?.gates as Record<string, unknown> | undefined)?.sensitivityConclusions as
    | Record<string, unknown>
    | undefined;
}

/** 与 auto-recall.ts 同一推导：profileIsolation 缺省 {teamId:"default",agentId:"default"}（不是 "global"）。 */
const TEST_PROFILE_SCOPE = buildProfileIsolationScope({ teamId: "default", agentId: "default" });

function provenanceOf(filename: string): string {
  return buildProfileStableId(TEST_PROFILE_SCOPE, "l2", filename);
}

/** 场景索引落点 = 与 performLayeredRecall 同一推导（缺省 scope 时数据目录就是 pluginDataDir）。 */
function profileDataDirFor(dir: string): string {
  return TEST_PROFILE_SCOPE === DEFAULT_PROFILE_SCOPE
    ? dir
    : path.join(dir, "profiles", encodeURIComponent(TEST_PROFILE_SCOPE));
}

async function writeSceneIndexFixture(dir: string, entries: Array<{ filename: string; summary: string }>): Promise<void> {
  await writeSceneIndex(profileDataDirFor(dir), entries.map((e) => ({ ...e, heat: 0, created: "", updated: "" })));
}

function conclusionLines(res: { memoryLines: string[] }): string[] {
  // 场景块结论带场景名前缀（formatConclusionLine：`[结论|场景名]`），只按 "[结论" 判前缀。
  return res.memoryLines.filter((l) => l.includes("[结论"));
}

beforeEach(() => {
  resetRerankBreakerForTests();
});

// ═══════════════ ① work_fact 结论：与经验行同一谓词 ═══════════════

describe("P0-1 ① · work_fact 结论行（原文直出）走行级敏感门", () => {
  it("私有上下文（池按 user_id 收窄且非 default 桶）→ 敏感结论照常注入，journal 不产噪声", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p01-wf-private-"));
    try {
      const rows = [wfRow("wf-h", "ConclHealth", { sensitivity: "health" }), ...episodicRows(2)];
      const res = await performLayeredRecall(
        paramsFor(dir, fallbackStore(rows), KW + " 项目进展如何", makeCfg(), { userId: "usr-private" }),
      );
      expect(conclusionLines(res).some((l) => l.includes("ConclHealth"))).toBe(true);
      expect(sensGateOf(dir)).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("未声明可见性（无 isolationFilter）→ 结论与经验两通道都不注入该行，只保留干净行", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p01-wf-undecl-"));
    try {
      const rows = [
        wfRow("wf-h", "ConclHealth", { sensitivity: "health" }),
        wfRow("wf-c", "ConclClean"),
        ...episodicRows(2),
      ];
      const res = await performLayeredRecall(paramsFor(dir, fallbackStore(rows), KW + " 项目进展如何", makeCfg({})));
      // 干净结论仍在（门只拦敏感行，不伤正常召回）
      expect(conclusionLines(res).some((l) => l.includes("ConclClean"))).toBe(true);
      // 敏感行两通道全无（行级门同谓词兜底，不存在"结论被拦、经验漏回"）
      expect(res.memoryLines.some((l) => l.includes("ConclHealth"))).toBe(false);
      const gate = sensGateOf(dir);
      expect(gate).toBeDefined();
      expect(gate?.audience).toBe("undeclared");
      expect(gate?.blocked).toBe(1);
      expect((gate?.byReason as Record<string, number>).undeclared).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("default 共享兜底桶不算私有 → 敏感结论不注入（池可能混入他人行）", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p01-wf-bucket-"));
    try {
      const rows = [wfRow("wf-h", "ConclHealth", { sensitivity: "relationship" }), ...episodicRows(2)];
      const res = await performLayeredRecall(
        paramsFor(dir, fallbackStore(rows), KW + " 项目进展如何", makeCfg(), { userId: SHARED_BUCKET }),
      );
      expect(res.memoryLines.some((l) => l.includes("ConclHealth"))).toBe(false);
      expect((sensGateOf(dir)?.byReason as Record<string, number>).undeclared).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("枚举外脏值（unclassified）任何上下文都不注入，journal 记 unclassified", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p01-wf-dirty-"));
    try {
      const rows = [wfRow("wf-d", "ConclDirty", { sensitivity: "secret" }), ...episodicRows(2)];
      const res = await performLayeredRecall(
        paramsFor(dir, fallbackStore(rows), KW + " 项目进展如何", makeCfg(), { userId: "usr-private" }),
      );
      expect(res.memoryLines.some((l) => l.includes("ConclDirty"))).toBe(false);
      const gate = sensGateOf(dir);
      expect((gate?.byReason as Record<string, number>).unclassified).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ═══════════════ ② scene_block 结论：按派生来源判 ═══════════════

describe("P0-1 ② · scene_block 结论（N 行蒸馏聚合）按 derived_from 溯源判定", () => {
  const filename = "场景甲.md";

  it("溯源 id 与 profile-sync 写边时同一个稳定 id，并按块一次批量取画像", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p01-sb-id-"));
    try {
      const seen: string[][] = [];
      const store = fallbackStore(episodicRows(2), { seenDerivedIds: seen, derivedStats: { [provenanceOf(filename)]: { targets: 9, sensitive: 0 } } });
      await writeSceneIndexFixture(dir, [{ filename, summary: KW + " 交付窗口安排：每周三固定回归三层门禁后上线" }]);
      await performLayeredRecall(paramsFor(dir, store, KW + " 项目进展如何", makeCfg()));
      expect(seen.length).toBe(1);
      expect(seen[0]).toContain(provenanceOf(filename));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("来源含敏感行 + 非私有 → 不注入（derived-sensitive）", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p01-sb-sens-"));
    try {
      const store = fallbackStore(episodicRows(2), { derivedStats: { [provenanceOf(filename)]: { targets: 12, sensitive: 2 } } });
      await writeSceneIndexFixture(dir, [{ filename, summary: KW + " 交付窗口安排：每周三固定回归三层门禁后上线" }]);
      const res = await performLayeredRecall(paramsFor(dir, store, KW + " 项目进展如何", makeCfg()));
      expect(conclusionLines(res).some((l) => l.includes("交付窗口安排"))).toBe(false);
      const gate = sensGateOf(dir);
      expect(gate?.audience).toBe("undeclared");
      expect(gate?.blocked).toBe(1);
      expect((gate?.byReason as Record<string, number>)["derived-sensitive"]).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("同一块在私有上下文 → 放行（visible 为本人私有，来源敏感不决定能否注入）", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p01-sb-private-"));
    try {
      const store = fallbackStore(episodicRows(2), { derivedStats: { [provenanceOf(filename)]: { targets: 12, sensitive: 2 } } });
      await writeSceneIndexFixture(dir, [{ filename, summary: KW + " 交付窗口安排：每周三固定回归三层门禁后上线" }]);
      const res = await performLayeredRecall(
        paramsFor(dir, store, KW + " 项目进展如何", makeCfg(), { userId: "usr-private" }),
      );
      expect(conclusionLines(res).some((l) => l.includes("交付窗口安排"))).toBe(true);
      expect(sensGateOf(dir)).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("后端不提供溯源查询（旧后端）→ 非私有按 derived-unknown 不注入；私有放行", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p01-sb-nostore-"));
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "p01-sb-nostore-p-"));
    try {
      await writeSceneIndexFixture(dir, [{ filename, summary: KW + " 交付窗口安排：每周三固定回归三层门禁后上线" }]);
      const res = await performLayeredRecall(
        paramsFor(dir, fallbackStore(episodicRows(2), { withoutDerivedStats: true }), KW + " 项目进展如何", makeCfg()),
      );
      expect(conclusionLines(res).some((l) => l.includes("交付窗口安排"))).toBe(false);
      expect((sensGateOf(dir)?.byReason as Record<string, number>)["derived-unknown"]).toBe(1);

      await writeSceneIndexFixture(dir2, [{ filename, summary: KW + " 交付窗口安排：每周三固定回归三层门禁后上线" }]);
      const res2 = await performLayeredRecall(
        paramsFor(dir2, fallbackStore(episodicRows(2), { withoutDerivedStats: true }), KW + " 项目进展如何", makeCfg(), {
          userId: "usr-private",
        }),
      );
      expect(conclusionLines(res2).some((l) => l.includes("交付窗口安排"))).toBe(true);
      expect(sensGateOf(dir2)).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  });
});
