/**
 * #74 Batch A · sanitizeRecallQuery 两级剥噪契约（合同 §1.2）。
 *
 * D4 定案：清洗后残留 < 10 字符 → skipped=true（一级：整条跳过，零检索零注入）；
 * 否则返回清洗后查询（二级：清洗后检索）。阈值常量 MIN_QUERY_RESIDUAL_CHARS=10 导出。
 * RED 形态：函数与常量尚不存在——import 失败即 feature-missing RED。
 */
import { describe, expect, it } from "vitest";
import { MIN_QUERY_RESIDUAL_CHARS, sanitizeRecallQuery } from "../sanitize.js";

describe("sanitizeRecallQuery · 两级剥噪（#74 D4）", () => {
  it("常量=10（D4 定案口径）", () => {
    expect(MIN_QUERY_RESIDUAL_CHARS).toBe(10);
  });

  it("纯脚手架查询 → skipped=true + 空文本（一级：整条跳过）", () => {
    const raw = [
      '<acp tokens="30" type="text">m00207</acp>',
      "Time sampled while preparing turn 45, step 1: 2026-10-20T03:15:00+08:00[Asia/Shanghai]",
      "Browser time zone for this request: Asia/Shanghai. Interpret otherwise-unqualified dates and times in this zone.",
      "⚠️ Context limit reached — compress now",
    ].join("\n");
    const r = sanitizeRecallQuery(raw);
    expect(r.skipped).toBe(true);
    expect(r.text).toBe("");
    expect(r.residualChars).toBe(0);
  });

  it("脚手架+真实问题 → skipped=false + 清洗后查询（二级：清洗后检索）", () => {
    const raw = [
      '<acp tokens="18" type="text">m00209</acp>',
      "【Compressed conversation section】— 任务接单",
      "帮我分析召回精度不足的根因",
    ].join("\n");
    const r = sanitizeRecallQuery(raw);
    expect(r.skipped).toBe(false);
    expect(r.text).toBe("帮我分析召回精度不足的根因");
  });

  it("干净查询逐位保留（仅首尾空白 trim）", () => {
    const raw = "  重启 tdai-core 后 journal 行为不变  ";
    const r = sanitizeRecallQuery(raw);
    expect(r.skipped).toBe(false);
    expect(r.text).toBe("重启 tdai-core 后 journal 行为不变");
  });

  it("边界：残留恰好 9 字符 → skip；10 字符 → 检索", () => {
    expect(sanitizeRecallQuery("一二三四五六七八九").skipped).toBe(true);
    const r10 = sanitizeRecallQuery("一二三四五六七八九十");
    expect(r10.skipped).toBe(false);
    expect(r10.text).toBe("一二三四五六七八九十");
  });

  it("裸 m-ref+脚手架混合后残留不足 → skip（六 pattern 全参战）", () => {
    const raw = "m00207\n【Compressed conversation section】\n[soul-feeling] 平稳";
    const r = sanitizeRecallQuery(raw);
    expect(r.skipped).toBe(true);
    expect(r.text).toBe("");
  });
});
