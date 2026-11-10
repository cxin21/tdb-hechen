/**
 * 硬删 agent 必须清内容（2026-11-09）。
 *
 * 以前 deleteAgents 只删 meta 行，归档才调内容清理。结果硬删之后
 * soul_* / l0 / l1 还在，按 agent_id 还能读到已删 agent 的人格和情绪。
 * 这里锁：硬删走和归档同一条清理，而且清理发生在 meta 行删除之前
 * （清理要靠 agent 行拿到 team_id）。
 */
import { describe, expect, it } from "vitest";
import { MetadataService } from "../metadata-service.js";
import { SqliteMetadataStore } from "../../store/sqlite-adapter.js";

function makeService(cleaner: (params: { teamId: string; agentId: string }) => Promise<void>): {
  service: MetadataService;
  store: SqliteMetadataStore;
} {
  const store = new SqliteMetadataStore(":memory:");
  store.init();
  const service = new MetadataService(store);
  service.setChatMemoryContentCleaner(cleaner);
  return { service, store };
}

describe("deleteAgents 走内容清理", () => {
  it("删除前按 team+agent 调清理，agent 行不存在则不调", async () => {
    const calls: Array<{ teamId: string; agentId: string }> = [];
    const { service, store } = makeService(async (params) => {
      calls.push(params);
      expect(store.getAgentById(params.agentId)).not.toBeNull();
    });
    const user = store.createUser({ auth_provider: "local", external_id: "ext-1", username: "u1" });
    const team = store.createTeam({ name: "T", owner_user_id: user.user_id });
    const agent = store.createAgent({ team_id: team.team_id, owner_user_id: user.user_id, name: "待删" });

    const result = await service.deleteAgents([agent.agent_id, "agt-missing"]);

    expect(result.deleted_ids).toEqual([agent.agent_id]);
    expect(calls).toEqual([{ teamId: team.team_id, agentId: agent.agent_id }]);
    expect(store.getAgentById(agent.agent_id)).toBeNull();
    store.close();
  });

  it("没装清理器时仍能删 meta 行，不抛", async () => {
    const store = new SqliteMetadataStore(":memory:");
    store.init();
    const service = new MetadataService(store);
    const user = store.createUser({ auth_provider: "local", external_id: "ext-2", username: "u2" });
    const team = store.createTeam({ name: "T", owner_user_id: user.user_id });
    const agent = store.createAgent({ team_id: team.team_id, owner_user_id: user.user_id, name: "待删" });

    const result = await service.deleteAgents([agent.agent_id]);

    expect(result.deleted_ids).toEqual([agent.agent_id]);
    store.close();
  });
});
