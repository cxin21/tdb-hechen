/**
 * generated/schemas.ts 自引用闭合守卫。
 *
 * 背景：#127 已确立「Kubb 源 spec（docs/team-api-仅memory.yaml）不在仓内 →
 * 生成物只能手工同步」的既定事实。该 spec 从未入库（2026-11-02 取证：上游
 * 4 个分支 full tree、229 提交全历史、GitHub 全站代码搜索、npm tarball 均为阴性）。
 *
 * 手工同步时代必须保证「被引用的名字都有定义」，否则 tsc 报
 * Cannot find name（TS2304 / TS2552）。2026-11-02 的 51 条红正是这么来的：
 * wiki / code-graph 两段 operation 被生成，其 components 定义却缺失。
 *
 * 本用例不锁具体名字，只锁不变量 —— 将来再漏一处会直接 RED。
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const schemasSrc = readFileSync(resolve(here, "generated/schemas.ts"), "utf8");
const typesSrc = readFileSync(resolve(here, "generated/types.ts"), "utf8");

/** schemas.ts 从 types.ts 导入的类型名集合。 */
function importedTypeNames(): Set<string> {
  const m = schemasSrc.match(/import type \{[^}]*\} from "\.\/types\.ts"/);
  if (!m) return new Set();
  const body = m[0].replace(/^import type \{/, "").replace(/\}[^}]*$/, "");
  return new Set(
    body
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/** schemas.ts 文件内定义的 `export const xxxSchema` 名字集合。 */
function definedSchemaNames(): Set<string> {
  const names = new Set<string>();
  for (const m of schemasSrc.matchAll(/^export const ([A-Za-z_$][\w$]*) =/gm)) {
    names.add(m[1]);
  }
  return names;
}

/** types.ts 文件内定义的 `export type Xxx` 名字集合。 */
function definedTypeNames(): Set<string> {
  const names = new Set<string>();
  for (const m of typesSrc.matchAll(/^export type ([A-Za-z_$][\w$]*)/gm)) {
    names.add(m[1]);
  }
  return names;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

describe("generated/schemas.ts 自引用闭合", () => {
  it("z.lazy(() => X) 里的 X 必须在文件内被定义", () => {
    const defined = definedSchemaNames();
    const dangling: string[] = [];
    for (const m of schemasSrc.matchAll(/z\.lazy\(\(\) => ([A-Za-z_$][\w$]*)\)/g)) {
      if (!defined.has(m[1])) dangling.push(m[1]);
    }
    expect(uniqueSorted(dangling)).toEqual([]);
  });

  it("z.ZodType<T> 里的 T 必须已从 types.ts 导入或在文件内定义", () => {
    const imported = importedTypeNames();
    const defined = definedSchemaNames();
    const dangling: string[] = [];
    for (const m of schemasSrc.matchAll(/z\.ZodType<([A-Za-z_$][\w$]*)>/g)) {
      const name = m[1];
      if (!imported.has(name) && !defined.has(name)) dangling.push(name);
    }
    expect(uniqueSorted(dangling)).toEqual([]);
  });

  it("表达式里裸引用的 XxxSchema 必须已在文件内定义", () => {
    const defined = definedSchemaNames();
    const dangling: string[] = [];
    // 形如 wikiListDataSchema.optional() / skillSummarySchema.and(...)
    for (const m of schemasSrc.matchAll(/([a-z][A-Za-z0-9_$]*Schema)\.(?:optional|and|describe|nullable)/g)) {
      if (!defined.has(m[1])) dangling.push(m[1]);
    }
    expect(uniqueSorted(dangling)).toEqual([]);
  });

  it("z.ZodType<T> 里的 T 必须能在 types.ts 里找到定义（防导入不存在的类型）", () => {
    const imported = importedTypeNames();
    const definedTypes = definedTypeNames();
    const missing: string[] = [];
    for (const name of imported) {
      if (!definedTypes.has(name)) missing.push(name);
    }
    expect(uniqueSorted(missing)).toEqual([]);
  });
});
