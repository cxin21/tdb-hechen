import { describe, it, expect } from "vitest";
import {
  isSessionInitTailDumpEnabled,
  summarizeSessionInitTail,
  SESSION_INIT_TAIL_ENV,
} from "../session-init-tail.js";

const SECRET = "用户的私有正文：我叫何晨，工号 12345，密码别写进来";

describe("summarizeSessionInitTail（日志脱敏）", () => {
  it("缺省不回显正文，只给类型与长度", () => {
    const out = summarizeSessionInitTail([
      { role: "system", content: "sys" },
      { role: "user", content: SECRET },
      { role: "user", content: SECRET },
    ]);
    expect(out).not.toContain("何晨");
    expect(out).not.toContain("密码");
    expect(out).toContain(`string(len=${SECRET.length})`);
    expect(out).toContain("role=user");
  });

  it("显式 dumpBody 才回显前 80 字，且仍截断", () => {
    const out = summarizeSessionInitTail([{ role: "user", content: SECRET }], { dumpBody: true });
    expect(out).toContain("何晨");
    expect(out).toContain(`string(len=${SECRET.length})`);
    const long = "x".repeat(500);
    const truncated = summarizeSessionInitTail([{ role: "user", content: long }], { dumpBody: true });
    expect(truncated).not.toContain("x".repeat(200));
    expect(truncated.split('"')[1].length).toBe(80);
  });

  it("数组 content 只报 block 类型，不报 block 内文本", () => {
    const out = summarizeSessionInitTail([
      {
        role: "user",
        content: [
          { type: "text", text: SECRET },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        ],
      },
    ]);
    expect(out).toContain("array[text,image_url]");
    expect(out).not.toContain("何晨");
    expect(out).not.toContain("base64");
  });

  it("tool_call_id / tool_calls.id 一律截断，避免长 id 灌日志", () => {
    const out = summarizeSessionInitTail([
      {
        role: "tool",
        content: "ok",
        tool_call_id: "call_0123456789abcdef",
        tool_calls: [{ id: "call_0123456789abcdef" }],
      },
    ]);
    expect(out).not.toContain("call_0123456789abcdef");
    expect(out).toContain("call_012…");
  });

  it("只取最后 3 条（前面的大正文不进日志）", () => {
    const out = summarizeSessionInitTail([
      { role: "user", content: "OLD-" + "a".repeat(100) },
      { role: "user", content: "b" },
      { role: "user", content: "c" },
      { role: "user", content: "d" },
    ], { dumpBody: true });
    expect(out).not.toContain("OLD-");
    expect(out.split("[0]")[1]?.startsWith("role=user content=string(len=1) \"b\"")).toBe(true);
  });

  it("异常形状不抛：null / 缺字段 / 非字符串 role", () => {
    const out = summarizeSessionInitTail([null, {}, { role: 42, content: null }, { content: undefined }]);
    expect(out).toContain("role=?");
    expect(out).toContain("content=null");
    expect(out).toContain("content=undefined");
  });

  it("环境开关严格等于 \"1\" 才开启（0/true/空都不算）", () => {
    expect(isSessionInitTailDumpEnabled({ [SESSION_INIT_TAIL_ENV]: "1" } as NodeJS.ProcessEnv)).toBe(true);
    for (const v of ["0", "true", "", "yes", " 1"]) {
      expect(isSessionInitTailDumpEnabled({ [SESSION_INIT_TAIL_ENV]: v } as NodeJS.ProcessEnv)).toBe(false);
    }
    expect(isSessionInitTailDumpEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });
});
