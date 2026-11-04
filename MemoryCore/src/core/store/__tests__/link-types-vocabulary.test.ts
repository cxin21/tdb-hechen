import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LINK_TYPES, LINK_TYPE_VALUES } from "../types.js";

/**
 * D 项（2026-11-04）：边型受控词表越界门。
 *
 * **读真实源文件文本**（不用 AST、不 import 生产模块）：五个写点的边型字面量必须
 * 全部来自 store/types.ts 的 LINK_TYPES，禁止再散落字符串。任一写点新增了词表外
 * 边型（如 'causal'），本测试立即红——词表只有一处可改。
 *
 * 期望出现次数按写点实测钉死（正则失效 / 写点被静默删掉都会红，防"空集 ⊆ 全集"的永真）。
 */
const HERE = dirname(fileURLToPath(import.meta.url));
/** MemoryCore/src（__tests__ → store → core → src）。 */
const SRC_ROOT = resolve(HERE, "../../..");

/** 写点清单 → 该文件应被识别出的边型引用次数。 */
const WRITE_POINTS: ReadonlyArray<{ file: string; tokens: number }> = [
  { file: "core/record/l1-extractor.ts", tokens: 5 },
  { file: "core/lifecycle/consolidation/consolidation-worker.ts", tokens: 1 },
  { file: "core/lifecycle/reflection.ts", tokens: 1 },
  { file: "core/lifecycle/evolution-worker.ts", tokens: 4 },
  { file: "utils/pipeline-factory.ts", tokens: 1 },
];

/** `LINK_TYPES.XXX` 常量引用。 */
const LINK_TYPES_REF = /LINK_TYPES\.([A-Z][A-Z0-9_]*)/g;
/** `addLink(...)` / `addLink?.(...)` / `addLink!(...)` 调用及其实参文本。 */
const ADD_LINK_CALL = /addLink\s*(?:\?\.|!)?\s*(?:\.\s*call\s*)?\(([^)]*)\)/g;
/** 实参里的短标识符字符串字面量（即边型字面量）。 */
const ADD_LINK_LITERAL = /["']([a-z][a-z_]*?)["']/g;
/** 读点 `getLinksByType('literal')`（须改用常量）。 */
const GET_LINKS_BY_TYPE_LITERAL = /getLinksByType\s*\(\s*["'][a-z_]+["']/g;

interface Scan {
  readonly refs: string[];
  readonly literals: string[];
  readonly badReads: string[];
  readonly text: string;
}

function scan(rel: string): Scan {
  const text = readFileSync(resolve(SRC_ROOT, rel), "utf8");
  const refs = Array.from(text.matchAll(LINK_TYPES_REF), (m) => m[1] as string);
  const literals: string[] = [];
  for (const call of text.matchAll(ADD_LINK_CALL)) {
    for (const lit of (call[1] ?? "").matchAll(ADD_LINK_LITERAL)) literals.push(lit[1] as string);
  }
  const badReads = Array.from(text.matchAll(GET_LINKS_BY_TYPE_LITERAL), (m) => m[0]);
  return { refs, literals, badReads, text };
}

const SCANS = WRITE_POINTS.map((p) => ({ ...p, scan: scan(p.file) }));
const ALL_TYPES = new Set<string>(LINK_TYPE_VALUES);

describe("D 项 · 边型受控词表 LINK_TYPES", () => {
  it("词表恰为六项，无 causal，值全为小写 snake_case 且无重复", () => {
    expect([...LINK_TYPE_VALUES].sort()).toEqual(
      ["conflict", "derived_from", "evolve", "evolved_from", "part_of", "similar"].sort(),
    );
    expect(LINK_TYPE_VALUES).toHaveLength(6);
    expect(LINK_TYPE_VALUES).not.toContain("causal");
    for (const v of LINK_TYPE_VALUES) expect(v).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(new Set(LINK_TYPE_VALUES).size).toBe(LINK_TYPE_VALUES.length);
  });

  it("LINK_TYPES 的六个键与值一一对应（无别名/无漂移）", () => {
    expect(Object.keys(LINK_TYPES).sort()).toEqual([
      "CONFLICT",
      "DERIVED_FROM",
      "EVOLVE",
      "EVOLVED_FROM",
      "PART_OF",
      "SIMILAR",
    ]);
    expect(LINK_TYPES.DERIVED_FROM).toBe("derived_from");
    expect(LINK_TYPES.SIMILAR).toBe("similar");
    expect(LINK_TYPES.PART_OF).toBe("part_of");
    expect(LINK_TYPES.CONFLICT).toBe("conflict");
    expect(LINK_TYPES.EVOLVE).toBe("evolve");
    expect(LINK_TYPES.EVOLVED_FROM).toBe("evolved_from");
  });

  it("五个写点不再散落边型字面量（全部走 LINK_TYPES）", () => {
    const offenders = SCANS.flatMap((s) => s.scan.literals.map((lit) => `${s.file}: ${lit}`));
    expect(offenders).toEqual([]);
  });

  it("五个写点的边型引用全部落在词表内且次数与写点清单一致", () => {
    for (const s of SCANS) {
      // 常量键必须真实存在于词表（防 LINK_TYPES.EVOLVED 之类拼写漂移）
      for (const key of s.scan.refs) {
        expect(Object.prototype.hasOwnProperty.call(LINK_TYPES, key), `${s.file}: LINK_TYPES.${key} 不在词表`).toBe(
          true,
        );
        expect(ALL_TYPES.has((LINK_TYPES as Record<string, string>)[key] as string)).toBe(true);
      }
      expect(s.scan.refs.length, `${s.file} 边型引用数`).toBe(s.tokens);
    }
  });

  it("evolution-worker 的 getLinksByType 读点也用常量（无字面量）", () => {
    for (const s of SCANS) expect(s.scan.badReads, s.file).toEqual([]);
  });

  /**
   * 全仓兜底（对抗评审 P2-7）：上面的 WRITE_POINTS 是**白名单**——新增第 6 个写入点、
   * 或有人在别的生产文件里写 addLink('...','causal') 都不会红。这里改成扫整个 src
   * （排除 __tests__ / *.test.ts），任何生产文件的 addLink 实参里出现字面量边型即失败。
   */
  it("src 全量（不含测试）没有任何 addLink/getLinksByType 边型字面量", () => {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const abs = resolve(dir, name);
        if (statSync(abs).isDirectory()) {
          if (name === "__tests__" || name === "node_modules") continue;
          walk(abs);
          continue;
        }
        if (!name.endsWith(".ts") || name.endsWith(".test.ts") || name.endsWith(".d.ts")) continue;
        files.push(abs);
      }
    };
    walk(SRC_ROOT);
    expect(files.length).toBeGreaterThan(100); // 防扫空目录造成的永真
    const offenders: string[] = [];
    for (const abs of files) {
      const text = readFileSync(abs, "utf8");
      const rel = abs.slice(SRC_ROOT.length + 1).replace(/\\/g, "/");
      for (const call of text.matchAll(ADD_LINK_CALL)) {
        for (const lit of (call[1] ?? "").matchAll(ADD_LINK_LITERAL)) offenders.push(`${rel}: addLink 字面量 \"${lit[1]}\"`);
      }
      for (const bad of text.matchAll(GET_LINKS_BY_TYPE_LITERAL)) offenders.push(`${rel}: ${bad[0]}`);
    }
    expect(offenders).toEqual([]);
  });

  /**
   * 脚本面（2026-11-04 D 项收尾，对抗评审 P2-7 复查）：`MemoryCore/scripts/*.ts` 是
   * 一次性验收脚本，不是生产写点——**允许**用字面量，但取值必须落在词表内。
   * 这条把此前的 `'causal'`（词表外，已迁到 `LINK_TYPES.DERIVED_FROM`）钉死，
   * 防止新手脚本再把已废弃边型写回库里。
   */
  it("scripts 的边型字面量必须 ⊆ LINK_TYPES（允许字面量、禁止词表外取值）", () => {
    const scriptsRoot = resolve(SRC_ROOT, "../scripts");
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const abs = resolve(dir, name);
        if (statSync(abs).isDirectory()) {
          if (name === "node_modules") continue;
          walk(abs);
          continue;
        }
        if (!name.endsWith(".ts") || name.endsWith(".test.ts") || name.endsWith(".d.ts")) continue;
        files.push(abs);
      }
    };
    walk(scriptsRoot);
    expect(files.length).toBeGreaterThan(5); // 防扫空目录造成的永真
    /**
     * 取 addLink 的**第 3 个实参**（边型位）文本：src 的写点测试能直接扫全部字面量，
     * 因为那里的前两个实参都是变量；脚本里前两个实参常是节点 id 字面量（"a"/"alien"），
     * 扫全集会把它们误判成边型。按顶层逗号切分，跳过引号/模板/嵌套括号里的逗号。
     */
    const thirdArg = (args: string): string => {
      const parts: string[] = [];
      let buf = "";
      let quote = "";
      let depth = 0;
      for (let i = 0; i < args.length; i++) {
        const ch = args[i] as string;
        if (quote) {
          buf += ch;
          if (ch === quote && args[i - 1] !== "\\") quote = "";
          continue;
        }
        if (ch === '"' || ch === "'" || ch === "`") { quote = ch; buf += ch; continue; }
        if (ch === "(" || ch === "[" || ch === "{") depth++;
        if (ch === ")" || ch === "]" || ch === "}") depth--;
        if (ch === "," && depth === 0) { parts.push(buf); buf = ""; continue; }
        buf += ch;
      }
      parts.push(buf);
      return (parts[2] ?? "").trim();
    };
    const offenders: string[] = [];
    for (const abs of files) {
      const text = readFileSync(abs, "utf8");
      const rel = abs.slice(scriptsRoot.length + 1).replace(/\\/g, "/");
      for (const call of text.matchAll(ADD_LINK_CALL)) {
        const typeArg = thirdArg(call[1] ?? "");
        const lit = /^(["'])([a-z][a-z_]*?)\1$/.exec(typeArg);
        if (lit && !ALL_TYPES.has(lit[2] as string)) {
          offenders.push(`scripts/${rel}: addLink 词表外边型 "${lit[2]}"`);
        }
      }
      for (const bad of text.matchAll(GET_LINKS_BY_TYPE_LITERAL)) {
        const lit = /["']([a-z_]+)["']/.exec(bad[0])?.[1] ?? "";
        if (!ALL_TYPES.has(lit)) offenders.push(`scripts/${rel}: ${bad[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
