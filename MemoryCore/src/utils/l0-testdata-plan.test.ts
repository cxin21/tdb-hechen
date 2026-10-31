/**
 * task-83 B 段单测：L0 测试污染会话的「选择 + 计划」纯逻辑。
 * 断言口径：只测行为（选中谁 / 保留谁 / 送什么 id / 计划是否被拦），不测实现细节。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SESSION_ID,
  buildDeleteSessionIds,
  deletableIdsOf,
  groupKeyOf,
  selectL0Sessions,
  validatePlan,
  type L0RowLike,
} from "./l0-testdata-plan.js";

function row(over: Partial<L0RowLike> & { session_key: string }): L0RowLike {
  return {
    record_id: `r-${Math.random().toString(36).slice(2)}`,
    session_id: "default",
    role: "user",
    message_text: "hello",
    timestamp: 0,
    recorded_at: "",
    ...over,
  };
}

describe("selectL0Sessions · 缺省模式", () => {
  it("命中 probe-/session-probe-，真实会话全部保留，读数按会话聚合", () => {
    const rows: L0RowLike[] = [
      row({ session_key: "probe-abc", message_text: "一二三", recorded_at: "2026-10-31T10:00:00Z" }),
      row({ session_key: "probe-abc", role: "assistant", message_text: "45", recorded_at: "2026-10-31T12:00:00Z" }),
      row({ session_key: "session-probe-chatmem", message_text: "x" }),
      row({ session_key: "sess-real-1", message_text: "keep me" }),
      row({ session_key: "my-probe-not-a-hit", message_text: "keep me too" }),
    ];
    const res = selectL0Sessions(rows);

    expect(res.selected.map((g) => g.key)).toEqual(["probe-abc", "session-probe-chatmem"]);
    expect(res.kept.map((g) => g.key).sort()).toEqual(["my-probe-not-a-hit", "sess-real-1"]);
    expect(res.selectedRows).toBe(3);
    expect(res.keptRows).toBe(2);
    expect(res.totalRows).toBe(5);

    const g = res.selected[0]!;
    expect(g.rows).toBe(2);
    expect(g.chars).toBe("一二三".length + "45".length);
    expect(g.bytes).toBe(Buffer.byteLength("一二三", "utf8") + 2);
    expect(g.roles).toEqual({ user: 1, assistant: 1 });
    expect(g.firstSeen).toBe("2026-10-31T10:00:00Z");
    expect(g.lastSeen).toBe("2026-10-31T12:00:00Z");
    expect(g.matchedBy).toMatchObject({ kind: "pattern", pattern: "probe-" });
  });

  it("session_id 命中（session_key 是普通值）也算命中", () => {
    const res = selectL0Sessions([row({ session_key: "sk-normal", session_id: "probe-by-id" })]);
    expect(res.selected).toHaveLength(1);
    expect(res.selected[0]!.matchedBy).toMatchObject({ kind: "pattern", matchedOn: "session_id", value: "probe-by-id" });
  });

  it("patterns=[] 且无 sessions ⇒ 一个都不选（validatePlan 拦下）", () => {
    const res = selectL0Sessions([row({ session_key: "probe-abc" })], { patterns: [] });
    expect(res.selected).toHaveLength(0);
    expect(res.kept).toHaveLength(1);
    expect(validatePlan(res)).toEqual([expect.stringContaining("选中 0 个会话")]);
  });

  it("按 rows 降序排列（便于人读）", () => {
    const rows = [
      row({ session_key: "probe-small" }),
      row({ session_key: "probe-big" }),
      row({ session_key: "probe-big" }),
      row({ session_key: "probe-big" }),
    ];
    expect(selectL0Sessions(rows).selected.map((g) => g.key)).toEqual(["probe-big", "probe-small"]);
  });

  it("timestamp 兜底（recorded_at 为空时用毫秒时间戳转 ISO）", () => {
    const res = selectL0Sessions([row({ session_key: "probe-ts", timestamp: Date.UTC(2026, 9, 31, 1, 2, 3) })]);
    expect(res.selected[0]!.firstSeen).toBe(new Date(Date.UTC(2026, 9, 31, 1, 2, 3)).toISOString());
  });

  it("两个 id 都空的行走不进分组（但计入 totalRows 读数）", () => {
    const res = selectL0Sessions([row({ session_key: "", session_id: "" }), row({ session_key: "probe-a" })]);
    expect(res.selected).toHaveLength(1);
    expect(res.totalRows).toBe(2);
    expect(res.selectedRows).toBe(1);
  });
});

describe("selectL0Sessions · 显式 --sessions", () => {
  it("未命中模式的会话可被显式点名，标 matchedBy=explicit", () => {
    const res = selectL0Sessions([row({ session_key: "weird-test-7" })], { patterns: [], sessions: ["weird-test-7"] });
    expect(res.selected.map((g) => g.key)).toEqual(["weird-test-7"]);
    expect(res.selected[0]!.matchedBy).toEqual({ kind: "explicit" });
  });

  it("纯显式计划默认被拦（防手滑清库），--allow-unmatched-sessions 放行", () => {
    const res = selectL0Sessions([row({ session_key: "weird-test-7" })], { patterns: [], sessions: ["weird-test-7"] });
    expect(validatePlan(res)).toEqual([expect.stringContaining("--allow-unmatched-sessions")]);
    expect(validatePlan(res, { allowUnmatched: true })).toEqual([]);
  });
});

describe("buildDeleteSessionIds · 删除 id 口径", () => {
  it("剔除缺省 session_id 'default'（否则等于清空该身份全部缺省会话）", () => {
    const rows = [row({ session_key: "probe-abc", session_id: DEFAULT_SESSION_ID })];
    const res = selectL0Sessions(rows);
    expect(res.selected[0]!.ids).toEqual(["probe-abc"]);
    expect(buildDeleteSessionIds(res.selected)).toEqual(["probe-abc"]);
  });

  it("session_key 与非缺省 session_id 一并带上并去重排序", () => {
    const rows = [
      row({ session_key: "probe-a", session_id: "sid-a" }),
      row({ session_key: "probe-a", session_id: "sid-a" }),
      row({ session_key: "probe-b", session_id: "sid-b" }),
    ];
    expect(buildDeleteSessionIds(selectL0Sessions(rows).selected)).toEqual(["probe-a", "probe-b", "sid-a", "sid-b"]);
  });

  it("deletableIdsOf / groupKeyOf 的边界", () => {
    expect(deletableIdsOf({ session_key: "", session_id: "default" })).toEqual([]);
    expect(deletableIdsOf({ session_key: " k ", session_id: " default " })).toEqual(["k"]);
    expect(groupKeyOf({ session_key: "", session_id: "only-sid" })).toBe("only-sid");
    expect(groupKeyOf({ session_key: "sk", session_id: "sid" })).toBe("sk");
  });

  it("validatePlan 永不放行 'default' 作为删除 id（即使被显式塞进 groups）", () => {
    const forged = [
      { key: "k", ids: [DEFAULT_SESSION_ID], rows: 1, chars: 1, bytes: 1, firstSeen: null, lastSeen: null, roles: {}, matchedBy: { kind: "explicit" as const } },
    ];
    expect(buildDeleteSessionIds(forged)).toEqual([]);
    expect(validatePlan({ selected: forged, kept: [], selectedRows: 1, selectedChars: 1, keptRows: 0, keptChars: 0, totalRows: 1 })).toEqual([
      expect.stringContaining("选中 0 个会话"),
    ]);
  });
});
