/**
 * 缺口 A · 人设版本与漂移审计（纯函数层）RED 套件。
 *
 * 合同：
 *  - slot 图键空间 = slot:<core_memory slot> / value:<value_id|label> / block:<渲染段标签>；
 *  - diff 键级三类：added / removed / changed，值摘要截断为单行（不引 jsdiff 依赖）；
 *  - 变更归因 = 受控枚举（first-version / identity-discovery / core-values / promise /
 *    state / slots / layout），细节进 detail；
 *  - 上一版 slot 图不可得时不得伪装成 first-version（如实 slots + previous-slots-unavailable）；
 *  - 版本视图：version 单调、parentHash 指向上一版 content_hash、每版 diff 对上一版；
 *  - content_hash 单一源 fnv1a32Hex：同内容同 hash、不同内容不同 hash。
 */
import { describe, expect, it } from "vitest";
import {
  SOUL_CHANGE_REASONS,
  buildSoulSlotMap,
  classifySoulChange,
  diffSoulSlots,
  listSoulVersions,
  parseSoulSlotMap,
  querySoulVersions,
  summarizeSoulDiff,
} from "../soul-versioning.js";
import { fnv1a32Hex } from "../soul-assembler.js";

describe("A · soul slot 图（键空间）", () => {
  it("core slots / values / 渲染块三段键空间；缺省信号不造键", () => {
    const map = buildSoulSlotMap({
      slots: [{ slot: "self_identity", content: "我是测试者。" }],
      values: [{ value_id: "v1", label: "根因", weight: 0.8, valence: 1, state: "active" }],
      parts: ["<soul-identity>\nX 内容\n</soul-identity>", "<soul-feeling>\nY 内容\n</soul-feeling>"],
    });
    expect(map["slot:self_identity"]).toBe("我是测试者。");
    expect(map["value:v1"]).toContain("根因");
    expect(map["block:soul-identity"]).toContain("X 内容");
    expect(map["block:soul-feeling"]).toContain("Y 内容");
    expect(Object.keys(buildSoulSlotMap({}))).toHaveLength(0);
  });

  it("value 键回落 label（无 value_id）；状态/权重入值摘要（漂移可见）", () => {
    const map = buildSoulSlotMap({ values: [{ label: "审慎", weight: 0.2, valence: -1, state: "active" }] });
    expect(map["value:审慎"]).toContain("审慎");
    expect(map["value:审慎"]).toContain("w=0.2");
    expect(map["value:审慎"]).toContain("v=-1");
  });
});

describe("A · slot 级 diff（added / removed / changed 三类 + 值摘要）", () => {
  it("三类可区分；未变只计数", () => {
    const before = { "slot:self_identity": "旧", "slot:identity": "保留", "value:v9": "删除" };
    const after = { "slot:self_identity": "新", "slot:identity": "保留", "slot:core_value": "新增" };
    const d = diffSoulSlots(before, after, { summaryChars: 4 });
    expect(d.added.map((e) => e.key)).toEqual(["slot:core_value"]);
    expect(d.removed.map((e) => e.key)).toEqual(["value:v9"]);
    expect(d.changed.map((e) => e.key)).toEqual(["slot:self_identity"]);
    expect(d.changed[0]!.before).toBe("旧");
    expect(d.changed[0]!.after).toBe("新");
    expect(d.unchanged).toBe(1);
  });

  it("首版（before 为 null）：全部 added，且不伪造 removed/changed", () => {
    const d = diffSoulSlots(null, { "slot:self_identity": "首版" });
    expect(d.added).toHaveLength(1);
    expect(d.removed).toHaveLength(0);
    expect(d.changed).toHaveLength(0);
  });

  it("长值摘要截断且折叠单行", () => {
    const long = "第一行内容\n第二行内容还要更长一些用于验证截断行为";
    const d = diffSoulSlots({ "slot:identity": "旧" }, { "slot:identity": long }, { summaryChars: 6 });
    const after = d.changed[0]!.after;
    expect(after).not.toContain("\n");
    expect(after.length).toBeLessThanOrEqual(7);
    expect(after.endsWith("…")).toBe(true);
  });

  it("summarizeSoulDiff 输出计数与键清单（无人读原始值也能归因）", () => {
    const d = diffSoulSlots(
      { "slot:self_identity": "旧", "value:v9": "删" },
      { "slot:self_identity": "新", "slot:core_value": "加" },
    );
    const s = summarizeSoulDiff(d);
    expect(s).toContain("changed=1");
    expect(s).toContain("added=1");
    expect(s).toContain("removed=1");
    expect(s).toContain("slot:self_identity");
  });
});

describe("A · 变更归因（受控枚举，不自由文本）", () => {
  it("枚举闭集导出（消费方可断言）", () => {
    expect([...SOUL_CHANGE_REASONS]).toEqual([
      "first-version",
      "identity-discovery",
      "core-values",
      "promise",
      "state",
      "slots",
      "layout",
    ]);
  });

  it("core_memory 身份槽 → identity-discovery；core_value/strict_rule → core-values", () => {
    expect(classifySoulChange(diffSoulSlots(null, { "slot:self_identity": "x" })).code).toBe("first-version");
    expect(classifySoulChange(diffSoulSlots({ "slot:self_identity": "a" }, { "slot:self_identity": "b" })).code).toBe(
      "identity-discovery",
    );
    expect(classifySoulChange(diffSoulSlots({ "slot:core_value": "a" }, { "slot:core_value": "b" })).code).toBe(
      "core-values",
    );
    expect(classifySoulChange(diffSoulSlots({ "slot:strict_rule": "a" }, { "slot:strict_rule": "b" })).code).toBe(
      "core-values",
    );
  });

  it("价值锚变化 → core-values；承诺槽 → promise；感受段 → state；纯布局 → layout", () => {
    expect(classifySoulChange(diffSoulSlots({ "value:v1": "w=0.1" }, { "value:v1": "w=0.9" })).code).toBe(
      "core-values",
    );
    expect(
      classifySoulChange(diffSoulSlots({ "slot:promise_create": "a" }, { "slot:promise_transition": "b" })).code,
    ).toBe("promise");
    expect(classifySoulChange(diffSoulSlots({ "block:soul-feeling": "a" }, { "block:soul-feeling": "b" })).code).toBe(
      "state",
    );
    const layout = classifySoulChange(diffSoulSlots({ "slot:identity": "same" }, { "slot:identity": "same" }));
    expect(layout.code).toBe("layout");
    expect(layout.detail).toContain("layout");
  });

  it("上一版 slot 图不可得 → 不得冒充 first-version（如实 slots + detail）", () => {
    const c = classifySoulChange(diffSoulSlots(null, { "slot:self_identity": "x" }), { previousSlotsAvailable: false });
    expect(c.code).toBe("slots");
    expect(c.detail).toBe("previous-slots-unavailable");
  });

  it("detail 携带变更键（可读归因，无自由文本枚举）", () => {
    const c = classifySoulChange(diffSoulSlots({ "slot:self_identity": "a" }, { "slot:self_identity": "b" }));
    expect(c.detail).toContain("self_identity");
  });
});

describe("A · content_hash 单一源（fnv1a32Hex）", () => {
  it("同内容同 hash、不同内容不同 hash", () => {
    expect(fnv1a32Hex("同一渲染")).toBe(fnv1a32Hex("同一渲染"));
    expect(fnv1a32Hex("同一渲染")).not.toBe(fnv1a32Hex("另一渲染"));
    expect(fnv1a32Hex("同一渲染")).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("A · 版本视图（按时间窗列版本 + 每版 diff 摘要）", () => {
  const rows = [
    {
      ts: "2026-11-01T00:00:00.000Z",
      content_hash: "h1",
      version: 1,
      parent_hash: null,
      trigger: "first-version",
      reason_detail: "",
      slots_json: JSON.stringify({ "slot:self_identity": "v1" }),
    },
    {
      ts: "2026-11-02T00:00:00.000Z",
      content_hash: "h2",
      version: 2,
      parent_hash: "h1",
      trigger: "identity-discovery",
      reason_detail: "slot:self_identity",
      slots_json: JSON.stringify({ "slot:self_identity": "v2" }),
    },
    {
      ts: "2026-11-03T00:00:00.000Z",
      content_hash: "h3",
      version: 3,
      parent_hash: "h2",
      trigger: "core-values",
      reason_detail: "value:v1",
      slots_json: JSON.stringify({ "slot:self_identity": "v2", "value:v1": "w=0.9" }),
    },
  ];

  it("逐版出 version / parentHash / 归因 / 对上一版的 diff 摘要", () => {
    const views = listSoulVersions(rows);
    expect(views.map((v) => v.version)).toEqual([1, 2, 3]);
    expect(views[0]!.parentHash).toBeNull();
    expect(views[1]!.parentHash).toBe("h1");
    expect(views[2]!.parentHash).toBe("h2");
    expect(views[1]!.reasonCode).toBe("identity-discovery");
    expect(views[1]!.diff.changed.map((e) => e.key)).toEqual(["slot:self_identity"]);
    expect(views[2]!.diff.added.map((e) => e.key)).toEqual(["value:v1"]);
    expect(views[0]!.summary).toContain("changed=");
  });

  it("时间窗过滤 + limit 取最近 N 版（窗口外不出现）", () => {
    const win = listSoulVersions(rows, { fromTs: "2026-11-02T00:00:00.000Z" });
    expect(win.map((v) => v.version)).toEqual([2, 3]);
    const tail = listSoulVersions(rows, { limit: 1 });
    expect(tail.map((v) => v.version)).toEqual([3]);
  });

  it("旧行缺 version（历史反填前）按行序补位，不丢版本", () => {
    const legacy = [
      { ts: "2026-10-01T00:00:00.000Z", content_hash: "a", trigger: "render", payload_json: "x" },
      { ts: "2026-10-02T00:00:00.000Z", content_hash: "b", trigger: "render", payload_json: "y" },
    ];
    const views = listSoulVersions(legacy);
    expect(views.map((v) => v.version)).toEqual([1, 2]);
    expect(views[1]!.parentHash).toBe("a");
  });

  it("parseSoulSlotMap 容错：非法 JSON / 空 / null → {} 且不抛", () => {
    expect(parseSoulSlotMap("")).toEqual({});
    expect(parseSoulSlotMap(null)).toEqual({});
    expect(parseSoulSlotMap("not-json")).toEqual({});
    expect(parseSoulSlotMap('["array"]')).toEqual({});
    expect(parseSoulSlotMap('{"slot:a":"b"}')).toEqual({ "slot:a": "b" });
  });
});

describe("A · 查询面（store 支撑的时间窗版本查询）", () => {
  it("有 listSoulSnapshots 实现 → 版本视图透传时间窗；缺实现 → 降级留 note 不静默", async () => {
    const rows = [
      {
        ts: "2026-11-01T00:00:00.000Z",
        content_hash: "h1",
        version: 1,
        parent_hash: null,
        trigger: "first-version",
        slots_json: JSON.stringify({ "slot:self_identity": "v1" }),
      },
      {
        ts: "2026-11-03T00:00:00.000Z",
        content_hash: "h2",
        version: 2,
        parent_hash: "h1",
        trigger: "core-values",
        slots_json: JSON.stringify({ "value:v1": "w=0.9" }),
      },
    ];
    const store = { listSoulSnapshots: async () => rows };
    const got = await querySoulVersions(
      store,
      { teamId: "t", userId: "u", agentId: "a" },
      { fromTs: "2026-11-02T00:00:00.000Z" },
    );
    expect(got.notes).toEqual([]);
    expect(got.versions.map((v) => v.version)).toEqual([2]);
    expect(got.versions[0]!.summary).toContain("added=");

    const bare = await querySoulVersions({}, { teamId: "t", userId: "u", agentId: "a" });
    expect(bare.versions).toEqual([]);
    expect(bare.notes.join("|")).toContain("snapshot-surface-unavailable");
  });
});
