import { describe, it, expect } from "vitest";
import { buildSoulPrefix } from "./soul-assembler.js";

const TENANT = { teamId: "flowtest", userId: "ev5", agentId: "agent-l5ug" };

function makeStore(slots: Array<{ slot: string; content: string }>, values: Array<{ label: string; weight?: number; valence?: number | null; state?: string }> = []) {
  return {
    readCore: async () => slots,
    listValues: async () => values,
  } as never;
}

describe("soul-assembler 四段渲染（P1）", () => {
  const IDENTITY_ONLY = [{ slot: "identity", content: "用户是家里的首席厨师" }];

  it("opts 缺省：渲染与现状逐字节一致（无（我是谁）标注、无预算）", async () => {
    const out = await buildSoulPrefix(makeStore(IDENTITY_ONLY) as never, TENANT);
    expect(out).toBe("<soul-identity>\n## 此刻的你\n- [identity] 用户是家里的首席厨师\n</soul-identity>\n\n");
  });

  it("enabled=true：self 与 identity 分行标注", async () => {
    const out = await buildSoulPrefix(
      makeStore([
        { slot: "identity", content: "用户是家里的首席厨师" },
        { slot: "self_identity", content: "我在这个团队负责技术评审" },
      ]) as never,
      TENANT,
      undefined,
      { selfIdentityEnabled: true },
    );
    expect(out).toContain("（我是谁）- [self_identity] 我在这个团队负责技术评审");
    expect(out).toContain("（我心中的他）- [identity] 用户是家里的首席厨师");
    expect(out.indexOf("（我是谁）")).toBeLessThan(out.indexOf("（我心中的他）"));
  });

  it("enabled=true：multi-line content 仅首行带前缀，后续行原样", async () => {
    const out = await buildSoulPrefix(
      makeStore([{ slot: "self_identity", content: "- 我负责技术评审\n- 我承诺每周五出周报" }]) as never,
      TENANT,
      undefined,
      { selfIdentityEnabled: true, budgetSelfChars: 600 },
    );
    expect(out).toContain("（我是谁）- [self_identity] - 我负责技术评审\n- 我承诺每周五出周报");
  });

  it("F17 预算：超限截断（宁缺毋滥，无省略号）", async () => {
    const long = "我负责技术评审".repeat(200); // 1400 chars
    const out = await buildSoulPrefix(
      makeStore([{ slot: "self_identity", content: long }]) as never,
      TENANT,
      undefined,
      { selfIdentityEnabled: true, budgetSelfChars: 600 },
    );
    expect(out).not.toContain("……");
    expect(out.includes(long)).toBe(false);
    expect((out.match(/我负责技术评审/g) ?? []).length).toBeLessThan(200);
  });

  it("enabled=true 但 self 槽空：（我是谁）小节整段省略（宁缺毋滥）", async () => {
    const out = await buildSoulPrefix(makeStore(IDENTITY_ONLY) as never, TENANT, undefined, { selfIdentityEnabled: true });
    expect(out).not.toContain("（我是谁）");
    expect(out).toContain("（我心中的他）");
  });
});
