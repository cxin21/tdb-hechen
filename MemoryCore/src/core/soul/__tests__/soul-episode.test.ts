/**
 * 事件层（soul_episodes）单测：确定性挖掘 / 幂等 id / kind 优先级 / 逐字原话 /
 * 代价不编造 / 情绪派生 / 检索匹配。
 *
 * 铁律与 persona 单测相同：纯函数、不联网、不碰生产库、不调 LLM。
 * 事件层的价值在于「事实可回查」，所以每条断言都钉在某个具体字段上，而不是「看起来像」。
 */
import { describe, expect, it } from "vitest";
import {
  cleanObjectPhrase,
  episodeAppraisal,
  emotionEventFromEpisode,
  episodeDigest,
  emotionObjectForEpisode,
  extractCost,
  isAssistantQuoteCandidate,
  matchEpisode,
  mineEpisodes,
  type EpisodeSourceRow,
} from "../episode.js";
import { resolveSoulConfig } from "../types.js";

const CFG = resolveSoulConfig({ enabled: true });

const ROWS: EpisodeSourceRow[] = [
  {
    record_id: "u1",
    session_id: "s1",
    role: "user",
    message_text: "不对，这不是我要的：先给我一手证据，不要听转述。",
    recorded_at: "2026-11-04T10:00:00.000Z",
  },
  {
    record_id: "a1",
    session_id: "s1",
    role: "assistant",
    message_text: "我直接去现场跑一遍，把真实错误贴回来。",
    recorded_at: "2026-11-04T10:01:00.000Z",
  },
  {
    record_id: "u2",
    session_id: "s1",
    role: "user",
    message_text: "我宁可少做一个功能，也不交付没验证过的结论，这个代价我认。",
    recorded_at: "2026-11-04T10:02:00.000Z",
  },
  {
    record_id: "a2",
    session_id: "s1",
    role: "assistant",
    message_text: "好，我按你说的先取证再动手。",
    recorded_at: "2026-11-04T10:03:00.000Z",
  },
  // 代码/路径句不能成为 few-shot：voice 层要的是「他怎么说话」，不是他粘贴了什么。
  {
    record_id: "u3",
    session_id: "s1",
    role: "user",
    message_text: "看 D:/TDB/td-agemem/MemoryCore/src/core/soul/worker.ts 第 42 行",
    recorded_at: "2026-11-04T10:04:00.000Z",
  },
];

describe("episode：团队频道的公开纠正", () => {
  const teamRows = (text: string): EpisodeSourceRow[] => [
    { record_id: "t1", session_id: "team1", role: "user", message_text: text, recorded_at: "2026-11-04T09:00:00.000Z" },
    { record_id: "t2", session_id: "team1", role: "assistant", message_text: "我补上收尾报告，把三处缺陷逐条修掉。", recorded_at: "2026-11-04T09:05:00.000Z" },
  ];

  it("Lead 在团队频道点名收尾缺陷：算公开纠正，同一件事在私聊是愧疚、在群里是害羞", () => {
    const res = mineEpisodes(teamRows("Team message from lead:隔夜续接：你中断于 t12 收尾阶段（无收尾回报），Lead 亲跑四门发现 3 处收尾缺陷。"), CFG);
    expect(res.episodes).toHaveLength(1);
    expect(res.episodes[0].kind).toBe("correction");
    expect(res.episodes[0].userStance).toContain("缺陷");
    expect(emotionEventFromEpisode(res.episodes[0], CFG, { publicSession: true }).label).toBe("害羞");
    expect(emotionEventFromEpisode(res.episodes[0], CFG).label).toBe("愧疚");
  });

  it("builder 自己的完工回报里出现「必修」不算被纠正：只认 Lead 的裁决", () => {
    const res = mineEpisodes(teamRows("Team message from builder:t10 微提交（adversary C1 必修+C4 顺手补）完工回报：改动文件两个，测试全绿。"), CFG);
    expect(res.episodes.filter((e) => e.kind === "correction")).toHaveLength(0);
  });
});

describe("episode：L0 原始对话的确定性切片", () => {
  it("从真实对话挖出事件，id 由会话+记录决定（重跑逐字相同）", () => {
    const a = mineEpisodes(ROWS, CFG);
    const b = mineEpisodes(ROWS, CFG);
    expect(a.episodes.length).toBeGreaterThanOrEqual(2);
    expect(a.episodes.map((e) => e.episodeId)).toEqual(b.episodes.map((e) => e.episodeId));
    for (const ep of a.episodes) expect(ep.episodeId).toMatch(/^ep-[0-9a-z]+$/);
    // 同一会话内去重：同一句抱怨不会因为 tick 重跑而变成两条。
    const ids = a.episodes.map((e) => e.episodeId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("kind 优先级：取舍（value_conflict）压过纠正；普通纠正不会被漏掉", () => {
    const { episodes } = mineEpisodes(ROWS, CFG);
    const kinds = episodes.map((e) => e.kind).sort();
    expect(kinds).toContain("value_conflict");
    expect(kinds).toContain("correction");
  });

  it("逐字原话 + 双方立场 + 代价：每个字段都能回查到具体 record_id", () => {
    const { episodes } = mineEpisodes(ROWS, CFG);
    const value = episodes.find((e) => e.kind === "value_conflict")!;
    expect(value.quote?.text).toContain("宁可少做一个功能");
    expect(value.quote?.recordId).toBe("u2");
    expect(value.userStance).toContain("宁可");
    // 代价短语取「取舍词周围的原文字面」，不是模型概括：这里命中的是「宁可少做」。
    expect(value.cost).toContain("宁可少做");
    // 立场=他回应时我上一条的说法；结果=他之后我实际怎么收尾。两者分开存，才看得见「我改没改」。
    expect(value.agentStance).toBe("我直接去现场跑一遍，把真实错误贴回来");
    expect(value.outcome).toBe("好，我按你说的先取证再动手");
    expect(value.evidenceIds).toContain("u2");
    // 证据 id 全部来自真实输入，不允许合成。
    const real = new Set(ROWS.map((r) => r.record_id));
    for (const id of value.evidenceIds) expect(real.has(id)).toBe(true);
  });

  it("找不到代价就留空——不补写、不推断", () => {
    const { episodes } = mineEpisodes([ROWS[0], ROWS[1]], CFG);
    const corr = episodes.find((e) => e.kind === "correction")!;
    expect(corr.cost).toBe("");
  });

  it("voice 语料只收助手自己的干净短句（用户原话/路径/代码一律排除）", () => {
    const { voiceQuotes } = mineEpisodes(ROWS, CFG);
    // 2026-11-05 生产 review：voice 是「我的说话方式」，不能拿他的原话冒充；
    // 旧实现把 u2 收进来，生成结果是「他开口像下工单」却挂在「## 我的说话方式」下。
    expect(voiceQuotes.some((q) => q.recordId === "a1")).toBe(true);
    expect(voiceQuotes.some((q) => q.recordId === "a2")).toBe(true);
    expect(voiceQuotes.some((q) => q.recordId === "u2")).toBe(false);
    expect(voiceQuotes.some((q) => q.recordId === "u3")).toBe(false);
    expect(voiceQuotes.every((q) => q.role === "assistant")).toBe(true);
    expect(isAssistantQuoteCandidate("看 D:/TDB/x.worker.ts 第 42 行", 8)).toBe(false);
    expect(isAssistantQuoteCandidate("我直接去现场跑一遍，把真实错误贴回来。", 8)).toBe(true);
  });

  it("情绪由词面与标点决定：对象来自原话，强度有界且可复算", () => {
    const { episodes } = mineEpisodes(ROWS, CFG);
    const corr = episodes.find((e) => e.kind === "correction")!;
    expect(corr.valence).toBeLessThan(0);
    expect(corr.intensity).toBeGreaterThan(0);
    expect(corr.intensity).toBeLessThanOrEqual(1);
    const ev = emotionEventFromEpisode(corr, CFG);
    expect(ev.object.length).toBeGreaterThan(0);
    expect(ev.valence).toBe(corr.valence);
    expect(ev.at).toBe(corr.at);
  });

  it("appraisal 由事件结构与回应结果派生，不是常量：同类事件结局不同，控制感/归因不同", () => {
    const { episodes } = mineEpisodes(ROWS, CFG);
    const corr = episodes.find((e) => e.kind === "correction")!;
    const withReply = episodeAppraisal({ ...corr, agentStance: "我直接去现场跑一遍", outcome: "已按你说的改完并重跑" });
    const noReply = episodeAppraisal({ ...corr, agentStance: "", outcome: "" });
    // 有回应 → 我还能控制；没有回应 → 控制感低（旧实现两者恒为 .5）。
    expect(withReply.control).toBeGreaterThan(noReply.control);
    expect(withReply.agency).toBe("self");
    expect(noReply.agency).toBe("other");
    // 纠正类事件的期望违背高于拍板类，不是同一个常量。
    const decision = episodeAppraisal({ ...corr, kind: "decision" });
    expect(withReply.expectationViolation).toBeGreaterThan(decision.expectationViolation);
    // 目标相关性与强度绑定，有界。
    const strong = episodeAppraisal({ ...corr, intensity: 1 });
    const weak = episodeAppraisal({ ...corr, intensity: 0 });
    expect(strong.goalRelevance).toBeGreaterThan(weak.goalRelevance);
    expect(strong.goalRelevance).toBeLessThanOrEqual(0.95);
  });
  it("情绪对象：任务标题抽不到人/事就留空，不退回「被纠正」充数", () => {
    expect(emotionObjectForEpisode({ kind: "correction", object: "【任务】把 GitHub issue #179 的注入预算守卫改完并复测" })).toBe("");
    expect(emotionObjectForEpisode({ kind: "value_conflict", object: "假绿" })).toBe("假绿");
    expect(emotionObjectForEpisode({ kind: "correction", object: "列表按钮状态处理不对", userStance: "列表按钮状态处理不对" })).toBe("被当面指出不对");
  });

  it("digest 只给事实行（id/kind/对象/原话/代价），可直接进 prompt", () => {
    const { episodes } = mineEpisodes(ROWS, CFG);
    const lines = episodeDigest(episodes, { max: 10 });
    expect(lines.length).toBe(episodes.length);
    expect(lines[0]).toMatch(/^ep-[0-9a-z]+ \| /);
    expect(lines.join("\n")).toContain("cost=");
  });

  it("检索：按对象/原话/立场可命中，空 query 返回全部", () => {
    const { episodes } = mineEpisodes(ROWS, CFG);
    const corr = episodes.find((e) => e.kind === "correction")!;
    expect(matchEpisode(corr, "一手证据")).toBe(true);
    expect(matchEpisode(corr, "完全不存在的词")).toBe(false);
    expect(matchEpisode(corr, "")).toBe(true);
  });

  it("对象短语去语气词：『不对，这不是我要的』不该把『不对』当对象", () => {
    expect(cleanObjectPhrase("不对，这不是我要的：先给我一手证据")).not.toContain("不对");
  });

  it("语料卫生：压缩段/ACP 注入/图片回执不是他说的话，一个事件都不产", () => {
    const noise: EpisodeSourceRow[] = [
      { record_id: "n1", session_id: "s9", role: "user", message_text: "[Compressed conversation section] — 你说不对，我改了很多次，重做", recorded_at: "2026-11-04T10:00:00.000Z" },
      { record_id: "n2", session_id: "s9", role: "user", message_text: '<acp tokens="12" type="text">m00001</acp> 你是一个独立作答代理，不对就重做', recorded_at: "2026-11-04T10:01:00.000Z" },
      { record_id: "n3", session_id: "s9", role: "user", message_text: "已收到图片「image.png」（附件 id：sha256:abc）这里不对，重做", recorded_at: "2026-11-04T10:02:00.000Z" },
      { record_id: "n4", session_id: "s9", role: "user", message_text: '{"currentTitle":"QQ · 不对"}', recorded_at: "2026-11-04T10:03:00.000Z" },
    ];
    expect(mineEpisodes(noise, CFG).episodes).toHaveLength(0);
  });

  it("真实语气的四类句式各成事件：追责、催、道谢夸奖、算了", () => {
    const rows: EpisodeSourceRow[] = [
      { record_id: "c1", session_id: "s10", role: "user", message_text: "你搞错了，我的意思是复用 memory 的配置项", recorded_at: "2026-11-04T11:00:00.000Z" },
      { record_id: "c2", session_id: "s10", role: "user", message_text: "尽快改完，今晚要用", recorded_at: "2026-11-04T11:05:00.000Z" },
      { record_id: "c3", session_id: "s10", role: "user", message_text: "辛苦你了，改得好，就按这个", recorded_at: "2026-11-04T11:10:00.000Z" },
      { record_id: "c4", session_id: "s10", role: "user", message_text: "算了，你看着办吧", recorded_at: "2026-11-04T11:15:00.000Z" },
    ];
    const kinds = mineEpisodes(rows, CFG).episodes.map((e) => e.kind).sort();
    expect(kinds).toEqual(["complaint", "praise", "pressure", "resignation"]);
  });

  it("同一批句式在情绪上区分开：追责=恼火、催=着急、道谢=感激、算了=无奈", () => {
    const mk = (kind: any, userStance: string) =>
      emotionEventFromEpisode(
        {
          episodeId: "ep-x",
          at: "2026-11-04T11:00:00.000Z",
          day: "2026-11-04",
          kind,
          title: userStance.slice(0, 20),
          object: "这件事",
          participants: ["何晨", "assistant"],
          userStance,
          agentStance: "",
          cost: "",
          outcome: "",
          valence: -0.4,
          arousal: 0.6,
          intensity: 0.6,
          evidenceIds: ["c1"],
          sessionId: "s10",
          quote: { text: userStance, role: "user", recordId: "c1", at: "2026-11-04T11:00:00.000Z" },
          affectSource: "lexicon",
          signals: [],
        } as never,
        CFG,
      );
    expect(mk("complaint", "你搞错了，我的意思是复用配置项").label).toBe("恼火");
    expect(mk("pressure", "尽快改完，今晚要用").label).toBe("着急");
    expect(mk("praise", "辛苦你了，改得好，就按这个").label).toBe("感激");
    expect(mk("resignation", "算了，你看着办吧").label).toBe("无奈");
  });

  it("立场只取带情绪的那一句：长 prompt 里的追责不把整段通报搬进人格", () => {
    const head = "你是独立评审代理。请阅读下面材料，按要求逐条核对，不要联网、不要改文件、不要提交，输出 Markdown。".repeat(6);
    const rows: EpisodeSourceRow[] = [
      {
        record_id: "c9",
        session_id: "s11",
        role: "user",
        message_text: head + "你搞错了，我的意思是复用 memory 的配置项，不要再新建一套。",
        recorded_at: "2026-11-04T12:00:00.000Z",
      },
    ];
    const eps = mineEpisodes(rows, CFG).episodes;
    expect(eps).toHaveLength(1);
    expect(eps[0].userStance.length).toBeLessThanOrEqual(120);
    expect(eps[0].userStance).toContain("搞错");
    expect(eps[0].userStance.startsWith("你是独立评审代理")).toBe(false);
  });

it("系统状态行不是他的发言：回执格式提示不进事件、不变成「我没守住」", () => {
    const rows: EpisodeSourceRow[] = [
      {
        record_id: "s1",
        session_id: "s12",
        role: "user",
        message_text:
          "回执格式不合规：本轮结束后没有找到可识别的状态行，或状态行与本轮运行结果矛盾。 原因：回执里没有 已完成 / 没跑成 / 没事可做 / 待你拍板 之一。",
        recorded_at: "2026-11-04T12:00:00.000Z",
      },
      {
        record_id: "s2",
        session_id: "s12",
        role: "assistant",
        message_text: "结论先行：票面核对通过",
        recorded_at: "2026-11-04T12:01:00.000Z",
      },
    ];
    expect(mineEpisodes(rows, CFG).episodes).toHaveLength(0);
  });

it("被错怪时是委屈，不是恼火：我回复里摆出「不是我造成」的证据，就不能再记成对他的火气", () => {
    const wronged = {
      episodeId: "ep-wronged-1",
      at: "2026-11-04T11:00:00.000Z",
      day: "2026-11-04",
      kind: "correction",
      title: "你搞错了",
      object: "被当面指出不对",
      participants: ["何晨", "assistant"],
      userStance: "这处不对，是不是你改坏的",
      agentStance: "不是我造成的：这行代码我这一轮没动过，是上游接口返回了旧数据",
      cost: "",
      outcome: "证据已贴：diff 里没有这处改动",
      valence: -0.5,
      arousal: 0.6,
      intensity: 0.6,
      evidenceIds: ["c2"],
      sessionId: "s-team",
      quote: { text: "这处不对，是不是你改坏的", role: "user", recordId: "c2", at: "2026-11-04T11:00:00.000Z" },
      affectSource: "lexicon",
      signals: [],
    } as never;
    expect(episodeAppraisal(wronged).exculpated).toBe(true);
    expect(emotionEventFromEpisode(wronged, CFG).label).toBe("委屈");
});

it("追责句也一样：他说「是不是你改坏的」，我回「不是我造成的」，记委屈不记恼火；我回「我漏了」才记愧疚", () => {
    const base = {
      at: "2026-11-04T11:00:00.000Z",
      day: "2026-11-04",
      kind: "complaint",
      title: "你改坏了",
      object: "被当面指出不对",
      participants: ["何晨", "assistant"],
      userStance: "这处不对，是不是你改坏的",
      cost: "",
      valence: -0.4,
      arousal: 0.5,
      intensity: 0.5,
      evidenceIds: ["c9"],
      sessionId: "s-private",
      affectSource: "lexicon",
      signals: [],
    };
    const wronged = { ...base, episodeId: "ep-c-wronged", agentStance: "", outcome: "不是我造成的：这行代码我这一轮没动过，是上游接口返回了旧数据" } as never;
    expect(episodeAppraisal(wronged).exculpated).toBe(true);
    expect(emotionEventFromEpisode(wronged, CFG).label).toBe("委屈");
    const admitted = { ...base, episodeId: "ep-c-admit", agentStance: "", outcome: "我漏了，这就补上" } as never;
    expect(emotionEventFromEpisode(admitted, CFG).label).toBe("愧疚");
  });

it("被错怪时我拿证据顶回（没说「不是我的问题」）也算委屈：真机、日志、上游缓存这类举证足够", () => {
    const base = {
      at: "2026-11-04T11:00:00.000Z",
      day: "2026-11-04",
      kind: "complaint",
      title: "怀疑接口",
      object: "被当面指出不对",
      participants: ["何晨", "assistant"],
      userStance: "我怀疑接口有问题，我试了十几次都不行，你看看是不是你的接口写错了",
      cost: "",
      valence: -0.4,
      arousal: 0.5,
      intensity: 0.5,
      evidenceIds: ["c9"],
      sessionId: "s-private",
      affectSource: "lexicon",
      signals: [],
    };
    const proved = { ...base, episodeId: "ep-c-proof", agentStance: "", outcome: "真机截图核对完了：接口返回正常，是上游缓存了旧数据，两处都能收口" } as never;
    expect(emotionEventFromEpisode(proved, CFG).label).toBe("委屈");
    // 只有指控、没有举证时不能算委屈，否则每句追责都变成被错怪。
    const bare = { ...base, episodeId: "ep-c-bare", agentStance: "", outcome: "我看一下" } as never;
    expect(emotionEventFromEpisode(bare, CFG).label).not.toBe("委屈");
  });

it("同一个错：团队频道里是害羞，私聊里是愧疚——暴露面来自会话本身，不靠原话写「当众」", () => {
    const base = {
      episodeId: "ep-public-1",
      at: "2026-11-04T11:00:00.000Z",
      day: "2026-11-04",
      kind: "correction",
      title: "你搞错了",
      object: "被当面指出不对",
      participants: ["何晨", "assistant"],
      userStance: "你搞错了，我的意思是复用配置项",
      agentStance: "我补上了，已按同一条 16px 轨道对齐",
      cost: "",
      outcome: "已按",
      valence: -0.5,
      arousal: 0.6,
      intensity: 0.6,
      evidenceIds: ["c1"],
      sessionId: "s-team",
      quote: { text: "你搞错了", role: "user", recordId: "c1", at: "2026-11-04T11:00:00.000Z" },
      affectSource: "lexicon",
      signals: [],
    } as never;
    expect(emotionEventFromEpisode(base, CFG).label).toBe("愧疚");
    expect(emotionEventFromEpisode(base, CFG, { publicSession: true }).label).toBe("害羞");
    expect(emotionEventFromEpisode(base, CFG, { publicSession: false }).label).toBe("愧疚");
  });

  it("代价截取限定在原文范围内，不跨句编造", () => {
    const cost = extractCost("我宁可少做一个功能，也不交付没验证过的结论");
    expect(cost.length).toBeGreaterThan(0);
    expect("我宁可少做一个功能，也不交付没验证过的结论").toContain(cost.replace(/\s+/gu, " ").trim());
  });
});


describe("追责槽位接进事件层", () => {
  it("词表一个标记都没有的裸报障（「报错参数不合法」），靠槽位+我的回复成立为追责事件", () => {
    const rows: EpisodeSourceRow[] = [
      {
        record_id: "u1",
        session_id: "s-slots",
        role: "user",
        message_text: "现在搜索框搜索报错参数不合法",
        recorded_at: "2026-11-04T10:00:00.000Z",
      },
      {
        record_id: "a1",
        session_id: "s-slots",
        role: "assistant",
        message_text: "收到，已修好：查询参数按原产品改成 bid，搜索框不再报参数不合法。",
        recorded_at: "2026-11-04T10:01:00.000Z",
      },
    ];
    const out = mineEpisodes(rows, CFG, { windowDays: 3650, maxMessages: 100 });
    const ep = out.episodes.find((e) => e.sessionId === "s-slots");
    expect(ep?.kind).toBe("complaint");
    expect((ep?.signals ?? []).some((s) => s.startsWith("slot:"))).toBe(true);
  });

  it("派活句（「有没有问题的」）不会被槽位抬成追责", () => {
    const rows: EpisodeSourceRow[] = [
      {
        record_id: "u1",
        session_id: "s-inst",
        role: "user",
        message_text: "你再检查一下未提交的改动看看有没有有问题的",
        recorded_at: "2026-11-04T10:00:00.000Z",
      },
      {
        record_id: "a1",
        session_id: "s-inst",
        role: "assistant",
        message_text: "盘点干净：7 M + 1 新测试。",
        recorded_at: "2026-11-04T10:01:00.000Z",
      },
    ];
    const out = mineEpisodes(rows, CFG, { windowDays: 3650, maxMessages: 100 });
    expect(out.episodes.find((e) => e.sessionId === "s-inst")).toBeUndefined();
  });

  it("带「怎么/为什么」的派活句（「你再检查一下逻辑是否正确」）是 decision，不是冲突", () => {
    const rows: EpisodeSourceRow[] = [
      {
        record_id: "u1",
        session_id: "s-ask",
        role: "user",
        message_text: "两个页面的跳转是怎么做的，你再检查一下逻辑是否正确，此外在没有数据的情况下我能否现在就看到页面效果",
        recorded_at: "2026-11-04T10:00:00.000Z",
      },
      {
        record_id: "a1",
        session_id: "s-ask",
        role: "assistant",
        message_text: "审计完成，未改动任何文件（检查类只读）。",
        recorded_at: "2026-11-04T10:01:00.000Z",
      },
    ];
    const out = mineEpisodes(rows, CFG, { windowDays: 3650, maxMessages: 100 });
    const ep = out.episodes.find((e) => e.sessionId === "s-ask");
    expect(ep?.kind).toBe("decision");
    expect(ep?.signals ?? []).toContain("slot:instruction");
  });

  it("Lead 的 builder 续接是交办，不能记成他挑我的错", () => {
    const rows: EpisodeSourceRow[] = [
      {
        record_id: "u1",
        session_id: "s-brief",
        role: "user",
        message_text: "builder 续接：t13（#26 调度器核心）你在收尾期中断——产出 2 文件在场（src/schedule.ts）",
        recorded_at: "2026-11-04T10:00:00.000Z",
      },
      {
        record_id: "a1",
        session_id: "s-brief",
        role: "assistant",
        message_text: "红线复诵完毕，14 条逐条核对无冲突。",
        recorded_at: "2026-11-04T10:01:00.000Z",
      },
    ];
    const out = mineEpisodes(rows, CFG, { windowDays: 3650, maxMessages: 100 });
    const ep = out.episodes.find((e) => e.sessionId === "s-brief");
    expect(ep?.kind).not.toBe("complaint");
  });
});
