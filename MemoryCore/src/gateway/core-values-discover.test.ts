/**
 * Task DISC：价值锚发现（Anchor Discovery，提议制）vitest。
 *
 * 覆盖（brief 验收）：
 *   - mock LLM：提案 2 条 / 0 条 / 幻觉 label / 证据重算
 *   - 提案不落库断言（K1 信任边界：discover 全程只读）
 *   - weight 公式边界（0 / 等样本 / 超样本 / 零样本守卫）
 *   - 去重（已有锚不再提 + 提案内部去重）
 *   - 宽松 JSON 解析（code fence / garbage / 非 JSON）
 *   - prompt 形状（截断 200 字 / 已有锚清单 / JSON 输出指令）
 *
 * harness 仿 scripts/verify-c2.ts 的 depsFor（mock store + iso + mock runner），
 * 纯函数直引 ./core-values-discover.js（无 LLM、无 IO、确定性）。
 */
import { describe, it, expect, vi } from "vitest";

import {
  suggestAnchorWeight,
  recountEvidence,
  parseProposalsJson,
  dedupProposals,
  buildDiscoverPrompt,
  selectSampleRows,
  DISCOVER_SAMPLE_CAP,
  DISCOVER_TRUNCATE_CHARS,
  DISCOVER_MIN_EVIDENCE,
} from "./core-values-discover.js";
import { handleCoreMemoryValuesDiscover } from "./v2-router.js";

// ── 纯函数：weight 公式边界 ──────────────────────────────────────

describe("suggestAnchorWeight（0.3..0.8，0.3 + 0.5*e/sampleSize）", () => {
  it("e=0 → 下限 0.3", () => {
    expect(suggestAnchorWeight(0, 10)).toBe(0.3);
  });
  it("e=3, sample=10 → 0.45", () => {
    expect(suggestAnchorWeight(3, 10)).toBeCloseTo(0.45, 10);
  });
  it("e=sampleSize → 上限 0.8（不被超出）", () => {
    expect(suggestAnchorWeight(10, 10)).toBe(0.8);
  });
  it("e>sampleSize（幻觉重算后不可能但公式守卫）→ clamp 0.8", () => {
    expect(suggestAnchorWeight(20, 10)).toBe(0.8);
  });
  it("sampleSize=0 → 守卫返回下限 0.3（流程不可达：无语料必无提案）", () => {
    expect(suggestAnchorWeight(5, 0)).toBe(0.3);
  });
});

// ── 纯函数：证据重算口径 ────────────────────────────────────────

describe("recountEvidence（LLM 报数不可信，按 label 关键词实际命中重算）", () => {
  const corpus = [
    "完成增量对账设计：FTS5 与向量混合检索",
    "增量对账脚本跑通，零孤儿",
    "今天天气不错",
    "对账：内容 sha256 指纹增量对齐", // 只含「对账」不含「增量」→ CJK 整串判定不命中
  ];

  it("纯 CJK label：整串子串包含判定，逐条计数", () => {
    expect(recountEvidence("增量对账", corpus)).toBe(2);
  });
  it("幻觉 label（语料零命中）→ 0", () => {
    expect(recountEvidence("不存在的主题", corpus)).toBe(0);
  });
  it("latin 多 token label：全 token 命中才计数（大小写不敏感）", () => {
    const c = ["Code Review every PR", "we do code review daily", "code standards only", "CODE and REVIEW"];
    expect(recountEvidence("Code Review", c)).toBe(3);
  });
  it("空 label → 0", () => {
    expect(recountEvidence("  ", corpus)).toBe(0);
  });
  it("确定性：同输入同输出（两次调用一致）", () => {
    expect(recountEvidence("增量对账", corpus)).toBe(recountEvidence("增量对账", corpus));
  });
});

// ── 纯函数：宽松 JSON 解析（仿 parseBatchResult 宁缺毋滥）────────

describe("parseProposalsJson（宽松解析，丢弃不可用项）", () => {
  it("纯 JSON 数组字符串 → 解析出候选", () => {
    const raw = JSON.stringify([
      { label: "增量对账", rationale: "反复出现", evidenceCount: 99 },
      { label: "实证求真", rationale: "一切结论以数据为准", evidenceCount: 5 },
    ]);
    expect(parseProposalsJson(raw)).toEqual([
      { label: "增量对账", rationale: "反复出现" },
      { label: "实证求真", rationale: "一切结论以数据为准" },
    ]);
  });
  it("code-fence 包裹（推理模型常见）→ 剥离后解析", () => {
    const raw = '```json\n[{"label":"克己","rationale":"r","evidenceCount":4}]\n```';
    expect(parseProposalsJson(raw)).toEqual([{ label: "克己", rationale: "r" }]);
  });
  it("garbage / 无数组 / JSON.parse 失败 → []（不抛错）", () => {
    expect(parseProposalsJson("garbage")).toEqual([]);
    expect(parseProposalsJson('{"not":"array"}')).toEqual([]);
    expect(parseProposalsJson("[{broken")).toEqual([]);
    expect(parseProposalsJson("")).toEqual([]);
  });
  it("非对象项 / 空 label 丢弃；evidenceCount 不采信不透传", () => {
    const raw = JSON.stringify([
      "not-an-object",
      null,
      { label: "  ", rationale: "r" },
      { label: "可用", rationale: "r" },
    ]);
    expect(parseProposalsJson(raw)).toEqual([{ label: "可用", rationale: "r" }]);
  });
});

// ── 纯函数：去重 ────────────────────────────────────────────────

describe("dedupProposals（已有锚不再提 + 提案内部去重，归一化比对）", () => {
  const existing = ["增量对账", " 实证求真 "];
  it("与已有锚 label 相同（trim+大小写归一化）→ 丢弃", () => {
    const out = dedupProposals(
      [
        { label: "增量对账", rationale: "r1" },
        { label: "增量对账 ", rationale: "r2" },
        { label: "新主题", rationale: "r3" },
      ],
      existing,
    );
    expect(out).toEqual([{ label: "新主题", rationale: "r3" }]);
  });
  it("提案内部同义重复只留第一个", () => {
    const out = dedupProposals(
      [
        { label: "主题A", rationale: "first" },
        { label: "主题A", rationale: "dup" },
      ],
      [],
    );
    expect(out).toEqual([{ label: "主题A", rationale: "first" }]);
  });
});

// ── 纯函数：prompt 形状 ─────────────────────────────────────────

describe("buildDiscoverPrompt（样本量控制 50×200 字 + 已有锚 + JSON 输出指令）", () => {
  it("超 200 字的样本被截断到 200 字 + 省略号", () => {
    const long = "增".repeat(500);
    const p = buildDiscoverPrompt([long], []);
    expect(p).toContain("增".repeat(DISCOVER_TRUNCATE_CHARS) + "…");
    expect(p).not.toContain("增".repeat(DISCOVER_TRUNCATE_CHARS + 1));
  });
  it("已有锚清单与去重指令出现；输出格式为 JSON 数组且带 evidence<3 不提约束", () => {
    const p = buildDiscoverPrompt(["样本一"], ["已有锚甲"]);
    expect(p).toContain("已有锚甲");
    expect(p).toContain("去重");
    expect(p).toContain("JSON");
    expect(String(DISCOVER_MIN_EVIDENCE)).toBe("3");
    expect(p).toContain("3");
  });
  it("样本 cap：超过 50 条只取 50（DISCOVER_SAMPLE_CAP）", () => {
    expect(DISCOVER_SAMPLE_CAP).toBe(50);
    expect(DISCOVER_TRUNCATE_CHARS).toBe(200);
  });
});

// ── 纯函数：样本选取（高 significance 优先 + 最近补齐 + 硬上限 50）─

describe("selectSampleRows（高 significance 优先，最近补齐，硬上限 50）", () => {
  function row(id: string, updated: string, opts: { sig?: number; priority?: number } = {}) {
    return {
      record_id: id,
      content: `content-${id}`,
      type: "episodic",
      priority: opts.priority ?? 0.5,
      scene_name: "",
      session_key: "",
      session_id: "",
      team_id: "t",
      task_id: "",
      user_id: "u",
      agent_id: "a",
      version: 1,
      timestamp_str: updated,
      timestamp_start: updated,
      timestamp_end: updated,
      created_time: updated,
      updated_time: updated,
      metadata_json: opts.sig !== undefined ? JSON.stringify({ significance: opts.sig }) : "{}",
    };
  }

  it("高 significance（metadata.significance ≥ 0.8）优先入选，其余按 updated_time 倒序补齐", () => {
    const rows = [
      row("r1", "2026-09-01T00:00:00Z"),
      row("r2", "2026-09-02T00:00:00Z", { sig: 0.9 }),
      row("r3", "2026-09-03T00:00:00Z"),
    ];
    const sample = selectSampleRows(rows, 50);
    expect(sample.map((r) => r.record_id)).toEqual(["r2", "r3", "r1"]);
  });
  it("硬上限 cap：只取 cap 条", () => {
    const rows = Array.from({ length: 60 }, (_, i) => row(`r${i}`, new Date(2026, 8, 1 + i).toISOString()));
    const sample = selectSampleRows(rows, 50);
    expect(sample.length).toBe(50);
  });
  it("cap=0 → 空样本", () => {
    expect(selectSampleRows([row("r1", "2026-09-01T00:00:00Z")], 0)).toEqual([]);
  });
});

// ── handler：handleCoreMemoryValuesDiscover ─────────────────────

const ISO_A = { teamId: "teamA", userId: "userA", agentId: "agentA", sessionId: "s1" };
const AUTH = {} as never;

function rowFor(recordId: string, content: string, updated: string) {
  return {
    record_id: recordId,
    content,
    type: "episodic",
    priority: 0.5,
    scene_name: "",
    session_key: "",
    session_id: "s1",
    team_id: "teamA",
    task_id: "",
    user_id: "userA",
    agent_id: "agentA",
    version: 1,
    timestamp_str: updated,
    timestamp_start: updated,
    timestamp_end: updated,
    created_time: updated,
    updated_time: updated,
    metadata_json: "{}",
  };
}

/** mock store：queryL1Records 返回语料；listValues 返回已有锚；upsertValue 为 spy（不落库断言）。 */
function mockStore(opts: { rows?: unknown[]; values?: Array<{ value_id: string; label: string; weight: number; created_by: string; valence: number | null }> } = {}) {
  const upsertValue = vi.fn(async () => true);
  return {
    queryL1Records: vi.fn(async () => opts.rows ?? []),
    listValues: vi.fn(async () => opts.values ?? []),
    upsertValue,
  };
}

/** mock LLM runner：可编程返回 + 记录 run() 调用参数（maxTokens 覆写断言用）。 */
function mockRunner(reply: string) {
  const calls: Array<{ params: Record<string, unknown> }> = [];
  return {
    run: async (params: Record<string, unknown>) => {
      calls.push({ params });
      return reply;
    },
    calls,
  };
}

function depsFor(store: unknown, iso: typeof ISO_A | undefined, runner: unknown) {
  return {
    getStore: () => store,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    requestIsolation: iso,
    getValueValenceLlmRunner: async () => runner,
  } as never;
}

describe("POST /core-memory/values/discover（提议制 handler）", () => {
  const corpusRows = [
    rowFor("r1", "增量对账：FTS5 与向量混合检索跑通", "2026-09-01T00:00:00Z"),
    rowFor("r2", "增量对账脚本幂等，零孤儿", "2026-09-02T00:00:00Z"),
    rowFor("r3", "增量对账对账完成", "2026-09-03T00:00:00Z"),
    rowFor("r4", "无关内容", "2026-09-04T00:00:00Z"),
  ];

  it("提案 2 条：证据重算覆盖 LLM 报数 + weight 公式 + sampleSize；不落库（K1）", async () => {
    const store = mockStore({ rows: corpusRows, values: [{ value_id: "existing", label: "已有锚", weight: 0.5, created_by: "agent", valence: null }] });
    const runner = mockRunner(
      JSON.stringify([
        { label: "增量对账", rationale: "反复出现", evidenceCount: 999 },
        { label: "实证求真", rationale: "以数据为准", evidenceCount: 1 },
      ]),
    );
    const res = await handleCoreMemoryValuesDiscover({}, AUTH, "req-disc-1", depsFor(store, ISO_A, runner));

    expect(res.code).toBe(0);
    const data = (res as { data: { proposals: Array<{ label: string; rationale: string; evidenceCount: number; suggestedWeight: number }>; sampleSize: number } }).data;
    expect(data.sampleSize).toBe(4);
    // 提案1：重算 999 → 实际命中 3（r1/r2/r3），weight = 0.3 + 0.5*3/4 = 0.675
    expect(data.proposals[0]).toEqual({ label: "增量对账", rationale: "反复出现", evidenceCount: 3, suggestedWeight: 0.675 });
    // 提案2：重算 1 < 3 → 宁缺毋滥丢弃
    expect(data.proposals.length).toBe(1);
    // K1：discover 全程只读——upsertValue 永不被调用
    expect(store.upsertValue).not.toHaveBeenCalled();
    // maxTokens 覆写 8192（推理模型输出预算）+ taskId
    expect(runner.calls.length).toBe(1);
    expect(runner.calls[0].params.maxTokens).toBe(8192);
    expect(runner.calls[0].params.taskId).toBe("core-values-discover");
  });

  it("LLM 0 条提议 → proposals: []（宁缺毋滥，不造）", async () => {
    const store = mockStore({ rows: corpusRows });
    const runner = mockRunner("[]");
    const res = await handleCoreMemoryValuesDiscover({}, AUTH, "req-disc-2", depsFor(store, ISO_A, runner));
    expect(res.code).toBe(0);
    expect((res as { data: { proposals: unknown[] } }).data.proposals).toEqual([]);
    expect(store.upsertValue).not.toHaveBeenCalled();
  });

  it("幻觉 label（语料零命中）→ 重算 0 < 3 → 丢弃；去重：已有锚不再提", async () => {
    const store = mockStore({
      rows: corpusRows,
      values: [{ value_id: "a", label: "增量对账", weight: 0.6, created_by: "agent", valence: 1 }],
    });
    const runner = mockRunner(
      JSON.stringify([
        { label: "幻觉主题", rationale: "r", evidenceCount: 50 },
        { label: "增量对账", rationale: "已有锚重复", evidenceCount: 30 },
      ]),
    );
    const res = await handleCoreMemoryValuesDiscover({}, AUTH, "req-disc-3", depsFor(store, ISO_A, runner));
    expect(res.code).toBe(0);
    expect((res as { data: { proposals: unknown[] } }).data.proposals).toEqual([]);
  });

  it("无 LLM runner → 503（R3 降级可见，不静默空数组）", async () => {
    const store = mockStore({ rows: corpusRows });
    const res = await handleCoreMemoryValuesDiscover({}, AUTH, "req-disc-4", depsFor(store, ISO_A, undefined));
    expect(res.code).toBe(503);
  });

  it("无 store → 503", async () => {
    const res = await handleCoreMemoryValuesDiscover({}, AUTH, "req-disc-5", depsFor(undefined, ISO_A, mockRunner("[]")));
    expect(res.code).toBe(503);
  });

  it("LLM 输出不可解析（garbage）→ proposals: []，不抛错", async () => {
    const store = mockStore({ rows: corpusRows });
    const runner = mockRunner("完全不是 JSON");
    const res = await handleCoreMemoryValuesDiscover({}, AUTH, "req-disc-6", depsFor(store, ISO_A, runner));
    expect(res.code).toBe(0);
    expect((res as { data: { proposals: unknown[] } }).data.proposals).toEqual([]);
  });

  it("租户过滤：queryL1Records / listValues 按请求隔离三元组调用", async () => {
    const store = mockStore({ rows: corpusRows });
    const runner = mockRunner("[]");
    await handleCoreMemoryValuesDiscover({}, AUTH, "req-disc-7", depsFor(store, ISO_A, runner));
    expect(store.queryL1Records).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: "teamA", userId: "userA", agentId: "agentA" }),
    );
    expect(store.listValues).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: "teamA", userId: "userA", agentId: "agentA" }),
    );
  });
});
