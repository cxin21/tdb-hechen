/**
 * 人物身份的租户维度与平台补绑（阶段 1 实施时发现的两处缺口）：
 *  1. 名字分支的 person_key 必须带 team|user|agent —— 否则不同 agent 下同名撞主键，
 *     迁移时会把 5 个人挂在主租户，其它 agent 查不到人（生产实测：两个 agent 193 行指向不存在的 key）。
 *  2. 名字唯一命中且本次带 platformId、旧行未绑平台时，就地补绑 —— 否则同一人跨平台永远是两个身份。
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { VectorStore } from "../../store/sqlite.js";
import { personKeyOf, resolvePerson } from "../resolve.js";

const T1 = { teamId: "team-a", userId: "usr-a", agentId: "agt-a" };
const T2 = { teamId: "team-a", userId: "usr-a", agentId: "agt-b" };

const dirs: string[] = [];
const stores: VectorStore[] = [];

afterEach(() => {
  while (stores.length) stores.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function makeStore(): VectorStore {
  const dir = mkdtempSync(join(tmpdir(), "person-tenant-"));
  dirs.push(dir);
  const store = new VectorStore(join(dir, "vectors.db"), 0);
  stores.push(store);
  store.init();
  return store;
}

describe("person_key 的租户维度", () => {
  it("同名在两个 agent 下生成不同 person_key（不跨租户共用主键）", () => {
    const a = personKeyOf({ ...T1, displayName: "何晨" });
    const b = personKeyOf({ ...T2, displayName: "何晨" });
    expect(a).not.toBe(b);
    expect(a.startsWith("p_name_")).toBe(true);
    // 归一化后同名同租户必须稳定（幂等）
    expect(personKeyOf({ ...T1, displayName: " 何晨 " })).toBe(a);
  });

  it("两个 agent 各自建人：各自 listSoulPersons 只看到自己那个", async () => {
    const store = makeStore();
    const inA = await resolvePerson(store, T1, { displayName: "何晨" });
    const inB = await resolvePerson(store, T2, { displayName: "何晨" });
    expect(inA.personKey).not.toBe(inB.personKey);
    expect(store.listSoulPersons!(T1).map((p) => p.personKey)).toEqual([inA.personKey]);
    expect(store.listSoulPersons!(T2).map((p) => p.personKey)).toEqual([inB.personKey]);
  });
});

describe("名字命中后的平台补绑", () => {
  it("先按名字建人，再带 platformId 命中同一个人时把平台补上", async () => {
    const store = makeStore();
    const byName = await resolvePerson(store, T1, { displayName: "何晨" });
    expect(byName.platformId ?? "").toBe("");

    const bound = await resolvePerson(store, T1, { displayName: "何晨", platform: "qq", platformId: "qq-123" });
    expect(bound.personKey).toBe(byName.personKey);
    const row = store.getSoulPersonByPlatform!(T1, { platform: "qq", platformId: "qq-123" });
    expect(row?.personKey).toBe(byName.personKey);
    // 补绑不造第二个人
    expect(store.listSoulPersons!(T1).length).toBe(1);
  });

  it("已绑平台的行不会被另一个 platformId 抢走（归属优先于本次线索）", async () => {
    const store = makeStore();
    const first = await resolvePerson(store, T1, { displayName: "何晨", platform: "qq", platformId: "qq-1" });
    const second = await resolvePerson(store, T1, { displayName: "何晨", platform: "qq", platformId: "qq-2" });
    expect(second.personKey).toBe(first.personKey);
    expect(store.getSoulPersonByPlatform!(T1, { platform: "qq", platformId: "qq-2" })).toBeNull();
  });
});
