import { describe, expect, it } from "vitest";
import { renderSoulTurnState } from "../turn-state.js";
import { PERSONA_TURN_MAX_CHARS } from "../traits.js";
import type { SoulCalibrationOutcome, SoulCalibrationRow } from "../../store/soul-event-types.js";

/**
 * t26 / P4：每轮尾巴用 soul_calibration 写一句按域把握。
 * 预算 400 是硬的：校准句整条放不下就整条丢，不留半句。
 */

function cal(
  domain: string,
  predicted: number,
  outcome: SoulCalibrationOutcome,
  index: number,
): SoulCalibrationRow {
  return {
    id: `cal-${index}`,
    team_id: "team-1",
    user_id: "user-1",
    agent_id: "agent-1",
    domain,
    predicted_confidence: predicted,
    actual_outcome: outcome,
    event_id: `ev-${index}`,
    at: "2026-11-10T00:00:00.000Z",
    error: null,
    note: "",
  };
}

function rows(predicted: number, outcome: SoulCalibrationOutcome, count: number): SoulCalibrationRow[] {
  return Array.from({ length: count }, (_, i) => cal("测试", predicted, outcome, i + 1));
}

describe("turn 尾巴：心境 + 未完的事 + 可选校准句", () => {
  it("没有校准：输出与旧口径逐字节一致，不多写「把握」", () => {
    const result = renderSoulTurnState({
      moodLine: "心里有点沉",
      openLoops: ["把票关了", "把说明改短"],
    });
    expect(result.text).toBe("心里有点沉\n未完的事：把票关了；把说明改短");
    expect(result.text).not.toContain("把握");
    expect(result.openLoops).toEqual(["把票关了", "把说明改短"]);
  });

  it("有校准：心境在前，校准句以「记得：」接在未完的事后面", () => {
    const result = renderSoulTurnState({
      moodLine: "心里有点沉",
      openLoops: ["把票关了"],
      calibration: rows(0.5, "success", 3),
    });
    const lines = result.text.split("\n");
    expect(lines[0]).toBe("心里有点沉");
    expect(lines[1]).toBe("未完的事：把票关了");
    expect(lines[2]).toContain("记得：在测试上，我给自己半成把握，3 次里成了 3 次。");
    expect(result.text.length).toBeLessThanOrEqual(PERSONA_TURN_MAX_CHARS);
  });

  it("校准全错：写「没成」，把握度不升", () => {
    const result = renderSoulTurnState({
      moodLine: "心里有点沉",
      openLoops: [],
      calibration: rows(0.8, "fail", 3),
    });
    expect(result.text).toContain("记得：在测试上，我给自己八成把握，3 次里没成 3 次。");
    expect(result.text).toContain("没成 3 次");
    expect(result.text).toContain("报得比实际高约 0.80");
    expect(result.text).not.toContain("八成把握，3 次里成了");
  });

  it("预算 400：校准句整条放不下就整条丢，绝不截半句", () => {
    const mood = "沉".repeat(PERSONA_TURN_MAX_CHARS - 10);
    const result = renderSoulTurnState({
      moodLine: mood,
      openLoops: ["把票关了"],
      calibration: rows(0.5, "success", 3),
    });
    expect(result.text.length).toBeLessThanOrEqual(PERSONA_TURN_MAX_CHARS);
    expect(result.text).not.toContain("记得：");
    expect(result.text.startsWith(mood)).toBe(true);
  });

  it("超长正文才截断，截断留省略号；未完的事最多 3 条并单行化", () => {
    const result = renderSoulTurnState({
      moodLine: "沉".repeat(PERSONA_TURN_MAX_CHARS + 50),
      openLoops: ["  a \n b ", "", "c", "d", "e"],
    });
    expect(result.text.length).toBe(PERSONA_TURN_MAX_CHARS);
    expect(result.text.endsWith("…")).toBe(true);
    expect(result.openLoops).toEqual(["a b", "c", "d"]);
  });
});
