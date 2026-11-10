/**
 * 端到端（临时库，只注入构造数据）：把生产语料里跑不出来的情绪分支补齐。
 *
 * 为什么要有这一层：生产库 14383 条 L0 里没有「当众被夸」「环境卡住」「他也在付代价」
 * 这类事件，12 个情绪模板因此只有单测证据。单测喂的是 appraisal 向量，证明不了
 * 「从对话挖事件 → 评价 → 标签」这条链；这里用构造的 hechen 形状对话走同一套
 * mineEpisodes / episodeAppraisal / pickTemplate，证明 24 个标签全部可达。
 *
 * 顺带证明判断改动：产出的心境能决定「先看哪一层」（moodAttention）与
 * 「这一轮长不长身份」（moodGrowthGate），并且注入行写得出对象与原因。
 * 只用临时 sqlite；不联网、不调 LLM（llmCallBudget=0）。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../../store/sqlite.js";
import type { L0Record } from "../../store/types.js";
import { runSoulMaintenance } from "../worker.js";
import { emotionEventFromEpisode } from "../episode.js";
import {
  EMOTION_LABELS,
  EMOTION_TEMPLATE_VERSION,
  moodAttention,
  moodFocusOf,
  moodGrowthGate,
  renderMoodLine,
  type SoulMoodState,
} from "../emotion.js";
import { resolveSoulConfig } from "../types.js";

const T = { teamId: "t-inj", userId: "u-inj", agentId: "a-inj" };
const NOW = "2026-11-01T00:40:00.000Z";

type Turn = [role: "user" | "assistant", text: string];

/**
 * 24 段对话，每段一个会话（perSessionCap=5 不会截断）。
 * 每段都是「他要真说得出的话」：写死的不是标签，是原话与我的回应；
 * 标签由 episodeAppraisal 的维度决定，改词就会改判。
 */
const DIALOGUES: Array<{ id: string; turns: Turn[]; public?: boolean }> = [
  // 公开裁缺陷 + 我认了 → 害羞
  { id: "s-shy", public: true, turns: [["assistant", "已改好"], ["user", "Team message from lead: 发现 3 处收尾缺陷，C1·HIGH·必修"], ["assistant", "我漏了，这就补上。"]] },
  // 私下认错 → 愧疚
  { id: "s-guilt", turns: [["assistant", "已修好"], ["user", "这个按钮的选中态不对，你改坏了"], ["assistant", "我漏了，这就补上。"]] },
  // 被错怪、拿证据顶回 → 委屈
  { id: "s-wronged", turns: [["assistant", "已改"], ["user", "这个接口是不是你写错了"], ["assistant", "不是我造成的，我查了日志，上游缓存了旧数据"]] },
  // 当众出岔子、不是我造成 → 尴尬
  { id: "s-awkward", turns: [["assistant", "已改"], ["user", "当着大家的面说，这个按钮为什么又点不动了"], ["assistant", "这个我确认一下。"]] },
  // 他造成、踩了规矩、我没认 → 恼火
  { id: "s-angry", turns: [["assistant", "已改"], ["user", "你搞错了吧，这个按钮又点不动"], ["assistant", "我先看一下"]] },
  // 他造成、我还拿得住、没到被错怪 → 烦躁
  { id: "s-irritated", turns: [["assistant", "我先看看"], ["user", "我不认同这个做法，你的问题在于取舍"], ["assistant", "我把两种做法的成本列一下"]] },
  // 他一边怪我一边说自己加班 → 同情
  { id: "s-pity", turns: [["assistant", "已改"], ["user", "你为什么又漏了，我这边也加班到现在"], ["assistant", "我再核一遍"]] },
  // 虚惊一场后继续 → 释然
  { id: "s-relief", turns: [["assistant", "改完了"], ["user", "还好没影响，就按方案继续"], ["assistant", "好，我接着推"]] },
  // 低强度拍板、我接得住 → 平静
  { id: "s-calm", turns: [["assistant", "收到"], ["user", "用这个吧，没问题"], ["assistant", "我开始改"]] },
  // 低强度拍板、我没回应 → 意外
  { id: "s-surprise", turns: [["user", "那就用这个方案吧"]] },
  // 卡在外部、我没回应 → 失落
  { id: "s-lost", turns: [["user", "我不认同这个做法，上游接口一直挂着"]] },
  // 我没做好、低强度 → 失望
  { id: "s-disappointed", turns: [["assistant", "我先看看"], ["user", "我不认同这个做法"], ["assistant", "我把两种做法的成本列一下"]] },
  // 高强度取舍、我没回应 → 悬着
  { id: "s-anxious", turns: [["user", "宁可慢一点也绝不能牺牲质量，千万必须彻底守住底线"]] },
  // 高强度取舍、我接住了 → 振奋
  { id: "s-high", turns: [["assistant", "我记下了"], ["user", "宁可慢一点也绝不能牺牲质量，千万必须彻底守住底线"]] },
  // 高强度拍板、我没回应 → 踏实
  { id: "s-steady", turns: [["user", "就按方案来做，务必到位！！！"]] },
  // 高强度拍板、我接住了 → 笃定
  { id: "s-sure", turns: [["assistant", "收到"], ["user", "就按方案来做，务必做扎实！！！"]] },
  // 他夸我 → 开心
  { id: "s-joy", turns: [["assistant", "已改"], ["user", "这次改得好，不错"]] },
  // 我自己收口（低强度）→ 安心
  { id: "s-relief2", turns: [["assistant", "已改"], ["user", "用这个方案，彻底执行！！！"], ["assistant", "我补上了，已经按原话重做"]] },
  // 我自己收口且很在意 → 欣慰
  { id: "s-warm", turns: [["assistant", "已改"], ["user", "就按方案执行，必须彻底搞定，这事最急！！！"], ["assistant", "我补上了，已经按原话重做"]] },
  // 他为我付了代价 → 感激
  { id: "s-grateful", turns: [["assistant", "已改"], ["user", "辛苦了，这次改得好"]] },
  // 催结果 → 着急
  { id: "s-urgent", turns: [["user", "尽快把这个改完，等着用"]] },
  // 放弃争取 → 无奈
  { id: "s-resigned", turns: [["user", "算了，你看着办吧"]] },
  // 公开收口 → 自豪
  { id: "s-proud", public: true, turns: [["user", "Team message from lead: 按方案落地，务必到位！！！"], ["assistant", "我补上了，已经按原话重做"]] },
  // 被指出但没认、也没洗清 → 不安
  { id: "s-uneasy", turns: [["assistant", "我先看看"], ["user", "这个按钮的选中态不对，你重新看一下"], ["assistant", "我先看看"]] },
];

function buildRows(): { rows: L0Record[]; publicSessions: Set<string> } {
  const rows: L0Record[] = [];
  const publicSessions = new Set<string>();
  let t = Date.parse("2026-11-01T00:00:00.000Z");
  for (const d of DIALOGUES) {
    if (d.public) publicSessions.add(d.id);
    for (const [role, text] of d.turns) {
      t += 60_000;
      const at = new Date(t).toISOString();
      rows.push({
        id: `${d.id}-${rows.length}`,
        sessionKey: d.id,
        sessionId: d.id,
        taskId: "task-inj",
        role,
        messageText: text,
        recordedAt: at,
        timestamp: Date.parse(at),
        ...T,
      });
    }
  }
  return { rows, publicSessions };
}

describe("端到端注入：24 个情绪标签全部能从对话挖出来，且改变判断", () => {
  it("一条构造语料 → 24 个标签可达、心境落库、注意力与情绪门生效", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "soul-inj-"));
    const store = new VectorStore(path.join(dir, "vectors.db"), 0);
    try {
      store.init();
      if (store.isDegraded()) throw new Error("临时库初始化降级");
      const { rows, publicSessions } = buildRows();
      for (const r of rows) store.upsertL0(r, undefined);

      const report = await runSoulMaintenance({
        store,
        tenant: T,
        now: NOW,
        config: { episodeWindowDays: 30, updateIntervalHours: 0, emotionHalfLifeHours: 3 },
        trigger: "manual",
        llmCallBudget: 0,
      });
      expect(report.episodes?.mined ?? 0).toBeGreaterThanOrEqual(20);

      const cfg = resolveSoulConfig({ emotionHalfLifeHours: 3 });
      const eps = await store.listSoulEpisodes(T, { since: "2026-10-01T00:00:00.000Z", limit: 200 });
      const events = eps.map((e) =>
        emotionEventFromEpisode(e, cfg, { publicSession: publicSessions.has(e.sessionId) }),
      );
      const labels = new Set(events.map((e) => e.label));
      // 不是断言「别少于 N 个」：24 个模板必须全部有生产路径，少一个就是死代码。
      expect([...labels].sort()).toEqual([...EMOTION_LABELS].sort());

      const st = await store.readSoulState?.(T);
      expect(st?.emotionLabel ?? "").not.toBe("");
      expect(EMOTION_LABELS).toContain(st?.emotionLabel ?? "");
      expect((st?.emotionObject ?? "").trim()).not.toBe("");

      const mood: SoulMoodState = {
        valence: st?.valence ?? 0,
        arousal: st?.arousal ?? 0,
        baselineValence: st?.baselineValence ?? 0,
        baselineArousal: st?.baselineArousal ?? 0.3,
        updatedAt: st?.updatedAt ?? NOW,
        sampleCount: st?.sampleCount ?? 0,
        emotion:
          st?.emotionObject && st?.emotionLabel
            ? {
                object: st.emotionObject,
                label: st.emotionLabel,
                intensity: st.emotionIntensity ?? 0,
                at: st.emotionAt ?? st.updatedAt ?? NOW,
              }
            : undefined,
      };
      // 情绪史：每条「说得出对象」的事件按模板版本落一行，标签与心境同源。
      // 没有对象的事件（纯强度插话、问句）只是读数，不落情绪史——这是设计，不是丢失。
      const history = (await store.listSoulEmotions?.(T, { limit: 200 })) ?? [];
      const withObject = events.filter((e) => e.object !== "");
      expect(withObject.length).toBeGreaterThanOrEqual(15);
      // 首判行：每条「说得出对象」的事件按当前模板版本各一行。
      const firstJudgement = history.filter((h) => h.templateVersion === EMOTION_TEMPLATE_VERSION);
      expect(firstJudgement.length).toBe(withObject.length);
      // 重评行：已修复的事件追加 +reappraise 一行、原判行原样保留（P5 重评口径，不是重复计数）。
      const reappraised = history.filter(
        (h) => h.templateVersion === `${EMOTION_TEMPLATE_VERSION}+reappraise`,
      );
      expect(reappraised.length).toBeGreaterThan(0);
      expect(history.length).toBe(firstJudgement.length + reappraised.length);
      expect(new Set(history.map((h) => h.label)).size).toBeGreaterThanOrEqual(12);
      const attention = moodAttention(mood);
      expect(attention.object).not.toBe("");
      expect(attention.focus).not.toBe("none");

      // 判断落点一：同一对象复发且没修好时，这一轮不许把它写成身份/立场。
      // 这里不用 attention 当输入——构造语料里强度最高的是正向收口（欣慰），
      // 而情绪门的触发条件是「自我向/冲突向 + 同一对象 ≥2 次」，要从真实产出的情绪史里挑。
      const repeatedSelf = history.find(
        (h) => moodFocusOf(h.label) === "self" && history.filter((x) => x.object === h.object).length >= 2,
      );
      expect(repeatedSelf).toBeTruthy();
      const gate = moodGrowthGate({ focus: "self", object: repeatedSelf!.object, count: 2, repaired: false });
      expect(gate?.defer ?? []).toContain("identity");
      // 修复向情绪（欣慰/安心/笃定…）不拦：这不是永久封禁，是排期。
      expect(moodGrowthGate({ focus: "repair", object: attention.object, count: 3, repaired: false })).toBeNull();

      // 判断落点二：注入行必须说得出对象与原因，而不是只有「心情偏低」。
      const line = renderMoodLine(mood);
      expect(line).toContain("近期心境");
      expect(line).toContain(attention.object);

    } finally {
      try { store.close(); } catch { /* 已关闭 */ }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
