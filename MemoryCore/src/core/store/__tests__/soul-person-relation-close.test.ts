/**
 * P2 S13d：结束的关系必须落 valid_to（且 status=ended / tense=past），
 * 默认列表读不到，includeClosed 能读到「曾经」，卡上不再出现。
 *
 * 规格依据：docs/specs/2026-11-10-soul-event-model-full-optimization.md §4.4（失效三件事一起写）；
 * 全测计划 S13d「前合作方三月份就散了，没有合作关系」→ 不产现行边（或产 valid_to 已结束）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { VectorStore } from "../sqlite.js";
import { buildStructuredRelationshipLines } from "../../soul/card-service.js";

const TENANT = { teamId: "t1", userId: "u1", agentId: "a1" };
const HE = "p_he";
const EX = "p_ex_partner";

function tmpDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "soul-relation-close-")), "vectors.db");
}

function makeStore(dbPath: string): VectorStore {
  const store = new VectorStore(dbPath, 0);
  const res = store.init();
  if (store.isDegraded()) throw new Error("临时库初始化降级（环境问题）：" + res.reason);
  return store;
}

describe("S13d：关系失效写 valid_to 且退出卡", () => {
  it("close → valid_to/status/tense 三件事一起落库，默认列表为空，includeClosed 读得到，卡不渲染", () => {
    const store = makeStore(tmpDb());
    store.upsertSoulPerson(TENANT, { personKey: HE, displayName: "何晨" });
    store.upsertSoulPerson(TENANT, { personKey: EX, displayName: "前合作方" });

    store.commitSoulPersonRelations(TENANT, {
      insert: [
        {
          relId: "r-ex",
          subjKey: HE,
          pred: "合作方",
          inversePred: null,
          objKey: EX,
          objName: null,
          direction: "out",
          quote: "三月份还在一起做项目",
          recordId: "l1-1",
          evidence: [],
          validFrom: "2026-03-01T00:00:00.000Z",
          validTo: null,
          createdAt: "2026-03-01T00:00:00.000Z",
          updatedAt: "2026-03-01T00:00:00.000Z",
        },
      ],
    });

    const res = store.commitSoulPersonRelations(TENANT, {
      close: [{ relId: "r-ex", at: "2026-11-05T00:00:00.000Z" }],
    });
    expect(res.closed).toBe(1);

    // 默认读面：现行关系集合里没有它。
    expect(store.listSoulPersonRelations(TENANT, { subjKey: HE })).toHaveLength(0);

    // includeClosed：行还在、valid_to 有值、语义列同步改成 ended/past。
    const all = store.listSoulPersonRelations(TENANT, { subjKey: HE, includeClosed: true });
    expect(all).toHaveLength(1);
    expect(all[0]!.validTo).toBe("2026-11-05T00:00:00.000Z");
    expect(all[0]!.status).toBe("ended");
    expect(all[0]!.tense).toBe("past");

    // 卡：即便把这条（已结束的）边喂进去，也不出一行。
    const card = buildStructuredRelationshipLines({
      relations: all,
      personNames: new Map([[EX, "前合作方"]]),
      persons: [HE],
    });
    expect(card.lines).toEqual([]);

    // 再关一次不重复计数（幂等：只关 valid_to IS NULL 的行）。
    expect(store.commitSoulPersonRelations(TENANT, { close: [{ relId: "r-ex", at: "2026-11-06T00:00:00.000Z" }] }).closed).toBe(0);
  });
});
