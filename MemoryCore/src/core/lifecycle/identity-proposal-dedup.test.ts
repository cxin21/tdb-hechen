/**
 * V6-任务8（2026-09-23 用户令提前开工）：红线提案语义去重 P1 闸门 + P2 上下文注入。
 * 根因实锚：store 层精确守卫（同 slot+content，sqlite.ts:2755-2758）挡不住换措辞
 * 语义重复——生产 102 条 pending 实测最大簇 9-15 条（网关不重启簇）。
 * 阈值 0.75 生产全行标定：0.790 真重复命中 / 0.692 同簇但低于阈值（宁漏勿错杀守卫）。
 * RED 先行：闸门拦截/计数/prompt 注入用例在 identity-discovery 补丁前全 failed。
 */
import { describe, it, expect, vi } from "vitest";
import { runIdentityDiscovery } from "./identity-discovery.js";
import { proposalSimilarity, findDuplicateProposal, PROPOSAL_DUP_THRESHOLD } from "./proposal-dedup.js";

// 生产实锚全文（2026-09-23 只读探针 core_pending 102 条中的真实行，网关簇）
const GATE_ROW_A =
  "运维操作（如清理测试租户数据）期间绝不重启网关，以免中断会话；所有服务重启脚本必须加入 sleep 与 health 就绪探针判断重启是否成功，否则网关断连会导致 AI 连不上 LLM；且不得污染记忆向量覆盖率指标。";
const GATE_ROW_B =
  "运维操作期间绝不随意重启网关以免中断会话；重启服务时脚本必须加入 sleep 与 health 就绪探针判断重启是否成功，否则网关断连会导致 AI 连不上 LLM；清理测试租户数据不得污染记忆向量覆盖率指标。";
const GATE_ROW_C =
  "运维期间绝不重启网关以免中断用户会话；任何服务重启脚本必须加入 sleep 与 health 就绪探针判断重启是否成功（否则网关断连会导致我连不上 LLM）；数据清理等操作不得污染记忆向量覆盖率指标。";

describe("proposalSimilarity（字符 bigram Jaccard 单一源）", () => {
  it("逐字等同 → 1；完全无关 → 近 0", () => {
    expect(proposalSimilarity(GATE_ROW_A, GATE_ROW_A)).toBe(1);
    expect(proposalSimilarity("绝不泄露数据库连接串与密钥明文", "周末全家聚餐，用户是家里的首席厨师")).toBeLessThan(0.05);
  });
  it("阈值常量=0.75（生产全行标定：0.790 真重复 / 0.692 同簇不并）", () => {
    expect(PROPOSAL_DUP_THRESHOLD).toBe(0.75);
    expect(proposalSimilarity(GATE_ROW_A, GATE_ROW_B)).toBeGreaterThanOrEqual(0.75);
    expect(proposalSimilarity(GATE_ROW_A, GATE_ROW_C)).toBeLessThan(0.75);
  });
  it("findDuplicateProposal：同 slot 高相似命中（取最高者）；异 slot 隔离；低于阈值不命中", () => {
    const d = findDuplicateProposal(GATE_ROW_B, "strict_rule", [
      { slot: "strict_rule", content: GATE_ROW_A },
      { slot: "core_value", content: GATE_ROW_B },
    ]);
    expect(d).toBeDefined();
    expect(d!.content).toBe(GATE_ROW_A);
    expect(findDuplicateProposal(GATE_ROW_B, "core_value", [{ slot: "strict_rule", content: GATE_ROW_A }])).toBeUndefined();
    expect(findDuplicateProposal(GATE_ROW_C, "strict_rule", [{ slot: "strict_rule", content: GATE_ROW_A }])).toBeUndefined();
  });
});

function makeStoreDedup(existing: Array<{ slot: string; content: string }>, pendingRows: Array<{ slot: string; content: string; state: string }>) {
  const pendingCaptured: Array<{ slot: string; content: string; evidence: number }> = [];
  return {
    pendingCaptured,
    queryL1Records: () => [
      { record_id: "r1", content: "周末全家聚餐，用户是家里的首席厨师兼采购，菜品丰富", significance: 0.9, updated_time: "2026-09-17T09:00:00Z" },
      { record_id: "r2", content: "用户在项目里负责技术评审与交付把关", significance: 0.8, updated_time: "2026-09-17T09:10:00Z" },
    ],
    countL1: () => 2,
    readCore: () => existing,
    upsertCore: () => true,
    upsertPendingCore: (slot: string, content: string, evidence: number) => {
      pendingCaptured.push({ slot, content, evidence });
      return true;
    },
    listPendingCore: () => pendingRows,
    getIdentityDiscoveryState: async () => ({ lastAttemptAt: null, lastCorpusCount: null }),
    setIdentityDiscoveryState: async () => {},
  } as never;
}

function makeStorePlain(existing: Array<{ slot: string; content: string }> = []) {
  return {
    queryL1Records: () => [
      { record_id: "r1", content: "周末全家聚餐，用户是家里的首席厨师兼采购，菜品丰富", significance: 0.9, updated_time: "2026-09-17T09:00:00Z" },
      { record_id: "r2", content: "用户在项目里负责技术评审与交付把关", significance: 0.8, updated_time: "2026-09-17T09:10:00Z" },
    ],
    countL1: () => 2,
    readCore: () => existing,
    upsertCore: () => true,
    upsertPendingCore: () => true,
    getIdentityDiscoveryState: async () => ({ lastAttemptAt: null, lastCorpusCount: null }),
    setIdentityDiscoveryState: async () => {},
  } as never;
}

const NOW = () => new Date("2026-09-17T10:00:00Z");

async function runWith(store: never, proposals: unknown) {
  const run = vi.fn().mockResolvedValue(JSON.stringify(proposals));
  const res = await runIdentityDiscovery({
    store,
    llmRunner: { run },
    logger: undefined,
    config: { intervalHours: 24 },
    selfIdentity: { enabled: false, maxPerPass: 2 },
    now: NOW,
  });
  const prompt = (run.mock.calls[0]?.[0] as { prompt?: string } | undefined)?.prompt ?? "";
  return { res, prompt };
}

const caps = (store: never) => (store as never as { pendingCaptured: Array<{ slot: string; content: string }> }).pendingCaptured;

describe("P1 提案语义去重闸门（入队前拦截换措辞重复）", () => {
  it("与 pending 既有提案换措辞重复 → 不入队不计 pending", async () => {
    const store = makeStoreDedup([], [{ slot: "strict_rule", content: GATE_ROW_A, state: "pending" }]);
    const { res } = await runWith(store, [{ slot: "strict_rule", content: GATE_ROW_B, rationale: "r" }]);
    expect(caps(store)).toHaveLength(0);
    expect(res.pending).toBe(0);
  });
  it("与已采纳红线 slot 重复 → 同样拦截", async () => {
    const store = makeStoreDedup([{ slot: "strict_rule", content: GATE_ROW_A }], []);
    const { res } = await runWith(store, [{ slot: "strict_rule", content: GATE_ROW_B, rationale: "r" }]);
    expect(caps(store)).toHaveLength(0);
    expect(res.pending).toBe(0);
  });
  it("新提案（无重复）→ 正常入队（守卫：闸门不误杀）", async () => {
    const store = makeStoreDedup([], [{ slot: "strict_rule", content: GATE_ROW_A, state: "pending" }]);
    const { res } = await runWith(store, [{ slot: "strict_rule", content: "绝不泄露数据库连接串与密钥明文", rationale: "r" }]);
    expect(caps(store)).toHaveLength(1);
    expect(res.pending).toBe(1);
  });
  it("同簇低于阈值（0.692）→ 不拦截（宁漏勿错杀守卫）", async () => {
    const store = makeStoreDedup([], [{ slot: "strict_rule", content: GATE_ROW_A, state: "pending" }]);
    const { res } = await runWith(store, [{ slot: "strict_rule", content: GATE_ROW_C, rationale: "r" }]);
    expect(caps(store)).toHaveLength(1);
    expect(res.pending).toBe(1);
  });
});

describe("P2 上下文注入（prompt 携带 pending 列表，生成层预防）", () => {
  it("store 支持 listPendingCore → prompt 含『已有待拍板提案』段与 pending 内容", async () => {
    const store = makeStoreDedup([], [{ slot: "strict_rule", content: GATE_ROW_A, state: "pending" }]);
    const { prompt } = await runWith(store, [{ slot: "strict_rule", content: "绝不泄露数据库连接串与密钥明文", rationale: "r" }]);
    expect(prompt).toContain("已有待拍板提案");
    expect(prompt).toContain(GATE_ROW_A.slice(0, 60));
  });
  it("store 不支持 listPendingCore → prompt 逐位现状（无新段，向后兼容守卫）", async () => {
    const store = makeStorePlain();
    const { prompt } = await runWith(store, [{ slot: "strict_rule", content: "绝不泄露数据库连接串与密钥明文", rationale: "r" }]);
    expect(prompt).not.toContain("已有待拍板提案");
    expect(prompt).toContain("请提炼身份事实提案。");
  });
});
