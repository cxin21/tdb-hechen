/**
 * B1 生产化（bench/recall-opt G1）：注入块时间序打包——纯函数排序器单测。
 *
 * 口径（与 bench buildEvidenceBlock 同一比较器语义）：
 *  - 提取行首 [YYYY-MM-DD HH:MM(:SS)?] 前缀作为时间键，升序（旧→新）；
 *  - 无时间前缀的行排在最后，彼此保持原相对顺序；
 *  - 同时间键保持原相对顺序（稳定排序）；
 *  - 空数组透传。
 */
import { describe, expect, it } from "vitest";
import { leadingTimestampOf, sortLinesByLeadingTimestamp } from "../inject-order.js";

describe("sortLinesByLeadingTimestamp（G1 注入块时间序）", () => {
  it("空数组透传", () => {
    expect(sortLinesByLeadingTimestamp([])).toEqual([]);
  });

  it("单元素透传", () => {
    const one = ["[2023-05-01 10:00] User: hi"];
    expect(sortLinesByLeadingTimestamp(one)).toEqual(one);
  });

  it("按行首时间戳升序（旧→新）", () => {
    const lines = [
      "[2023-08-11 16:44] User: three tops",
      "[2023-01-03 09:00] User: early",
      "[2023-12-31 23:59] User: late",
    ];
    expect(sortLinesByLeadingTimestamp(lines)).toEqual([
      "[2023-01-03 09:00] User: early",
      "[2023-08-11 16:44] User: three tops",
      "[2023-12-31 23:59] User: late",
    ]);
  });

  it("支持秒级与 T 分隔符", () => {
    const lines = [
      "[2023-05-01T10:00:30] a",
      "[2023-05-01 10:00] b",
      "[2023-05-01 10:00:00] c",
    ];
    // b 与 c 同键（秒省略=00），a 带 30 秒最后；b/c 保持原相对顺序
    expect(sortLinesByLeadingTimestamp(lines)).toEqual(["[2023-05-01 10:00] b", "[2023-05-01 10:00:00] c", "[2023-05-01T10:00:30] a"]);
  });

  it("无时间前缀的行排最后，保持原相对顺序", () => {
    const lines = [
      "no ts B",
      "[2023-01-01 00:00] has ts",
      "no ts A",
    ];
    expect(sortLinesByLeadingTimestamp(lines)).toEqual([
      "[2023-01-01 00:00] has ts",
      "no ts B",
      "no ts A",
    ]);
  });

  it("同时间键稳定（保持原相对顺序）", () => {
    const lines = [
      "[2023-05-01 10:00] first",
      "mid",
      "[2023-05-01 10:00] second",
    ];
    const out = sortLinesByLeadingTimestamp(lines);
    expect(out.indexOf("[2023-05-01 10:00] first")).toBeLessThan(out.indexOf("[2023-05-01 10:00] second"));
  });

  it("leadingTimestampOf：无前缀返回哨兵最大值", () => {
    expect(leadingTimestampOf("no ts")).toBe("9999-99-99 99:99");
    expect(leadingTimestampOf("[2023-05-01 08:00] x")).toBe("2023-05-01 08:00");
  });

  it("不修改输入数组", () => {
    const lines = ["[2023-02-01 00:00] b", "[2023-01-01 00:00] a"];
    sortLinesByLeadingTimestamp(lines);
    expect(lines).toEqual(["[2023-02-01 00:00] b", "[2023-01-01 00:00] a"]);
  });
});

import { parseConfig } from "../../../config.js";

describe("recall.injectTimeSort / injectWrapper parse（G1）", () => {
  it("缺省 = 关 + legacy（逐位现状）", () => {
    const cfg = parseConfig({});
    expect(cfg.recall.injectTimeSort).toEqual({ enabled: false });
    expect(cfg.recall.injectWrapper).toBe("legacy");
  });
  it("显式开启/取值", () => {
    const cfg = parseConfig({ recall: { injectTimeSort: { enabled: true }, injectWrapper: "neutral" } });
    expect(cfg.recall.injectTimeSort).toEqual({ enabled: true });
    expect(cfg.recall.injectWrapper).toBe("neutral");
  });
  it("非法 injectWrapper 回落 legacy", () => {
    const cfg = parseConfig({ recall: { injectWrapper: "bogus" } });
    expect(cfg.recall.injectWrapper).toBe("legacy");
  });
});
