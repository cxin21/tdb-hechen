/**
 * P2 Task 2（spec §2.6/§5 F11/F12）：person 证据口径 + valence 符号化 + 人物发现 prompt 单一源。
 * F11 verbatim：personEv = |{ r : content 包含 label 或任一 alias }|；
 * F12 valence 符号化：≥+0.2→1，≤-0.2→-1，否则 0；parse 护栏：role 白名单外归"其他"，
 * aliases 规范化（去空/去重/去同 label）；非法输入 → []（宁缺毋滥）。
 */
import { describe, it, expect } from "vitest";
import {
  personEvCount,
  personValenceSymbol,
  personEvidenceMeanValence,
  parsePersonProposals,
  PERSON_DISCOVER_SYSTEM_PROMPT,
  buildPersonDiscoverPrompt,
} from "./gateway/core-values-discover.js";

describe("F11 personEv 口径", () => {
  it("label 或任一 alias 命中去重（同一行只计一次）", () => {
    const corpus = ["女儿今天月考", "闺女要去图书馆", "老周下棋", "女儿的房间", "闺女和女儿一起做饭"];
    expect(personEvCount("女儿", ["闺女"], corpus)).toBe(4);
  });
  it("无 alias 空数组退化 = label 纯包含", () => {
    expect(personEvCount("老周", [], ["老周下棋", "象棋"])).toBe(1);
  });
  it("零命中 → 0", () => {
    expect(personEvCount("张三", ["小三"], ["女儿月考"])).toBe(0);
  });
});

describe("F12 valence 符号化", () => {
  it("边界：≥+0.2→1 / ≤-0.2→-1 / 否则 0", () => {
    expect(personValenceSymbol(0.2)).toBe(1);
    expect(personValenceSymbol(0.9)).toBe(1);
    expect(personValenceSymbol(-0.2)).toBe(-1);
    expect(personValenceSymbol(-1)).toBe(-1);
    expect(personValenceSymbol(0.19)).toBe(0);
    expect(personValenceSymbol(-0.19)).toBe(0);
    expect(personValenceSymbol(0)).toBe(0);
  });
  it("personEvidenceMeanValence：命中行 valence 均值；无 valence 行 → null", () => {
    const rows = [
      { content: "女儿今天月考", valence: 0.5 },
      { content: "闺女要去图书馆", valence: 0.1 },
      { content: "女儿的房间", valence: null },
      { content: "无关", valence: 1 },
    ];
    expect(personEvidenceMeanValence("女儿", ["闺女"], rows)).toBeCloseTo(0.3);
    expect(personEvidenceMeanValence("老周", [], rows)).toBeNull();
  });
});

describe("parsePersonProposals 护栏", () => {
  it("role 白名单外归其他；aliases 去空/去重/去同 label", () => {
    const rows = parsePersonProposals('[{"label":"女儿","role":"boss","aliases":["闺女","","女儿","闺女"]}]');
    expect(rows).toEqual([{ label: "女儿", role: "其他", aliases: ["闺女"] }]);
  });
  it("role 合法保留；```json 围栏可解析", () => {
    const raw = '```json\n[{"label":"老周","role":"朋友","aliases":["老周头"]}]\n```';
    expect(parsePersonProposals(raw)).toEqual([{ label: "老周", role: "朋友", aliases: ["老周头"] }]);
  });
  it("非法 JSON / 缺 label / 非数组 → []（宁缺毋滥）", () => {
    expect(parsePersonProposals("not json")).toEqual([]);
    expect(parsePersonProposals('[{"role":"家人"}]')).toEqual([]);
    expect(parsePersonProposals('{"label":"x"}')).toEqual([]);
    expect(parsePersonProposals("")).toEqual([]);
  });
  it("缺省 role → 其他；缺省 aliases → []", () => {
    expect(parsePersonProposals('[{"label":"某人"}]')).toEqual([{ label: "某人", role: "其他", aliases: [] }]);
  });
});

describe("person 发现 prompt", () => {
  it("SYSTEM prompt 硬约束齐备（行为可证/宁缺毋滥/禁状态/JSON 输出）", () => {
    expect(PERSON_DISCOVER_SYSTEM_PROMPT).toContain("行为可证");
    expect(PERSON_DISCOVER_SYSTEM_PROMPT).toContain("宁缺毋滥");
    expect(PERSON_DISCOVER_SYSTEM_PROMPT).toContain("JSON");
  });
  it("build prompt 含样本与既有名单（label+alias）", () => {
    const p = buildPersonDiscoverPrompt(["女儿今天月考"], ["女儿", "闺女"]);
    expect(p).toContain("女儿今天月考");
    expect(p).toContain("闺女");
  });
});
