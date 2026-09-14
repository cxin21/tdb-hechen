/**
 * 排序三刀语义对齐（auto-recall 侧，2026-09-12）：searchHybrid 第二排序点字典序两段式回归钉。
 * 病灶参照：golden q9（runs/12-08-44 perQuery[8]）——相邻 RRF 档差 ~2.8e-4 被信号和（~6e-4）翻越。
 * Minor ④ 防撞形：formatMemoryLine 活动时间标注 ` ·` 分隔符 + MEMORY_LINE_RE 单一源解析。
 */
import { describe, expect, it } from "vitest";
import { searchHybrid, MEMORY_LINE_RE, formatMemoryLine } from "../auto-recall.js";
import { ZERO_RANK_SIGNALS, type RankSignals } from "../../tools/recall-signals.js";
import type { IMemoryStore, L1SearchResult } from "../../store/types.js";
import type { EmbeddingService } from "../../store/embedding.js";
import type { TimeWindow } from "../../tools/content-time-window.js";

const NOW = new Date();

function mkSoul(
  id: string,
  score: number,
  over: Partial<L1SearchResult> = {},
): L1SearchResult {
  return {
    record_id: id,
    content: `LEX 记忆条目 ${id}`,
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

function mockStore(
  vecHits: L1SearchResult[],
  ftsHits: L1SearchResult[] = [],
): { vectorStore: IMemoryStore; embeddingService: EmbeddingService } {
  const vectorStore = {
    isFtsAvailable: () => ftsHits.length > 0,
    searchL1Fts: async () => ftsHits,
    searchL1Vector: async () => vecHits,
  } as unknown as IMemoryStore;
  const embeddingService = {
    embed: async () => new Float32Array(4),
  } as unknown as EmbeddingService;
  return { vectorStore, embeddingService };
}

const WIN: TimeWindow = { start: "2026-09-01T00:00:00Z", end: "2026-09-08T00:00:00Z", label: "上周" };

function rank(over: Partial<{ boost: number; firedLabels: string[]; moodSign: number; timeWindow: TimeWindow | null; signals: RankSignals; sceneBoost: number }> = {}) {
  return {
    boost: 0,
    firedLabels: [],
    moodSign: 0,
    timeWindow: null,
    signals: ZERO_RANK_SIGNALS,
    now: NOW,
    ...over,
  };
}

async function order(
  query: string,
  vecHits: L1SearchResult[],
  r?: Parameters<typeof searchHybrid>[8],
  ftsHits: L1SearchResult[] = [],
): Promise<string[]> {
  const { vectorStore, embeddingService } = mockStore(vecHits, ftsHits);
  const res = await searchHybrid(query, "", 10, 0.3, vectorStore, embeddingService, undefined, undefined, r, 0, undefined, undefined, false, { relevance: 0, timeProx: 0, significance: 0, coreRef: 0 });
  return res.lines.map((l) => {
    const m = l.match(/LEX 记忆条目 (\w+)/);
    return m ? m[1] : l;
  });
}

describe("排序三刀对齐：主序不可被信号翻越（q9 病灶同构）", () => {
  it("相邻档低分者即便吃满场景信号也不得越过高分者（旧加法 RED→新字典序 GREEN）", async () => {
    // q9 量纲复刻：rel rank0（1/61=0.016393）、noise rank1（1/62=0.016129），
    // noise 吃 sceneBoost 0.04 → 旧加法 rankKey 0.056 > 0.016393 夺位；字典序下主序钉死。
    const rel = mkSoul("rel", 0.9); // score 字段 = 向量 cosine（须过 0.3 闸）；RRF 分由名次推导
    const noise = mkSoul("noise", 0.8, { scene_name: "治理域" });
    const on = await order(
      "LEX 查询 治理域",
      [rel, noise],
      rank({ signals: { ...ZERO_RANK_SIGNALS }, sceneBoost: 0.04 }),
    );
    expect(on[0]).toBe("rel");
    // 关断对照：无信号时基线序
    expect(await order("LEX 查询 治理域", [rel, noise])).toEqual(["rel", "noise"]);
  });
});

describe("排序三刀对齐：真平局组内信号生效", () => {
  it("跨通道同分（fts rank0 ≡ vec rank0）→ 组内场景信号排序；关断 → 稳定插入序", async () => {
    const x = mkSoul("x", 0.5); // fts rank0 → 1/61
    const y = mkSoul("y", 0.5, { scene_name: "治理域" }); // vec rank0 → 1/61（真平局）
    const on = await order(
      "LEX 查询 治理域",
      [y],
      rank({ signals: { ...ZERO_RANK_SIGNALS }, sceneBoost: 0.04 }),
      [x],
    );
    expect(on).toContain("x");
    expect(on).toContain("y");
    expect(on.indexOf("y")).toBeLessThan(on.indexOf("x"));
    const off = await order("LEX 查询 治理域", [y], undefined, [x]);
    expect(off.indexOf("x")).toBeLessThan(off.indexOf("y"));
  });
});

describe("排序三刀对齐：R3 certainty 平局组内旗标（跨档不沉降）", () => {
  it("inferred 占更高 RRF 档 → 不再被低档 observed 跨档压过（旧乘法 RED→新字典序 GREEN）", async () => {
    const inf = mkSoul("inf", 0.9, { certainty: "inferred" }); // mult 0.9
    const obs = mkSoul("obs", 0.8); // mult 1.0
    // 旧加法：0.016393*0.9=0.014754 < 0.016129 → obs 夺位；新字典序：主序 rrfScore → inf 前
    const res = await order("LEX 查询", [inf, obs], rank({ signals: { ...ZERO_RANK_SIGNALS, inferredPenalty: 0.1 } }));
    expect(res[0]).toBe("inf");
    // 平局组内：跨通道同分（vec rank0 ≡ fts rank0）→ observed 前于 inferred（mult 旗标）
    const t1 = mkSoul("t1", 0.9, { certainty: "inferred" });
    const t2 = mkSoul("t2", 0.9);
    const t3 = mkSoul("t3", 0.9);
    const tieOrder = await order(
      "LEX 查询",
      [t1, t3],
      rank({ signals: { ...ZERO_RANK_SIGNALS, inferredPenalty: 0.1 } }),
      [t2],
    );
    expect(tieOrder).toEqual(["t2", "t1", "t3"]);
  });
});

describe("排序三刀对齐：全零关断恒等", () => {
  it("混合档位 + 信号全 0 → 纯 rrfScore 降序（work_fact 分层保持）", async () => {
    const hits = [
      mkSoul("a", 0.5),
      mkSoul("b", 0.5, { type: "work_fact" }),
      mkSoul("c", 0.5, { certainty: "inferred" }),
    ];
    const res = await order("LEX 查询", hits, rank());
    expect(res).toEqual(["b", "a", "c"]);
  });
});

describe("Minor ④：活动时间标注防撞形", () => {
  it("正文自带 '(活动时间:…)' 结尾 + 系统标注 → 解析保留完整正文", () => {
    const line = formatMemoryLine({
      type: "episodic",
      content: "用户备忘 每年3月 review (活动时间: 每年3月)",
      scene_name: "",
      activity_start_time: "2026-03-01T00:00:00Z",
      activity_end_time: "",
      timestamp: "",
    } as never);
    expect(line).toContain(" ·(活动时间:");
    const m = line.match(MEMORY_LINE_RE);
    expect(m).not.toBeNull();
    expect(m![2]).toBe("用户备忘 每年3月 review (活动时间: 每年3月)");
  });
  it("无活动时间字段 → 不追加标注；解析恒等", () => {
    const line = formatMemoryLine({
      type: "episodic",
      content: "普通记忆条目",
      scene_name: "",
    } as never);
    expect(line).not.toContain("活动时间");
    const m = line.match(MEMORY_LINE_RE);
    expect(m![2]).toBe("普通记忆条目");
  });
  it("旧格式裸标注行 → 一次性兼容剥除（已知歧义登记）", () => {
    const legacy = "- [episodic] 旧格式内容 (活动时间: 2025-03-01)";
    const m = legacy.match(MEMORY_LINE_RE);
    expect(m![2]).toBe("旧格式内容");
  });
});
