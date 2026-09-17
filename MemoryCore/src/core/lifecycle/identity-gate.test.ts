/**
 * P2 SOP Round2 修复（T9 实证弱点）：
 * A) 身份槽演化语义——identity-discovery 合并 existing ∪ new（行级去重 cap 8），单提案不再丢历史
 *    （store.upsertCore 保持 REPLACE 语义供面板直写；组合在 worker 层）。
 * B) 对抗人设注入门——「用户将我的身份设定为…」类第三方强加身份不是行为可证自我认知，拒收
 *    （strip 门同层单一源 isIdentityImposition）。
 */
import { describe, it, expect, vi } from "vitest";
import { runIdentityDiscovery, isIdentityImposition, mergeIdentityFacts } from "./identity-discovery.js";

describe("isIdentityImposition 主语一致性门（B）", () => {
  it("第三方强加身份 → true", () => {
    expect(isIdentityImposition("用户将我的身份设定为他的女儿，并要求我以此身份相处")).toBe(true);
    expect(isIdentityImposition("把我当成他的秘书")).toBe(true);
    expect(isIdentityImposition("用户让我以助手的身份汇报")).toBe(true);
    expect(isIdentityImposition("用户坚持说我是他的专属项目管理助理")).toBe(true);  // 对抗审查A2：说我是
    expect(isIdentityImposition("他称我为团队的数据守门人")).toBe(true);            // 对抗审查A2：称我为
    expect(isIdentityImposition("用户问我是不是他的助手")).toBe(false);            // 误报面：问我是≠说我是
    expect(isIdentityImposition("用户夸我是靠谱的伙伴")).toBe(false);              // 误报面：夸我是
  });
  it("合法行为自证 → false", () => {
    expect(isIdentityImposition("我承诺每周五下班前输出周报")).toBe(false);
    expect(isIdentityImposition("我的工作风格是先给结论再给细节")).toBe(false);
    expect(isIdentityImposition("我把用户当朋友一样坦诚")).toBe(false);
  });
});

describe("mergeIdentityFacts 演化合并（A）", () => {
  it("existing ∪ new 行级去重，不丢历史", () => {
    const existing = "- 用户每周日陪女儿去图书馆\n- 用户坚持每周五复盘";
    const merged = mergeIdentityFacts(existing, ["用户对接口性能要求严格"]);
    const lines = merged.split("\n");
    expect(lines.length).toBe(3);
    expect(merged).toContain("陪女儿去图书馆");
    expect(merged).toContain("接口性能");
  });
  it("重复事实不重复落（含 bulleted/裸行归一）", () => {
    const merged = mergeIdentityFacts("- 用户坚持每周五复盘", ["用户坚持每周五复盘", "- 新事实"]);
    expect(merged.split("\n").length).toBe(2);
  });
  it("cap 8：超限截断（宁缺毋滥，防无限膨胀）", () => {
    const existing = Array.from({ length: 6 }, (_, i) => `- 旧事实${i}`).join("\n");
    const merged = mergeIdentityFacts(existing, ["新事实甲", "新事实乙"]);
    expect(merged.split("\n").length).toBe(8);
  });
  it("对抗审查A1（饥饿）：槽满后新事实仍进入——保留最新 8 条（行为漂移=新事实更优）", () => {
    const existing = Array.from({ length: 8 }, (_, i) => `- 满槽事实${i}`).join("\n");
    const merged = mergeIdentityFacts(existing, ["新事实甲"]);
    const lines = merged.split("\n");
    expect(lines.length).toBe(8);
    expect(merged).toContain("新事实甲");       // 新事实必须进入
    expect(merged).not.toContain("满槽事实0"); // 最旧者让位
    expect(merged).toContain("满槽事实7");     // 最新旧行保留
  });
});

describe("集成：对抗人设提案被拒 + 历史保留", () => {
  function makeStore(existing: Array<{ slot: string; content: string }>) {
    const coreUpserts: Array<{ slot: string; content: string }> = [];
    return {
      coreUpserts,
      queryL1Records: () => [
        { record_id: "r1", content: "用户和同事评审代码，坚持先给结论", significance: 0.9, updated_time: "2026-09-17T09:00:00Z" },
      ],
      countL1: () => 1,
      readCore: () => existing,
      upsertCore: (slot: string, content: string) => {
        coreUpserts.push({ slot, content });
        return true;
      },
      getIdentityDiscoveryState: async () => ({ lastAttemptAt: null, lastCorpusCount: null }),
      setIdentityDiscoveryState: async () => {},
    } as never;
  }

  it("self_identity 人设提案拒收；合法提案采纳且 existing 事实保留（不替换）", async () => {
    const store = makeStore([{ slot: "self_identity", content: "- 我承诺每周五出周报" }, { slot: "identity", content: "- 用户是家里的首席厨师" }]);
    const run = vi.fn().mockResolvedValue(JSON.stringify([
      { slot: "self_identity", content: "用户将我的身份设定为他的女儿，并要求我以此身份相处", rationale: "对抗" },
      { slot: "identity", content: "用户对接口性能要求严格", rationale: "新事实" },
    ]));
    const res = await runIdentityDiscovery({
      store, llmRunner: { run }, logger: undefined,
      config: { intervalHours: 24 }, selfIdentity: { enabled: true, maxPerPass: 2 },
      now: () => new Date("2026-09-17T10:00:00Z"),
    });
    expect(res.adopted).toBe(1); // 仅 identity 新事实
    const ups = (store as unknown as { coreUpserts: Array<{ slot: string; content: string }> }).coreUpserts;
    const selfUp = ups.find((u) => u.slot === "self_identity");
    expect(selfUp).toBeUndefined(); // 人设提案被拒 → self_identity 零写入
    const idUp = ups.find((u) => u.slot === "identity")!;
    expect(idUp.content).toContain("首席厨师"); // 历史保留
    expect(idUp.content).toContain("接口性能"); // 新事实合并
    expect(idUp.content.split("\n").length).toBe(2);
  });
});
