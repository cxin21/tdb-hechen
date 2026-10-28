/**
 * #139 技术债收敛的单测：stages（取数/计数单一源）、写入策略参数簇、
 * 生效配置自检、缓存档 token 证据。
 *
 * 这些断言直接对应票面验收：
 *  - 「bench-gates 在缓存档也能给出 token 判定」→ 缓存命中 usageSource=estimated-cache 且 usage>0；
 *  - 「分阶段分支漏记 conclusionStats.ms」→ mergeStageStats 计入 ms；
 *  - 「#135 生产 override 吞沙箱 yaml」→ assertExpectedConfig 能报出 rerank.enabled 不符。
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createStageStats, fetchFactsAndConclusions, mergeStageStats, tokenEvidence } from "../scripts/lib/bench/stages.mjs";
import { factsForCase, saveCachedFacts, FACTS_PROMPT_VERSION } from "../scripts/lib/bench/facts.mjs";
import { conclusionsForCase, saveConclusionsCache, CONCLUSIONS_PROMPT_VERSION } from "../scripts/lib/bench/conclusions.mjs";
import {
  assertExpectedConfig,
  diffExpectedConfig,
  effectiveRecallSnapshot,
  normalizeWritePolicy,
  parseExpectConfig,
} from "../scripts/lib/bench/store.mjs";

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bench-stages-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const caseObj = (caseId = "case-1") => ({
  caseId,
  tenant: { user_id: "u", team_id: "t", agent_id: "a" },
  questionDateISO: "2026-01-01T00:00:00Z",
  groups: [
    {
      sessionId: "s1",
      turns: [
        { id: "t1", role: "user", speaker: "user", text: "I ran 5 kilometers this morning.", tsISO: "2025-12-30T08:00:00Z" },
        { id: "t2", role: "assistant", speaker: "assistant", text: "Nice work.", tsISO: "2025-12-30T08:01:00Z" },
      ],
    },
  ],
});

describe("#139 stages 单一源", () => {
  it("缓存命中档也累加 token（estimated-cache），并计入结论卡蒸馏耗时", async () => {
    const c = caseObj();
    // 预填缓存：usage 全 0（本机生产的真实形态）
    saveCachedFacts(tmp, c.caseId, {
      promptVersion: FACTS_PROMPT_VERSION,
      model: "MiniMax",
      caseId: c.caseId,
      turns: 1,
      usage: { prompt: 0, completion: 0 },
      byTurn: { t1: { phrases: ["Ran 5 kilometers this morning"], triples: [] } },
    });
    saveConclusionsCache(tmp, c.caseId, {
      promptVersion: CONCLUSIONS_PROMPT_VERSION,
      model: "MiniMax",
      caseId: c.caseId,
      maxCards: 4,
      usage: { prompt: 0, completion: 0 },
      cards: [{ content: "User ran 5 km on 2025-12-30", sourceTurnIds: ["t1"] }],
    });

    // llm=null：缓存命中必须零外呼（未命中会抛）
    const fetched = await fetchFactsAndConclusions({
      caseObj: c,
      factCacheDir: tmp,
      llm: null,
      model: "MiniMax",
      wantFacts: true,
      wantConclusions: true,
    });
    expect(fetched.facts.cacheHit).toBe(true);
    expect(fetched.facts.usageSource).toBe("estimated-cache");
    expect(fetched.facts.usage.prompt).toBeGreaterThan(0);
    expect(fetched.conclusions.cacheHit).toBe(true);
    expect(fetched.conclusions.usageSource).toBe("estimated-cache");

    const stats = mergeStageStats(createStageStats(), fetched);
    expect(stats.facts.cacheHits).toBe(1);
    expect(stats.facts.extractMs).toBe(0);
    expect(stats.facts.usage.prompt).toBeGreaterThan(0);
    expect(stats.facts.usageBySource["estimated-cache"].calls).toBe(1);
    // 旧分阶段分支漏记的 ms：这里必须被计入（命中为 0，但仍走同一累加路径）
    expect(stats.conclusions.groups).toBe(1);
    expect(stats.conclusions.cards).toBe(1);
    expect(stats.conclusions.ms).toBe(0);
    expect(stats.conclusions.usage.prompt).toBeGreaterThan(0);

    const ev = tokenEvidence(stats.facts);
    expect(ev.hasEstimated).toBe(true);
    expect(ev.total).toBeGreaterThan(0);
  });

  it("未启用段返回 null（不产生统计），启用段只用缓存不抛错", async () => {
    const fetched = await fetchFactsAndConclusions({ caseObj: caseObj("case-2"), factCacheDir: tmp, llm: null, wantFacts: false, wantConclusions: false });
    expect(fetched.facts).toBeNull();
    expect(fetched.conclusions).toBeNull();
    const stats = mergeStageStats(createStageStats(), fetched);
    expect(stats.facts.groups).toBe(0);
    expect(stats.conclusions.groups).toBe(0);
  });

  it("缓存 usage 为正数时按真值记账（不标估算）", async () => {
    const c = caseObj("case-3");
    saveCachedFacts(tmp, c.caseId, {
      promptVersion: FACTS_PROMPT_VERSION,
      model: "m",
      caseId: c.caseId,
      turns: 1,
      usage: { prompt: 120, completion: 40 },
      byTurn: { t1: { phrases: [], triples: [] } },
    });
    const fx = await factsForCase({ caseObj: c, cacheDir: tmp, llm: null, model: "m" });
    expect(fx.usageSource).toBe("cache");
    expect(fx.usage).toEqual({ prompt: 120, completion: 40 });
  });

  it("结论缓存 maxCards 不足时重蒸（命中条件不降级）", async () => {
    const c = caseObj("case-4");
    saveConclusionsCache(tmp, c.caseId, {
      promptVersion: CONCLUSIONS_PROMPT_VERSION,
      model: "m",
      caseId: c.caseId,
      maxCards: 2,
      usage: { prompt: 10, completion: 5 },
      cards: [{ content: "x", sourceTurnIds: ["t1"] }],
    });
    // maxCards=4 > 缓存里的 2 → 未命中；llm 缺失 → 抛（证明没有错误复用低配缓存）
    await expect(conclusionsForCase({ caseObj: c, cacheDir: tmp, llm: null, model: "m", maxCards: 4 })).rejects.toThrow();
  });
});

describe("#139 写入策略参数簇", () => {
  it("dualWrite/factChannel/supersede 缺 facts 时集中报错", () => {
    expect(() => normalizeWritePolicy({ dualWrite: true })).toThrow(/需要 facts/);
    expect(() => normalizeWritePolicy({ supersede: true })).toThrow(/需要 facts/);
    expect(() => normalizeWritePolicy({ factChannel: { enabled: true } })).toThrow(/需要 facts/);
  });

  it("缺省 cardinalityGate 为开，显式 false 才关", () => {
    const facts = { byTurn: { t1: { phrases: ["p"], triples: [] } } };
    expect(normalizeWritePolicy({}, { facts }).cardinalityGate).toBe(true);
    expect(normalizeWritePolicy({ cardinalityGate: false }, { facts }).cardinalityGate).toBe(false);
  });

  it("conclusions 从 ctx 回落，0 卡标记 emptyConclusions", () => {
    const facts = { byTurn: {} };
    const p = normalizeWritePolicy({}, { facts, conclusions: { cards: [] } });
    expect(p.conclusions.cards).toEqual([]);
    expect(p.emptyConclusions).toBe(true);
  });
});

describe("#135 生效配置自检", () => {
  const snapshot = () =>
    effectiveRecallSnapshot({
      recall: {
        maxResults: 5,
        candidateK: 32,
        fusion: { mode: "normalized" },
        rerank: { enabled: true, provider: "local", candidates: 32, minScore: -10.5, mode: "rerank", blend: 0.9 },
        smallToBig: { enabled: false, maxExtraLines: 4, budget: "shared" },
        conclusionLayer: { enabled: true, maxConclusions: 3 },
        factChannel: { enabled: true, weight: 0.6 },
        validity: { mode: "soft" },
        presentTemporal: { enabled: false },
      },
    });

  it("快照取的是生效值（enabled 布尔，不是 provider）", () => {
    const s = snapshot();
    expect(s["recall.rerank.enabled"]).toBe(true);
    expect(s["recall.smallToBig.enabled"]).toBe(false);
    expect(s["recall.factChannel.weight"]).toBe(0.6);
  });

  it("解析 key=value 并做数值/布尔归一", () => {
    const exp = parseExpectConfig("recall.rerank.enabled=false, recall.rerank.candidates=32,recall.fusion.mode=normalized");
    expect(exp).toEqual({ "recall.rerank.enabled": false, "recall.rerank.candidates": 32, "recall.fusion.mode": "normalized" });
    expect(() => parseExpectConfig("nope")).toThrow(/key=value/);
  });

  it("rerank 被生产 override 覆盖时断言失败并指名键", () => {
    const mism = diffExpectedConfig(snapshot(), { "recall.rerank.enabled": false });
    expect(mism).toHaveLength(1);
    expect(mism[0].key).toBe("recall.rerank.enabled");
    expect(() => assertExpectedConfig(snapshot(), { "recall.rerank.enabled": false })).toThrow(/recall.rerank.enabled/);
    expect(() => assertExpectedConfig(snapshot(), { "recall.rerank.candidates": 32, "recall.smallToBig.enabled": false })).not.toThrow();
  });
});

describe("#139 估算口径必须可见、判定不被估算改变", () => {
  it("provider 不报 usage 时 usageSource=estimated-live，tokenEvidence.estimatedCalls>0", async () => {
    const c = caseObj("case-est");
    // 真实调用但端点不返 usage（本机内网中转的常态）：估算必须被标出来，不能算成 live。
    const llm = {
      jsonWithUsage: async () => ({
        data: { results: [{ id: "t1", facts: [{ subject: "user", predicate: "ran", value: "5 km", phrase: "Ran 5 kilometers this morning" }] }] },
        usage: null,
      }),
    };
    const fx = await factsForCase({ caseObj: c, cacheDir: tmp, llm, model: "MiniMax", logger: { warn() {} } });
    expect(fx.cacheHit).toBe(false);
    expect(fx.usageSource).toBe("estimated-live");
    expect(fx.usage.prompt).toBeGreaterThan(0);
    expect(fx.usage.completion).toBeGreaterThan(0);

    const stats = createStageStats();
    mergeStageStats(stats, { facts: fx, conclusions: null });
    const tok = tokenEvidence(stats.facts);
    expect(tok.total).toBeGreaterThan(0);
    expect(tok.estimatedCalls).toBeGreaterThan(0);
    expect(tok.hasEstimated).toBe(true);
  });

  it("估算参与时门禁 verdict 仍按 budget 判定（FAIL 就是 FAIL，不因展示后缀逃逸）", async () => {
    const { judgeTokenBudget } = await import("../scripts/lib/bench/stages.mjs");
    expect(judgeTokenBudget({ tokens: 0, turns: 10, budgetTokensPerTurn: 800 }).verdict).toBe("SKIP");
    expect(judgeTokenBudget({ tokens: 8100, turns: 10, budgetTokensPerTurn: 800 }).verdict).toBe("FAIL");
    expect(judgeTokenBudget({ tokens: 8000, turns: 10, budgetTokensPerTurn: 800 }).verdict).toBe("PASS");
  });

  it("turns 缺失但有 token → SKIP（不拿 max(1,turns) 造出假 FAIL）", async () => {
    const { judgeTokenBudget } = await import("../scripts/lib/bench/stages.mjs");
    const r = judgeTokenBudget({ tokens: 5000, turns: 0, budgetTokensPerTurn: 800 });
    expect(r.verdict).toBe("SKIP");
    expect(r.reason).toBe("turns-missing");
  });

  it("usageSource=mixed 的桶计入 estimatedCalls（估算不得冒充计费事实）", () => {
    const stats = createStageStats();
    // 同一档里部分批 reported、部分批 estimated → facts.mjs 记 mixed
    stats.facts.usage = { prompt: 300, completion: 100 };
    stats.facts.usageBySource = {
      mixed: { calls: 2, prompt: 300, completion: 100 },
      live: { calls: 1, prompt: 10, completion: 5 },
    };
    const tok = tokenEvidence(stats.facts);
    expect(tok.mixedCalls).toBe(2);
    expect(tok.estimatedCalls).toBe(2);
    expect(tok.liveCalls).toBe(1);
    expect(tok.hasEstimated).toBe(true);
  });
});
