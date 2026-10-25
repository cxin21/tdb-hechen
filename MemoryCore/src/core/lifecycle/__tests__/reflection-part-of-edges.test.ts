/**
 * #78 W-a 写面（survey F4 small-to-big 上半段；拍板 Q2=(a) 写面无条件补边）：
 * reflection 结论卡写卡成功后，对触发行集写 part_of 身世边（卡→证据，对齐
 * consolidation-worker 的 part_of 语义）；addLink 幂等（ON CONFLICT），
 * 失败/缺能力软处理（warn/debug + continue），不阻塞写卡主链路；只新卡，存量零改动。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runReflection, writeReflectionPartOfEdges } from "../reflection.js";
import { VectorStore } from "../../store/sqlite.js";
import type { MemoryRecord } from "../../record/l1-writer.js";

const NOW = "2026-09-18T00:00:00.000Z";
const LOG = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };

const rows = () =>
  [
    { id: "r1", content: "用户坚持先给结论", type: "episodic", significance: 0.9, createdAt: NOW, updatedAt: NOW, teamId: "t1", userId: "u1", agentId: "a1", metadata: {} },
    { id: "r2", content: "用户每周五复盘", type: "episodic", significance: 0.8, createdAt: NOW, updatedAt: NOW, teamId: "t1", userId: "u1", agentId: "a1", metadata: {} },
    { id: "r3", content: "用户偏好清单式评审", type: "episodic", significance: 0.7, createdAt: NOW, updatedAt: NOW, teamId: "t1", userId: "u1", agentId: "a1", metadata: {} },
  ] as never;

const runWith = async (store: unknown, llmRaw = '[{"question":"q","conclusion":"用户偏好结论先行的沟通与结构化复盘","evidence":["r1","r2"]}]') =>
  runReflection({
    queryL1: async () => rows(),
    config: { enabled: true, rRef: 2 },
    store: store as never,
    llmRunner: { run: vi.fn(async () => llmRaw) },
    logger: LOG,
  });

const cardIdOf = (store: { upsertL1: { mock: { calls: unknown[][] } } }): string => {
  const rec = store.upsertL1.mock.calls[0]?.[0] as { id?: string } | undefined;
  return String(rec?.id ?? "");
};

function makeRealStore(): { store: VectorStore; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "w-a-part-of-"));
  const store = new VectorStore(path.join(dir, "vectors.db"), 0);
  const initRes = store.init();
  if (store.isDegraded()) throw new Error(`临时库初始化降级（环境问题）：${initRes.reason}`);
  return { store, dir };
}

const mkRecord = (id: string): MemoryRecord =>
  ({
    id,
    content: `条目 ${id}`,
    type: "episodic",
    priority: 0,
    scene_name: "t",
    source_message_ids: [],
    metadata: {},
    timestamps: ["2026-09-01T00:00:00Z"],
    occurred_at: "2026-09-01T00:00:00Z",
    certainty: "observed",
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    version: 0,
    sessionKey: "k",
    sessionId: "s",
  }) as MemoryRecord;

describe("#78 W-a：reflection 写卡成功 → 触发行集 part_of 身世边", () => {
  beforeEach(() => {
    LOG.info.mockClear();
    LOG.warn.mockClear();
    LOG.debug.mockClear();
    LOG.error.mockClear();
  });

  it("边方向 卡→证据（对齐 consolidation 语义），只对检索触发行写边（r3 零边）", async () => {
    const addLink = vi.fn(async () => true);
    const store = { upsertL1: vi.fn(async () => true), addLink };
    const res = await runWith(store);
    expect(res.cardsWritten).toBe(1);
    const cardId = cardIdOf(store);
    expect(cardId).toMatch(/^rf_/);
    expect(addLink).toHaveBeenCalledWith(cardId, "r1", "part_of", 1);
    expect(addLink).toHaveBeenCalledWith(cardId, "r2", "part_of", 1);
    expect(addLink).not.toHaveBeenCalledWith(cardId, "r3", "part_of", 1);
  });

  it("幻觉证据 id 不写边（只对检索触发行集），真实行照写", async () => {
    const addLink = vi.fn(async () => true);
    const store = { upsertL1: vi.fn(async () => true), addLink };
    await runWith(store, '[{"question":"q","conclusion":"用户偏好结论先行的沟通与结构化复盘","evidence":["r1","ghost9"]}]');
    const cardId = cardIdOf(store);
    expect(addLink).toHaveBeenCalledTimes(1);
    expect(addLink).toHaveBeenCalledWith(cardId, "r1", "part_of", 1);
    expect(addLink).not.toHaveBeenCalledWith(cardId, "ghost9", "part_of", 1);
  });

  it("软失败：单边抛错/返回 false → 不阻塞写卡（cardsWritten=1），warn 留痕，健康边照调", async () => {
    const addLink = vi.fn(async (_s: string, t: string) => {
      if (t === "r1") throw new Error("db down");
      return false;
    });
    const store = { upsertL1: vi.fn(async () => true), addLink };
    const res = await runWith(store);
    expect(res.cardsWritten).toBe(1);
    expect(addLink).toHaveBeenCalledTimes(2);
    expect(LOG.warn).toHaveBeenCalled();
  });

  it("缺 addLink 能力（旧后端）→ 静默跳过不抛，写卡主链路不受影响", async () => {
    const store = { upsertL1: vi.fn(async () => true) };
    const res = await runWith(store);
    expect(res.cardsWritten).toBe(1);
    expect(LOG.warn).not.toHaveBeenCalled();
  });

  it("真实 VectorStore：helper 幂等（重复调用零重边）+ getLinksBySource 沿边可反查", async () => {
    const { store, dir } = makeRealStore();
    try {
      store.upsertL1(mkRecord("card1"), undefined);
      store.upsertL1(mkRecord("ev1"), undefined);
      store.upsertL1(mkRecord("ev2"), undefined);
      const n1 = await writeReflectionPartOfEdges(store, "card1", ["ev1", "ev2"], LOG);
      const n2 = await writeReflectionPartOfEdges(store, "card1", ["ev1", "ev2"], LOG);
      expect(n1).toBe(2);
      expect(n2).toBe(2);
      const links = store.getLinksBySource("card1", "part_of");
      expect(links.map((e) => e.targetId).sort()).toEqual(["ev1", "ev2"]);
    } finally {
      try {
        store.close();
      } catch {
        /* 已关闭视为成功 */
      }
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows 文件锁抖动：临时目录交给系统清理 */
      }
    }
  });

  it("真实 VectorStore：cardId 不在库时 addLink 仍可写边（图先于行，读侧容忍）——记录现状", async () => {
    const { store, dir } = makeRealStore();
    try {
      store.upsertL1(mkRecord("ev1"), undefined);
      const n = await writeReflectionPartOfEdges(store, "ghost_card", ["ev1"], LOG);
      expect(n).toBe(1);
    } finally {
      try {
        store.close();
      } catch {
        /* 已关闭视为成功 */
      }
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows 文件锁抖动：临时目录交给系统清理 */
      }
    }
  });
});
