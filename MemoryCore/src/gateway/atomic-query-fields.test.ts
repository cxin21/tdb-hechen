import { describe, it, expect } from "vitest";
import { handleAtomicQueryShape } from "./atomic-query-fields.js";

/**
 * D-0（2026-09-21）：内核 /v3/atomic/query 出参映射补齐 7 字段 RED 用例。
 * 设计依据：spec §4.1 十九列——scene_name/priority/session_key/session_id/
 * timestamp_str/timestamp_start/timestamp_end 属 L1 设计列，落库已填（真数据 519-520/520）
 * 但 AtomicDetail 映射丢弃（v2-router.ts:1274-1291）。UI 属性表"诚实缺列"升级为全列呈现。
 * BFF 前向兼容注释（chat-memory.ts:1264）承诺"内核补映射后自动呈现"——本测试锁定该契约。
 */
describe("D-0: /v3/atomic/query 出参补齐 7 字段", () => {
  const row = {
    record_id: "r1", content: "c", type: "episodic",
    scene_name: "工作情境", priority: 80,
    session_key: "sk-1", session_id: "sess-1",
    timestamp_str: "2026-09-21", timestamp_start: "2026-09-20", timestamp_end: "2026-09-22",
    version: 3, team_id: "t", user_id: "u", agent_id: "a", task_id: "task",
    created_time: "2026-09-21T00:00:00.000Z", updated_time: "2026-09-21T01:00:00.000Z",
    metadata_json: '{"subject":"s"}',
    occurred_at: "2026-09-21T00:00:00.000Z", valid_start: "", valid_end: "",
    certainty: "observed", source: "extraction",
    valence: 0.5, arousal: 0.6, significance: 0.8,
  };

  it("映射含 scene_name/priority/session×2/timestamp×3 七个新字段", () => {
    const item = handleAtomicQueryShape(row);
    expect(item.scene_name).toBe("工作情境");
    expect(item.priority).toBe(80);
    expect(item.session_key).toBe("sk-1");
    expect(item.session_id).toBe("sess-1");
    expect(item.timestamp_str).toBe("2026-09-21");
    expect(item.timestamp_start).toBe("2026-09-20");
    expect(item.timestamp_end).toBe("2026-09-22");
  });

  it("既有字段逐位不回归（ soul 六字段/三元组/version/metadata）", () => {
    const item = handleAtomicQueryShape(row);
    expect(item.id).toBe("r1");
    expect(item.occurred_at).toBe("2026-09-21T00:00:00.000Z");
    expect(item.certainty).toBe("observed");
    expect(item.valence).toBe(0.5);
    expect(item.arousal).toBe(0.6);
    expect(item.significance).toBe(0.8);
    expect(item.version).toBe(3);
    expect(item.team_id).toBe("t");
    expect(item.metadata).toEqual({ subject: "s" });
  });

  it("空值行为：空串转 undefined（宁缺毋滥，UI 不造假值）", () => {
    const item = handleAtomicQueryShape({ ...row, scene_name: "", priority: 50, timestamp_str: "" });
    expect(item.scene_name).toBeUndefined();
    expect(item.priority).toBe(50); // priority 是数值列，缺省 50 属有效值照传
    expect(item.timestamp_str).toBeUndefined();
  });
});
