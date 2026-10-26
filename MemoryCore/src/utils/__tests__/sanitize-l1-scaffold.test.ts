/**
 * L1 脚手架闸门 · 纯函数用例（2026-10-26）
 *
 * 用例文本取自生产 L0（/data/tdai-memory/vectors.db l0_conversations）的真实头部，
 * 覆盖 classified 生效前那批 unclassified 行——它们没有 classification 标签，
 * 只能靠内容特征拦下：旧闸门让 8192 字系统提示全文通过，LLM 把它当用户长期指令，
 * 生产实测 133 条 L1 里 85 条源自这类文本。
 */
import { describe, expect, it } from "vitest";
import {
  isContentBearingScaffoldText,
  isHarnessScaffoldText,
  isNonRealL0Classification,
  shouldExtractL1,
} from "../sanitize.js";

describe("isHarnessScaffoldText · 生产样本", () => {
  const scaffoldSamples: Array<[string, string]> = [
    ["approval 变更通知", 'The approval policy changed from "ask" to "never" (changed by the user).'],
    ["system-reminder 块", "<system-reminder>\nThe following workspace instructions may be relevant to your work.\n</system-reminder>"],
    ["runtime context 快照", 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\nCurrent working directory: "D:\\DSH\\projects\\tdb-hechen".'],
    ["压缩 nudge 全文", "⚠️ Context limit reached — compress now. Prioritize consumed tool outputs. Compression Philosophy: - All compression serves the primary task, but be frugal. - "],
    ["nudge 尾部残片（8192 截断）", " and confirm the block count increased — a confirmation line you wrote yourself proves nothing. Execute these calls silently: no announcement or preamble before"],
    ["技能正文（artifact）", '<skill_content name="diagnosing-bugs">\n<skill_resources> Base directory for this skill: C:\\Users\\11245\\.dsh\\profiles\\desktop\\node_modules\\dsh-mattpocock-skills-deck\\b'],
    ["系统提示头", "You are an AI agent powered by DeepSeek Harness."],
    ["回合脚手架行", "Time sampled while preparing turn 18, step 1: 2026-10-26T22:23:38+08:00[Asia/Shanghai]"],
  ];

  for (const [name, text] of scaffoldSamples) {
    it(`拦下：${name}`, () => {
      expect(isHarnessScaffoldText(text)).toBe(true);
      expect(shouldExtractL1(text)).toBe(false);
    });
  }

  it("放行：有内容的脚手架（压缩摘要段 / 后台回执）——形态是脚手架、正文是工作事实", () => {
    const bearing: Array<[string, string]> = [
      ["压缩摘要段", "[Compressed conversation section] — #115 上游对比 + 本仓现状勘察（尚未写代码） ## 用户目标与硬约束 - User said (m00002): \"/implement https://github.com/cxin21/tdb-hechen/issues/115\""],
      ["后台任务回执头", "Background subagent e3238d25 finished: review done."],
      ["background job 回执", "Background job bash-414503c00f1f4ba8 finished [status: completed, exit code: 0]. Read its output with job_output."],
    ];
    for (const [name, text] of bearing) {
      expect(isHarnessScaffoldText(text), name).toBe(true);
      expect(isContentBearingScaffoldText(text), name).toBe(true);
      expect(shouldExtractL1(text), name).toBe(true);
    }
    // 纯注入物不得被误判为「有内容」
    expect(isContentBearingScaffoldText("Current runtime context. This snapshot supersedes earlier runtime-context snapshots.")).toBe(false);
    expect(isContentBearingScaffoldText("⚠️ Context limit reached — compress now. Compression Philosophy:")).toBe(false);
  });

  it("放行：真实用户消息（含带载荷的斜杠指令）", () => {
    const real = "太卡了这个，你改一下形式吧，改成绘制的动画";
    expect(isHarnessScaffoldText(real)).toBe(false);
    expect(shouldExtractL1(real)).toBe(true);

    // 生产 real 行原文：旧闸门因 startsWith("/") 把它整条丢掉
    const slash = "/implement https://github.com/cxin21/tdb-hechen/issues/115 我在服务器上也部署了当前的项目，和fork的原项目对比查了很多东西";
    expect(shouldExtractL1(slash)).toBe(true);
  });

  it("放行：assistant 侧的真实工作回复", () => {
    const reply = "#114 已修完并关票。 **根因是一个**：ingest-v2 的落盘路径由 LLM 抽取的 frontmatter type 间接推导，整条推导链既没有 type 白名单，也没有根目录边界校验。";
    expect(shouldExtractL1(reply)).toBe(true);
  });

  it("仍拦：无载荷的纯框架指令", () => {
    expect(shouldExtractL1("/new")).toBe(false);
    expect(shouldExtractL1("/reset")).toBe(false);
  });
});

describe("isNonRealL0Classification · proxy #83 枚举镜像", () => {
  it("非 real 类别全部拦截", () => {
    for (const c of ["scaffold", "artifact", "echo", "dup", "SCAFFOLD", " Artifact "]) {
      expect(isNonRealL0Classification(c)).toBe(true);
    }
  });

  it("real / unknown / 无标签 放行到内容闸门", () => {
    for (const c of ["real", "unknown", "unclassified", "", undefined, null, "REAL"]) {
      expect(isNonRealL0Classification(c)).toBe(false);
    }
  });
});
