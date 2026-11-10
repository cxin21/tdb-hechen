import { describe, expect, it } from "vitest";
import { assembleSoulCard, filterPersonaItems } from "../card-service.js";
import type { PersonaItem } from "../types.js";
import type { CoreTenant } from "../../store/types.js";

/**
 * P2-A：per-person 卡（在场者过滤）。
 *
 * 断言口径与 spec §4 P2-A 一致：
 *   - `persons === undefined` → 不过滤（所有人的行都在候选里）；
 *   - `meta.person.key === ""`（或读不到）→ 全局共性行，恒在场；
 *   - 其它行只有 person_key 在 `persons` 里才在场；
 *   - `persons` 里有谁都没有的行 → warnings 里留一条「关于你」。
 * P2（t1）起 relationship 也按人过滤：带 persons 时只认 soul_person_relation 的结构化行，
 * 旧的 persona relationship 行不再漏进按人过滤的卡（见 card-relations.test.ts）。
 *
 * v13 起 human 行按前缀进「我们」（身份/相处/约定/要求）与「生活」（喜欢/近况/经历/雷点），
 * 所以 fixture 用生产同款字段前缀，不用 A1/B1 这种测试编号。
 */

const TENANT: CoreTenant = { teamId: "t-sim", userId: "u-sim", agentId: "a-sim" };
const PERSON_A = "p_a";
const PERSON_B = "p_b";

function item(partial: Partial<PersonaItem> & { layer: PersonaItem["layer"]; text: string }): PersonaItem {
  return {
    itemId: `i-${partial.layer}-${partial.text.slice(0, 8)}`,
    state: "active",
    weight: 0.7,
    evidenceIds: ["e1"],
    evidenceDays: ["2026-11-08"],
    evidenceOrigins: ["user"],
    createdAt: "2026-11-08T00:00:00.000Z",
    updatedAt: "2026-11-08T00:00:00.000Z",
    lastEvidenceAt: "2026-11-08T00:00:00.000Z",
    ...partial,
  };
}

/** 4 条 human（A×1 / B×1 / 全局×2，按 lastEvidenceAt 降序）+ 1 条 relationship。 */
function items(): PersonaItem[] {
  return [
    item({ layer: "human", text: "身份：偏好在灰度之后全量", lastEvidenceAt: "2026-11-08T10:00:00.000Z", meta: { person: { key: PERSON_A } } }),
    item({ layer: "human", text: "相处：讨厌被替着做决定", lastEvidenceAt: "2026-11-08T09:00:00.000Z", meta: { person: { key: PERSON_A } } }),
    item({ layer: "human", text: "约定：发布窗口归他管", lastEvidenceAt: "2026-11-08T08:00:00.000Z", meta: { person: { key: PERSON_B } } }),
    item({ layer: "human", text: "要求：结论必须带证据", lastEvidenceAt: "2026-11-08T07:00:00.000Z", meta: { person: { key: PERSON_B } } }),
    item({ layer: "human", text: "喜欢：先把结论说清楚", lastEvidenceAt: "2026-11-08T06:00:00.000Z", meta: { person: { key: "" } } }),
    item({ layer: "relationship", text: "用户上次说别替他猜", lastEvidenceAt: "2026-11-08T05:00:00.000Z" }),
  ];
}

function makeStore(rows: PersonaItem[]) {
  return {
    readLastSoulSnapshot: async () => null,
    listSoulPersona: async () => rows,
    readSoulTraitState: async () => null,
    listSoulTraitLabels: async () => [],
    writeSoulSnapshot: async () => undefined,
  };
}

async function assemble(opts: { persons?: string[]; rows?: PersonaItem[] } = {}) {
  return assembleSoulCard({
    store: makeStore(opts.rows ?? items()),
    tenant: TENANT,
    persist: false,
    readAgentProfile: async () => ({ name: "小满" }),
    ...(opts.persons === undefined ? {} : { persons: opts.persons }),
  });
}

describe("P2-A per-person 卡（assembleSoulCard 的 persons）", () => {
  it("persons 省略：所有人的行都在候选里，卡是 v13 结构", async () => {
    const card = await assemble();
    expect(card.schema).toBe("13");
    expect(card.text).toContain("偏好在灰度之后全量");
    expect(card.text).toContain("发布窗口归他管");
    expect(card.text).toContain("你上次说别替他猜");
    expect(card.text).toContain('v="13"');
    expect(card.hash).toBe((await assemble()).hash);
  });

  it("persons:[A]：B 的行消失，A 的身份/相处与全局喜好都在", async () => {
    const card = await assemble({ persons: [PERSON_A] });
    expect(card.text).toContain("偏好在灰度之后全量");
    expect(card.text).toContain("讨厌被替着做决定");
    expect(card.text).toContain("先把结论说清楚");
    expect(card.text).not.toContain("发布窗口归他管");
    expect(card.text).not.toContain("结论必须带证据");
    // P2：按人过滤时 relationship 只来自结构化关系边；store 没有关系边 → 关系行不进卡，
    // 不再把全局 persona 关系行（展示名，没有 person_key）漏给这个人。
    expect(card.text).not.toContain("你上次说别替他猜");
    // 过滤没有把 human 段筛空 → 不补「关于你」warning。
    expect(card.warnings.some((w) => w.includes("关于你"))).toBe(false);
  });

  it("persons:[]：只剩全局共性行", async () => {
    const card = await assemble({ persons: [] });
    expect(card.text).toContain("先把结论说清楚");
    expect(card.text).not.toContain("偏好在灰度之后全量");
    expect(card.text).not.toContain("发布窗口归他管");
  });

  it("persons:[C] 而库里没有 C 的行：只剩全局共性行，且 warnings 含「关于你」", async () => {
    const card = await assemble({ persons: ["p_c"] });
    expect(card.text).toContain("先把结论说清楚");
    expect(card.text).not.toContain("偏好在灰度之后全量");
    expect(card.text).not.toContain("发布窗口归他管");
    expect(card.warnings.some((w) => w.includes("关于你"))).toBe(true);
  });
});

describe("P2-A filterPersonaItems（纯函数）", () => {
  it("只保留指定层且满足谓词的行，输入不被修改", () => {
    const rows = items();
    const snapshot = JSON.parse(JSON.stringify(rows)) as PersonaItem[];
    const out = filterPersonaItems(rows, ["human"], (it) => (it.meta?.["person"] as { key?: string } | undefined)?.key !== PERSON_B);
    expect(out.map((it) => it.text)).toEqual([
      "身份：偏好在灰度之后全量",
      "相处：讨厌被替着做决定",
      "喜欢：先把结论说清楚",
    ]);
    expect(rows).toEqual(snapshot);
  });
});

describe("P2-F 快照 payload 记录 persons", () => {
  async function persistWith(persons: string[] | undefined) {
    const writes: Array<{ payloadJson: string }> = [];
    const store = {
      ...makeStore(items()),
      writeSoulSnapshot: async (_t: unknown, row: { payloadJson: string }) => {
        writes.push(row);
      },
    };
    await assembleSoulCard({
      store: store as never,
      tenant: TENANT,
      persist: true,
      readAgentProfile: async () => ({ name: "小满" }),
      ...(persons === undefined ? {} : { persons }),
    });
    expect(writes).toHaveLength(1);
    return JSON.parse(writes[0]!.payloadJson) as Record<string, unknown>;
  }

  it("按人过滤时 payloadJson 带上该组 key（回放能还原当时用的在场者）", async () => {
    const payload = await persistWith([PERSON_A]);
    expect(payload.persons).toEqual([PERSON_A]);
    expect(payload.kind).toBe("persona-card");
  });

  it("不按人过滤时 payloadJson 不写 persons（未过滤≠过滤了空名单）", async () => {
    const payload = await persistWith(undefined);
    expect("persons" in payload).toBe(false);
  });
});
