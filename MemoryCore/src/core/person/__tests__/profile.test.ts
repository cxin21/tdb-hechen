/**
 * P2-H §9 测试 1/2/6 —— 人物档案提炼的确定性半边（提示词、解析、校验）。
 *
 * 这里不碰模型：断言的是「模型说什么会进库、说什么一定被丢」，
 * 因为这些判据必须是可复算的，而不是靠提示词里的一句「请不要编」。
 */
import { describe, expect, it } from "vitest";

import {
  PERSON_PROFILE_FIELD_ORDER,
  PROFILE_GUARD_LINE,
  PROFILE_ITEM_PREFIX,
  PROFILE_OBJ_NAME_MAX,
  PROFILE_RECENT_PER_PERSON,
  PROFILE_SYSTEM_PROMPT,
  PROFILE_TEXT_MAX,
  buildPersonProfilePrompt,
  countDropReasons,
  formatProfileText,
  normalizeRelationPred,
  isProfileFieldStale,
  parsePersonProfileOutput,
  profileItemId,
  profileSupersedingItemId,
  relationIdOf,
  stripProfileLabel,
  validatePersonProfileOutput,
  type ProfileMemoryInput,
} from "../profile.js";

const ME = "p_me";
const BOSS = "p_boss";

function mem(recordId: string, content: string, speakerIsSelf = true, at = "2026-11-01T00:00:00.000Z"): ProfileMemoryInput {
  return { recordId, at, content, speakerIsSelf, role: speakerIsSelf ? "speaker" : "subject" };
}

describe("§9-9 引文只认原话：摘要里有的句子不算逐字证据", () => {
  // 生产实测：L1 摘要把「不用我再催一次」改写成「不必他催」，模型引摘要也算「逐字通过」，
  // 等于让改写后的文本给自己作证。有原话时必须只对原话校验。
  const withOriginal: ProfileMemoryInput = {
    ...mem("r1", "用户要求按清单逐项勾选后再发确认"),
    originalText: "你把清单逐项勾一下，勾完再发我确认，别口头对一下就算完",
  };

  it("引摘要（原话里没有）→ quote_not_verbatim", () => {
    const res = validatePersonProfileOutput({
      personKey: ME,
      memories: [withOriginal],
      relations: [],
      fields: [
        {
          field: "handle",
          text: "要求按清单逐项勾选后再发确认",
          recordId: "r1",
          quote: "按清单逐项勾选后再发确认",
          op: "add",
        },
      ],
    });
    expect(res.fields).toHaveLength(0);
    expect(countDropReasons(res.dropped)).toMatchObject({ quote_not_verbatim: 1 });
  });

  it("引原话（摘要里没有）→ 收下", () => {
    const res = validatePersonProfileOutput({
      personKey: ME,
      memories: [withOriginal],
      relations: [],
      fields: [
        {
          field: "handle",
          text: "要求按清单逐项勾选后再发确认",
          recordId: "r1",
          quote: "勾完再发我确认",
          op: "add",
        },
      ],
    });
    expect(res.fields).toHaveLength(1);
    expect(res.dropped.filter((d) => d.reason === "quote_not_verbatim")).toHaveLength(0);
  });

  it("原话未采集（旧库/原话已删）→ 退回摘要口径，不整条拒收", () => {
    const res = validatePersonProfileOutput({
      personKey: ME,
      memories: [mem("r2", "用户要求按清单逐项勾选后再发确认")],
      relations: [],
      fields: [
        {
          field: "handle",
          text: "要求按清单逐项勾选后再发确认",
          recordId: "r2",
          quote: "按清单逐项勾选后再发确认",
          op: "add",
        },
      ],
    });
    expect(res.fields).toHaveLength(1);
  });

  it("提示词把摘要与原话分列，且没有原话时显式写「原话未采集」", () => {
    const prompt = buildPersonProfilePrompt({
      personKey: ME,
      displayName: "何晨",
      now: "2026-11-09T10:00:00.000Z",
      memories: [withOriginal, mem("r3", "只有摘要的一条")],
    });
    expect(prompt).toContain("## 记忆（recordId | 时间 | 谁说的 | 角色 | 摘要 | 原话）");
    expect(prompt).toContain("勾完再发我确认");
    expect(prompt).toContain("（原话未采集）");
    // 规则里必须明确禁止拿摘要当 quote，否则模型没有别的依据。
    expect(PROFILE_SYSTEM_PROMPT).toContain("「摘要」列是系统已改写过的，不能拿来当 quote");
  });
});

describe("§9-1 提示词只装原始素材，不装卡的产出", () => {
  const memories = Array.from({ length: PROFILE_RECENT_PER_PERSON }, (_, i) =>
    mem(`rec-${String(i).padStart(2, "0")}`, `第 ${i} 条：我在弄发布流程`),
  );

  it("40 条记忆的 recordId 全在提示词里（截断的是正文，不是条数）", () => {
    const prompt = buildPersonProfilePrompt({
      personKey: ME,
      displayName: "何晨",
      aliases: ["hechen"],
      now: "2026-11-08T06:00:00.000Z",
      memories,
    });
    for (const m of memories) expect(prompt).toContain(m.recordId);
    expect(prompt).toContain("何晨");
    expect(prompt).toContain("hechen");
  });

  it("不含人格卡文本、不含第一人称自述口吻", () => {
    const prompt = buildPersonProfilePrompt({
      personKey: ME,
      displayName: "何晨",
      now: "2026-11-08T06:00:00.000Z",
      memories,
    });
    // 卡的开场句/轴名不能进提示词：档案从对话长，不从卡回流（否则自我发酵）。
    expect(prompt).not.toContain("读法");
    expect(prompt).not.toContain("关于你");
    expect(prompt).not.toContain("我是小满");
    // 系统提示词里明写两条：不记「我自己」的人设、第三方转述不进档案。
    expect(PROFILE_SYSTEM_PROMPT).toContain("不要记「我自己」");
    expect(PROFILE_SYSTEM_PROMPT).toContain("第三方转述不进档案");
  });

  it("结尾防护句在用户提示词末尾", () => {
    const prompt = buildPersonProfilePrompt({
      personKey: ME,
      displayName: "何晨",
      now: "2026-11-08T06:00:00.000Z",
      memories,
    });
    expect(prompt.trimEnd().endsWith(PROFILE_GUARD_LINE.trimEnd())).toBe(true);
  });
});

describe("§9-2 确定性校验：四种伪造一律丢，且按原因计数", () => {
  const memories = [
    mem("r1", "我把发布流程改成了先灰度再全量"),
    mem("r2", "阿满说他不喜欢加班", false),
  ];
  const base = {
    personKey: ME,
    memories,
    knownPersons: [{ key: BOSS, displayName: "老板" }],
  };

  it("quote 不是原文 → quote_not_verbatim", () => {
    const res = validatePersonProfileOutput({
      ...base,
      relations: [],
      fields: [{ field: "style", text: "爱加班", recordId: "r1", quote: "我特别喜欢加班", op: "add" }],
    });
    expect(res.fields).toHaveLength(0);
    expect(countDropReasons(res.dropped)).toMatchObject({ quote_not_verbatim: 1 });
  });

  it("引用别人说的话（speakerIsSelf=false）→ not_speaker_self（A2）", () => {
    const res = validatePersonProfileOutput({
      ...base,
      relations: [],
      fields: [{ field: "dislikes", text: "不喜欢加班", recordId: "r2", quote: "阿满说他不喜欢加班", op: "add" }],
    });
    expect(res.fields).toHaveLength(0);
    expect(countDropReasons(res.dropped)).toMatchObject({ not_speaker_self: 1 });
  });

  it("recordId 不在本批记忆里 → record_not_in_batch", () => {
    const res = validatePersonProfileOutput({
      ...base,
      relations: [],
      fields: [{ field: "role", text: "负责发布", recordId: "r-from-elsewhere", quote: "负责发布", op: "add" }],
    });
    expect(countDropReasons(res.dropped)).toMatchObject({ record_not_in_batch: 1 });
  });

  it("正文超 40 字 → text_too_long（按码点算，不按 UTF-16）", () => {
    const long = "很".repeat(PROFILE_TEXT_MAX + 1);
    const res = validatePersonProfileOutput({
      ...base,
      relations: [],
      fields: [{ field: "style", text: long, recordId: "r1", quote: "灰度", op: "add" }],
    });
    expect(res.fields).toHaveLength(0);
    expect(countDropReasons(res.dropped)).toMatchObject({ text_too_long: 1 });
  });

  it("字段名不在 9 枚举里 → field_not_enum；一条合法一条非法时只留合法那条", () => {
    const res = validatePersonProfileOutput({
      ...base,
      relations: [],
      fields: [
        { field: "mbti", text: "INTJ", recordId: "r1", quote: "灰度", op: "add" },
        { field: "role", text: "负责发布流程", recordId: "r1", quote: "发布流程", op: "add" },
      ],
    });
    expect(res.fields.map((f) => f.field)).toEqual(["role"]);
    expect(countDropReasons(res.dropped)).toMatchObject({ field_not_enum: 1 });
  });

  it("空白归一后能对上原文也算逐字（换行/多空格不算伪造）", () => {
    const res = validatePersonProfileOutput({
      ...base,
      relations: [],
      fields: [{ field: "focus", text: "灰度发布", recordId: "r1", quote: "  灰度再全量 ", op: "add" }],
    });
    expect(res.fields).toHaveLength(1);
  });
});

describe("§9-6 关系边：自环丢、未知 obj 只留名字、反向边合并", () => {
  const memories = [mem("r1", "老板是我的上级，我向他汇报发布进度")];
  const known = [{ key: BOSS, displayName: "老板" }];

  it("obj 指向自己 → self_loop", () => {
    const res = validatePersonProfileOutput({
      personKey: ME,
      memories,
      knownPersons: known,
      fields: [],
      relations: [{ pred: "同事", obj: { key: ME }, recordId: "r1", quote: "上级", op: "add" }],
    });
    expect(res.relations).toHaveLength(0);
    expect(countDropReasons(res.dropped)).toMatchObject({ self_loop: 1 });
  });

  it("obj.key 不在 knownPersons → obj_unresolved（不许凭 key 想象一个人）", () => {
    const res = validatePersonProfileOutput({
      personKey: ME,
      memories,
      knownPersons: known,
      fields: [],
      relations: [{ pred: "上级", obj: { key: "p_ghost" }, recordId: "r1", quote: "上级", op: "add" }],
    });
    expect(countDropReasons(res.dropped)).toMatchObject({ obj_unresolved: 1 });
  });

  it("只给 objName 且 ≤20 字 → 收下，obj_key 为空（可读回）", () => {
    const res = validatePersonProfileOutput({
      personKey: ME,
      memories,
      knownPersons: known,
      fields: [],
      relations: [{ pred: "上级", objName: "某个没见过的人", recordId: "r1", quote: "上级", op: "add" }],
    });
    expect(res.relations).toHaveLength(1);
    expect(res.relations[0]).toMatchObject({ pred: "上级", objKey: null, objName: "某个没见过的人" });
  });

  it("objName 超 20 字 → obj_name_too_long", () => {
    const res = validatePersonProfileOutput({
      personKey: ME,
      memories,
      knownPersons: known,
      fields: [],
      relations: [{ pred: "上级", objName: "名".repeat(PROFILE_OBJ_NAME_MAX + 1), recordId: "r1", quote: "上级", op: "add" }],
    });
    expect(countDropReasons(res.dropped)).toMatchObject({ obj_name_too_long: 1 });
  });

  it("库里已有反向下属边 → 不插新边，回 mergeRelId（A5）", () => {
    const res = validatePersonProfileOutput({
      personKey: ME,
      memories,
      knownPersons: known,
      fields: [],
      // 谓词开放后，反向合并靠模型自己给的逆词：这条边说「何晨的上级是老板」，逆词「下属」。
      relations: [{ pred: "上级", inverse: "下属", obj: { key: BOSS }, recordId: "r1", quote: "上级", op: "add" }],
      existingRelations: [
        {
          relId: "rel-existing",
          subjKey: BOSS,
          pred: "下属",
          inversePred: "上级",
          objKey: ME,
          objName: null,
          direction: "out",
          quote: "汇报",
        },
      ],
    });
    expect(res.relations).toHaveLength(1);
    expect(res.relations[0]!.mergeRelId).toBe("rel-existing");
  });

  it("对称谓词反向出现 → 同一条边（同事 ↔ 同事）", () => {
    const res = validatePersonProfileOutput({
      personKey: ME,
      memories,
      knownPersons: known,
      fields: [],
      // 对称关系由模型声明 direction=mutual（不再有「哪些词是对称的」这张表）。
      relations: [
        { pred: "同事", direction: "mutual", obj: { key: BOSS }, recordId: "r1", quote: "上级", op: "add" },
      ],
      existingRelations: [
        { relId: "rel-c", subjKey: BOSS, pred: "同事", objKey: ME, objName: null, direction: "mutual", quote: "同事" },
      ],
    });
    expect(res.relations[0]!.mergeRelId).toBe("rel-c");
    expect(res.relations[0]!.direction).toBe("mutual");
  });
});

describe("写库形状与 TTL（§5.1 / §7 / A3）", () => {
  it("itemId 稳定且带 human:pp- 前缀：同人同字段两次算出来一样", () => {
    const a = profileItemId(ME, "role");
    expect(a.startsWith(PROFILE_ITEM_PREFIX)).toBe(true);
    expect(profileItemId(ME, "role")).toBe(a);
    expect(profileItemId(ME, "style")).not.toBe(a);
    expect(profileItemId(BOSS, "role")).not.toBe(a);
  });

  it("outdated 路径的新 itemId 带正文指纹，与本字段稳定 id 不同", () => {
    const stable = profileItemId(ME, "role");
    const fresh = profileSupersedingItemId(ME, "role", "负责发布");
    expect(fresh).not.toBe(stable);
    expect(fresh.startsWith(`${stable}-`)).toBe(true);
  });

  it("text 强制「标签：正文」，重复前缀不会叠加", () => {
    expect(formatProfileText("role", "负责发布")).toBe("身份：负责发布");
    expect(formatProfileText("role", "身份：负责发布")).toBe("身份：负责发布");
    expect(stripProfileLabel("role", "身份：负责发布")).toBe("负责发布");
  });

  it("9 个字段的顺序固定（提示词/读面/卡同源）", () => {
    expect(PERSON_PROFILE_FIELD_ORDER).toEqual([
      "alias",
      "role",
      "style",
      "likes",
      "dislikes",
      "focus",
      "story",
      "promise",
      "handle",
    ]);
  });

  it("focus 7 天过期、role 永久（§7）", () => {
    expect(isProfileFieldStale({ field: "focus", evidenceAt: "2026-10-01T00:00:00.000Z", nowIso: "2026-11-08T00:00:00.000Z" })).toBe(true);
    expect(isProfileFieldStale({ field: "role", evidenceAt: "2000-01-01T00:00:00.000Z", nowIso: "2026-11-08T00:00:00.000Z" })).toBe(false);
    // 90 天档：刚过 90 天算过期，89 天不算。
    expect(isProfileFieldStale({ field: "style", evidenceAt: "2026-08-09T00:00:00.000Z", nowIso: "2026-11-08T00:00:00.000Z" })).toBe(true);
    expect(isProfileFieldStale({ field: "style", evidenceAt: "2026-08-11T00:00:00.000Z", nowIso: "2026-11-08T00:00:00.000Z" })).toBe(false);
  });

  it("rel_id 带 valid_from：同一对边换个起始时间就是另一条（A4）", () => {
    const one = relationIdOf({ tenantKey: "t|u|a", subjKey: ME, pred: "上级", obj: BOSS, validFrom: "2026-11-01T00:00:00.000Z" });
    const two = relationIdOf({ tenantKey: "t|u|a", subjKey: ME, pred: "上级", obj: BOSS, validFrom: "2026-11-02T00:00:00.000Z" });
    expect(one.startsWith("rel-")).toBe(true);
    expect(one).toHaveLength(20);
    expect(one).not.toBe(two);
  });

  it("谓词是开放集合：示例词之外照收，只卡长度与空串", () => {
    // 这些词不在任何固定表里，但都是真实关系，必须收。
    for (const word of ["导师", "合伙人", "债主", "前同事", "竞争对手", "房东"]) {
      expect(normalizeRelationPred(word)).toBe(word);
    }
    // 包裹的引号/括号去掉后仍算合法。
    expect(normalizeRelationPred("「导师」")).toBe("导师");
    expect(normalizeRelationPred("  (客户)  ")).toBe("客户");
    // 空串、纯标点、超长一律 null（调用方记 pred_invalid 并丢这条边）。
    expect(normalizeRelationPred("")).toBeNull();
    expect(normalizeRelationPred("   ")).toBeNull();
    expect(normalizeRelationPred("「」")).toBeNull();
    expect(normalizeRelationPred("一二三四五六七八九")).toBeNull();
    expect(normalizeRelationPred(42)).toBeNull();
    // 8 字正好在界内。
    expect(normalizeRelationPred("一二三四五六七八")).toBe("一二三四五六七八");
  });
});

describe("解析：模型输出必须能被机器读，读不懂就整段丢", () => {
  it("接受裸 JSON 与 ```json 围栏两种形态", () => {
    const payload = JSON.stringify({ fields: [], relations: [] });
    expect(parsePersonProfileOutput(payload)).toMatchObject({ fields: [], relations: [] });
    expect(parsePersonProfileOutput("```json\n" + payload + "\n```")).toMatchObject({ fields: [], relations: [] });
  });

  it("非 JSON / 形状不对 → 抛错（由调用方记 parse 失败，不写水位）", () => {
    expect(() => parsePersonProfileOutput("我不是 JSON")).toThrow();
    expect(() => parsePersonProfileOutput(JSON.stringify({ fields: "oops" }))).toThrow();
  });
});

describe("§9-7 主语判据：本人说过 ≠ 这是他的档案（生产实例回归）", () => {
  // 2026-11-08 生产实测写出过这两条（本人确实说过，所以五道旧门全绿）：
  //   近况：生产档案链路有缺陷，human 行仍为0
  //   称呼：也叫 hechen，账号名即 hechen
  const memories = [
    mem("r-bug", "生产档案链路有缺陷，human 行仍为0", true),
    mem("r-name", "我叫 hechen，账号名即 hechen", true),
    mem("r-fix", "我在排查生产链路的缺陷，先把守卫前置", true),
    mem("r-key", "我的 token 又过期了，得重新配一下", true),
  ];
  const base = { personKey: ME, memories, knownPersons: [] as Array<{ key: string; displayName: string }> };

  it("系统状态句（主语是系统）→ system_state，不写进近况/身份", () => {
    const res = validatePersonProfileOutput({
      ...base,
      relations: [],
      fields: [
        { field: "focus", text: "生产档案链路有缺陷，human 行仍为0", recordId: "r-bug", quote: "生产档案链路有缺陷，human 行仍为0", op: "add" },
        { field: "role", text: "生产链路的缺陷还没修好", recordId: "r-bug", quote: "human 行仍为0", op: "add" },
      ],
    });
    expect(res.fields).toHaveLength(0);
    expect(countDropReasons(res.dropped).system_state).toBe(2);
  });

  it("有他作主语时，工程词不算违规（「他在排查链路缺陷」要留下）", () => {
    const res = validatePersonProfileOutput({
      ...base,
      relations: [],
      fields: [
        { field: "focus", text: "他在排查生产链路缺陷", recordId: "r-fix", quote: "我在排查生产链路的缺陷", op: "add" },
      ],
    });
    expect(res.fields).toHaveLength(1);
    expect(res.fields[0]!.field).toBe("focus");
  });

  it("账号标识当称呼 → identifier_not_profile", () => {
    const res = validatePersonProfileOutput({
      ...base,
      relations: [],
      fields: [
        { field: "alias", text: "也叫 hechen，账号名即 hechen", recordId: "r-name", quote: "账号名即 hechen", op: "add" },
      ],
    });
    expect(res.fields).toHaveLength(0);
    expect(countDropReasons(res.dropped).identifier_not_profile).toBe(1);
  });

  it("凭据词一律不进档案 → sensitive（任何字段）", () => {
    const res = validatePersonProfileOutput({
      ...base,
      relations: [],
      fields: [
        { field: "story", text: "他的 token 过期了", recordId: "r-key", quote: "我的 token 又过期了", op: "add" },
      ],
    });
    expect(res.fields).toHaveLength(0);
    expect(countDropReasons(res.dropped).sensitive).toBe(1);
  });

  it("提示词里带了主语判据与两条真实反例", () => {
    expect(PROFILE_SYSTEM_PROMPT).toContain("主语判据");
    expect(PROFILE_SYSTEM_PROMPT).toContain("主语是系统，不是他");
    expect(PROFILE_SYSTEM_PROMPT).toContain("账号标识，不是称呼");
  });
});

describe("§9-8 主语判据不误杀：身份是名词短语，工程名词照常收", () => {
  const memories = [
    mem("r-role", "我拍板要不要做身份回填，档案链路的事都我来定", true),
    mem("r-call", "同事都叫我老何，也叫何晨", true),
  ];
  const base = { personKey: ME, memories, knownPersons: [] as Array<{ key: string; displayName: string }> };

  it("身份写成「生产链路的拍板决策人」要留下（名词短语，没有状态谓词）", () => {
    const res = validatePersonProfileOutput({
      ...base,
      relations: [],
      fields: [
        { field: "role", text: "生产人物档案链路的拍板决策人", recordId: "r-role", quote: "档案链路的事都我来定", op: "add" },
      ],
    });
    expect(res.fields).toHaveLength(1);
  });

  it("真称呼（同事叫他老何）要留下，不因含中文名被当成标识", () => {
    const res = validatePersonProfileOutput({
      ...base,
      relations: [],
      fields: [
        { field: "alias", text: "也叫何晨，同事叫他老何", recordId: "r-call", quote: "同事都叫我老何", op: "add" },
      ],
    });
    expect(res.fields).toHaveLength(1);
  });
});
