/**
 * P2（卡的 relationship 段）：只在真的按人过滤时读 soul_person_relation，
 * 并且 fail-closed——解析不到 person_key 就省略这一行并给 warning，绝不回退展示名。
 */
import { describe, expect, it } from "vitest";
import { buildCardInput, buildStructuredRelationshipLines } from "../card-service.js";
import type { PersonaItem } from "../types.js";
import type { SoulPersonRelationRow } from "../../store/types.js";

const HE = "p_b38a137ab63b";

function rel(over: Partial<SoulPersonRelationRow> = {}): SoulPersonRelationRow {
  return {
    relId: "rel-1",
    subjKey: HE,
    pred: "上级",
    inversePred: null,
    objKey: "p_zhou",
    objName: "",
    direction: "out",
    quote: "周衡是我上级",
    recordId: "l1-1",
    evidence: [],
    validFrom: "2026-11-01T00:00:00.000Z",
    validTo: null,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...over,
  };
}

function personaItem(text: string): PersonaItem {
  return {
    itemId: "relationship:old-1",
    layer: "relationship",
    text,
    state: "active",
    weight: 0.9,
    evidenceIds: ["l0-1"],
    evidenceDays: ["2026-11-01"],
    evidenceOrigins: ["l1"],
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    lastEvidenceAt: "2026-11-01T00:00:00.000Z",
  };
}

const NAMES = new Map([
  ["p_zhou", "周衡"],
  ["p_lin", "林夏"],
  ["p_zhao", "赵宁"],
  ["p_chen", "陈屿"],
]);

describe("buildStructuredRelationshipLines：4 条结构化关系", () => {
  it("生产形状的 4 条边 → 4 行，全部用 person_key 解析出的名字", () => {
    const out = buildStructuredRelationshipLines({
      relations: [
        rel({ relId: "r1", objKey: "p_zhou", pred: "上级" }),
        rel({ relId: "r2", objKey: "p_lin", pred: "徒弟" }),
        rel({ relId: "r3", objKey: "p_zhao", pred: "同事", direction: "mutual" }),
        rel({ relId: "r4", objKey: "p_chen", pred: "客户" }),
      ],
      personNames: NAMES,
      persons: [HE],
    });
    expect(out.lines).toHaveLength(4);
    expect(out.warnings).toEqual([]);
    expect(out.lines[0]).toBe("你与周衡：上级");
    expect(out.lines.join("\n")).not.toContain("用户");
    expect(out.lines.join("\n")).not.toContain("对我的要求");
    expect(out.lines.join("\n")).not.toContain("我回过");
  });

  it("对象解析不到 person_key 就省略并给 person_unresolved，绝不回退 obj_name/展示名", () => {
    const out = buildStructuredRelationshipLines({
      relations: [
        rel({ relId: "r1", objKey: null, objName: "老周", pred: "上级" }),
        rel({ relId: "r2", objKey: "p_unknown", objName: "神秘人", pred: "前同事" }),
        rel({ relId: "r3", objKey: "p_lin", pred: "徒弟" }),
      ],
      personNames: NAMES,
      persons: [HE],
    });
    expect(out.lines).toEqual(["你与林夏：徒弟"]);
    expect(out.warnings).toEqual(["person_unresolved:r1", "person_unresolved:p_unknown"]);
    expect(out.lines.join("\n")).not.toContain("老周");
    expect(out.lines.join("\n")).not.toContain("神秘人");
  });

  it("A/B 隔离：只渲染 subj 在 persons 里的边，别人的关系一条都不出现", () => {
    const outA = buildStructuredRelationshipLines({
      relations: [rel({ relId: "ra", subjKey: "p_a", objKey: "p_shared", pred: "同事" })],
      personNames: new Map([["p_shared", "共享对象"]]),
      persons: ["p_a"],
    });
    const outB = buildStructuredRelationshipLines({
      relations: [rel({ relId: "ra", subjKey: "p_a", objKey: "p_shared", pred: "同事" })],
      personNames: new Map([["p_shared", "共享对象"]]),
      persons: ["p_b"],
    });
    expect(outA.lines).toEqual(["你与共享对象：同事"]);
    expect(outB.lines).toEqual([]);
  });

  it("已结束/有争议的边不进卡；空白名单不渲染任何关系", () => {
    const out = buildStructuredRelationshipLines({
      relations: [
        rel({ relId: "r1", validTo: "2026-11-05T00:00:00.000Z", pred: "前合作方" }),
        { ...rel({ relId: "r2", pred: "合作方" }), status: "disputed" } as SoulPersonRelationRow,
        { ...rel({ relId: "r3", pred: "同事" }), status: "ended" } as SoulPersonRelationRow,
        rel({ relId: "r4", pred: "上级" }),
      ],
      personNames: NAMES,
      persons: [HE],
    });
    expect(out.lines).toEqual(["你与周衡：上级"]);
    expect(buildStructuredRelationshipLines({ relations: [rel()], personNames: NAMES, persons: [] }).lines).toEqual([]);
  });
});

describe("buildCardInput：按人过滤时 relationship 只认结构化行（fail-closed）", () => {
  const oldLine = "用户对我的要求：「这里别写死」——我只回了话，没改";

  it("persons 已给 + 有结构化行 → 关系段不含旧 persona 行", () => {
    const input = buildCardInput({
      profile: { name: "小七" } as never,
      labels: [],
      items: [personaItem(oldLine)],
      version: 3,
      persons: [HE],
      structuredRelationship: ["你与周衡：上级"],
    });
    expect(input.relationship).toEqual(["你与周衡：上级"]);
  });

  it("persons 已给但没有结构化行 → 关系段为空，不把全局 persona 行漏出去", () => {
    const input = buildCardInput({
      profile: { name: "小七" } as never,
      labels: [],
      items: [personaItem(oldLine)],
      version: 3,
      persons: [HE],
    });
    expect(input.relationship).toEqual([]);
  });

  it("persons 未给（旧调用）→ 行为逐字不变，仍读 persona relationship 行", () => {
    const input = buildCardInput({
      profile: { name: "小七" } as never,
      labels: [],
      items: [personaItem(oldLine)],
      version: 3,
    });
    expect(input.relationship).toEqual([oldLine]);
  });
});
