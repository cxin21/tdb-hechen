/** GROW-EVO P2：durative 提取契约测试（prompt 契约 + 生产 yaml 落盘验证）。 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import * as extraction from "../../prompts/l1-extraction.js";

function allStrings(obj: unknown, out: string[] = []): string[] {
  if (typeof obj === "string") out.push(obj);
  else if (Array.isArray(obj)) obj.forEach((v) => allStrings(v, out));
  else if (obj && typeof obj === "object") Object.values(obj).forEach((v) => allStrings(v, out));
  return out;
}

describe("GROW-EVO P2 durative 提取契约", () => {
  it("提取 prompt 含 durative 判定指令（域外防泄漏：指令文本含宁缺毋滥兜底）", () => {
    const strings = allStrings(extraction);
    const joined = strings.join("\n");
    expect(joined).toContain("durative");
    expect(joined).toContain("valid_start");
    expect(joined).toContain("判定不了给 false");
  });

  it("生产 yaml durativeEnabled: true 已落盘（cloud 模板同步）", () => {
    const prod = fs.readFileSync("/opt/tdai/td-agemem/MemoryCore/tdai-gateway.yaml", "utf8");
    expect(prod).toMatch(/durativeEnabled: true/);
    const tpl = fs.readFileSync("/opt/tdai/td-agemem/deploy/tencent-cloud/config/core/tdai-gateway.cloud.yaml", "utf8");
    expect(tpl).toMatch(/durativeEnabled: true/);
  });
});