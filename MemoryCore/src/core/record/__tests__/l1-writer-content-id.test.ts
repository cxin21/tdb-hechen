/**
 * A3 Round7 CP1：同一租户内「同一条事实」重复写入必须落到同一行。
 *
 * 旧实现每次生成 m_<时间戳>_<随机串>，唯一性靠 ON CONFLICT(record_id)，同内容重跑抽取、
 * 同毫秒两条同内容都会各留一行（生产 23 组/46 行重复）。这里钉住：
 *  · 同内容两次写 → 同一 record_id、库里只有一行；
 *  · 换说法（不同内容）→ 不同 record_id；
 *  · update/merge 仍走随机 id（它要取代旧行，不能覆盖被取代的那行）。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { writeMemory, contentMemoryId } from "../l1-writer.js";
import type { DedupDecision, ExtractedMemory } from "../l1-writer.js";
import { VectorStore } from "../../store/sqlite.js";

const TENANT = { teamId: "team-cid", userId: "usr-cid", agentId: "agt-cid" };
const CONTENT = "他要求发布前必须自己跑一遍，不接受转述的通过结论";

function makeStore(): { store: VectorStore; dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "l1-cid-"));
  const store = new VectorStore(path.join(dir, "vectors.db"), 0);
  const initRes = store.init();
  if (store.isDegraded()) throw new Error(`临时库初始化降级：${initRes.reason}`);
  return { store, dir, cleanup: () => { store.close?.(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

function memoryOf(content: string, messages: string[]): ExtractedMemory {
  return {
    content,
    type: "persona",
    priority: 70,
    scene_name: "测试情境",
    source_message_ids: messages,
    timestamps: ["2026-11-18T00:00:00.000Z"],
    metadata: {},
  } as unknown as ExtractedMemory;
}

function storeDecision(): DedupDecision {
  return { record_id: "", action: "store", target_ids: [], merged_timestamps: [] } as unknown as DedupDecision;
}

describe("A3 Round7 CP1：L1 写入按内容幂等", () => {
  it("同一条事实写两次只留一行，id 由内容派生", async () => {
    const { store, dir, cleanup } = makeStore();
    try {
      const base = {
        baseDir: dir,
        sessionKey: "sess-cid",
        ...TENANT,
      };
      const first = await writeMemory({ ...base, vectorStore: store, memory: memoryOf(CONTENT, ["m1"]), decision: storeDecision() });
      const second = await writeMemory({ ...base, vectorStore: store, memory: memoryOf(CONTENT, ["m2"]), decision: storeDecision() });
      expect(first?.id).toBe(contentMemoryId(CONTENT, TENANT));
      expect(second?.id).toBe(first?.id);
      const rows = await store.queryL1Records?.({ query: CONTENT, topK: 10, filter: TENANT } as never);
      const hits = (rows ?? []).filter((r) => String(r.content ?? "") === CONTENT);
      expect(hits.length).toBe(1);
    } finally {
      cleanup();
    }
  });

  it("update/merge 带着抽取侧内容 id 时另铸新 id，不覆盖被取代的行", async () => {
    const { store, dir, cleanup } = makeStore();
    try {
      const base = { baseDir: dir, sessionKey: "sess-cid", ...TENANT };
      const first = await writeMemory({ ...base, vectorStore: store, memory: memoryOf(CONTENT, ["m1"]), decision: storeDecision() });
      const placeholder = contentMemoryId(CONTENT, TENANT);
      const updated = await writeMemory({
        ...base,
        vectorStore: store,
        memory: memoryOf(CONTENT, ["m2"]),
        decision: {
          record_id: placeholder,
          action: "update",
          target_ids: [String(first?.id ?? "")],
          merged_content: CONTENT + "（补充：包括夜间发布）",
          merged_type: "persona",
          merged_priority: 70,
          merged_timestamps: ["2026-11-19T00:00:00.000Z"],
        } as unknown as DedupDecision,
      });
      expect(updated?.id).not.toBe(placeholder);
      expect(updated?.id).toMatch(/^m_/);
      const old = await store.getL1ByIdsWithArchive?.([String(first?.id ?? "")] as never);
      expect((old ?? []).length).toBe(1);
      expect(String((old ?? [])[0]?.content ?? "")).toBe(CONTENT);
    } finally {
      cleanup();
    }
  });

  it("换一种说法就是另一条事实，id 不同", () => {
    expect(contentMemoryId(CONTENT, TENANT)).not.toBe(contentMemoryId(CONTENT + "，这点别忘", TENANT));
    expect(contentMemoryId(CONTENT, TENANT)).not.toBe(contentMemoryId(CONTENT, { ...TENANT, agentId: "agt-other" }));
  });

  it("数字之间的小数点不被归一化吃掉（13.5 ≠ 135，0.5 ≠ 05）", () => {
    expect(contentMemoryId("版本 13.5", TENANT)).not.toBe(contentMemoryId("版本 135", TENANT));
    expect(contentMemoryId("版本 13.5", TENANT)).not.toBe(contentMemoryId("版本 13 5", TENANT));
    expect(contentMemoryId("版本 13.5", TENANT)).toBe(contentMemoryId("版本13.5", TENANT));
    // 多点版本号：两处小数点都要留住，不然会被压成 153。
    expect(contentMemoryId("1.5.3", TENANT)).not.toBe(contentMemoryId("153", TENANT));
    expect(contentMemoryId("1.5.3", TENANT)).toBe(contentMemoryId("1．5．3", TENANT));
    expect(contentMemoryId("比例 0.5", TENANT)).not.toBe(contentMemoryId("比例 05", TENANT));
    // 句末句号照旧被吃掉：不改变原有归一口径。
    expect(contentMemoryId("发布前自测。", TENANT)).toBe(contentMemoryId("发布前自测", TENANT));
  });

  it("符号差异不进同一内容键（≥100万 ≠ 100万）", () => {
    // A3 Round24：旧归一把 \p{S} 也删了，「预算以≥100万为上限」与「预算以100万为上限」
    // 算出同一个 id，后写的把前一条覆盖掉——语义正好相反。
    expect(contentMemoryId("预算以≥100万为上限", TENANT)).not.toBe(contentMemoryId("预算以100万为上限", TENANT));
    expect(contentMemoryId("速度 ≥ 3 倍", TENANT)).not.toBe(contentMemoryId("速度 3 倍", TENANT));
    // A3 Round24 复核 CP2：≥ 只是其中一种符号，覆盖要成组——≤、±、× 都得留住，
    // 否则「不低于」「上下浮动」「按倍数」三种语义照旧会互相同键覆盖。
    expect(contentMemoryId("预算以≤100万为上限", TENANT)).not.toBe(contentMemoryId("预算以100万为上限", TENANT));
    expect(contentMemoryId("误差 ±5%", TENANT)).not.toBe(contentMemoryId("误差 5%", TENANT));
    expect(contentMemoryId("成本 3×", TENANT)).not.toBe(contentMemoryId("成本 3", TENANT));
    // 符号反了也是另一条事实（≥ 与 ≤ 不能归一到同一个键）。
    expect(contentMemoryId("预算以≥100万为上限", TENANT)).not.toBe(contentMemoryId("预算以≤100万为上限", TENANT));
    // 但只差空格的同一句话仍是同一条事实。
    expect(contentMemoryId("速度≥3倍", TENANT)).toBe(contentMemoryId("速度 ≥ 3 倍", TENANT));
    expect(contentMemoryId("误差±5%", TENANT)).toBe(contentMemoryId("误差 ± 5 %", TENANT));
    // A3 Round24 复核 r24c-a3：≤ 与 × 也要有正侧（只差空格仍同键），否则只证明了「不同」没证明「归一仍然成立」。
    expect(contentMemoryId("预算以≤100万为上限", TENANT)).toBe(contentMemoryId("预算以 ≤ 100万 为上限", TENANT));
    expect(contentMemoryId("成本3×", TENANT)).toBe(contentMemoryId("成本 3 × ", TENANT));
  });
});