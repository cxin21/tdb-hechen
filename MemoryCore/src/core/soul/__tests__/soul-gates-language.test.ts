/**
 * 判据的语言中立性：自维护人格不能只在中文语料里生长。
 * 这组用例把英文人格句送进同一套确定性门；中文用例是控制组（行为不变）。
 */
import { describe, expect, it } from "vitest";
import { classifyLine, evaluateCandidate, isSelfVoice, personaLength, personaShape } from "../gates.js";
import { DEFAULT_SOUL_MAINTENANCE_CONFIG } from "../types.js";

const cfg = DEFAULT_SOUL_MAINTENANCE_CONFIG;
const now = "2026-11-06T00:00:00.000Z";
const base = {
  now,
  existing: [],
  config: cfg,
  evidenceOrigins: ["l1" as const],
  evidenceEpisodeIds: ["ep-aaa111", "ep-bbb222"],
  userCorpus: ["I trust you to choose the best plan.", "You don't trust me, do you?"],
  personName: "He",
};

function failed(layer: "identity" | "values" | "self" | "boundary" | "relationship" | "narrative" | "voice", text: string) {
  return evaluateCandidate(text, { ...base, layer }).filter((r) => !r.pass).map((r) => r.code);
}

describe("personaLength：非 CJK 按信息量折算，中文行为不变", () => {
  it("中文 90 字仍是 90；英文 90 字只算 36 字", () => {
    expect(personaLength("我".repeat(90))).toBe(90);
    expect(personaLength("a".repeat(90))).toBe(36);
  });
  it("同样信息量的英文句不被中文字数档误杀", () => {
    expect(personaShape("I would rather lose a day than ship a number I have not checked.", "identity").pass).toBe(true);
  });
});

describe("英文人格句能过同一套门", () => {
  it("identity：第一人称取舍通过；事件句仍被拒", () => {
    expect(failed("identity", "I'd rather lose a day than ship a number I haven't verified myself.")).toEqual([]);
    expect(failed("identity", "I pushed commit abc1234 and all tests passed.")).toContain("event_sentence");
  });

  it("values：内在价值 + 代价 + 两难", () => {
    expect(failed("values", "I value honesty over speed, even if it costs me a day.")).toEqual([]);
  });

  it("self：对自己的承诺", () => {
    expect(failed("self", "I promised myself I would never call a red test green.")).toEqual([]);
  });

  it("boundary：禁令", () => {
    expect(failed("boundary", "I never delete user memory through scripts or maintenance jobs.")).toEqual([]);
  });

  it("relationship：逐字原话 + 具体的人", () => {
    expect(failed("relationship", 'He told me: "I trust you to choose the best plan."')).toEqual([]);
  });

  it("narrative：有来路、不是方法论", () => {
    expect(failed("narrative", "At first I chased green tests; over the years I learned to read the raw evidence myself.")).toEqual([]);
  });

  it("voice：第一人称 + 两条逐字 few-shot", () => {
    const codes = evaluateCandidate("I speak plainly, name the cost, and never hide a red test.", {
      ...base,
      layer: "voice",
      voiceFewShots: [
        { quote: "I trust you to choose the best plan.", recordId: "r1" },
        { quote: "You don't trust me, do you?", recordId: "r2" },
      ],
    }).filter((r) => !r.pass).map((r) => r.code);
    expect(codes).toEqual([]);
  });
});

describe("英文任务句/第三人称仍被挡住", () => {
  it("classifyLine 把英文进度句归到 method，不进人格层", () => {
    const c = classifyLine("I finished the migration and pushed commit abc1234, tests passed.");
    expect(c.layer).toBe("method");
  });
  it("第三人称画像不是 voice", () => {
    expect(isSelfVoice("He is a careful engineer who always verifies.")).toBe(false);
    expect(isSelfVoice("I verify before I claim.")).toBe(true);
  });
});
