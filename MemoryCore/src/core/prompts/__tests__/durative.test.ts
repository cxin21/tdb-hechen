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

  it("生产 yaml durativeEnabled: true 已落盘（cloud 模板同步；部署机限定，非 Linux 开发机跳过）", () => {
    // 评审建议：/opt/tdai 硬编码路径=部署机限定断言，非部署机必然 FileNotFoundError
    // → 存在性守卫跳过（部署机上照常生效，开发机全量套件不再恒 1 红）。
    const prodPath = "/opt/tdai/td-agemem/MemoryCore/tdai-gateway.yaml";
    const tplPath = "/opt/tdai/td-agemem/deploy/tencent-cloud/config/core/tdai-gateway.cloud.yaml";
    if (!fs.existsSync(prodPath) || !fs.existsSync(tplPath)) {
      return; // skip（环境不适用）
    }
    const prod = fs.readFileSync(prodPath, "utf8");
    expect(prod).toMatch(/durativeEnabled: true/);
    const tpl = fs.readFileSync(tplPath, "utf8");
    expect(tpl).toMatch(/durativeEnabled: true/);
  });
});