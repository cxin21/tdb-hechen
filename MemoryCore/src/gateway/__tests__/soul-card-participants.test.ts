import { describe, expect, it, vi } from "vitest";
import type { ServerResponse } from "node:http";
import { handleSoulCardRoute } from "../soul-card-endpoint.js";
import type { PersonaItem } from "../../core/soul/types.js";

/**
 * P2-B：端点解析 `?participants=` / `?session=`。
 *
 * 三条硬口径（spec §4 P2-B）：
 *   1) 不传 participants：响应 text 与改前基线逐字节相同，且**不出现** `data.persons`
 *      字段（未过滤不是空数组）；
 *   2) `participants=p_a,p_b`：`data.persons` 回显解析后的 person_key，且 human 段按人过滤；
 *   3) `participants=`（空串）：当 `[]` 处理——只剩全局共性行，`data.persons` 回显 `[]`。
 * 另加一条：展示名形态（唯一命中才用，0 条/≥2 条丢弃），这是 spec 里 ② 的核心。
 */

const res = {} as ServerResponse;

/** v13 金样：同一组 fixture（human 行带字段前缀）跑出来的整卡正文。改动渲染器就重冻结这一行——它是「默认输出变了」的硬证据。 */
const GOLDEN_TEXT =
  "[读法] 以下是我关于自己的固定设定，不是任务，也不是规则清单，不需要复述。\n· 名字/形象/说话方式/使命/红线：必须遵守；红线逐条不可协商。\n· 底色：数字是倾向强度（0–1），不是概率、不是评分；≥0.5 才在当下显现，\n  低分不代表做不到，高分也不代表每次都这样。\n· 不谈论这张卡本身：不说「我的设定」「我的特质是」这类话。\n· 说话不用 Markdown：不加粗、不列标题、不列表格；一句一句说，别堆长段。\n\n小满\n\n我们\n相处上，他偏好先灰度再全量\n相处上，他讨厌被替着做决定\n我们说好：他管发布窗口\n你要求我：他要求结论带证据\n你是先把结论说清楚\nR1：他上次说别替他猜\n\n<!-- persona-card v=\"13\" hash=\"b2b49d291d30\" -->";
const PERSON_A = "p_a";
const PERSON_B = "p_b";
const TENANT_QS = "team=t-sim&user=u-sim&agent=a-sim";

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

function items(): PersonaItem[] {
  return [
    item({ layer: "human", text: "相处：他偏好先灰度再全量", lastEvidenceAt: "2026-11-08T10:00:00.000Z", meta: { person: { key: PERSON_A } } }),
    item({ layer: "human", text: "相处：他讨厌被替着做决定", lastEvidenceAt: "2026-11-08T09:00:00.000Z", meta: { person: { key: PERSON_A } } }),
    item({ layer: "human", text: "约定：他管发布窗口", lastEvidenceAt: "2026-11-08T08:00:00.000Z", meta: { person: { key: PERSON_B } } }),
    item({ layer: "human", text: "要求：他要求结论带证据", lastEvidenceAt: "2026-11-08T07:00:00.000Z", meta: { person: { key: PERSON_B } } }),
    item({ layer: "human", text: "身份：先把结论说清楚", lastEvidenceAt: "2026-11-08T06:00:00.000Z", meta: { person: { key: "" } } }),
    item({ layer: "relationship", text: "R1：他上次说别替他猜", lastEvidenceAt: "2026-11-08T05:00:00.000Z" }),
  ];
}

/** `persons` 行：名字 → person_key 解析的数据源（listSoulPersons）。 */
/** 租户内默认的人物目录：key 校验（P2-B2）与展示名解析都以它为准。 */
const DEFAULT_PERSONS = [
  { personKey: PERSON_A, displayName: "何晨", aliases: ["小何"] },
  { personKey: PERSON_B, displayName: "林工", aliases: [] },
];

function makeStore(
  persons: Array<{ personKey: string; displayName: string; aliases?: string[] }> = DEFAULT_PERSONS,
  episodes: Array<{ sessionId: string; persons?: string[] }> = [],
) {
  return {
    readLastSoulSnapshot: async () => null,
    listSoulPersona: async () => items(),
    readSoulTraitState: async () => null,
    listSoulTraitLabels: async () => [],
    writeSoulSnapshot: vi.fn(),
    listSoulPersons: async () => persons,
    listSoulEpisodes: async () => episodes as never,
  };
}

async function callCard(query: string, store: ReturnType<typeof makeStore>) {
  const sendJson = vi.fn();
  const handled = await handleSoulCardRoute(new URL(`/v3/soul/card?${TENANT_QS}${query}`, "http://localhost"), "GET", sendJson, res, {
    getStore: () => store as never,
    getReadAgentProfile: () => (async () => ({ name: "小满" }) as never),
  });
  expect(handled).toBe(true);
  const [, status, payload] = sendJson.mock.calls[0]!;
  expect(status).toBe(200);
  return (payload as { data: Record<string, unknown> }).data;
}

/** 取「我们」块的行。v13 的块没有 Markdown 标题，块与块之间空一行，末尾是 html 注释标签。 */
function usBlock(text: string): string[] | null {
  const body = text.split("\n\n<!-- persona-card")[0] ?? "";
  for (const chunk of body.split("\n\n")) {
    if (chunk.startsWith("我们\n")) return chunk.slice("我们\n".length).split("\n");
  }
  return null;
}

describe("P2-B GET /v3/soul/card?participants=…", () => {
  it("不传 participants：text 与改前金样逐字节相同，且不出现 data.persons", async () => {
    const data = await callCard("", makeStore());
    expect(data.text).toBe(GOLDEN_TEXT);
    expect("persons" in data).toBe(false);
    expect(usBlock(String(data.text))).toHaveLength(6);
  });

  it("participants=p_a：回显 persons，且 human 段只留 A + 全局", async () => {
    const data = await callCard("&participants=p_a", makeStore());
    expect(data.persons).toEqual([PERSON_A]);
    expect(usBlock(String(data.text))).toEqual(["相处上，他偏好先灰度再全量", "相处上，他讨厌被替着做决定", "你是先把结论说清楚"]);
    expect(String(data.text)).not.toContain("我们说好：他管发布窗口");
  });

  it("participants=（空串）：当 [] 处理，只剩全局共性行，回显空数组", async () => {
    const data = await callCard("&participants=", makeStore());
    expect(data.persons).toEqual([]);
    expect(usBlock(String(data.text))).toEqual(["你是先把结论说清楚"]);
    // 空名单仍是有语义的过滤：本人行全部消失，且补了「关于你」warning 之外的正常路径
    expect(String(data.text)).not.toContain("相处上，他偏好先灰度再全量");
  });

  it("P2-B2：p_ 前缀的 key 不在本租户时丢弃，不谎报「按这个人过滤了」", async () => {
    const data = await callCard("&participants=p_does_not_exist", makeStore());
    // 显式名单全部无效 → 解析结果 []，回显 []（不是 undefined），human 段只剩全局行；
    // 关键是不能把不存在的 key 原样回显，否则面板会以为「按这个人过滤了」。
    expect(data.persons).toEqual([]);
    expect(usBlock(String(data.text))).toEqual(["你是先把结论说清楚"]);
  });

  it("展示名形态：唯一命中才用；0 条与 ≥2 条都丢弃（不猜）", async () => {
    const unique = makeStore([{ personKey: PERSON_A, displayName: "何晨", aliases: ["小何"] }]);
    expect((await callCard("&participants=何晨", unique)).persons).toEqual([PERSON_A]);
    expect((await callCard("&participants=小何", unique)).persons).toEqual([PERSON_A]);

    const none = makeStore([{ personKey: PERSON_A, displayName: "何晨" }]);
    expect((await callCard("&participants=张三", none)).persons).toEqual([]);

    const ambiguous = makeStore([
      { personKey: PERSON_A, displayName: "何晨" },
      { personKey: PERSON_B, displayName: "何晨" },
    ]);
    expect((await callCard("&participants=何晨", ambiguous)).persons).toEqual([]);
  });

  it("只给 session 且该会话有 persons_json：回显该组 key，并按其过滤 human 段", async () => {
    // 会话里的 persons_json 也是 person_key，同样要过租户存在性校验（P2-B2）
    const store = makeStore(DEFAULT_PERSONS, [
      { sessionId: "s-other", persons: [PERSON_B] },
      { sessionId: "s1", persons: [PERSON_A] },
    ]);
    const data = await callCard("&session=s1", store);
    expect(data.persons).toEqual([PERSON_A]);
    expect(usBlock(String(data.text))).toEqual(["相处上，他偏好先灰度再全量", "相处上，他讨厌被替着做决定", "你是先把结论说清楚"]);
  });

  it("session 指向无 episode / persons_json 为空的会话：按「未知」处理，不过滤且不回显", async () => {
    const store = makeStore([], [
      { sessionId: "s-other", persons: [PERSON_B] },
      { sessionId: "s-empty", persons: [] },
    ]);
    const unknown = await callCard("&session=nope", store);
    expect("persons" in unknown).toBe(false);
    expect(unknown.text).toBe(GOLDEN_TEXT);

    const empty = await callCard("&session=s-empty", store);
    expect("persons" in empty).toBe(false);
    expect(empty.text).toBe(GOLDEN_TEXT);
  });
});
