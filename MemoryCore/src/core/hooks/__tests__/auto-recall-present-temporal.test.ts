/**
 * #135 R3（查询时间感知）：searchHybrid 接线集成测试。
 * 信号经 rank 形参（RecallRankSignal.presentTemporal + signals.presentTemporalBoost）
 * 进入 structuralSignalOf——加法信号是精确平局组内次级判据（score 严格优先），
 * 故用双通道镜像位次构造真实 rrfScore 平局：emb=[old,new] + fts=[old,new] 同序
 * → old=1/61+1/61? 否——同序则 old 两路都是 rank0，天然平局（1/61+1/61 vs 1/62+1/62）。
 * 缺省（boost=0 或标记 false）= 逐位现状恒等。
 */
import { describe, expect, it } from "vitest";
import { searchHybrid } from "../auto-recall.js";
import type { IMemoryStore, L1SearchResult } from "../../store/types.js";
import type { EmbeddingService } from "../../store/embedding.js";
import { ZERO_RANK_SIGNALS } from "../../tools/recall-signals.js";
import type { RecallRankSignal } from "../auto-recall.js";

function mk(id: string, content: string, score: number, occurredAt?: string, extra: Partial<L1SearchResult> = {}): L1SearchResult {
  return { record_id: id, content, type: "episodic", priority: 60, scene_name: "", score,
    timestamp_str: occurredAt ?? "", timestamp_start: "", timestamp_end: "", version: 1,
    session_key: "sk", session_id: "s", team_id: "t", task_id: "", user_id: "u", agent_id: "a",
    metadata_json: "", occurred_at: occurredAt, ...extra } as L1SearchResult;
}

function mockStore(
  embHits: L1SearchResult[],
  ftsHits: L1SearchResult[] = [],
): { vectorStore: IMemoryStore; embeddingService: EmbeddingService } {
  const vectorStore = { isFtsAvailable: () => true, searchL1Vector: async () => embHits,
    searchL1Fts: async () => ftsHits } as unknown as IMemoryStore;
  const embeddingService = { embed: async () => new Float32Array(4) } as unknown as EmbeddingService;
  return { vectorStore, embeddingService };
}

const NOW = new Date("2026-10-27T00:00:00Z");
const OLD = new Date(NOW.getTime() - 300 * 86400000).toISOString();
const RECENT = new Date(NOW.getTime() - 1 * 86400000).toISOString();
/** 纯相关度精排（timeProx/significance 全 0）——隔离 presentTemporal 特征效应。 */
const RELEVANCE_ONLY = { relevance: 1, timeProx: 0, significance: 0, coreRef: 0 };

/** 位置形参：…logger(7) 后 rest[1..14]；rest[2]=rank、rest[7]=rerankWeights(RankSignals)。 */
function call(
  store: { vectorStore: IMemoryStore; embeddingService: EmbeddingService },
  rank?: RecallRankSignal,
) {
  const rest = new Array(15).fill(undefined);
  rest[7] = { ...RELEVANCE_ONLY, ...rank?.signals };
  if (rank) rest[2] = rank;
  return searchHybrid("我现在用哪个编辑器？", "", 5, 0.1, store.vectorStore, store.embeddingService, undefined, ...rest.slice(1));
}

/** 平局构造：两通道镜像位次（emb=[new,old] + fts=[old,new]）→ rrfScore 精确相等；
 * keyword 先并入 → 稳定序=old 先；signal 成为唯一次级判据。 */
const tieStore = (oldTxt: string, newTxt: string, oldAt: string, newAt: string, oldExtra?: Partial<L1SearchResult>, newExtra?: Partial<L1SearchResult>) =>
  mockStore(
    [mk("new", newTxt, 0.9, newAt, newExtra), mk("old", oldTxt, 0.9, oldAt, oldExtra)],
    [mk("old", oldTxt, 0.9, oldAt, oldExtra), mk("new", newTxt, 0.9, newAt, newExtra)],
  );

describe("#135 R3 查询时间感知（searchHybrid 接线；缺省关断）", () => {
  it("缺省（无 rank / boost=0）：当下标记不改变平局序（逐位现状，稳定序=池序）", async () => {
    const s = tieStore("旧编辑器 1250", "新编辑器 1300", OLD, RECENT);
    const res = await call(s);
    expect(res.lines[0]).toContain("旧编辑器 1250");
  });

  it("boost>0 + presentTemporal：近期条目平局反超（occurred 回看窗）", async () => {
    const s = tieStore("旧编辑器 1250", "新编辑器 1300", OLD, RECENT);
    const res = await call(s, { boost: 0, firedLabels: [], moodSign: 0, timeWindow: null,
      signals: { ...ZERO_RANK_SIGNALS, presentTemporalBoost: 0.08 }, now: NOW, presentTemporal: true });
    expect(res.lines[0]).toContain("新编辑器 1300");
  });

  it("boost>0 但 presentTemporal=false（query 未命中当下标记）：恒等", async () => {
    const s = tieStore("旧编辑器 1250", "新编辑器 1300", OLD, RECENT);
    const res = await call(s, { boost: 0, firedLabels: [], moodSign: 0, timeWindow: null,
      signals: { ...ZERO_RANK_SIGNALS, presentTemporalBoost: 0.08 }, now: NOW, presentTemporal: false });
    expect(res.lines[0]).toContain("旧编辑器 1250");
  });

  it("valid 区间覆盖 now → +boost；已失效条目（valid_end 过去）不受益", async () => {
    const s = tieStore("生效配置 1250", "失效配置 1300", OLD, RECENT,
      { valid_start: "2026-01-01" }, { valid_end: "2026-02-01" });
    const res = await call(s, { boost: 0, firedLabels: [], moodSign: 0, timeWindow: null,
      signals: { ...ZERO_RANK_SIGNALS, presentTemporalBoost: 0.08 }, now: NOW, presentTemporal: true });
    expect(res.lines[0]).toContain("生效配置 1250");
  });
});