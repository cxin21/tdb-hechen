/**
 * W1 补测（对抗审查 Q5/P1-2）：组装层两条契约原本全仓 0 断言——
 *   ①  没有任何召回产出时不得注入空壳（prependContext 空 ⇒ 整体 undefined，
 *      不能给宿主一个只含工具指南的 system 块）；
 *   ②  appendSystemContext 里的工具使用指南必须来自单一源
 *      `core/prompts/memory-tools-guide.ts`（不是任何宿主镜像或复制串）。
 *
 * 覆盖这两条曾被删掉的 `__tests__/openclaw-format-parity.test.ts` 半边，
 * 挂在同一 seam（真链路 performAutoRecall），不碰检索层。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { performAutoRecall } from "../auto-recall.js";
import { parseConfig } from "../../../config.js";
import { VectorStore } from "../../store/sqlite.js";
import { MEMORY_TOOLS_GUIDE, MEMORY_TOOLS_GUIDE_VERSION } from "../../prompts/memory-tools-guide.js";
import type { MemoryRecord } from "../../record/l1-writer.js";
import type { IMemoryStore } from "../../store/types.js";

const mk = (id: string, over: Partial<MemoryRecord> = {}): MemoryRecord =>
  ({
    id,
    content: over.content ?? `W1 组装契约条目 ${id}`,
    type: "episodic",
    priority: 0,
    scene_name: "w1-assembly",
    source_message_ids: [],
    metadata: {},
    timestamps: ["2026-11-01T00:00:00Z"],
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
    version: 0,
    sessionKey: "k",
    sessionId: "w1-assembly",
    ...over,
  }) as MemoryRecord;

function makeStore(rows: MemoryRecord[]): { store: VectorStore; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "w1-assembly-"));
  const store = new VectorStore(path.join(dir, "vectors.db"), 0);
  const initRes = store.init();
  if (store.isDegraded()) throw new Error(`临时库初始化降级（环境问题）：${initRes.reason}`);
  for (const m of rows) store.upsertL1(m, undefined);
  return { store, dir };
}

function cleanup(store: VectorStore, dir: string): void {
  try {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 无害 */
  }
}

async function recall(
  store: VectorStore,
  userText: string,
  cfgOverrides: Record<string, unknown> = {},
): Promise<Awaited<ReturnType<typeof performAutoRecall>>> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "w1-assembly-profile-"));
  try {
    return await performAutoRecall({
      userText,
      actorId: "w1",
      sessionKey: "w1-assembly",
      cfg: parseConfig({ recall: { strategy: "keyword", maxResults: 5, ...cfgOverrides } }),
      pluginDataDir: dataDir,
      vectorStore: store as unknown as IMemoryStore,
    });
  } finally {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* 无害 */
    }
  }
}

describe("W1 组装契约 · 空召回不得注入空壳", () => {
  it("没有任何命中、没有 persona/scene → 整体返回 undefined（不注入只含指南的块）", async () => {
    const { store, dir } = makeStore([]);
    try {
      const out = await recall(store, "completely unrelated probe query zzz");
      expect(out).toBeUndefined();
    } finally {
      cleanup(store, dir);
    }
  });

  it("无命中时不注入 prependContext（即便返回对象存在，前缀也必须为空）", async () => {
    const { store, dir } = makeStore([]);
    try {
      const out = await recall(store, "completely unrelated probe query zzz");
      expect(out?.prependContext ?? "").toBe("");
    } finally {
      cleanup(store, dir);
    }
  });
});

describe("W1 组装契约 · 工具指南来自单一源", () => {
  it("有命中 → appendSystemContext 逐字包含单一源指南（非任何镜像副本）", async () => {
    const { store, dir } = makeStore([mk("w1-hit", { content: "W1 单一源指南契约命中条目" })]);
    try {
      const out = await recall(store, "W1 单一源指南契约命中条目");
      expect(out?.prependContext ?? "").not.toBe("");
      expect(out?.appendSystemContext ?? "").toContain(MEMORY_TOOLS_GUIDE);
    } finally {
      cleanup(store, dir);
    }
  });

  it("单一源指南本身带版本锚与拒答纪律（与 memory-tools-guide.guard.test.ts 同源）", () => {
    expect(MEMORY_TOOLS_GUIDE_VERSION).toMatch(/^memory-tools-guide-v/);
    expect(MEMORY_TOOLS_GUIDE).toContain("不要因为记忆不完整而拒答");
  });
});
