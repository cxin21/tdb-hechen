import { describe, expect, it } from "vitest";
import { appraiseEmotion } from "../emotion.js";
import { episodeAppraisal } from "../episode.js";
import type { SoulEpisode, SoulEpisodeKind } from "../types.js";

const NOW = "2026-11-06T12:00:00.000Z";

function ep(over: Partial<SoulEpisode> & { kind: SoulEpisodeKind }): SoulEpisode {
  return {
    episodeId: `ep-${over.kind}`,
    at: NOW,
    day: "2026-11-06",
    title: "t",
    object: "",
    participants: ["user", "assistant"],
    userStance: "",
    agentStance: "",
    cost: "",
    outcome: "",
    valence: 0,
    arousal: 0.5,
    intensity: 0.5,
    evidenceIds: ["r1"],
    sessionId: "s1",
    quote: null,
    affectSource: "lexicon",
    ...over,
  };
}

function label(over: Partial<SoulEpisode> & { kind: SoulEpisodeKind }, publicSession = false): string {
  const e = ep(over);
  const appraisal = episodeAppraisal(e, { publicSession });
  return appraiseEmotion({ at: NOW, object: "x", appraisal }).label;
}

describe("英文语料的六种情绪可达", () => {
  it("开心：肯定 + 事情成了", () => {
    expect(label({ kind: "decision", userStance: "go with this, great work, thank you", agentStance: "shipped it", outcome: "done" })).toBe("开心");
  });
  it("恼火：追责且我没认、也没举证", () => {
    expect(label({ kind: "complaint", userStance: "why do you keep breaking this? this is broken again", agentStance: "let me look", outcome: "" })).toBe("恼火");
  });
  it("害羞：当众认账", () => {
    expect(label({ kind: "complaint", userStance: "you broke it in front of the team", agentStance: "my fault, i missed it, i'll fix it", outcome: "fixed" }, true)).toBe("害羞");
  });
  it("愧疚：私下认账", () => {
    expect(label({ kind: "complaint", userStance: "you missed the check", agentStance: "my mistake, i'll fix it", outcome: "fixed" })).toBe("愧疚");
  });
  it("委屈：被追责但举证不是我", () => {
    expect(label({ kind: "complaint", userStance: "you broke the build", agentStance: "not my fault, upstream cache, logs show old data", outcome: "tested" })).toBe("委屈");
  });
  it("安心：按我的判断收口、没人看见", () => {
    expect(label({ kind: "decision", userStance: "go with this", agentStance: "my mistake earlier, i'll fix it", outcome: "" })).toBe("安心");
  });
});

describe("情绪识别正确性", () => {
  it("负向情绪：越违反自己的规范越强；正向情绪反向", () => {
    const base = { goalRelevance: 0.7, expectationViolation: 0.8, control: 0.5, agency: "self" as const };
    const lowNorm = appraiseEmotion({ at: NOW, object: "x", appraisal: { ...base, normCompatibility: 0.2 } });
    const highNorm = appraiseEmotion({ at: NOW, object: "x", appraisal: { ...base, normCompatibility: 0.9 } });
    expect(lowNorm.intensity).toBeGreaterThan(highNorm.intensity);
  });
  it("当众认账的 agency 是 self，不是写死的 other", () => {
    const a = episodeAppraisal(ep({ kind: "complaint", userStance: "you broke it", agentStance: "my fault, i'll fix", outcome: "" }), { publicSession: true });
    expect(a.selfCause).toBe(true);
    expect(a.agency).toBe("self");
  });
});
