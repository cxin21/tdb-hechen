/**
 * R7-1 渐进式披露分层召回（DS-RECALL-LAYERED-R7-001）RED 套件 —— L2 结论层选择 + 预算切分 + 幂等组装。
 *
 * spec §2 R7-1 / §3 不变式：
 *   - L2 选择：query 与场景结论匹配（文本命中 + scene_name 命中，沿既有 detectSceneHit/buildFtsQuery 单一源）；
 *   - 幂等：结论未变化的场景不重组注入（借团队 幂等与防重 模式：命中已存不重组）；
 *   - 退化安全：无 L2 命中 → 与现状逐位一致（分层断言的前锚基线）；
 *   - 经验层防重：结论已收编的 work_fact 不在经验层重复出现（命中已存不重组）。
 */
import { describe, expect, it } from "vitest";
import {
  assembleLayeredLines,
  conclusionFingerprint,
  formatConclusionLine,
  parseFtsTokens,
  resolveIdempotentConclusionLines,
  selectL2Conclusions,
  splitBudget,
  truncateConclusionContent,
  type L2ConclusionCandidate,
} from "../recall-layered.js";
import { parseConfig } from "../../../config.js";
import { searchHybrid } from "../auto-recall.js";
import type { IMemoryStore, L1SearchResult } from "../../store/types.js";
import type { EmbeddingService } from "../../store/embedding.js";

const Q = "R7H 查询";

function cand(over: Partial<L2ConclusionCandidate> & { content: string }): L2ConclusionCandidate {
  return { sceneName: "", source: "scene_block", ...over };
}

// ═══════════════ R7-1 · L2 结论选择 ═══════════════

describe("R7-1 selectL2Conclusions（文本命中 + scene_name 命中，宁缺毋滥）", () => {
  it("scene_name 命中：query 含场景名 → 选中", () => {
    const out = selectL2Conclusions(
      `${Q} 项目重构`,
      [cand({ sceneName: "项目重构", content: "重构结论一句话" })],
      { ftsTokens: ["r7h", "查询"] },
      5,
    );
    expect(out).toHaveLength(1);
    expect(out[0].sceneName).toBe("项目重构");
  });

  it("文本命中：query token 为结论文本子串 → 选中", () => {
    const out = selectL2Conclusions(
      Q,
      [cand({ content: "登录缓存问题的结论是编码不一致" })],
      { ftsTokens: ["缓存"] },
      5,
    );
    expect(out).toHaveLength(1);
  });

  it("无命中 → 空（宁缺毋滥，退化安全前提）", () => {
    const out = selectL2Conclusions(
      "完全无关的其他话题",
      [
        cand({ sceneName: "项目重构", content: "重构结论" }),
        cand({ content: "登录缓存结论" }),
      ],
      { ftsTokens: ["归档"] },
      5,
    );
    expect(out).toHaveLength(0);
  });

  it("单字符 token 不参与文本命中（防噪声）", () => {
    const out = selectL2Conclusions(Q, [cand({ content: "结论里有单个的字" })], { ftsTokens: ["的"] }, 5);
    expect(out).toHaveLength(0);
  });

  it("work_fact 优先于 scene_block（持续态结论在前）；同层保序", () => {
    const out = selectL2Conclusions(
      `${Q} 缓存`,
      [
        cand({ sceneName: "场景B", content: "场景块缓存结论", source: "scene_block" }),
        cand({ content: "持续态缓存结论", source: "work_fact", recordId: "wf1" }),
      ],
      { ftsTokens: ["缓存"] },
      5,
    );
    expect(out.map((c) => c.source)).toEqual(["work_fact", "scene_block"]);
  });

  it("去重：同 scene+content 只保留一条", () => {
    const out = selectL2Conclusions(
      `${Q} 缓存`,
      [
        cand({ sceneName: "场景A", content: "缓存结论" }),
        cand({ sceneName: "场景A", content: "缓存结论" }),
      ],
      { ftsTokens: ["缓存"] },
      5,
    );
    expect(out).toHaveLength(1);
  });

  it("上限：命中数超 limit → 截断到 limit", () => {
    const out = selectL2Conclusions(
      `${Q} 缓存`,
      Array.from({ length: 4 }, (_, i) => cand({ sceneName: `场景${i}`, content: `缓存结论${i}` })),
      { ftsTokens: ["缓存"] },
      2,
    );
    expect(out).toHaveLength(2);
  });

  it("空候选 / 空 query → 空", () => {
    expect(selectL2Conclusions(Q, [], { ftsTokens: ["缓存"] }, 5)).toHaveLength(0);
    expect(selectL2Conclusions("", [cand({ content: "缓存结论" })], { ftsTokens: ["缓存"] }, 5)).toHaveLength(0);
  });
});

describe("R7-1 parseFtsTokens（buildFtsQuery 产物单源解析）", () => {
  it("OR 引号形态 → token 集；null → 空", () => {
    expect(parseFtsTokens('"记忆" OR "归档"')).toEqual(["记忆", "归档"]);
    expect(parseFtsTokens(null)).toEqual([]);
    expect(parseFtsTokens("")).toEqual([]);
  });
});

// ═══════════════ R7-1 · 预算切分 ═══════════════

describe("R7-1 splitBudget（注入 limit 对半；结论不足时余额给经验层）", () => {
  it("结论少 → 结论全额 + 余额归经验", () => {
    expect(splitBudget(10, 4)).toEqual({ conclusionLimit: 4, experienceLimit: 6 });
  });

  it("结论多 → 结论封顶一半", () => {
    expect(splitBudget(10, 8)).toEqual({ conclusionLimit: 5, experienceLimit: 5 });
  });

  it("奇数 limit 对半下取整", () => {
    expect(splitBudget(5, 5)).toEqual({ conclusionLimit: 2, experienceLimit: 3 });
  });

  it("无结论 → 经验层全额（退化安全）", () => {
    expect(splitBudget(6, 0)).toEqual({ conclusionLimit: 0, experienceLimit: 6 });
  });

  it("总预算 0 → 全 0", () => {
    expect(splitBudget(0, 3)).toEqual({ conclusionLimit: 0, experienceLimit: 0 });
  });
});

// ═══════════════ R7-3 · 注入形态（结论块前 + 经验折叠后）═══════════════

describe("R7-1 formatConclusionLine / assembleLayeredLines（[结论] 标注 + 结论块前）", () => {
  it("结论行带 [结论|场景] 标注；无场景名 → [结论]", () => {
    expect(formatConclusionLine({ sceneName: "场景A", content: "结论内容", source: "scene_block" })).toBe(
      "- [结论|场景A] 结论内容",
    );
    expect(formatConclusionLine({ sceneName: "", content: "结论内容", source: "work_fact" })).toBe(
      "- [结论] 结论内容",
    );
  });

  it("结论块在前、经验折叠在后", () => {
    const out = assembleLayeredLines(["- [结论|A] c1"], ["- [episodic] e1", "- [episodic] e2"]);
    expect(out).toEqual(["- [结论|A] c1", "- [episodic] e1", "- [episodic] e2"]);
  });

  it("无结论 → 与经验序列逐位一致（退化安全）", () => {
    const exp = ["- [episodic] e1", "- [episodic] e2"];
    expect(assembleLayeredLines([], exp)).toEqual(exp);
  });
});

// ═══════════════ R7-1 · 幂等结论层（命中已存不重组）═══════════════

describe("R7-1 幂等结论层（resolveIdempotentConclusionLines）", () => {
  it("同 session 同指纹 → 复用已存行（不重组，reused=true）", () => {
    const fp = conclusionFingerprint([{ sceneName: "A", content: "c", source: "scene_block" }]);
    const first = resolveIdempotentConclusionLines("s1", fp, ["- [结论|A] c"], 300_000, 1000);
    expect(first.reused).toBe(false);
    const second = resolveIdempotentConclusionLines("s1", fp, ["- [结论|A] c-重组后"], 300_000, 2000);
    expect(second.reused).toBe(true);
    expect(second.lines).toEqual(["- [结论|A] c"]); // 复用已存，不用 fresh 重组
  });

  it("指纹变化（结论变了）→ 重组", () => {
    resolveIdempotentConclusionLines("s2", "fp-old", ["- [结论] 旧"], 300_000, 1000);
    const next = resolveIdempotentConclusionLines("s2", "fp-new", ["- [结论] 新"], 300_000, 2000);
    expect(next.reused).toBe(false);
    expect(next.lines).toEqual(["- [结论] 新"]);
  });

  it("TTL 过期 → 重组（漂移防御）", () => {
    resolveIdempotentConclusionLines("s3", "fp", ["- [结论] 旧"], 100, 1000);
    const next = resolveIdempotentConclusionLines("s3", "fp", ["- [结论] 新"], 100, 1000 + 101);
    expect(next.reused).toBe(false);
  });

  it("ttl<=0 → 通道关（每次重组，不缓存）", () => {
    const a = resolveIdempotentConclusionLines("s4", "fp", ["- [结论] a"], 0, 1000);
    const b = resolveIdempotentConclusionLines("s4", "fp", ["- [结论] b"], 0, 2000);
    expect(a.reused).toBe(false);
    expect(b.reused).toBe(false);
    expect(b.lines).toEqual(["- [结论] b"]);
  });

  it("上界 200 session 防膨胀：最旧条目被逐出", () => {
    for (let i = 0; i < 201; i++) {
      resolveIdempotentConclusionLines(`bulk-${i}`, `fp-${i}`, [`l${i}`], 300_000, 1000 + i);
    }
    const evicted = resolveIdempotentConclusionLines("bulk-0", "fp-0", ["fresh"], 300_000, 9999);
    expect(evicted.reused).toBe(false);
  });
});

// ═══════════════ 审查修补 I③ · refresh-on-hit（缓存友好兑现） ═══════════════

describe("审查修补 I③ · resolveIdempotentConclusionLines refresh-on-hit（命中复用刷新插入序）", () => {
  it("命中复用刷新插入序——热键不被 FIFO 逐出；TTL 锚定首次写入（at 不刷新）", () => {
    // 灌满至容量上界（本测试专属键；此前用例遗留键会被自然挤出）
    for (let i = 0; i < 200; i++) {
      resolveIdempotentConclusionLines(`r7fix-lru-${i}`, `fp-${i}`, [`l${i}`], 300_000, 1000 + i);
    }
    // 命中最早写入的热键（refresh-on-hit：移到迭代序末尾）
    const hitRes = resolveIdempotentConclusionLines("r7fix-lru-0", "fp-0", ["fresh"], 300_000, 5000);
    expect(hitRes.reused).toBe(true);
    expect(hitRes.lines).toEqual(["l0"]); // 复用已存行，不用 fresh 重组
    // 再插入一个新键触发逐出：被逐出的应是未刷新的 r7fix-lru-1（FIFO 头），而非刷新过的 lru-0
    resolveIdempotentConclusionLines("r7fix-lru-new", "fp-new", ["lnew"], 300_000, 6000);
    const evicted = resolveIdempotentConclusionLines("r7fix-lru-1", "fp-1", ["fresh1"], 300_000, 7000);
    expect(evicted.reused).toBe(false);
    const survived = resolveIdempotentConclusionLines("r7fix-lru-0", "fp-0", ["fresh0"], 300_000, 8000);
    expect(survived.reused).toBe(true); // 热键幸存（refresh-on-hit 生效）
    expect(survived.lines).toEqual(["l0"]);
  });
});

// ═══════════════ 审查修补 I①/I③ · conclusionLayer 开关与 TTL 配置解析 ═══════════════

describe("审查修补 I①/I③ config：conclusionLayer.enabled / cacheTtlMs", () => {
  it("enabled 未配置 → true（现行为）；显式 false → false", () => {
    expect(parseConfig({ recall: { enabled: true } }).recall.conclusionLayer.enabled).toBe(true);
    expect(parseConfig({ recall: { conclusionLayer: { enabled: false } } }).recall.conclusionLayer.enabled).toBe(false);
  });

  it("cacheTtlMs 未配置 → undefined（运行期回落 sessionReuseTtlMs 保持现行为）", () => {
    expect(parseConfig({ recall: { enabled: true } }).recall.conclusionLayer.cacheTtlMs).toBeUndefined();
  });

  it("cacheTtlMs 显式 0 → 0（关）；正值透传；负值 clamp 0", () => {
    expect(parseConfig({ recall: { conclusionLayer: { cacheTtlMs: 0 } } }).recall.conclusionLayer.cacheTtlMs).toBe(0);
    expect(parseConfig({ recall: { conclusionLayer: { cacheTtlMs: 120_000 } } }).recall.conclusionLayer.cacheTtlMs).toBe(120_000);
    expect(parseConfig({ recall: { conclusionLayer: { cacheTtlMs: -3 } } }).recall.conclusionLayer.cacheTtlMs).toBe(0);
  });
});

// ═══════════════ R7-1 · 经验层防重（结论已收编 → 不在经验层重复）═══════════════

function hit(id: string, over: Partial<L1SearchResult> = {}): L1SearchResult {
  return {
    record_id: id,
    content: `R7H 记忆条目 ${id}`,
    type: "episodic",
    priority: 0,
    scene_name: "",
    score: 0.5,
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

function hybridMock(hits: L1SearchResult[]): { vectorStore: IMemoryStore; embeddingService: EmbeddingService } {
  const vectorStore = {
    isFtsAvailable: () => false,
    searchL1Vector: async () => hits,
  } as unknown as IMemoryStore;
  const embeddingService = { embed: async () => new Float32Array(4) } as unknown as EmbeddingService;
  return { vectorStore, embeddingService };
}

describe("R7-1 经验层防重（excludeIds：命中已存不重组）", () => {
  it("excludeIds 中的记录从经验层排除，其余保序", async () => {
    const { vectorStore, embeddingService } = hybridMock([hit("a"), hit("wf1"), hit("b")]);
    const res = await searchHybrid(Q, "", 10, 0.3, vectorStore, embeddingService, undefined, undefined, undefined, undefined, {
      excludeIds: ["wf1"],
      conclusionRefs: [],
      sceneNames: [],
    });
    expect(res.lines.some((l) => l.includes("wf1"))).toBe(false);
    expect(res.lines.map((l) => (l.includes("条目 a") ? "a" : "b"))).toEqual(["a", "b"]);
  });

  it("layered 缺省 → 与现状逐位一致（退化安全）", async () => {
    const hits = [hit("a"), hit("b")];
    const m1 = hybridMock(hits);
    const m2 = hybridMock(hits);
    const base = await searchHybrid(Q, "", 10, 0.3, m1.vectorStore, m1.embeddingService);
    const layered = await searchHybrid(Q, "", 10, 0.3, m2.vectorStore, m2.embeddingService, undefined, undefined, undefined, undefined, {
      excludeIds: [],
      conclusionRefs: [],
      sceneNames: [],
    });
    expect(layered.lines).toEqual(base.lines);
  });
});

// ═══════════════ Task CAL C1 · 结论层注入前截断 ═══════════════

describe("Task CAL C1 truncateConclusionContent（结论层注入前截断，spec：块 ≤ maxCharsPerMemory + 标注在场）", () => {
  it("21,660 字符场景块截断到 ≤2000 字符 + 尾部 …[截断:原文N字] 标注在场（首跑 F1 万词面匹配器修最痛）", () => {
    const big = "架构决策记录".repeat(3610); // 21,660 字符（与首跑 TDB团队-技术架构文档 摘要同规模）
    expect([...big].length).toBe(21660);
    const out = truncateConclusionContent(big, 2000);
    const len = [...out].length;
    expect(len).toBeLessThanOrEqual(2000);
    expect(out).toMatch(/…\[截断:原文21660字\]$/);
    expect(out.startsWith("架构决策记录")).toBe(true);
  });

  it("截断标注计入 maxChars 预算（保留正文 = maxChars − 标注长度，码点安全）", () => {
    const big = "甲乙丙丁".repeat(600); // 2400 字符
    const out = truncateConclusionContent(big, 100);
    const len = [...out].length;
    expect(len).toBeLessThanOrEqual(100);
    expect(out.endsWith("…[截断:原文2400字]")).toBe(true);
  });

  it("短内容 ≤ maxChars → 原样返回（无标注、无改动）", () => {
    const s = "一句话结论";
    expect(truncateConclusionContent(s, 2000)).toBe(s);
    expect(truncateConclusionContent(s, s.length)).toBe(s);
  });

  it("maxChars=0 → 不截断（0=关闭截断通道，brief：0=不截断）", () => {
    const big = "x".repeat(5000);
    expect(truncateConclusionContent(big, 0)).toBe(big);
  });

  it("maxChars 非法（负数/非有限数）→ 不截断（宁缺毋滥降级，不在召回路径抛异常）", () => {
    const big = "y".repeat(3000);
    expect(truncateConclusionContent(big, -5)).toBe(big);
    expect(truncateConclusionContent(big, Number.NaN)).toBe(big);
  });

  it("极小 maxChars（不足以容纳标注）→ 纯码点截断不标注（退化不崩溃）", () => {
    const big = "z".repeat(100);
    const out = truncateConclusionContent(big, 5);
    expect([...out].length).toBe(5);
    expect(out).toBe("zzzzz");
  });

  it("formatConclusionLine 行首 - [结论|场景名] 结构不受截断影响（metric 解析正则兼容）", () => {
    const big = "结论内容".repeat(1000);
    const truncated = truncateConclusionContent(big, 2000);
    const line = formatConclusionLine({ sceneName: "TDB团队-技术架构文档", content: truncated, source: "scene_block" });
    expect(line).toMatch(/^- \[结论\|TDB团队-技术架构文档\] /);
    expect(line).toMatch(/…\[截断:原文4000字\]$/);
  });
});

describe("Task CAL C1 config：conclusionLayer.maxCharsPerMemory（默认 2000，0=不截断）", () => {
  it("未配置 → 默认 2000（brief：默认 2000 字符/块）", () => {
    const cfg = parseConfig({ recall: { enabled: true } });
    expect(cfg.recall.conclusionLayer.maxCharsPerMemory).toBe(2000);
  });

  it("显式 0 → 0（不截断）；显式正值透传；负值 clamp 0", () => {
    expect(parseConfig({ recall: { conclusionLayer: { maxCharsPerMemory: 0 } } }).recall.conclusionLayer.maxCharsPerMemory).toBe(0);
    expect(parseConfig({ recall: { conclusionLayer: { maxCharsPerMemory: 500 } } }).recall.conclusionLayer.maxCharsPerMemory).toBe(500);
    expect(parseConfig({ recall: { conclusionLayer: { maxCharsPerMemory: -3 } } }).recall.conclusionLayer.maxCharsPerMemory).toBe(0);
  });
});
