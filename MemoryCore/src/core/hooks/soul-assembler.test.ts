import { describe, it, expect } from "vitest";
import { buildSoulPrefix } from "./soul-assembler.js";

const TENANT = { teamId: "flowtest", userId: "ev5", agentId: "agent-l5ug" };

function makeStore(slots: Array<{ slot: string; content: string }>, values: Array<{ label: string; value_id?: string; weight?: number; valence?: number | null; state?: string; attrs_json?: string }> = []) {
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

  it("D-1：多行内容截断按行边界——超限行整行丢弃，无断句残行", async () => {
    const lines = [
      "- 我负责技术评审与验收门禁（第一条较长的事实陈述）",
      "- 我承诺每周五输出周报",
      "- 我执行过『先审计后动手』的协作铁律",
      "- 我在批次六收口事故后固化了双写防护纪律",
      "- 我对 gated 待拍板事项坚持不抢跑",
    ];
    const content = lines.join("\n");
    const out = await buildSoulPrefix(
      makeStore([{ slot: "self_identity", content }]) as never,
      TENANT,
      undefined,
      { selfIdentityEnabled: true, budgetSelfChars: 100 },
    );
    const body = out.split("（我是谁）- [self_identity] ")[1] ?? "";
    const outLines = body.split("\n").filter((l) => l.trim() && !l.startsWith("##") && !l.startsWith("</soul-identity>"));
    // 可判定判据：任何输出正文行要么是某源行整行，要么与所有源行无前缀关系（残句=断句铁证）
    for (const l of outLines) {
      const isWhole = lines.includes(l);
      const isPartial = lines.some((src) => src.startsWith(l) && l.length < src.length);
      expect(isWhole).toBe(true);
      expect(isPartial).toBe(false);
    }
  });

  it("D-1：短内容（≤预算）逐字节不变（回归）", async () => {
    const content = "- 我负责技术评审\n- 我承诺每周五出周报";
    const out = await buildSoulPrefix(
      makeStore([{ slot: "self_identity", content }]) as never,
      TENANT,
      undefined,
      { selfIdentityEnabled: true, budgetSelfChars: 600 },
    );
    expect(out).toContain(content);
  });

  it("D-1：单行超预算（无行边界可用）→ 首行字符截断兜底（槽不空）", async () => {
    const long = "我负责技术评审".repeat(200); // 1400 chars 单行
    const out = await buildSoulPrefix(
      makeStore([{ slot: "self_identity", content: long }]) as never,
      TENANT,
      undefined,
      { selfIdentityEnabled: true, budgetSelfChars: 600 },
    );
    expect(out.length).toBeGreaterThan(0);
    expect((out.match(/我负责技术评审/g) ?? []).length).toBeLessThan(200);
  });

  it("enabled=true 但 self 槽空：（我是谁）小节整段省略（宁缺毋滥）", async () => {
    const out = await buildSoulPrefix(makeStore(IDENTITY_ONLY) as never, TENANT, undefined, { selfIdentityEnabled: true });
    expect(out).not.toContain("（我是谁）");
    expect(out).toContain("（我心中的他）");
  });
});

describe("V7 F-U2：感受段首要锚并列 weight 两端序统一", () => {
  it("并列 weight：value_id 次级键（与 Panel pickPrimeAnchor 同键；输入序不承载语义的显式化守占）", async () => {
    const out = await buildSoulPrefix(
      makeStore(
        [{ slot: "identity", content: "用户是家里的首席厨师" }],
        [
          { label: "乙", value_id: "v-b", weight: 0.8, valence: 1, attrs_json: '{"description":"乙描述"}' },
          { label: "甲", value_id: "v-a", weight: 0.8, valence: 1, attrs_json: '{"description":"甲描述"}' },
        ],
      ) as never,
      TENANT,
    );
    expect(out).toContain("；首要 甲：甲描述");
  });
});

describe("V7 方案A：首要描述句边界截取（消残句，宁缺毋滥）", () => {
  const longDesc = "用户长期偏好：文本类成果（含移交提示词、分析报告、文档）一律在对话框直接输出可复制全文，不得落成文档文件。后续补充句。";
  it("首句在预算内：完整首句呈现至句号（非 30 字硬截）", async () => {
    const out = await buildSoulPrefix(
      makeStore(
        [{ slot: "identity", content: "用户是家里的首席厨师" }],
        [{ label: "文档", value_id: "v-d", weight: 0.8, valence: 1, attrs_json: JSON.stringify({ description: longDesc }) }],
      ) as never,
      TENANT,
    );
    // 注：断言限定感受段——价值锚行另有描述渲染（V6-1b，全量存储描述），不在本断言范围
    const feel = out.match(/<soul-feeling>[\s\S]*?<\/soul-feeling>/)?.[0] ?? "";
    expect(feel).toContain("首要 文档：" + longDesc.split("。")[0] + "。");
    expect(feel).not.toContain("后续");
  });
  it("无句边界且超预算：省略描述（宁缺毋滥，不产残句）", async () => {
    const noBound = "表层现象与真实根因多次背离：" + "长长长长长".repeat(30);
    const out = await buildSoulPrefix(
      makeStore(
        [{ slot: "identity", content: "用户是家里的首席厨师" }],
        [{ label: "根因", value_id: "v-r", weight: 0.8, valence: 1, attrs_json: JSON.stringify({ description: noBound }) }],
      ) as never,
      TENANT,
    );
    expect(out).not.toContain("；首要");
  });
});
