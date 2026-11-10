import { describe, expect, it } from "vitest";
import { EPISODE_ROLE_PARTICIPANTS, personsForEpisode } from "../episode.js";
import { resolvePerson } from "../../person/resolve.js";
import type { IMemoryStore } from "../../store/types.js";

/**
 * P2-E：事件挂人的纯函数部分。
 *
 * 边界只有三条，但每条都会直接变成 soul_person 里的一行，错了就是脏人：
 *   1) 角色词不是人（user/assistant/system/助手/用户/系统）——不剔除就会给「助手」建人；
 *   2) 空串/空白不是人；
 *   3) 展示名原样保留、去重保序（后面要拿它去 resolvePerson 做唯一命中）。
 * 解析（名字 → person_key）不在这里做：纯函数不碰 store，由 worker 在落库前完成。
 */

const TENANT = { teamId: "t1", userId: "u1", agentId: "a1" };

/** 只带 resolvePerson 需要的两个方法：名字唯一命中 → 复用既有 personKey。 */
function storeWith(persons: Array<{ personKey: string; displayName: string; aliases?: string[] }>) {
  return {
    listSoulPersons: async () => persons,
  } as unknown as IMemoryStore;
}

describe("personsForEpisode 剔除", () => {
  it("角色词与空串全部剔除（英文大小写不敏感）", () => {
    const { names } = personsForEpisode([
      "assistant",
      "user",
      "system",
      "Assistant",
      "USER",
      "助手",
      "用户",
      "系统",
      "",
      "   ",
      "何晨",
    ]);
    expect(names).toEqual(["何晨"]);
    expect(EPISODE_ROLE_PARTICIPANTS).toContain("assistant");
  });

  it("undefined / 空数组 → 空名单（不是异常）", () => {
    expect(personsForEpisode(undefined).names).toEqual([]);
    expect(personsForEpisode([]).names).toEqual([]);
  });

  it("去重保序，保留原始大小写与空白外沿的裁剪结果", () => {
    expect(personsForEpisode(["何晨", " 何晨 ", "何晨", "小何", ""]).names).toEqual(["何晨", "小何"]);
    expect(personsForEpisode(["Alice", "alice"]).names).toEqual(["Alice"]);
  });
});

describe("personsForEpisode → speaker（平台身份）", () => {
  it("userId 非空 → 同时给出 platformId，名字仍按角色词剔除", () => {
    expect(personsForEpisode(["何晨", "assistant"], { userId: " usr-2m7b1144d9 " })).toEqual({
      names: ["何晨"],
      platformId: "usr-2m7b1144d9",
    });
  });

  it("userId 缺失/空白 → 不设 platformId（调用侧走展示名回退）", () => {
    expect(personsForEpisode(["何晨"], {})).toEqual({ names: ["何晨"] });
    expect(personsForEpisode(["何晨"], { userId: "   " })).toEqual({ names: ["何晨"] });
    expect(personsForEpisode(["何晨"])).toEqual({ names: ["何晨"] });
  });

  it("只有 agentId 不算人身份：agent 是另一方，不是这条事件的说话人", () => {
    expect(personsForEpisode(["何晨"], { agentId: "agt-bbr29z58s2" })).toEqual({ names: ["何晨"] });
  });

  it("platformId 精确命中 → 复用既有 person_key（名字只作补绑线索，不决定归属）", async () => {
    const store = {
      getSoulPersonByPlatform: async () => ({ personKey: "p_platform_hit", displayName: "何晨" }),
      listSoulPersons: async () => [{ personKey: "p_name_a", displayName: "何晨", aliases: [] }],
    } as unknown as IMemoryStore;
    const hinted = personsForEpisode(["何晨", "assistant"], { userId: "usr-1" });
    const person = await resolvePerson(store, TENANT, {
      platform: "tdai",
      platformId: hinted.platformId,
      displayName: "何晨",
    });
    expect(person.personKey).toBe("p_platform_hit");
  });
});

describe("personsForEpisode → resolvePerson 解析", () => {
  it("展示名唯一命中 → 复用既有 person_key（不新建人）", async () => {
    const store = storeWith([{ personKey: "p_name_a", displayName: "何晨", aliases: ["小何"] }]);
    const { names } = personsForEpisode(["何晨", "assistant"]);
    const resolved = await Promise.all(names.map((name) => resolvePerson(store, TENANT, { displayName: name })));
    expect(resolved.map((p) => p.personKey)).toEqual(["p_name_a"]);
  });

  it("别名也能命中同一个人（账户 vs 微信名的常态）", async () => {
    const store = storeWith([{ personKey: "p_name_a", displayName: "何晨", aliases: ["小何"] }]);
    const { names } = personsForEpisode(["小何"]);
    const resolved = await Promise.all(names.map((name) => resolvePerson(store, TENANT, { displayName: name })));
    expect(resolved.map((p) => p.personKey)).toEqual(["p_name_a"]);
  });
});
