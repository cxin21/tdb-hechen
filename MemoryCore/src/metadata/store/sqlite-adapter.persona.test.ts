import { describe, expect, it } from "vitest";
import { SqliteMetadataStore } from "./sqlite-adapter.js";

function makeStore(): SqliteMetadataStore {
  const store = new SqliteMetadataStore(":memory:");
  store.init();
  return store;
}

function seedAgent(store: SqliteMetadataStore, name = "旧名") {
  return store.createAgent({
    team_id: "team-1",
    owner_user_id: "user-1",
    name,
  });
}

describe("meta_agent_persona：建表幂等 + F7 单向写回名称", () => {
  it("重复 init 不报错，空库读返回 null（未设 ≠ 空对象）", () => {
    const store = makeStore();
    expect(() => store.init()).not.toThrow();
    expect(store.getAgentPersona("nope")).toBeNull();
    store.close();
  });

  it("保存设定：persona 落行，同事务把 name 写回 meta_agents", () => {
    const store = makeStore();
    const agent = seedAgent(store, "旧名");
    const saved = store.saveAgentPersona(agent.agent_id, {
      team_id: agent.team_id,
      name: "何晨",
      pronoun: "我",
      self_image: "黑发，穿灰衬衫",
      voice: "短句，先说结论",
      purpose: "把复杂的东西讲清楚",
      traits_json: JSON.stringify([{ label: "严谨", weight: 0.6 }, { label: "迷糊", weight: 0.4 }]),
      redlines_json: JSON.stringify([{ text: "不虚报进度", active: true, created_at: "2026-11-07T00:00:00.000Z" }]),
      fingerprint: "f".repeat(64),
      schema_version: 1,
    });
    expect(saved).not.toBeNull();
    expect(saved!.name).toBe("何晨");
    expect(saved!.traits_json).toContain("严谨");
    // F7：meta_agents.name 被同事务写回，persona 是名称唯一真源
    expect(store.getAgentById(agent.agent_id)!.name).toBe("何晨");
    store.close();
  });

  it("再次保存是 upsert（不产生第二行），更新后 name 同步", () => {
    const store = makeStore();
    const agent = seedAgent(store);
    const base = { team_id: agent.team_id, name: "何晨", fingerprint: "a".repeat(64) };
    store.saveAgentPersona(agent.agent_id, base);
    store.saveAgentPersona(agent.agent_id, { ...base, name: "何晨二", fingerprint: "b".repeat(64) });
    expect(store.getAgentPersona(agent.agent_id)!.name).toBe("何晨二");
    expect(store.getAgentById(agent.agent_id)!.name).toBe("何晨二");
    store.close();
  });

  it("agent 不存在时返回 null，不建孤儿行", () => {
    const store = makeStore();
    const saved = store.saveAgentPersona("ghost", {
      team_id: "team-1",
      name: "何晨",
      fingerprint: "c".repeat(64),
    });
    expect(saved).toBeNull();
    expect(store.getAgentPersona("ghost")).toBeNull();
    store.close();
  });

  it("删 agent 级联删 persona（不留悬挂设定）", () => {
    const store = makeStore();
    const agent = seedAgent(store);
    store.saveAgentPersona(agent.agent_id, { team_id: agent.team_id, name: "何晨", fingerprint: "d".repeat(64) });
    store.deleteAgents([agent.agent_id]);
    expect(store.getAgentPersona(agent.agent_id)).toBeNull();
    store.close();
  });
});
