/**
 * S4 判侧接线验收（[TRAIT-PROTOCOL v1]，spec §3.1）：
 * 1) 判侧提示词的信息屏障——只有事件 + 六轴锚 + 规则 + schema + 标签名，
 *    没有当前卡文本、没有当前数值、没有上一轮的票；
 * 2) 六轴与五条计票规则逐字进提示词（判据靠文本，不靠模型记性）；
 * 3) 坏输出（越界轴 / 越界步长 / 非 ep- id / 非 JSON）零票不抛；
 * 4) 端到端两轮：临时库跑 runSoulMaintenance，soul_trait_state 真的动、账本留 drift 行。
 * 只用 mkdtemp 临时库，不碰生产库，不联网。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createTraitJudge } from "../trait-judge.js";
import { buildTraitJudgePrompt, TRAIT_JUDGE_SYSTEM_PROMPT } from "../trait-judge-prompt.js";
import { AXIS_ANCHORS, AXIS_LABELS, SEED_LABELS, SOUL_AXES, TRAIT_PROTOCOL_VERSION } from "../traits.js";
import type { TraitVote } from "../trait-drift.js";
import type { SoulEpisode } from "../types.js";
import { VectorStore } from "../../store/sqlite.js";
import type { L0Record } from "../../store/types.js";
import { runSoulMaintenance } from "../worker.js";
import { resolveSoulConfig } from "../types.js";
import { runSoulMaintenanceTick } from "../../lifecycle/lifecycle-scheduler.js";

const T = { teamId: "t-judge", userId: "u-judge", agentId: "a-judge" };

function episode(id: string, patch: Partial<SoulEpisode> = {}): SoulEpisode {
  return {
    episodeId: `ep-${id}`,
    at: "2026-11-07T02:00:00.000Z",
    day: "2026-11-07",
    kind: "correction",
    title: "他把这处改动算在我头上",
    object: "改动",
    participants: ["他", "我"],
    userStance: "他认为这一列是我改坏的",
    agentStance: "我否认是自己造成的",
    cost: "",
    outcome: "他要求我重查",
    valence: -0.42,
    arousal: 0.61,
    intensity: 0.73,
    evidenceIds: [`l0-${id}`],
    sessionId: "s-judge",
    quote: { text: "这处不对，是不是你改坏的", role: "user", recordId: `l0-${id}` },
    affectSource: "lexicon",
    ...patch,
  };
}

function l0(id: string, role: string, text: string, at: string): L0Record {
  return {
    id,
    sessionKey: "s-judge-e2e",
    sessionId: "s-judge-e2e",
    taskId: "task-judge",
    role,
    messageText: text,
    recordedAt: at,
    timestamp: Date.parse(at),
    ...T,
  };
}

describe("S4 判侧提示词：信息屏障（判据 12）", () => {
  it("只给事件与规则，不含当前卡文本/当前数值/上一轮票", () => {
    const prompt = `${TRAIT_JUDGE_SYSTEM_PROMPT}\n${buildTraitJudgePrompt([episode("a"), episode("b")])}`;
    // 卡文本：18 条种子标签的 gloss 是进卡的性格注解，判侧看到就会开始模仿语气。
    for (const seed of SEED_LABELS) expect(prompt).not.toContain(seed.gloss);
    // definition 也不能进：traits.ts 现有 18 条种子里 14 条 definition 与 gloss 一字不差，
    // 把定义递给判侧等于把进卡文本递过去（判据 12 要求 0 次泄漏）。所以标签只给名字。
    for (const seed of SEED_LABELS) expect(prompt).not.toContain(seed.definition);
    // 当前数值：任何小数都算泄漏（α、state、上轮 net 全是小数）；本提示词只有整数步长。
    expect(prompt).not.toMatch(/\d+\.\d+/);
    expect(prompt).not.toContain("state=");
    expect(prompt).not.toContain("axis_json");
    expect(prompt).not.toContain("soul_trait_state");
    // 事件里的情绪读数可反推当前人格，不进判侧输入。
    expect(prompt).not.toContain("valence");
    expect(prompt).not.toContain("arousal");
    expect(prompt).not.toContain("intensity");
    // 但事件本身必须在：判据不能靠模型猜他在气什么。
    expect(prompt).toContain("ep-a");
    expect(prompt).toContain("这处不对，是不是你改坏的");
    expect(prompt).toContain("他认为这一列是我改坏的");
  });
});

describe("S4 判侧提示词：六轴锚与五条规则逐字进提示词", () => {
  it("六轴（中英名 + 高低锚）与 [TRAIT-PROTOCOL v1] 头都在", () => {
    const prompt = TRAIT_JUDGE_SYSTEM_PROMPT;
    expect(prompt).toContain(`[TRAIT-PROTOCOL ${TRAIT_PROTOCOL_VERSION}]`);
    for (const axis of SOUL_AXES) {
      expect(prompt).toContain(axis);
      expect(prompt).toContain(AXIS_LABELS[axis]);
      expect(prompt).toContain(AXIS_ANCHORS[axis].high);
      expect(prompt).toContain(AXIS_ANCHORS[axis].low);
    }
    // rigor 与 boundary 的分界是这份契约最容易混的地方，必须写明。
    expect(prompt).toContain("rigor = 做得对不对；boundary = 说得实不实");
  });

  it("五条计票规则与输出 schema 都在（含标签方向载荷）", () => {
    const prompt = TRAIT_JUDGE_SYSTEM_PROMPT;
    expect(prompt).toContain("只对显式行为计票，无证据不投");
    expect(prompt).toContain("每条事件最多两个轴，每轴只 ±1");
    expect(prompt).toContain("不复述人格、不推断动机、不因语气礼貌加分");
    expect(prompt).toContain("direction 是载荷不是数值");
    expect(prompt).toContain("新标签必须可区分");
    expect(prompt).toContain('"votes"');
    expect(prompt).toContain('"label_proposals"');
    expect(prompt).toContain('"direction"');
    expect(prompt).toContain('"evidence_ids"');
    // 已有标签名要进（同义复用），但没有 gloss。
    for (const seed of SEED_LABELS) expect(prompt).toContain(seed.label);
  });
});

describe("S4 createTraitJudge：坏输出零票不抛", () => {
  it("任务参数固定，且用判侧提示词", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const judge = createTraitJudge({
      run: async (params) => {
        calls.push(params as unknown as Record<string, unknown>);
        return '{"votes":[],"label_proposals":[]}';
      },
    });
    const out = await judge([episode("a")]);
    expect(out.votes).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0].taskId).toBe("memory.soul-trait-judge");
    expect(calls[0].timeoutMs).toBe(60_000);
    expect(calls[0].maxTokens).toBe(32768);
    expect(calls[0].systemPrompt).toBe(TRAIT_JUDGE_SYSTEM_PROMPT);
    expect(String(calls[0].prompt)).toContain("ep-a");
  });

  it("非 JSON 输出：零票 + invalid 计数，不抛", async () => {
    const judge = createTraitJudge({ run: async () => "我想了想，他今天情绪不太好。" });
    await expect(judge([episode("a")])).resolves.toEqual({ votes: [], labelProposals: [], invalid: 1 });
  });

  it("越界轴 / 越界步长 / 非 ep- id 的票被丢弃并计数，好的票保留", async () => {
    const judge = createTraitJudge({
      run: async () =>
        JSON.stringify({
          votes: [
            { episode_id: "ep-a", axis: "kindness", delta: 1 },
            { episode_id: "ep-a", axis: "rigor", delta: 3 },
            { episode_id: "ep-a", axis: "rigor", delta: 0.5 },
            { episode_id: "u1", axis: "rigor", delta: 1 },
            { episode_id: "ep-a", axis: "rigor", delta: 1, quote: "他又漏了", why: "漏步骤被指出" },
          ],
          label_proposals: [],
        }),
    });
    const out = await judge([episode("a")]);
    expect(out.votes).toEqual([
      { episodeId: "ep-a", axis: "rigor", delta: 1, quote: "他又漏了", why: "漏步骤被指出" },
    ]);
    expect(out.invalid).toBe(4);
  });

  it("空响应只重试一次；非空响应类错误照旧上抛", async () => {
    let n = 0;
    const retried = createTraitJudge({
      run: async () => {
        n += 1;
        if (n === 1) throw new Error("empty response: finishReason=length");
        return '{"votes":[{"episode_id":"ep-a","axis":"rigor","delta":1}],"label_proposals":[]}';
      },
    });
    const out = await retried([episode("a")]);
    expect(n).toBe(2);
    expect(out.votes).toHaveLength(1);

    const failing = createTraitJudge({
      run: async () => {
        throw new Error("request timeout after 60000ms");
      },
    });
    await expect(failing([episode("a")])).rejects.toThrow(/timeout/i);
  });
});

describe("S4 端到端（临时库）：两轮维护真的让六轴动起来并留账本", () => {
  it("traitJudge 接线后严谨轴上移，soul_trait_state 落库，soul_ledger 留 action=drift", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "soul-trait-judge-"));
    const store = new VectorStore(path.join(dir, "vectors.db"), 0);
    const base = Date.now();
    const iso = (msAgo: number) => new Date(base - msAgo).toISOString();
    const judged: string[][] = [];
    /**
     * 直接读 soul_trait_state 的原始行。写侧确实落了数组 JSON，而
     * store.readSoulTraitState 目前读回来是零向量（缺陷见本文件末尾的见证用例），
     * 所以这里先用原始行验收「真的动了」。
     */
    const rawAxes = (): number[] => {
      const db = new DatabaseSync(path.join(dir, "vectors.db"), { readOnly: true });
      try {
        const row = db
          .prepare(
            "SELECT axis_json FROM soul_trait_state WHERE team_id = ? AND user_id = ? AND agent_id = ?",
          )
          .get(T.teamId, T.userId, T.agentId) as { axis_json?: string } | undefined;
        if (!row?.axis_json) throw new Error("soul_trait_state 没有行");
        return JSON.parse(row.axis_json) as number[];
      } finally {
        db.close();
      }
    };
    const RIGOR = SOUL_AXES.indexOf("rigor");
    // 判侧替身：对每条事件在严谨轴投 +1（「漏步骤被当众指出」是显式行为）。
    const traitJudge = async (episodes: SoulEpisode[]) => {
      judged.push(episodes.map((ep) => ep.episodeId));
      const votes: TraitVote[] = episodes.map((ep) => ({
        episodeId: ep.episodeId,
        axis: "rigor",
        delta: 1,
        quote: "你又漏了",
        why: "漏步骤被指出",
      }));
      return { votes, labelProposals: [], invalid: 0 };
    };
    const runRound = (now: string) =>
      runSoulMaintenance({
        store,
        tenant: T,
        now,
        config: { episodeWindowDays: 30, updateIntervalHours: 0 },
        trigger: "manual",
        llmCallBudget: 0,
        traitJudge,
      });
    try {
      store.init();
      if (store.isDegraded()) throw new Error("临时库初始化降级");
      store.upsertL0(l0("u1", "user", "这处不对，是不是你改坏的", iso(3 * 3_600_000)), undefined);
      store.upsertL0(l0("a1", "assistant", "不是我造成的：这行代码我这一轮没动过", iso(3 * 3_600_000 - 60_000)), undefined);
      store.upsertL0(l0("u2", "user", "这一列还是不对，你又漏了", iso(2 * 3_600_000)), undefined);
      store.upsertL0(l0("a2", "assistant", "我漏了，这就补上", iso(2 * 3_600_000 - 60_000)), undefined);

      // 两轮的 now 显式差 1 秒：账本 entryId 含 now，浮点时钟不该把两次真实位移并成一行。
      const r1 = await runRound(new Date(base).toISOString());
      expect(judged).toHaveLength(1);
      expect(r1.trait?.changed).toBe(true);
      const rigor1 = (r1.trait?.axes ?? []).find((a) => a.axis === "rigor");
      expect(rigor1?.net ?? 0).toBeGreaterThanOrEqual(2);
      expect(rigor1?.delta ?? 0).toBeGreaterThan(0);
      expect(r1.traitSkipped).toBeUndefined();

      const raw1 = rawAxes();
      expect(raw1[RIGOR]).toBeGreaterThan(0);
      // 其它轴没票：不许被顺手带起来。
      SOUL_AXES.forEach((axis, i) => {
        if (axis !== "rigor") expect(raw1[i]).toBe(0);
      });

      // 第二轮：新事件进来，同一判侧再投，状态必须在第一轮之上继续上移。
      store.upsertL0(l0("u3", "user", "测试没跑就说修好了？这就是假绿", iso(3_600_000)), undefined);
      store.upsertL0(l0("a3", "assistant", "我重跑全量，把数字贴上来再给结论", iso(3_600_000 - 60_000)), undefined);
      store.upsertL0(l0("u4", "user", "还是漏了一次，你根本没核对", iso(1_800_000)), undefined);
      store.upsertL0(l0("a4", "assistant", "这次我逐条核对过了", iso(1_800_000 - 60_000)), undefined);
      const r2 = await runRound(new Date(base + 1000).toISOString());
      expect(judged).toHaveLength(2);
      expect(r2.trait?.changed).toBe(true);
      const raw2 = rawAxes();
      expect(raw2[RIGOR]).toBeGreaterThan(0);
      // 判据要求「相对第一轮至少一个轴变了」：两轮净票不同，步长也确实不同。
      expect(raw2[RIGOR]).not.toBe(raw1[RIGOR]);
      SOUL_AXES.forEach((axis, i) => {
        if (axis !== "rigor") expect(raw2[i]).toBe(0);
      });

      // 判据 6：每次真实位移都能从账本追回，且带协议版本。
      const drift = store.listSoulLedger(T, 500).filter((e) => e.action === "drift");
      expect(drift.length).toBeGreaterThanOrEqual(2);
      for (const row of drift) {
        expect(row.protocolVersion).toBe(TRAIT_PROTOCOL_VERSION);
        expect(row.gates).toContain(`trait_protocol:${TRAIT_PROTOCOL_VERSION}`);
        expect(row.reason).toContain("rigor");
      }
    } finally {
      try { store.close(); } catch { /* 已关闭 */ }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * 读侧口径回归（原「已知缺陷见证」，2026-11-07 修复）：写侧 `writeSoulTraitState` 落的是
   * 数组 JSON（sqlite.ts:3569 axisVectorToArray），读侧 `toAxisVector` 的字符串分支此前
   * safeJson 出数组后仍按对象取键 → 每个轴都取不到 → 读回全 0，漂移每轮从零起步、永不累积。
   * 修法（traits.ts:290-317）：字符串先解析再**分派**，数组按 SOUL_AXES 索引映射；
   * 存储口径继续用数组（既有 5 行 + DDL 默认值都是数组，改读侧最便宜）。
   */
  it("读侧口径：TEXT 数组按索引解析，写→读六轴逐轴相等", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "soul-trait-read-"));
    const store = new VectorStore(path.join(dir, "vectors.db"), 0);
    try {
      store.init();
      if (store.isDegraded()) throw new Error("临时库初始化降级");
      const state = {
        warmth: 0.1,
        agency: -0.2,
        rigor: 0.25,
        openness: 0.3,
        stability: -0.4,
        boundary: 0.05,
      };
      store.writeSoulTraitState(T, { state, updatedAt: "2026-11-07T00:00:00.000Z" });
      const db = new DatabaseSync(path.join(dir, "vectors.db"), { readOnly: true });
      const row = db
        .prepare(
          "SELECT axis_json FROM soul_trait_state WHERE team_id = ? AND user_id = ? AND agent_id = ?",
        )
        .get(T.teamId, T.userId, T.agentId) as { axis_json?: string } | undefined;
      db.close();
      // 存储口径：数组，顺序同 SOUL_AXES（warmth, agency, rigor, openness, stability, boundary）。
      expect(JSON.parse(row!.axis_json!)).toEqual([0.1, -0.2, 0.25, 0.3, -0.4, 0.05]);
      // 读回来必须逐轴相等，不能被解析成零向量。
      const back = store.readSoulTraitState(T)?.state;
      expect(back?.rigor).toBeCloseTo(0.25);
      SOUL_AXES.forEach((axis) => expect(back?.[axis]).toBeCloseTo(state[axis]));
    } finally {
      try { store.close(); } catch { /* 已关闭 */ }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("S4 调度器接线：tick 自己提供 traitJudge 并把结果聚进 summary", () => {
  it("runSoulMaintenanceTick + llmRunner → summary.trait 有轴/票数，taskId 走判侧", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "soul-trait-tick-"));
    const store = new VectorStore(path.join(dir, "vectors.db"), 0);
    const base = Date.now();
    const iso = (msAgo: number) => new Date(base - msAgo).toISOString();
    const taskIds: string[] = [];
    const llmRunner = {
      run: async (params: { prompt: string; taskId: string }) => {
        taskIds.push(params.taskId);
        if (params.taskId !== "memory.soul-trait-judge") return '{"items":[]}';
        const ids = [...new Set(params.prompt.match(/ep-[a-z0-9-]+/g) ?? [])];
        return JSON.stringify({
          votes: ids.map((id) => ({ episode_id: id, axis: "rigor", delta: 1 })),
          label_proposals: [],
        });
      },
    };
    try {
      store.init();
      if (store.isDegraded()) throw new Error("临时库初始化降级");
      store.upsertL0(l0("u1", "user", "这一列还是不对，你又漏了", iso(7_200_000)), undefined);
      store.upsertL0(l0("a1", "assistant", "我漏了，这就补上", iso(7_140_000)), undefined);
      store.upsertL0(l0("u2", "user", "测试没跑就说修好了？这就是假绿", iso(3_600_000)), undefined);
      store.upsertL0(l0("a2", "assistant", "我重跑全量，把数字贴上来再给结论", iso(3_540_000)), undefined);

      const summary = await runSoulMaintenanceTick({
        store,
        config: { ...resolveSoulConfig({}), updateIntervalHours: 0, episodeWindowDays: 30 },
        llmRunner,
        logger: { info() {}, warn() {}, debug() {}, error() {} },
      });
      expect(summary.tenants).toBe(1);
      expect(summary.trait).toBeDefined();
      expect(summary.trait?.movedAxes).toBe(1);
      expect(summary.trait?.votes).toBeGreaterThanOrEqual(2);
      expect(summary.trait?.rejectedVotes).toBe(0);
      expect(summary.trait?.skipped).toEqual([]);
      expect(taskIds).toContain("memory.soul-trait-judge");
    } finally {
      try { store.close(); } catch { /* 已关闭 */ }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
