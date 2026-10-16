/**
 * ① 全角引号容错（B 类失败根因修复的回归锚）：
 * 模型把 FILE 开标签的 path 属性定界符写成全角引号 “…”（U+201C/201D）时，
 * 解析器必须照样识别（2026-10-15 全球化规范.md generate 189s 正常返回却 parse_empty files=0 的实锤）。
 * 约束：只放宽 path 属性定界符，绝不改动正文内容（中文正文里的 “” 是合法内容）。
 */
import { test, expect } from "vitest";
import { parseFileBlocks, normalizeWikiPath } from "../src/engines/wiki/ingest-v2/file-protocol.js";

test("全角双引号定界的 FILE 开标签可解析", () => {
  const out = [
    '<<<FILE path=“wiki/sources/全球化规范.md”>>>',
    "---",
    "type: source",
    "title: 全球化规范",
    "---",
    "正文A",
    "<<<END>>>",
  ].join("\n");
  const { files, warnings } = parseFileBlocks(out);
  expect(warnings).toEqual([]);
  expect(files).toHaveLength(1);
  expect(files[0].path).toBe("wiki/sources/全球化规范.md");
  expect(files[0].content).toContain("正文A");
});

test("直引号定界（原始协议）不受影响", () => {
  const out = [
    '<<<FILE path="wiki/sources/a.md">>>',
    "---",
    "type: source",
    "---",
    "正文B",
    "<<<END>>>",
  ].join("\n");
  const { files, warnings } = parseFileBlocks(out);
  expect(warnings).toEqual([]);
  expect(files).toHaveLength(1);
  expect(files[0].path).toBe("wiki/sources/a.md");
});

test("全角开、直角收的混合定界也能解析", () => {
  const out = [
    '<<<FILE path=“wiki/sources/b.md">>>',
    "---",
    "type: source",
    "---",
    "正文C",
    "<<<END>>>",
  ].join("\n");
  const { files } = parseFileBlocks(out);
  expect(files).toHaveLength(1);
  expect(files[0].path).toBe("wiki/sources/b.md");
});

test("正文中的全角引号原样保留，不被当作定界符消费", () => {
  const out = [
    '<<<FILE path="wiki/sources/c.md">>>',
    "---",
    "type: source",
    "---",
    "他说“你好”之后离开了。",
    "<<<END>>>",
  ].join("\n");
  const { files } = parseFileBlocks(out);
  expect(files).toHaveLength(1);
  expect(files[0].content).toContain("他说“你好”之后离开了。");
});

test("normalizeWikiPath 行为不回归", () => {
  expect(normalizeWikiPath("wiki/sources/x.md")).toBe("wiki/sources/x.md");
  expect(normalizeWikiPath("../etc/passwd")).toBeNull();
  expect(normalizeWikiPath("C:/win/tmp.md")).toBeNull();
});

test("裸路径形态（无 path= 属性）可解析——2026-10-15 查询-报表.md 实锤", () => {
  const out = [
    "<<<FILE wiki/sources/query-report.md>>>",
    "---",
    "type: source",
    "title: 查询-报表",
    "---",
    "正文D",
    "<<<END>>>",
  ].join("\n");
  const { files, warnings } = parseFileBlocks(out);
  expect(warnings).toEqual([]);
  expect(files).toHaveLength(1);
  expect(files[0].path).toBe("wiki/sources/query-report.md");
  expect(files[0].content).toContain("正文D");
});

test("attributed 与裸路径混合输出可全部解析", () => {
  const out = [
    '<<<FILE path="wiki/sources/mix1.md">>>',
    "正文E",
    "<<<END>>>",
    "<<<FILE wiki/sources/mix2.md>>>",
    "正文F",
    "<<<END>>>",
  ].join("\n");
  const { files, warnings } = parseFileBlocks(out);
  expect(warnings).toEqual([]);
  expect(files.map((f) => f.path)).toEqual(["wiki/sources/mix1.md", "wiki/sources/mix2.md"]);
});

test("裸路径带引号或 path= 无引号前缀的变体也可解析", () => {
  const q = parseFileBlocks(['<<<FILE "wiki/sources/q.md">>>', "正文G", "<<<END>>>"].join("\n"));
  expect(q.files[0]?.path).toBe("wiki/sources/q.md");
  const p = parseFileBlocks(["<<<FILE path=wiki/sources/p.md>>>", "正文H", "<<<END>>>"].join("\n"));
  expect(p.files[0]?.path).toBe("wiki/sources/p.md");
});
