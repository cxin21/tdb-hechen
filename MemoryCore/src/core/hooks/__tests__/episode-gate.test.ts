/**
 * 灵魂注入质量轮 R2：episode gate（记忆内容混入灵魂门）单元测试。
 * 设计依据：灵魂=笼统价值观/特质，具体某件事的记忆叙述不得进入灵魂注入。
 * 判定纪律：宁漏勿错杀——只拦机器可判定的高置信硬特征。
 */
import { describe, expect, it } from "vitest";
import { looksLikeEpisode } from "../episode-gate.js";

describe("looksLikeEpisode（记忆内容混入灵魂门）", () => {
  it("具体事件硬特征逐类命中", () => {
    expect(looksLikeEpisode("用户要求落实为 T-D 日志任务，以提交 b1ea2e5")).toBe(true); // commit hash
    expect(looksLikeEpisode("遗留工作落入台账 REG-REMAINING-006 按序推进")).toBe(true); // 登记号
    expect(looksLikeEpisode("A-3 勘误审计#27 口径，A-5 达 GRE")).toBe(true); // 编号+工号
    expect(looksLikeEpisode("D-4 以真实周期性事实种子库定案 A/B 设计")).toBe(true); // D-4
    expect(looksLikeEpisode("用配置的 key 做直连探针实测可切割定责：探针 HTTP 200")).toBe(true); // HTTP
    expect(looksLikeEpisode("事件发生在 2026-10-04 收口")).toBe(true); // 日期
    expect(looksLikeEpisode("根因定位见 sqlite.ts:2381 白名单")).toBe(true); // 文件后缀
    expect(looksLikeEpisode("所有待拍板事项（A-7b小节、neighborExpand选项等）呈")).toBe(true); // A-7b
  });
  it("合格灵魂级价值观说明不误杀", () => {
    expect(looksLikeEpisode("先取证再下结论的工作纪律")).toBe(false);
    expect(looksLikeEpisode("解决问题必须从第一性原理出发，先定位根本原因并从根源根治，拒绝临时补丁式修复。")).toBe(false);
    expect(looksLikeEpisode("交付必须 TDD 先 RED 后实现，测试失败先取证归因再动码")).toBe(false);
    expect(looksLikeEpisode("文本类成果一律在对话框直接输出可复制的完整全文")).toBe(false);
    expect(looksLikeEpisode("用户需求被转化为可验证任务并闭环收口")).toBe(false);
    expect(looksLikeEpisode("A/B 测试对照≥10 组真实数据方可判定效果")).toBe(false); // A/B 无连字符数字
    expect(looksLikeEpisode("一贯做法是所有待拍板事项呈报后再执行")).toBe(false);
    expect(looksLikeEpisode("")).toBe(false);
  });
});
