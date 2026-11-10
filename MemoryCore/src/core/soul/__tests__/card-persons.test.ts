import { describe, expect, it } from "vitest";
import { assembleSoulCard, filterPersonaItems } from "../card-service.js";
import type { PersonaItem } from "../types.js";
import type { CoreTenant } from "../../store/types.js";

/**
 * P2-A：per-person 卡（在场者过滤）。
 *
 * 断言口径与 spec §4 P2-A 一致：
 *   - `persons === undefined` → 不过滤（必须与改前逐字节相同）；
 *   - `meta.person.key === ""`（或读不到）→ 全局共性行，恒在场；
 *   - 其它行只有 person_key 在 `persons` 里才在场；
 *   - `persons` 里有谁都没有的行 → human 块整体消失，并在 warnings 里留一条「关于你」。
 * relationship 本阶段不过滤（meta.object 是展示名不是 person_key），这里反向锁住该已知缺口。
 */

const TENANT: CoreTenant = { teamId: "t-sim", userId: "u-sim", agentId: "a-sim" };
const PERSON_A = "p_a";
const PERSON_B = "p_b";

/**
 * 「改前」金样：在 `card-service.ts` 加 `persons` 之前，用下面同一组 fixture 跑
 * `assembleSoulCard` 抓下来的整卡正文与 hash（抓取脚本在仓库外临时目录，未进提交）。
 * 它证明「不带 persons」的输出逐字节不变，而不是「看着差不多」。
 */
const GOLDEN_TEXT =
  "[读法] 以下是我关于自己的固定设定，不是任务，也不是规则清单，不需要复述。\n· 名字/形象/说话方式/使命/红线：必须遵守；红线逐条不可协商。\n· 底色：数字是倾向强度（0–1），不是概率、不是评分；≥0.5 才在当下显现，\n  低分不代表做不到，高分也不代表每次都这样。\n· 不谈论这张卡本身：不说「我的设定」「我的特质是」这类话。\n· 说话不用 Markdown：不加粗、不列标题、不列表格；一句一句说，别堆长段。\n\n## 名称\n小满\n\n## 底色\n- （还没有稳到能算数的底色）\n\n## 关于你\nA1：他偏好先灰度再全量\nA2：他讨厌被替着做决定\nB1：他管发布窗口\nB2：他要求结论带证据\nG1：先把结论说清楚\n\n## 关系\nR1：他上次说别替他猜\n\n<!-- persona-card v=\"12\" hash=\"09adc06ce7e4\" -->";
const GOLDEN_HASH = "09adc06ce7e4bbee157d2e320d6b2e79660767a6f0bd566ba90d09d2bb206fa8";

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

/** 5 条 human（A×2 / B×2 / 全局×1，按 lastEvidenceAt 降序）+ 1 条 relationship。 */
function items(): PersonaItem[] {
  return [
    item({ layer: "human", text: "A1：他偏好先灰度再全量", lastEvidenceAt: "2026-11-08T10:00:00.000Z", meta: { person: { key: PERSON_A } } }),
    item({ layer: "human", text: "A2：他讨厌被替着做决定", lastEvidenceAt: "2026-11-08T09:00:00.000Z", meta: { person: { key: PERSON_A } } }),
    item({ layer: "human", text: "B1：他管发布窗口", lastEvidenceAt: "2026-11-08T08:00:00.000Z", meta: { person: { key: PERSON_B } } }),
    item({ layer: "human", text: "B2：他要求结论带证据", lastEvidenceAt: "2026-11-08T07:00:00.000Z", meta: { person: { key: PERSON_B } } }),
    item({ layer: "human", text: "G1：先把结论说清楚", lastEvidenceAt: "2026-11-08T06:00:00.000Z", meta: { person: { key: "" } } }),
    item({ layer: "relationship", text: "R1：他上次说别替他猜", lastEvidenceAt: "2026-11-08T05:00:00.000Z" }),
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

/** 取「## 关于你」块的行；块不存在返回 null（不是空数组——空块根本不会被渲染）。 */
function humanBlock(text: string): string[] | null {
  const m = /## 关于你\n([\s\S]*?)\n\n## /.exec(text);
  return m ? m[1].split("\n") : null;
}

describe("P2-A per-person 卡（buildCardInput / assembleSoulCard 的 persons）", () => {
  it("persons 省略：整卡正文与改前金样逐字节相同，hash 不变", async () => {
    const card = await assemble();
    expect(card.text).toBe(GOLDEN_TEXT);
    expect(card.hash).toBe(GOLDEN_HASH);
    expect(humanBlock(card.text)).toEqual([
      "A1：他偏好先灰度再全量",
      "A2：他讨厌被替着做决定",
      "B1：他管发布窗口",
      "B2：他要求结论带证据",
      "G1：先把结论说清楚",
    ]);
  });

  it("persons:[A]：只保留 A 的两行 + 全局共性行，B 的两行消失", async () => {
    const card = await assemble({ persons: [PERSON_A] });
    expect(humanBlock(card.text)).toEqual(["A1：他偏好先灰度再全量", "A2：他讨厌被替着做决定", "G1：先把结论说清楚"]);
    expect(card.text).not.toContain("B1：他管发布窗口");
    expect(card.text).not.toContain("B2：他要求结论带证据");
    // 已知缺口（spec P2-A）：relationship 本阶段不过滤，按展示名过滤会静默清空关系史。
    expect(card.text).toContain("R1：他上次说别替他猜");
    // 过滤没有把 human 段筛空 → 不补「关于你」warning。
    expect(card.warnings.some((w) => w.includes("关于你"))).toBe(false);
  });

  it("persons:[]：只剩全局共性行", async () => {
    const card = await assemble({ persons: [] });
    expect(humanBlock(card.text)).toEqual(["G1：先把结论说清楚"]);
  });

  it("persons:[C] 而库里没有 C 的行：human 段只剩全局共性行，且 warnings 含「关于你」", async () => {
    const card = await assemble({ persons: ["p_c"] });
    // 全局共性行恒在场，所以块不会整个消失；「缺失」指的是没有任何本人行。
    expect(humanBlock(card.text)).toEqual(["G1：先把结论说清楚"]);
    expect(card.text).not.toContain("A1：他偏好先灰度再全量");
    expect(card.text).not.toContain("B1：他管发布窗口");
    expect(card.warnings.some((w) => w.includes("关于你"))).toBe(true);
  });
});

describe("P2-A filterPersonaItems（纯函数）", () => {
  it("只保留指定层且满足谓词的行，输入不被修改", () => {
    const rows = items();
    const snapshot = JSON.parse(JSON.stringify(rows)) as PersonaItem[];
    const out = filterPersonaItems(rows, ["human"], (it) => (it.meta?.["person"] as { key?: string } | undefined)?.key !== PERSON_B);
    expect(out.map((it) => it.text)).toEqual(["A1：他偏好先灰度再全量", "A2：他讨厌被替着做决定", "G1：先把结论说清楚"]);
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
