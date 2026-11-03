import test from "node:test";
import assert from "node:assert/strict";
import { parseDiagnostics, compareDiagnostics, groupAsObject, sortObject } from "./typecheck-gate-lib.mjs";

/** 造一行 tsc --pretty false 输出 */
const diag = (file, line, code, message = "boom") => `${file}(${line},5): error ${code}: ${message}`;

const snapshot = (lines) => parseDiagnostics(lines.join("\n"));

/** 基线只由 CLI --update 写；测试里手工构造同形状对象 */
const baselineOf = (snap) => ({
  total: snap.total,
  fileCount: snap.fileCount,
  globalErrors: snap.globalErrors,
  byCode: snap.byCode,
  byFile: snap.byFile,
  groups: groupAsObject(snap.byGroup),
});

test("解析：文件路径归一、按文件/错误码/组计数、全局错误单列", () => {
  const snap = snapshot([
    "src/a.ts(1,5): error TS2304: Cannot find name 'wikiListDataSchema'.",
    "src/a.ts(2,5): error TS2304: Cannot find name 'wikiDetailSchema'.",
    "src\\win\\b.ts(3,5): error TS2552: Cannot find name 'ListWiki200'. Did you mean 'ListSkill200'?",
    "error TS5055: Output file has been built.",
  ]);
  assert.equal(snap.total, 4);
  assert.equal(snap.globalErrors, 1);
  assert.equal(snap.byFile["src/a.ts"], 2);
  assert.equal(snap.byFile["src/win/b.ts"], 1, "Windows 反斜杠必须归一成 /");
  assert.equal(snap.byCode.TS2304, 2);
  assert.equal(snap.byGroup["src/a.ts\u0000TS2304"], 2);
  assert.equal(snap.details[0].line, 1);
  assert.equal(snap.details[0].code, "TS2304");
});

test("同行换错误码、文件面积不变 ⇒ 不算新增，只记 reclassified", () => {
  const base = baselineOf(snapshot([diag("src/generated/schemas.ts", 1373, "TS2304")]));
  const now = snapshot([diag("src/generated/schemas.ts", 1373, "TS2552")]);
  const cmp = compareDiagnostics(now, base);
  assert.deepEqual(cmp.added, [], "同一行只换了诊断码，不得判新增");
  assert.equal(cmp.removed.length, 0);
  assert.equal(cmp.reclassified.length, 1);
  assert.equal(cmp.reclassified[0].file, "src/generated/schemas.ts");
  assert.deepEqual(cmp.reclassified[0].before, { TS2304: 1 });
  assert.deepEqual(cmp.reclassified[0].after, { TS2552: 1 });
});

test("同文件错误数变多 ⇒ 新增（按文件面积判）", () => {
  const base = baselineOf(snapshot([diag("src/a.ts", 1, "TS2304")]));
  const now = snapshot([diag("src/a.ts", 1, "TS2304"), diag("src/a.ts", 9, "TS2304")]);
  const cmp = compareDiagnostics(now, base);
  assert.equal(cmp.added.length, 1);
  assert.equal(cmp.added[0].file, "src/a.ts");
  assert.equal(cmp.added[0].before, 1);
  assert.equal(cmp.added[0].after, 2);
  assert.equal(cmp.added[0].newFile, false);
});

test("出现基线外的新文件 ⇒ 新增，并标记 newFile", () => {
  const base = baselineOf(snapshot([diag("src/a.ts", 1, "TS2304")]));
  const now = snapshot([diag("src/a.ts", 1, "TS2304"), diag("src/new.ts", 3, "TS2551")]);
  const cmp = compareDiagnostics(now, base);
  assert.equal(cmp.added.length, 1);
  assert.equal(cmp.added[0].file, "src/new.ts");
  assert.equal(cmp.added[0].newFile, true);
});

test("同文件错误数变少 ⇒ 只记 removed，不算新增", () => {
  const base = baselineOf(snapshot([diag("src/a.ts", 1, "TS2304"), diag("src/a.ts", 2, "TS2304")]));
  const now = snapshot([diag("src/a.ts", 1, "TS2304")]);
  const cmp = compareDiagnostics(now, base);
  assert.deepEqual(cmp.added, []);
  assert.equal(cmp.removed.length, 1);
  assert.equal(cmp.removed[0].after, 1);
});

test("全局错误变多 ⇒ 新增（不受文件面积豁免）", () => {
  const base = baselineOf(snapshot(["error TS5055: Output file has been built."]));
  const now = snapshot([
    "error TS5055: Output file has been built.",
    "error TS6307: File is not listed within the file list of project.",
  ]);
  const cmp = compareDiagnostics(now, base);
  assert.equal(cmp.added.length, 1);
  assert.equal(cmp.added[0].file, "<global>");
  assert.equal(cmp.added[0].before, 1);
  assert.equal(cmp.added[0].after, 2);
});

test("完全一致 ⇒ added/removed/reclassified 全空", () => {
  const snap = snapshot([diag("src/a.ts", 1, "TS2304"), diag("src/b.ts", 7, "TS18048")]);
  const cmp = compareDiagnostics(snap, baselineOf(snap));
  assert.deepEqual(cmp.added, []);
  assert.deepEqual(cmp.removed, []);
  assert.deepEqual(cmp.reclassified, []);
});

test("多文件混合：换码的文件记 INFO、变多的文件记 FAIL，互不干扰", () => {
  const base = baselineOf(snapshot([diag("src/generated/schemas.ts", 1373, "TS2304"), diag("src/a.ts", 1, "TS2304")]));
  const now = snapshot([
    diag("src/generated/schemas.ts", 1373, "TS2552"),
    diag("src/a.ts", 1, "TS2304"),
    diag("src/a.ts", 2, "TS2304"),
  ]);
  const cmp = compareDiagnostics(now, base);
  assert.deepEqual(
    cmp.added.map((a) => a.file),
    ["src/a.ts"],
  );
  assert.deepEqual(
    cmp.reclassified.map((r) => r.file),
    ["src/generated/schemas.ts"],
  );
});

test("sortObject 键序稳定（基线 diff 不抖动）", () => {
  assert.deepEqual(Object.keys(sortObject({ b: 1, a: 2 })), ["a", "b"]);
});

test("v3 回归锁：同文件非名称解析族互换（面积不变）⇒ FAIL", () => {
  // 审查 MAJOR：v2 按文件面积判时，「旧错消失 + 新错出现」面积不变却 PASS。
  const base = baselineOf(snapshot([diag("src/recall.ts", 10, "TS18048")]));
  const now = snapshot([diag("src/recall.ts", 10, "TS2532")]);
  const cmp = compareDiagnostics(now, base);
  assert.equal(cmp.reclassified.length, 0, "非族内互换不得归为 INFO");
  assert.deepEqual(
    cmp.added.map((a) => [a.file, a.code]),
    [["src/recall.ts", "TS2532"]],
  );
  assert.deepEqual(
    cmp.removed.map((r) => [r.file, r.code]),
    [["src/recall.ts", "TS18048"]],
  );
});

test("v3 回归锁：同文件新增第三种错误码、同时旧码减少（面积不变）⇒ FAIL", () => {
  const base = baselineOf(snapshot([diag("src/a.ts", 1, "TS2304"), diag("src/a.ts", 2, "TS2304")]));
  const now = snapshot([diag("src/a.ts", 1, "TS2304"), diag("src/a.ts", 2, "TS7006")]);
  const cmp = compareDiagnostics(now, base);
  assert.deepEqual(
    cmp.added.map((a) => a.code),
    ["TS7006"],
  );
});

test("v3：名称解析族内一增一减恰好抵消 ⇒ 只记 INFO，不 FAIL", () => {
  const base = baselineOf(snapshot([diag("src/g.ts", 1, "TS2304"), diag("src/g.ts", 2, "TS2304")]));
  const now = snapshot([diag("src/g.ts", 1, "TS2552"), diag("src/g.ts", 2, "TS2552")]);
  const cmp = compareDiagnostics(now, base);
  assert.deepEqual(cmp.added, []);
  assert.deepEqual(cmp.removed, []);
  assert.deepEqual(
    cmp.reclassified.map((r) => r.file),
    ["src/g.ts"],
  );
});

test("v3：族内增得比减得多 ⇒ 差额仍算新增", () => {
  const base = baselineOf(snapshot([diag("src/g.ts", 1, "TS2304")]));
  const now = snapshot([diag("src/g.ts", 1, "TS2552"), diag("src/g.ts", 2, "TS2552")]);
  const cmp = compareDiagnostics(now, base);
  assert.deepEqual(
    cmp.added.map((a) => [a.code, a.before, a.after]),
    [["TS2552", 0, 2]],
  );
});
