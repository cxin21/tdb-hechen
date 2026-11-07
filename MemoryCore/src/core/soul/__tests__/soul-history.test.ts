import { describe, expect, it } from "vitest";
import type { SoulEpisode } from "../types.js";
import {
  contradictRepairClaims,
  factsFromEpisode,
  historyItemNeedsUpdate,
  historyToItems,
  reversals,
  settlePromises,
} from "../history.js";

function ep(over: Partial<SoulEpisode>): SoulEpisode {
  return {
    episodeId: "ep-1",
    at: "2026-11-05T09:00:00.000Z",
    day: "2026-11-05",
    kind: "correction",
    title: "",
    object: "被当面指出不对",
    participants: ["何晨"],
    userStance: "列表按钮状态处理不对",
    agentStance: "",
    cost: "",
    outcome: "",
    valence: -0.55,
    arousal: 0.5,
    intensity: 0.5,
    evidenceIds: ["r1"],
    sessionId: "s",
    quote: null,
    affectSource: "lexicon",
    signals: [],
    ...over,
  };
}

describe("事件 → 自我/关系史", () => {
  it("没有我的表态，不长自我", () => {
    expect(factsFromEpisode(ep({ agentStance: "" }))).toEqual([]);
  });

  it("被指出后我改了，记成复盘和修复，不是方法论", () => {
    const facts = factsFromEpisode(ep({
      agentStance: "我没守住间距，已按原话重做并对齐",
    }));
    // 失败是事实，后来改成也是事实——两件都记，不二选一。
    expect(facts.map((f) => f.kind).sort()).toEqual(["failure", "repair", "review"]);
    // 关系史写他的原话，不把主题词（被当面指出不对）当成「他指出的事」。
    const rel = facts.find((f) => f.layer === "relationship");
    expect(rel?.text).toContain("列表按钮状态处理不对");
    expect(rel?.text).not.toContain("被当面指出不对");
    expect(rel?.object).toBe("何晨");
    const review = facts.find((f) => f.kind === "review");
    expect(review?.text).toContain("列表按钮状态处理不对");
    expect(review?.text).toContain("后来改成");
    const failure = facts.find((f) => f.kind === "failure");
    expect(failure?.text).toContain("没守住");
  });

  it("关系史能长出冲突：他指出来，我只回了没做到、也没补——不是修复", () => {
    const facts = factsFromEpisode(ep({
      agentStance: "我漏了这一步，先不动等你确认",
      outcome: "",
    }));
    const conflict = facts.find((f) => f.kind === "conflict");
    expect(conflict?.layer).toBe("relationship");
    expect(conflict?.text).toContain("只回了");
    expect(facts.some((f) => f.kind === "repair")).toBe(false);
  });

  it("回复只剩代码块/空白时不写「只回了：」，也不凭空记一条冲突", () => {
    const facts = factsFromEpisode(ep({
      userStance: "按钮组看着还是不对，你好好划分一下吧",
      agentStance: "```dsh-ui\n{\"title\":\"x\"}\n```",
      outcome: "",
      valence: -0.5,
    }));
    expect(facts.filter((f) => f.layer === "relationship")).toHaveLength(0);
  });

  it("信任升降排在具体冲突之前：注入里先看见关系状态", () => {
    const trust = factsFromEpisode(ep({
      userStance: "你找的组件库是不是不靠谱啊",
      agentStance: "我核过了，组件确实在",
      outcome: "",
      valence: -0.5,
    })).find((f) => f.kind === "trust");
    const conflict = factsFromEpisode(ep({
      userStance: "这不对，你改的东西和报错不一样",
      agentStance: "我先查一下",
      outcome: "",
      valence: -0.5,
    })).find((f) => f.kind === "conflict");
    expect(trust).toBeTruthy();
    expect(conflict).toBeTruthy();
    const w = (k: string) => historyToItems([trust!, conflict!], "2026-11-06T00:00:00.000Z").find((i) => i.meta?.historyKind === k)?.weight ?? 0;
    expect(w("trust")).toBeGreaterThan(w("conflict"));
  });

  it("团队频道裁决不是何晨说的：关系行写 Lead，不把裁决按在他头上", () => {
    const facts = factsFromEpisode(ep({
      userStance: "裁决 PASS-WITH-CONCERNS（2 LOW+3 INFO），Lead 定夺：C1+C2 必修",
      agentStance: "C1+C2 必修已按裁决落地",
      outcome: "",
    }));
    const rel = facts.find((f) => f.layer === "relationship");
    expect(rel?.text.startsWith("Lead 指出")).toBe(true);
  });

  it("他指出来时我还没修好、也没认，也是冲突；说「你说的对」就不算", () => {
    const pending = factsFromEpisode(ep({
      agentStance: "先核查我改动过哪些内容，仍是同一个空指针",
      outcome: "仍是同一个空指针",
    }));
    expect(pending.some((f) => f.kind === "conflict")).toBe(true);
    const agreed = factsFromEpisode(ep({
      agentStance: "你说的对，是上游返回旧代码，我马上改",
      outcome: "",
    }));
    expect(agreed.some((f) => f.kind === "conflict")).toBe(false);
  });

  it("先没守住、后来改了，才有反悔；只有失败不编", () => {
    const fail = factsFromEpisode(ep({
      episodeId: "ep-a",
      at: "2026-11-05T08:00:00.000Z",
      userStance: "「间距」不对",
      agentStance: "我错了，按自己的理解做了",
      outcome: "",
    }));
    const fix = factsFromEpisode(ep({
      episodeId: "ep-b",
      at: "2026-11-05T10:00:00.000Z",
      userStance: "「间距」还是不对",
      agentStance: "我错了，已按原话重做并对齐",
    }));
    const rev = reversals([...fail, ...fix]);
    expect(rev).toHaveLength(1);
    expect(rev[0].kind).toBe("reversal");
    expect(rev[0].episodeIds).toEqual(["ep-a", "ep-b"]);
    // 注入里给人看的是「在什么事上反悔」，不是内部事件编号；编号留在 evidenceIds 供回查。
    expect(rev[0].text).toContain("间距");
    expect(rev[0].text).not.toContain("ep-a");
    expect(reversals(fail)).toEqual([]);
  });

  it("条目 id 由事件决定，重跑不变", () => {
    const facts = factsFromEpisode(ep({ agentStance: "我错了，已按 16px 对齐" }));
    const a = historyToItems(facts, "2026-11-06T00:00:00.000Z");
    const b = historyToItems(facts, "2026-11-06T01:00:00.000Z");
    expect(a.map((i) => i.itemId)).toEqual(b.map((i) => i.itemId));
    expect(a[0].evidenceOrigins).toEqual(["episode"]);
  });

  it("同一条事件换了文案，生成新条目，旧文案不再占用注入", () => {
    const facts = factsFromEpisode(ep({ agentStance: "我错了，已按 16px 对齐" }));
    const now = "2026-11-06T00:00:00.000Z";
    const oldItems = historyToItems(facts, now);
    const renamed = facts.map((f) => ({ ...f, text: f.text + "（改写）" }));
    const newItems = historyToItems(renamed, now);
    expect(newItems.map((i) => i.itemId)).not.toEqual(oldItems.map((i) => i.itemId));
  });

  it("复盘引用的是他纠正之后我那条回复，不是我上一轮无关的话", () => {
    const facts = factsFromEpisode(ep({
      userStance: "列表按钮状态处理不对，选中了为什么派发不可点",
      agentStance: "设置页的间距与缩进已按同一条 16px 轨道对齐",
      outcome: "我把四个问题的按钮状态都重排了，选中态和排序都能切换",
    }));
    const review = facts.find((f) => f.kind === "review");
    expect(review?.text).toContain("按钮状态都重排");
    expect(review?.text).not.toContain("设置页的间距");
  });

  it("交付体不当复盘：后来改成不能写成「任务…完成，交付如下」", () => {
    const facts = factsFromEpisode(ep({
      agentStance: "我漏了这一步，这就补上",
      outcome: "任务六三缺陷修复完成，交付如下：",
    }));
    const review = facts.find((f) => f.kind === "review");
    expect(review?.text).toContain("补上");
    expect(review?.text ?? "").not.toContain("交付如下");
  });

  it("两边都只有交付体时，复盘只写「后来补上了」，不搬验证链和提交号", () => {
    const facts = factsFromEpisode(ep({
      agentStance: "验证链闭环，问题已处理",
      outcome: "三处缺陷已修复交付（m02325）",
    }));
    const review = facts.find((f) => f.kind === "review");
    expect(review?.text).toContain("后来补上了");
    expect(review?.text ?? "").not.toContain("验证链");
    expect(review?.text ?? "").not.toContain("m02325");
  });

  it("他指出不对、我用改完的结果回应，也是修复，不必先说我错了", () => {
    const facts = factsFromEpisode(ep({
      userStance: "列表按钮状态处理不对",
      agentStance: "间距与缩进已按同一条 16px 轨道对齐",
      outcome: "四个问题都已改完",
    }));
    expect(facts.map((f) => f.kind).sort()).toEqual(["failure", "repair", "review"]);
  });

  it("他把方案权交出来，记成信任变化，不因为回复开头像汇报就丢掉", () => {
    const facts = factsFromEpisode(ep({
      userStance: "你自己找最优方案，先做测试然后再下结论",
      agentStance: "前置说明：我先取证，再给方案",
      valence: 0.2,
    }));
    expect(facts.map((f) => f.kind)).toContain("trust");
    expect(factsFromEpisode(ep({ userStance: "【任务】你自己会选一个方案", agentStance: "收到" })).map((f) => f.kind)).not.toContain("trust");
    expect(facts.find((f) => f.kind === "trust")?.layer).toBe("relationship");
  });

  it("他说不靠谱，记成信任下降；关系史里信任有方向", () => {
    const facts = factsFromEpisode(
      ep({
        kind: "complaint",
        userStance: "你找的组件库是不是不靠谱啊，没有这些组件么",
        agentStance: "我换了组件库并逐项比对",
      }),
    );
    const trust = facts.find((f) => f.kind === "trust");
    expect(trust).toBeTruthy();
    expect(trust?.direction).toBe("down");
    expect(trust?.text).toContain("不靠谱");
  });

  it("进度汇报不进关系史", () => {
    const facts = factsFromEpisode(ep({
      agentStance: "受理后整条链路已经完成",
    }));
    expect(facts).toEqual([]);
  });

  it("他说我错了、我回的是取证报告 → 不长失败，冲突写「顶了回去」", () => {
    const facts = factsFromEpisode(ep({
      userStance: "我怀疑接口有问题，你看看是不是你的接口写错了",
      agentStance: "真机截图核对完了：接口返回正常，是上游缓存了旧数据，两处都能收口",
      valence: -0.4,
    }));
    expect(facts.some((f) => f.kind === "failure")).toBe(false);
    expect(facts.some((f) => f.kind === "review")).toBe(false);
    const conflict = facts.find((f) => f.kind === "conflict");
    expect(conflict?.text).toContain("我当场顶了回去");
    expect(conflict?.text).not.toContain("还没修好");
  });

  it("派活/转发缺陷单不是关系冲突：不把交办写成「他指出、我顶了回去」", () => {
    const facts = factsFromEpisode(ep({
      userStance: "按 R1 出修复方案，调到 72h，在 #91 票内返工；出完方案后重新进行根因分析",
      agentStance: "按 SOP 出了一版方案，先给结论",
      outcome: "",
      valence: -0.3,
    }));
    expect(facts.some((f) => f.layer === "relationship")).toBe(false);
  });

  it("我只是照办去改、没认也没顶 → 冲突记中性，不写成顶了回去", () => {
    const facts = factsFromEpisode(ep({
      userStance: "这就是你设计的UI？怎么还有很多原始样式的地方",
      agentStance: "好，键 extras 会被透传，我把样式表补上",
      valence: -0.4,
    }));
    const conflict = facts.find((f) => f.kind === "conflict");
    expect(conflict?.text).toContain("我当时回的是");
    expect(conflict?.text).not.toContain("顶了回去");
    expect(conflict?.text).not.toContain("还没修好");
  });

  it("他只说「不对」、我只回「红线收到」→ 不算我失败", () => {
    const facts = factsFromEpisode(ep({
      userStance: "这不对吧，先把红线守住",
      agentStance: "红线收到，全程遵守",
      valence: -0.4,
    }));
    expect(facts.some((f) => f.kind === "failure")).toBe(false);
  });

  it("我说「我答应自己…」→ self/promise 事实，权重 0.72，进自我史", () => {
    const facts = factsFromEpisode(ep({
      userStance: "这版数据你验过吗",
      agentStance: "我先跑一遍。",
      // 承诺是我对他这条消息的回复（outcome），不是我上一轮的话。
      outcome: "我答应自己：以后交出去的每一格都要有实测数字。",
      valence: 0.2,
    }));
    const promise = facts.find((f) => f.kind === "promise");
    expect(promise?.layer).toBe("self");
    expect(promise?.text).toContain("我答应过自己");
    // 引导语去重：注入里不该出现「我答应过自己：「我答应自己：…」」
    expect(promise?.text).not.toContain("我答应过自己：「我答应自己");
    const items = historyToItems(facts, "2026-11-05T12:00:00.000Z");
    const item = items.find((i) => i.meta?.historyKind === "promise");
    expect(item?.weight).toBe(0.72);
  });

  it("上一轮的承诺不在下一轮重复长：promise 只认本轮回复", () => {
    const facts = factsFromEpisode(ep({
      userStance: "补贴那一项你又漏了两个人的报销",
      // 这句承诺属于上一轮事件，本轮只是它之前说过的话。
      agentStance: "我答应自己以后每次改导出都先用真实数据跑一遍再回你。",
      outcome: "我漏了，已经补上了，以后按名单逐条核对。",
      valence: -0.5,
    }));
    expect(facts.some((f) => f.kind === "promise")).toBe(false);
  });

  it("承诺后来同一对象补上了 → kept；又没守住 → broken；没后续 → open 且不写兑现后缀", () => {
    const said = ep({
      episodeId: "ep-p",
      at: "2026-11-05T08:00:00.000Z",
      outcome: "我答应自己：交出去的每一格都要有实测数字。",
      valence: 0.2,
    });
    const kept = ep({
      episodeId: "ep-k",
      at: "2026-11-05T10:00:00.000Z",
      agentStance: "我漏了，已经补上了。",
      outcome: "按名单逐条核对，补上了。",
    });
    const broken = ep({
      episodeId: "ep-b",
      at: "2026-11-05T11:00:00.000Z",
      agentStance: "我没守住，又漏了。",
      outcome: "我没守住，又漏了两个人。",
    });
    const openItems = historyToItems(settlePromises(factsFromEpisode(said), [said]), "2026-11-05T12:00:00.000Z");
    const open = openItems.find((i) => i.meta?.historyKind === "promise");
    expect(open?.meta?.fulfillment).toBeUndefined();

    const keptItems = historyToItems(settlePromises(factsFromEpisode(said), [said, kept]), "2026-11-05T12:00:00.000Z");
    const keptItem = keptItems.find((i) => i.meta?.historyKind === "promise");
    expect(keptItem?.meta?.fulfillment).toBe("kept");
    expect(keptItem?.itemId).toBe(open?.itemId);

    const brokenItems = historyToItems(settlePromises(factsFromEpisode(said), [said, broken]), "2026-11-05T12:00:00.000Z");
    const brokenItem = brokenItems.find((i) => i.meta?.historyKind === "promise");
    expect(brokenItem?.meta?.fulfillment).toBe("broken");
    expect(brokenItem?.itemId).toBe(open?.itemId);
  });

  it("「修好了」不算兑现：承诺核对只认情绪门那条修复口径", () => {
    const said = ep({
      episodeId: "ep-p2",
      at: "2026-11-05T08:00:00.000Z",
      outcome: "我答应自己：交出去的每一格都要有实测数字。",
      valence: 0.2,
    });
    const loose = ep({
      episodeId: "ep-loose",
      at: "2026-11-05T10:00:00.000Z",
      agentStance: "导出功能我已经修好了。",
      outcome: "导出功能我已经修好了。",
    });
    const items = historyToItems(settlePromises(factsFromEpisode(said), [said, loose]), "2026-11-05T12:00:00.000Z");
    expect(items.find((i) => i.meta?.historyKind === "promise")?.meta?.fulfillment).toBeUndefined();
  });

  it("修复行引的是他纠正之后我那条回复，不是他开口前那句（常是后来被推翻的假声明）", () => {
    const facts = factsFromEpisode(ep({
      userStance: "导出还是不对，我一直不敢用",
      agentStance: "导出我已经修好了，你试一下。",
      outcome: "这次重做了导出，补上了空行校验。",
      valence: -0.55,
    }));
    const repair = facts.find((f) => f.kind === "repair");
    expect(repair?.text).toContain("补上了空行校验");
    expect(repair?.text).not.toContain("导出我已经修好了");
  });

  it("trust 的 up/down 进 meta；没有方向就不写 direction 键（缺失=未采集）", () => {
    const items = historyToItems([
      { kind: "trust", layer: "relationship", text: "他开始不太放心。", object: "何晨", episodeIds: ["ep-x"], at: "2026-11-05T09:00:00.000Z", direction: "down" },
      { kind: "trust", layer: "relationship", text: "他把方案权交出来。", object: "何晨", episodeIds: ["ep-y"], at: "2026-11-05T10:00:00.000Z" },
    ], "2026-11-05T12:00:00.000Z");
    expect(items[0]?.meta?.direction).toBe("down");
    expect(items[1]?.meta && "direction" in items[1]!.meta).toBe(false);
  });

  it("代理信封 <acp …>m00777</acp> 不能进人格行冒充我说的话", () => {
    const facts = factsFromEpisode(ep({
      userStance: "提案采纳之后怎么还能超过数量显示呢",
      agentStance: "这个问题我先查一下",
      outcome: '<acp tokens="611" type="text">m00777</acp> 依赖边实证：这一轮没有删除任何一行',
      valence: -0.3,
    }));
    for (const f of facts) {
      expect(f.text).not.toContain("<acp");
      expect(f.text).not.toContain("m00777");
    }
  });
});

describe("矛盾：后来的失败证伪「我补上了」", () => {
  const laterEp = (over: Partial<SoulEpisode>) =>
    ep({
      episodeId: "ep-late",
      at: "2026-11-06T09:00:00.000Z",
      day: "2026-11-06",
      agentStance: "这个问题我先看一下",
      ...over,
    });
  const repairItems = () =>
    historyToItems(
      factsFromEpisode(ep({ agentStance: "我没守住间距，已按原话重做并对齐" })),
      "2026-11-05T12:00:00.000Z",
    ).filter((i) => i.meta?.historyKind === "repair" || i.meta?.historyKind === "review");

  it("同对象更晚的未修复失败 → 自我层每条修复主张记一次矛盾；关系层不拿人当主题锚", () => {
    const selfItems = repairItems().filter((i) => i.layer === "self");
    const relItems = repairItems().filter((i) => i.layer === "relationship");
    expect(selfItems.length).toBeGreaterThan(0);
    expect(relItems.length).toBeGreaterThan(0);
    const hits = contradictRepairClaims([...selfItems, ...relItems], [ep({}), laterEp({})]);
    expect(hits.map((h) => h.itemId).sort()).toEqual(selfItems.map((i) => i.itemId).sort());
    expect(hits[0].episodeId).toBe("ep-late");
  });

  it("最新一条仍是修复 → 主张成立，不记矛盾", () => {
    const items = repairItems();
    expect(contradictRepairClaims(items, [laterEp({ agentStance: "已按原话重做，问题收口" })])).toEqual([]);
  });

  it("同一天内的反复不算第二次矛盾（证据独立性按自然日计）", () => {
    const items = repairItems();
    expect(contradictRepairClaims(items, [laterEp({ at: "2026-11-05T10:00:00.000Z", day: "2026-11-05" })])).toEqual([]);
  });

  it("同一集事件只记一条：lastContradictionEpisode 已记过就不再 +1", () => {
    const items = repairItems().map((i) => ({ ...i, meta: { ...(i.meta ?? {}), lastContradictionEpisode: "ep-late" } }));
    expect(contradictRepairClaims(items, [laterEp({})])).toEqual([]);
  });

  it("对象抽不出来（这件事）或不是修复主张 → 宁可判不到，也不拿泛指当锚", () => {
    const items = repairItems().map((i) => ({ ...i, meta: { ...(i.meta ?? {}), object: "这件事" } }));
    expect(contradictRepairClaims(items, [laterEp({})])).toEqual([]);
    const failures = historyToItems(
      factsFromEpisode(ep({ agentStance: "我没守住间距，已按原话重做并对齐" })),
      "2026-11-05T12:00:00.000Z",
    ).filter((i) => i.meta?.historyKind === "failure");
    expect(failures.length).toBeGreaterThan(0);
    expect(contradictRepairClaims(failures, [laterEp({})])).toEqual([]);
  });
});

describe("对象锚要能补到老条目上", () => {
  const next = historyToItems(
    factsFromEpisode(ep({ agentStance: "我没守住间距，已按原话重做并对齐" })),
    "2026-11-06T00:00:00.000Z",
  ).find((i) => i.meta?.historyKind === "repair");

  it("老条目没有 meta.object → 需要重写，否则矛盾判据永远看不到锚", () => {
    const legacy = { ...next!, meta: { ...(next!.meta ?? {}), object: undefined } };
    expect(historyItemNeedsUpdate(legacy, next!)).toBe(true);
  });

  it("已经锚好的条目不被重复重写", () => {
    expect(historyItemNeedsUpdate(next!, next!)).toBe(false);
  });

  it("新一轮没有锚时不重写，不能用无锚快照覆盖已锚定的条目", () => {
    const anchored = next!;
    const fresh = { ...next!, meta: { ...(next!.meta ?? {}), object: undefined } };
    expect(historyItemNeedsUpdate(anchored, fresh)).toBe(false);
  });
});

