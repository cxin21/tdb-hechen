import { describe, expect, it } from "vitest";
import { searchHybrid } from "../auto-recall.js";
import type { IMemoryStore, L1SearchResult } from "../../store/types.js";
import type { EmbeddingService } from "../../store/embedding.js";

/**
 * #166（v2 事实行值级泄漏）钩子路接线：
 * 写侧已按事实级失效（旧值行 valid_end 落库、行不删除），但行 content 是**父 turn 原文**——
 * 同 turn 的多值兄弟仍 active，折叠回 turn 时把含旧值的原文重新注入：行级判据全对，
 * 注入文本里照样出现旧值。
 *
 * 修法（本测试钉死的接线）：present-intent 下把池内 **expired 事实行**当污染源，
 * 该 turn 的存活行不再用父原文，改注入各自的事实短语（metadata.fact_phrase）；
 * 短语缺失或短语本身仍含旧值的行直接剔出注入。
 *
 * 两条路径都要覆盖：
 *   · soft（recall.validity.mode=soft）：过期行降权保留（related 判定常不成立）；
 *   · hard（默认 excludeInvalidated=true）：过期行在折叠**之后**才被 applyExclusion 过滤，
 *     折叠时父原文同样在池里——只覆盖 soft 等于默认档不修（实测回归点）。
 * 非 present-intent（问历史）必须逐位不变：旧值仍可回溯。
 */

function mk(id: string, content: string, score: number, occurredAt?: string, extra: Partial<L1SearchResult> = {}): L1SearchResult {
  return { record_id: id, content, type: "work_fact", priority: 60, scene_name: "", score,
    timestamp_str: occurredAt ?? "", timestamp_start: "", timestamp_end: "", version: 1,
    session_key: "sk", session_id: "s", team_id: "t", task_id: "", user_id: "u", agent_id: "a",
    metadata_json: "", occurred_at: occurredAt, ...extra } as L1SearchResult;
}

function mockStore(hits: L1SearchResult[]): { vectorStore: IMemoryStore; embeddingService: EmbeddingService } {
  const vectorStore = { isFtsAvailable: () => false, searchL1Vector: async () => hits } as unknown as IMemoryStore;
  const embeddingService = { embed: async () => new Float32Array(4) } as unknown as EmbeddingService;
  return { vectorStore, embeddingService };
}

const NOW = new Date("2026-05-01T00:00:00.000Z");
const OLD_START = "2026-03-02T09:12:00.000Z";
const OLD_END = "2026-04-11T19:40:00.000Z";
const NEW_START = "2026-04-11T19:40:00.000Z";
const RELEVANCE_ONLY = { relevance: 1, timeProx: 0, significance: 0, coreRef: 0 };

/** 位置形参：…logger(7) 后 rest[1..14] → rest[7]=rerankWeights、rest[9]=excludeInvalidated、rest[10]=validityNow。 */
function call(
  store: { vectorStore: IMemoryStore; embeddingService: EmbeddingService },
  opts: { excludeInvalidated?: boolean | "soft"; userText?: string } = {},
) {
  const rest = new Array(15).fill(undefined);
  rest[7] = RELEVANCE_ONLY;
  if (opts.excludeInvalidated !== undefined) rest[9] = opts.excludeInvalidated;
  rest[10] = NOW;
  return searchHybrid(opts.userText ?? "q", "", 5, 0.1, store.vectorStore, store.embeddingService, undefined, ...rest.slice(1));
}

const TURN_1_TEXT = "我住在柏林，最近迷上摄影";
const TURN_3_TEXT = "我上个月搬到慕尼黑了";
const factMd = (parent: string, phrase: string, value: string, index: number, cardinality = "single") =>
  JSON.stringify({
    fact_of: parent,
    fact_key: "用户 居住城市",
    cardinality,
    fact_index: index,
    fact_phrase: phrase,
    fact_value: value,
  });

/** turn-1：旧值（柏林，已过期）+ 同 turn 兄弟（摄影，active）；turn-3：新值（慕尼黑）。 */
function pool(): L1SearchResult[] {
  return [
    mk("turn-1", TURN_1_TEXT, 0.95, OLD_START, {
      valid_start: OLD_START,
      valid_end: OLD_END,
      metadata_json: factMd("turn-1", "用户住在柏林", "柏林", 0),
    }),
    mk("turn-1#f2", TURN_1_TEXT, 0.9, OLD_START, {
      valid_start: OLD_START,
      metadata_json: factMd("turn-1", "用户最近迷上摄影", "摄影", 1, "multi"),
    }),
    mk("turn-3", TURN_3_TEXT, 0.9, NEW_START, {
      valid_start: NEW_START,
      metadata_json: factMd("turn-3", "用户搬到慕尼黑", "慕尼黑", 0),
    }),
  ];
}

const PRESENT_Q = "我现在住在哪里？";
const HISTORY_Q = "我2026年3月的时候住在哪里？";

describe("#166 值级泄漏（searchHybrid 接线）", () => {
  it("soft + 问当下：同 turn 兄弟行改注入事实短语，旧值不再回流", async () => {
    const res = await call(mockStore(pool()), { excludeInvalidated: "soft", userText: PRESENT_Q });
    const text = res.lines.join("\n");
    expect(text).not.toContain("柏林");
    expect(text).not.toContain(TURN_1_TEXT);
    expect(text).toContain("用户最近迷上摄影");
    expect(text).toContain("慕尼黑");
  });

  it("hard（默认 excludeInvalidated=true）+ 问当下：同样遮蔽（默认档不得漏）", async () => {
    const res = await call(mockStore(pool()), { userText: PRESENT_Q });
    const text = res.lines.join("\n");
    expect(text).not.toContain("柏林");
    expect(text).not.toContain(TURN_1_TEXT);
    expect(text).toContain("用户最近迷上摄影");
    expect(text).toContain("慕尼黑");
  });

  it("soft + 问历史：不遮蔽，旧值仍可回溯（零行为变化）", async () => {
    const res = await call(mockStore(pool()), { excludeInvalidated: "soft", userText: HISTORY_Q });
    const text = res.lines.join("\n");
    expect(text).toContain("柏林");
    expect(text).toContain(TURN_1_TEXT);
  });

  it("混合意图（既问现在又问过去）不遮蔽：旧值与新值同时注入（答案横跨两个时点）", async () => {
    // LME 深池实证：这类题 gold turn 往往就是含旧值的那条，遮蔽会把整条剔出注入（turnCov 0.5→0）。
    const MIXED_Q = "我刚开始工作的时候住在哪里？我现在住在哪里？";
    const res = await call(mockStore(pool()), { excludeInvalidated: "soft", userText: MIXED_Q });
    const text = res.lines.join("\n");
    expect(text).toContain("柏林");
    expect(text).toContain("慕尼黑");
  });

  it("事实短语本身仍含旧值 → 该行剔出注入（宁缺毋滥，绝不带旧值）", async () => {
    const hits = pool();
    // 抽取/归一异常的极端形状：兄弟行的 phrase 里也写着旧值。
    hits[1] = mk("turn-1#f2", TURN_1_TEXT, 0.9, OLD_START, {
      valid_start: OLD_START,
      metadata_json: factMd("turn-1", "用户住在柏林且最近迷上摄影", "摄影", 1, "multi"),
    });
    const res = await call(mockStore(hits), { excludeInvalidated: "soft", userText: PRESENT_Q });
    const text = res.lines.join("\n");
    expect(text).not.toContain("柏林");
    expect(text).not.toContain("摄影");
    expect(text).toContain("慕尼黑");
  });

  it("无污染源（池内无 expired 行）时零变化：父 turn 原文照常注入", async () => {
    const hits = pool();
    hits[0] = mk("turn-1", TURN_1_TEXT, 0.95, OLD_START, {
      valid_start: OLD_START,
      metadata_json: factMd("turn-1", "用户住在柏林", "柏林", 0),
    });
    const res = await call(mockStore(hits), { excludeInvalidated: "soft", userText: PRESENT_Q });
    expect(res.lines.join("\n")).toContain(TURN_1_TEXT);
  });

  it("excludeInvalidated=false（通道退出）：不遮蔽，逐位现状", async () => {
    const res = await call(mockStore(pool()), { excludeInvalidated: false, userText: PRESENT_Q });
    expect(res.lines.join("\n")).toContain("柏林");
  });
});
