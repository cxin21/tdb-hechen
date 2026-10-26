/**
 * 落盘路径边界（issue #114 回归锚）：
 *
 * ingest-v2 的落盘路径由 LLM 抽取的 `type` 间接推导。历史上这条推导链既没有白名单，
 * 也没有根目录校验：恶意/异常 type 能拼出逃出项目根目录的相对路径——
 * 读会把根目录外的文件内容读进 merge prompt（外泄），写会把文件落在项目外。
 *
 * 两道卡口：
 *   1) slug.ts 的 dirForType —— type 只认白名单内的标识符，其余一律回落 other；
 *   2) safe-path.ts 的 isInsideRoot —— commitCandidates 读写前确认路径没逃出项目根目录。
 */
import { test, expect, describe, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dirForType, pageRelPath } from "../src/engines/wiki/ingest-v2/slug.js";
import { canonicalizePagePath, commitCandidates } from "../src/engines/wiki/ingest-v2/index.js";
import { isInsideRoot } from "../src/engines/wiki/ingest-v2/safe-path.js";
import { parseFileBlocks } from "../src/engines/wiki/ingest-v2/file-protocol.js";
import type { LlmClient } from "../src/engines/wiki/ingest-v2/llm.js";

/** 恶意 type：原型链成员 + 目录穿越片段。 */
const MALICIOUS_TYPES = ["__proto__", "constructor", "..", "a/b"];

/** 记录每次 chat 调用的假 LLM——用来断言「越界文件内容没被读进 merge prompt」。 */
function mockLlm(calls: string[]): LlmClient {
  return {
    config: {
      protocol: "openai",
      baseUrl: "http://127.0.0.1:1",
      apiKey: "test",
      model: "test",
      maxTokens: 16,
      timeoutMs: 1000,
      maxRetries: 0,
      stream: false,
    },
    async chat(params) {
      calls.push(params.prompt);
      return "---\ntype: entity\ntitle: merged\n---\nmerged body\n";
    },
  };
}

/** 本次测试用到的临时目录，afterEach 统一清理。 */
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 建一个临时项目目录：base 下放 proj/（项目根）与可能的同级文件。 */
function tempProject(prefix: string): { base: string; projectPath: string } {
  const base = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(base);
  const projectPath = join(base, "proj");
  mkdirSync(projectPath, { recursive: true });
  return { base, projectPath };
}

describe("dirForType：type 白名单", () => {
  test("恶意 type 一律回落 other（原型链成员 + 穿越片段）", () => {
    for (const t of MALICIOUS_TYPES) {
      expect(dirForType(t), `type=${t}`).toBe("other");
    }
  });

  test("已知 type 仍映射到约定目录（不回归）", () => {
    expect(dirForType("source")).toBe("sources");
    expect(dirForType("entity")).toBe("entities");
    expect(dirForType("concept")).toBe("concepts");
    expect(dirForType("comparison")).toBe("comparisons");
    expect(dirForType("synthesis")).toBe("synthesis");
    expect(dirForType("thesis")).toBe("synthesis");
    expect(dirForType("methodology")).toBe("concepts");
    expect(dirForType("finding")).toBe("synthesis");
  });

  test("大小写与空白归一后仍按已知 type 处理", () => {
    expect(dirForType("  ENTITY  ")).toBe("entities");
    expect(dirForType("Source")).toBe("sources");
  });

  test("未知但合法的 type 以自身作 generic 目录（保住 LLM 已有的目录约定）", () => {
    expect(dirForType("sources")).toBe("sources");
    expect(dirForType("people")).toBe("people");
  });

  test("空 type 回落 other", () => {
    expect(dirForType("")).toBe("other");
    expect(dirForType("   ")).toBe("other");
  });

  test("pageRelPath 对恶意 type 也只产出 wiki/other/ 下的路径", () => {
    for (const t of MALICIOUS_TYPES) {
      const p = pageRelPath(t, "Redis");
      expect(p, `type=${t}`).toBe("wiki/other/redis.md");
    }
  });
});

describe("isInsideRoot：根目录边界", () => {
  const root = join(tmpdir(), "wiki-root-probe");

  test("root 自身与 root 内的路径算在内", () => {
    expect(isInsideRoot(root, root)).toBe(true);
    expect(isInsideRoot(root, join(root, "wiki", "a.md"))).toBe(true);
  });

  test("越界路径算在外", () => {
    expect(isInsideRoot(root, join(root, "..", "evil.md"))).toBe(false);
    expect(isInsideRoot(root, join(root, "..", "..", "etc", "passwd"))).toBe(false);
  });

  test("同前缀的兄弟目录不算在内", () => {
    expect(isInsideRoot(root, `${root}-evil/a.md`)).toBe(false);
  });
});

describe("canonicalizePagePath：落盘路径不越界", () => {
  test("恶意 type 被规整到 wiki/other/ 下", () => {
    const content = ["---", "type: ../../evil", "title: Redis", "---", "正文"].join("\n");
    const rel = canonicalizePagePath("wiki/sources/redis.md", content);
    expect(rel).toBe("wiki/other/redis.md");
    expect(rel).not.toContain("..");
  });

  test("原型链成员 type 不再被字符串化进目录名", () => {
    for (const t of ["__proto__", "constructor"]) {
      const content = ["---", `type: ${t}`, "title: Redis", "---", "正文"].join("\n");
      const rel = canonicalizePagePath("wiki/sources/redis.md", content);
      expect(rel, `type=${t}`).toBe("wiki/other/redis.md");
    }
  });

  test("正常 type 的规范路径不回归", () => {
    const content = ["---", "type: entity", "title: Redis Cluster", "---", "正文"].join("\n");
    expect(canonicalizePagePath("wiki/entity/redis.md", content)).toBe("wiki/entities/redis-cluster.md");
  });
});

describe("端到端：LLM 输出的恶意 type 不会落盘到根目录外", () => {
  test("4 个恶意 type 走完整链路后落在 wiki/other/，且根目录外无文件", async () => {
    for (const t of MALICIOUS_TYPES) {
      const { base, projectPath } = tempProject("wiki-e2e-");

      // 模拟 LLM 原始输出：FILE 块里的 path 是「正常」的，恶意只藏在 frontmatter 的 type 上。
      const llmOut = [
        "<<<FILE path=wiki/entity/redis.md>>>",
        "---",
        `type: ${t}`,
        "title: Redis",
        "---",
        "正文",
        "<<<END>>>",
      ].join("\n");

      const { files } = parseFileBlocks(llmOut);
      expect(files, `type=${t}`).toHaveLength(1);

      // 完整推导链：LLM 输出 → parseFileBlocks → canonicalizePagePath → 候选路径
      const rel = canonicalizePagePath(files[0].path, files[0].content);
      expect(rel, `type=${t}`).toBe("wiki/other/redis.md");
      expect(rel, `type=${t}`).not.toContain("..");

      // 完整落盘链：候选路径 → commitCandidates → 写盘
      const calls: string[] = [];
      const result = await commitCandidates(
        projectPath,
        [{ sourceFilename: "src.md", candidates: new Map([[rel, files[0].content]]) }],
        mockLlm(calls),
      );
      expect(result.mergeErrors, `type=${t}`).toEqual([]);
      expect(result.written, `type=${t}`).toEqual(["wiki/other/redis.md"]);
      expect(existsSync(join(projectPath, "wiki", "other", "redis.md")), `type=${t}`).toBe(true);

      // 根目录外没有落盘：base 下除项目根外无任何新增文件。
      const siblings = readdirSync(base).filter((n) => n !== "proj");
      expect(siblings, `type=${t}`).toEqual([]);

      // 也没有被当成原型链成员名建出目录。
      const wikiDir = join(projectPath, "wiki");
      const wikiEntries = existsSync(wikiDir) ? readdirSync(wikiDir) : [];
      expect(wikiEntries.filter((n) => n === "__proto__" || n === "constructor"), `type=${t}`).toEqual([]);
    }
  });
});

describe("commitCandidates：越界落盘被阻断", () => {
  test("逃出项目根目录的 relPath 不写盘、不读盘，并记入 mergeErrors", async () => {
    const { base, projectPath } = tempProject("wiki-escape-");

    // 项目外的一份「敏感」文件：越界路径正好指向它。
    const outsideFile = join(base, "outside.md");
    writeFileSync(outsideFile, "TOP-SECRET-CONTENT", "utf-8");

    const calls: string[] = [];
    const result = await commitCandidates(
      projectPath,
      [{ sourceFilename: "src.md", candidates: new Map([["wiki/../../outside.md", "---\ntype: entity\n---\nnew body\n"]]) }],
      mockLlm(calls),
    );

    // 未写入任何根目录外的文件；根目录外那份原文未被覆盖。
    expect(readFileSync(outsideFile, "utf-8")).toBe("TOP-SECRET-CONTENT");
    expect(result.written).toEqual([]);
    expect(result.mergeErrors).toHaveLength(1);
    expect(result.mergeErrors[0].error).toContain("escapes project root");

    // 越界文件内容没被读进 merge prompt。
    expect(calls.join("\n")).not.toContain("TOP-SECRET-CONTENT");
  });

  test("项目内的正常路径照常落盘（不回归）", async () => {
    const { projectPath } = tempProject("wiki-normal-");

    const calls: string[] = [];
    const result = await commitCandidates(
      projectPath,
      [{ sourceFilename: "src.md", candidates: new Map([["wiki/entities/redis.md", "---\ntype: entity\n---\nbody\n"]]) }],
      mockLlm(calls),
    );

    expect(result.mergeErrors).toEqual([]);
    expect(result.written).toEqual(["wiki/entities/redis.md"]);
    expect(existsSync(join(projectPath, "wiki", "entities", "redis.md"))).toBe(true);
  });
});
