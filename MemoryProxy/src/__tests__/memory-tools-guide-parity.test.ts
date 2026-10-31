import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  MEMORY_TOOLS_GUIDE,
  MEMORY_TOOLS_GUIDE_VERSION,
  GUIDANCE_OVERRIDES_FROM_SINGLE_SOURCE,
  PROXY_TOOL_DOCS,
} from "../injection/injectors/memory-tools-guide.proxy.js";
import { MEMORY_TOOLS_GUIDE as INJECTOR_GUIDE } from "../injection/injectors/tdai-profile-memory-injector.js";
import { listRegisteredToolNames } from "../injection/injectors/tdai-tools-injector.js";

/**
 * MemoryProxy 侧 guide **适配版** × MemoryCore 单一源的**结构**对拍。
 *
 * 为什么不是逐字对拍：两包暴露给 LLM 的工具集不同——源面向钩子路，第三个工具是
 * tdai_read_cos（MemoryCore/src/core/tools/read-cos.ts:153）并引用「下方 Scene Navigation」；
 * 本包只注册 6 个 curl 工具（无 tdai_read_cos），逐字照抄会让 LLM 调幻影工具，还漏掉
 * atomic_query / conversation_query / scenario_ls。所以本测试守住三件事：
 *   ① 纪律句与版本串逐字 == 源（反拒答口径不许漂移）；
 *   ② 本文件工具名集合 == 本包真实注册集（从 tdai-tools-injector 渲染结果解析，不手抄）；
 *   ③ 适配版 != 源，且每处差异都在 GUIDANCE_OVERRIDES_FROM_SINGLE_SOURCE 里登记。
 */

const CANON_PATH = fileURLToPath(
  new URL("../../../MemoryCore/src/core/prompts/memory-tools-guide.ts", import.meta.url),
);

/** 从源文件文本里抠出 MEMORY_TOOLS_GUIDE 模板字面量与版本号（不 import 源，避免跨包依赖）。 */
function readCanon(): { guide: string; version: string } | null {
  if (!existsSync(CANON_PATH)) return null;
  const raw = readFileSync(CANON_PATH, "utf8");
  const guide = raw.match(/export const MEMORY_TOOLS_GUIDE = (`[\s\S]*?`);\n/);
  const version = raw.match(/export const MEMORY_TOOLS_GUIDE_VERSION = "([^"]+)";/);
  if (!guide || !version) return null;
  return { guide: guide[1].slice(1, -1), version: version[1] };
}

const canon = readCanon();
if (!canon) {
  // 读不到源文件不静默通过：打印原因，逐字/派生比对整体跳过（集合类断言仍跑）
  console.warn(`[guide-parity] 读不到 MemoryCore 单一源，跳过逐字/派生比对：${CANON_PATH}`);
}

/** 解析「- **tdai_xxx**：…」清单行 → 工具名集合。 */
function parseToolList(text: string): Set<string> {
  return new Set(Array.from(text.matchAll(/^- \*\*(tdai_[a-z_]+)\*\*：/gm), (m) => m[1]));
}

const guideTools = parseToolList(MEMORY_TOOLS_GUIDE);
const registryTools = new Set(listRegisteredToolNames());

describe("① 纪律句 / 版本串：与单一源逐字一致", () => {
  it.skipIf(!canon)("开篇反拒答句逐字 == 源", () => {
    const canonIntro = canon!.guide
      .split("\n")
      .find((l) => l.startsWith("已注入的记忆优先使用"));
    expect(canonIntro).toBeTruthy();
    expect(MEMORY_TOOLS_GUIDE).toContain(canonIntro!);
  });

  it.skipIf(!canon)("调用次数限制整段逐字 == 源", () => {
    const start = canon!.guide.indexOf("### ⚠️ 调用次数限制");
    const end = canon!.guide.lastIndexOf("</memory-tools-guide>");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const canonLimit = canon!.guide.slice(start, end).trimEnd();
    expect(MEMORY_TOOLS_GUIDE).toContain(canonLimit);
  });

  it.skipIf(!canon)("版本号与源文件一致", () => {
    expect(MEMORY_TOOLS_GUIDE_VERSION).toBe(canon!.version);
    expect(MEMORY_TOOLS_GUIDE_VERSION).toMatch(/memory-tools-guide-v/);
  });
});

describe("② 工具名集合：与本包真实注册集集合相等（不手抄名单）", () => {
  it("guide 里讲的工具集合 == tdai-tools-injector 实际渲染的 <tool name> 集合", () => {
    expect(registryTools.size).toBeGreaterThan(0);
    expect([...guideTools].sort()).toEqual([...registryTools].sort());
  });

  it("PROXY_TOOL_DOCS 与 guide 正文同源（每个 doc 的 name 都在正文里）", () => {
    expect(PROXY_TOOL_DOCS.length).toBe(registryTools.size);
    for (const doc of PROXY_TOOL_DOCS) {
      expect(guideTools.has(doc.name)).toBe(true);
    }
  });

  it("注册集包含 proxy 特有的 tdai_read_scene，且不含幻影工具 tdai_read_cos", () => {
    expect(registryTools.has("tdai_read_scene")).toBe(true);
    expect(registryTools.has("tdai_read_cos")).toBe(false);
  });

  it.skipIf(!canon)("源里有、本包没有的工具，必须在 overrides.source 里点名", () => {
    const canonTools = parseToolList(canon!.guide);
    const missing = [...canonTools].filter((t) => !registryTools.has(t));
    for (const t of missing) {
      expect(
        GUIDANCE_OVERRIDES_FROM_SINGLE_SOURCE.some((o) => o.source?.includes(t)),
        `源工具 ${t} 在本包未注册，但 overrides 里没登记`,
      ).toBe(true);
    }
    // 已知的具体缺口：read_cos（本包用 read_scene 替代）
    expect(missing).toContain("tdai_read_cos");
  });

  it.skipIf(!canon)("本包有、源里没有的工具，必须在 overrides.proxy 里写明用途", () => {
    const canonTools = parseToolList(canon!.guide);
    const added = [...registryTools].filter((t) => !canonTools.has(t));
    for (const t of added) {
      expect(
        GUIDANCE_OVERRIDES_FROM_SINGLE_SOURCE.some((o) => o.proxy.includes(t)),
        `本包工具 ${t} 源里没有，但 overrides 里没登记`,
      ).toBe(true);
    }
    expect(added.sort()).toEqual(
      ["tdai_atomic_query", "tdai_conversation_query", "tdai_read_scene", "tdai_scenario_ls"].sort(),
    );
  });
});

describe("③ 适配版 != 源，且差异已显式登记", () => {
  it.skipIf(!canon)("正文与源不同（防止有人顺手改回逐字，把幻影工具带回来）", () => {
    expect(MEMORY_TOOLS_GUIDE).not.toBe(canon!.guide);
  });

  it("每处 override 都写清了 源 / 本侧 / 为什么", () => {
    expect(GUIDANCE_OVERRIDES_FROM_SINGLE_SOURCE.length).toBeGreaterThanOrEqual(5);
    for (const o of GUIDANCE_OVERRIDES_FROM_SINGLE_SOURCE) {
      expect(o.field.length).toBeGreaterThan(2);
      expect(o.proxy.length).toBeGreaterThan(2);
      expect(o.why.length).toBeGreaterThan(10);
      if (o.source !== null) expect(o.source.length).toBeGreaterThan(2);
    }
  });

  it("块名口径已统一到本包真实块名 <l2_scene_index>", () => {
    expect(MEMORY_TOOLS_GUIDE).toContain("<l2_scene_index>");
    expect(MEMORY_TOOLS_GUIDE).not.toContain("Scene Navigation");
    expect(
      GUIDANCE_OVERRIDES_FROM_SINGLE_SOURCE.some((o) => o.source === "下方 Scene Navigation"),
    ).toBe(true);
  });

  it("正文不含幻影工具名", () => {
    expect(MEMORY_TOOLS_GUIDE).not.toContain("tdai_read_cos");
  });
});

describe("镜像/适配不含旧的诱导拒答框架", () => {
  it.each([
    "这不是文档",
    "不足以回答",
    "请直接根据已有信息回复",
    "我在记忆里没找到",
    "不要幻想",
  ])("不含「%s」", (banned) => {
    expect(MEMORY_TOOLS_GUIDE).not.toContain(banned);
  });

  it("正面纪律必须在场：有相关记忆就得答，只有完全无线索才说明无法确定", () => {
    expect(MEMORY_TOOLS_GUIDE).toContain("不要因为记忆不完整而拒答");
    expect(MEMORY_TOOLS_GUIDE).toContain("只有已注入的记忆也完全没有相关线索时才说明无法确定");
    expect(MEMORY_TOOLS_GUIDE).toContain("合计最多调用 3 次");
  });
});

describe("注入器用的是这份适配版常量，不是内联副本", () => {
  it("injector 导出的 MEMORY_TOOLS_GUIDE 就是适配版常量（同一引用）", () => {
    expect(INJECTOR_GUIDE).toBe(MEMORY_TOOLS_GUIDE);
  });

  it("injector 源文件里不再内联旧文案、也不内联 guide 正文", () => {
    const injectorSrc = readFileSync(
      fileURLToPath(new URL("../injection/injectors/tdai-profile-memory-injector.ts", import.meta.url)),
      "utf8",
    );
    for (const banned of ["这不是文档", "不足以回答", "我在记忆里没找到", "请直接根据已有信息回复"]) {
      expect(injectorSrc).not.toContain(banned);
    }
    expect(injectorSrc).toContain('from "./memory-tools-guide.proxy.js"');
  });
});
