#!/usr/bin/env node
/**
 * acceptance-scan.mjs — 全开档验收扫描器（Lead 自用，只读）
 *
 * 为什么这样扫：会话归档是 append-only 多帧 zstd（单帧解只读到 198 字符，必须按
 * magic 28 b5 2f fd 切帧逐帧解）。段证据分两处，不能用「全文搜标记」：
 *   1) head pack 是 ctx.systemPrompt.section（index.ts:551-556），只在
 *      system/message 事件的 data.message.content[].text 里能看到 → 扫 system/message。
 *   2) volatile 是 pre-step 追加的 user/message，带
 *      source.kind='plugin:tdb-agemem-dsh' + id='agemem-volatile-N' → 按 source 认，
 *      不能按正文认（正文里讨论标记会造成假阳性）。
 *
 * 用法：
 *   node scratch/lead/acceptance-scan.mjs [--session <sid前缀>] [--all] [--json]
 */
import { readdirSync, readFileSync, statSync, existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { zstdDecompressSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DSH_HOME = process.env.DSH_HOME || join(homedir(), ".dsh");
const SESSIONS = join(DSH_HOME, "sessions");

export function decodeSessionArchive(buf) {
  const out = [];
  let start = -1;
  for (let i = 0; i + 3 < buf.length; i += 1) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) {
      if (start >= 0 && i > start) {
        try { out.push(zstdDecompressSync(buf.subarray(start, i)).toString("utf8")); } catch { /* skip bad frame */ }
      }
      start = i;
      i += 3;
    }
  }
  if (start >= 0) {
    try { out.push(zstdDecompressSync(buf.subarray(start)).toString("utf8")); } catch { /* skip */ }
  }
  return out.join("");
}

/** head pack 段标记（顺序无关，只求命中与字符数）。 */
const HEADPACK_SEGMENTS = [
  { key: "core_memory", open: "<core_memory>", close: "</core_memory>" },
  { key: "identity_narrative", open: "<identity_narrative>", close: "</identity_narrative>" },
  { key: "strict_rule", open: "<strict_rule>", close: "</strict_rule>" },
  { key: "cloud_skills", open: "<cloud_skills>", close: "</cloud_skills>" },
  { key: "available_skills", open: "<available_skills>", close: "</available_skills>" },
  { key: "knowledge_tools", open: "<knowledge_tools>", close: "</knowledge_tools>" },
  { key: "scene_index", open: "长期记忆", close: null },
];

/** volatile 段标记（同一 user/message 里分账）。 */
const VOLATILE_SEGMENTS = [
  { key: "soul_identity", open: "<soul-identity>", close: "</soul-identity>" },
  { key: "soul_feeling", open: "<soul-feeling>", close: "</soul-feeling>" },
  { key: "relevant_memories", open: "<relevant-memories>", close: "</relevant-memories>" },
  { key: "team_wiki", open: "<team-wiki>", close: "</team-wiki>" },
  { key: "memory_hint", open: "【agemem 记忆提示】", close: null },
];

function measure(text, seg) {
  const i = text.indexOf(seg.open);
  if (i < 0) return { hit: false, chars: 0 };
  if (!seg.close) return { hit: true, chars: Math.max(0, Math.min(text.length - i, 2000)) };
  const j = text.indexOf(seg.close, i);
  return { hit: true, chars: j > i ? j + seg.close.length - i : seg.open.length };
}

function systemText(evt) {
  const c = evt?.data?.message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === "string" ? p : p?.text || "")).join("\n");
  return "";
}

function userText(evt) {
  const c = evt?.data?.message?.content ?? evt?.data?.content ?? evt?.message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === "string" ? p : p?.text || "")).join("\n");
  return "";
}

/** 归档布局：sessions/<workspace-scoped-dir>/<sessionId>/session.v4.jsonl.zstd（两层）。 */
function listSessionFiles() {
  if (!existsSync(SESSIONS)) return [];
  const out = [];
  for (const ws of readdirSync(SESSIONS)) {
    const wsPath = join(SESSIONS, ws);
    try { if (!statSync(wsPath).isDirectory()) continue; } catch { continue; }
    for (const sid of readdirSync(wsPath)) {
      const zst = join(wsPath, sid, "session.v4.jsonl.zstd");
      const plain = join(wsPath, sid, "session.v4.jsonl"); // 自检 fixture 用（真归档恒为 .zstd）
      const arch = existsSync(zst) ? zst : (existsSync(plain) ? plain : null);
      if (!arch) continue;
      out.push({ id: sid, workspace: ws, path: arch, mtime: statSync(arch).mtimeMs });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

function analyze(text) {
  let headPack = null;
  const volatiles = [];
  const tools = {};
  let assistantCount = 0;
  for (const ln of text.split("\n")) {
    if (!ln.trim()) continue;
    let evt;
    try { evt = JSON.parse(ln); } catch { continue; }
    if (evt.type === "assistant/message") assistantCount += 1;
    // 代码模式（PTC）下宿主只暴露 run_code，插件工具以 tool/ptc-dispatch 出现，
    // 所以「工具真的注册了」的归档判据是 ptc-dispatch 的 name，而不是 request/header.tools。
    if (evt.type === "tool/ptc-dispatch" || evt.type === "tool/call") {
      const n = evt?.data?.name;
      if (typeof n === "string") {
        tools[n] = tools[n] || { calls: 0, errors: 0 };
        tools[n].calls += 1;
        if (evt?.data?.isError) tools[n].errors += 1;
      }
    }
    if (evt.type === "system/message") {
      const t = systemText(evt);
      if (t.includes("<cloud_skills>") || t.includes("长期记忆") || t.includes("<core_memory>") || t.includes("<knowledge_tools>")) {
        headPack = { seq: evt.seq, turn: evt.data?.turn, chars: t.length, text: t };
      }
    }
    if (evt.type === "user/message") {
      // user/message 的 event.data 就是 message 本体（形状与 assistant/message 的 data.message 不同）
      const msg = evt?.data?.role ? evt.data : (evt?.data?.message ?? evt?.message ?? {});
      const src = msg.source;
      const id = msg.id;
      if (src?.kind === "plugin:tdb-agemem-dsh" && typeof id === "string" && id.startsWith("agemem-volatile-")) {
        const t = userText(evt);
        volatiles.push({ seq: evt.seq, id, chars: t.length, text: t });
      }
    }
  }
  const headRows = HEADPACK_SEGMENTS.map((s) => ({ ...s, ...(headPack ? measure(headPack.text, s) : { hit: false, chars: 0 }) }));
  const volRows = VOLATILE_SEGMENTS.map((s) => {
    const hits = volatiles.filter((v) => v.text.includes(s.open));
    const chars = hits.reduce((acc, v) => acc + measure(v.text, s).chars, 0);
    return { key: s.key, label: s.open, events: hits.length, chars };
  });
  return {
    assistantCount,
    headPackSeq: headPack?.seq ?? null,
    headPackChars: headPack?.chars ?? 0,
    headRows,
    volatileCount: volatiles.length,
    volatileChars: volatiles.reduce((a, v) => a + v.chars, 0),
    tools,
    volRows,
    traces: volatiles.map((v) => ({ seq: v.seq, id: v.id, chars: v.chars, hasSoul: v.text.includes("<soul-identity>"), hasMem: v.text.includes("<relevant-memories>"), hasWiki: v.text.includes("<team-wiki>") })),
  };
}

/** --selftest：造两个临时 DSH_HOME（全齐 / 全缺）跑本扫描器，证明判据能 PASS 也能 FAIL。 */
function selftest() {
  const mk = (root, events) => {
    const dir = join(root, "sessions", "--tmp--", "session-selftest-0001");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "session.v4.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    return root;
  };
  const roots = [];
  const headText = [
    "You are an AI agent.",
    "<core_memory>",
    "<identity_narrative>我是何晨的助手</identity_narrative>",
    "<strict_rule>不许自行 commit</strict_rule>",
    "</core_memory>",
    "<cloud_skills>available skills ...</cloud_skills>",
    "<knowledge_tools>knowledge ...</knowledge_tools>",
    "长期记忆 · 场景索引（L2）",
    "- scene_blocks/foo.md",
  ].join("\n");
  const full = [
    { type: "system/message", seq: 1, data: { turn: 1, step: 1, message: { role: "system", content: [{ type: "text", text: headText }] } } },
    { type: "user/message", seq: 2, data: { id: "agemem-volatile-1", role: "user", source: { kind: "plugin:tdb-agemem-dsh" }, content: [{ type: "text", text: "<soul-identity>红线</soul-identity>\n<relevant-memories>- [work_fact] x</relevant-memories>" }] } },
    { type: "tool/ptc-dispatch", seq: 3, data: { name: "memory_recall", isError: false } },
    ...REQUIRED_TOOLS.filter((n) => n !== "memory_recall").map((n, i) => ({ type: "tool/ptc-dispatch", seq: 10 + i, data: { name: n, isError: false } })),
  ];
  const empty = [{ type: "system/message", seq: 1, data: { turn: 1, step: 1, message: { role: "system", content: [{ type: "text", text: "nothing here" }] } } }];

  const a = mk(mkdtempSync(join(tmpdir(), "scanok-")), full);
  const b = mk(mkdtempSync(join(tmpdir(), "scanfail-")), empty);
  roots.push(a, b);
  const run = (root) => {
    const probe = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--json", "--strict"], { env: { ...process.env, DSH_HOME: root }, encoding: "utf8" });
    return probe;
  };
  const okRun = run(a);
  const badRun = run(b);
  let okParsed = null;
  try { okParsed = JSON.parse(okRun.stdout); } catch { /* noop */ }
  const okRep = okParsed?.reports?.[0];
  const pass = Boolean(okRep)
    && REQUIRED_HEAD.every((k) => okRep.headRows.some((r) => r.key === k && r.hit) || (k === "cloud_skills" && okRep.headRows.some((r) => r.key === "available_skills" && r.hit)))
    && REQUIRED_VOL.every((k) => okRep.volRows.some((r) => r.key === k && r.events))
    && REQUIRED_TOOLS.every((n) => okRep.tools[n]);
  const badExit = badRun.status;
  console.log("selftest full  PASS=" + pass + "  head=" + (okRep ? okRep.headRows.filter((r) => r.hit).length + "/" + okRep.headRows.length : "n/a") + "  vol=" + (okRep ? okRep.volRows.filter((r) => r.events).length + "/" + okRep.volRows.length : "n/a") + "  tools=" + (okRep ? REQUIRED_TOOLS.filter((n) => okRep.tools[n]).length : 0) + "/" + REQUIRED_TOOLS.length);
  console.log("selftest empty strict_exit=" + badExit + "（期望 1）");
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  if (!pass || badExit !== 1) { console.error("SELFTEST FAILED"); process.exitCode = 1; return false; }
  console.log("SELFTEST OK");
  return true;
}

function fmt(n) { return Number(n).toLocaleString("en-US"); }

const REQUIRED_HEAD = ["core_memory", "cloud_skills", "knowledge_tools"];
const REQUIRED_VOL = ["soul_identity", "relevant_memories"];

/** 全开档必须真实出现过的工具（task-72 的 10 个技能工具 + 召回 + knowledge）。 */
const REQUIRED_TOOLS = [
  "memory_recall",
  "skill_search", "skill_view", "skill_files_read",
  "skill_create", "skill_update", "skill_patch", "skill_delete", "skill_files_write", "skill_files_remove",
  "knowledge_search", "knowledge_read",
];

function main() {
  const argv = process.argv.slice(2);
  const wantJson = argv.includes("--json");
  const strict = argv.includes("--strict");
  const all = argv.includes("--all");
  const sidIdx = argv.indexOf("--session");
  const sid = sidIdx >= 0 ? argv[sidIdx + 1] : undefined;

  let files = listSessionFiles();
  if (sid) files = files.filter((f) => f.id.includes(sid));
  else if (!all) files = files.slice(0, 3);
  if (!files.length) { console.log(JSON.stringify({ ok: false, reason: "no archives", dir: SESSIONS })); process.exit(2); }

  const reports = files.map((f) => {
    const raw = readFileSync(f.path);
    const a = analyze(f.path.endsWith(".jsonl") ? raw.toString("utf8") : decodeSessionArchive(raw));
    return { sessionId: f.id, workspace: f.workspace, archiveBytes: statSync(f.path).size, ...a };
  });

  if (wantJson) {
    const failedJson = reports.filter((r) => {
      const aliasHit = r.headRows.some((s) => (s.key === "cloud_skills" || s.key === "available_skills") && s.hit);
      const mh = r.headRows.filter((s) => REQUIRED_HEAD.includes(s.key) && !s.hit && !((s.key === "cloud_skills" || s.key === "available_skills") && aliasHit));
      const mv = r.volRows.filter((s) => REQUIRED_VOL.includes(s.key) && !s.events);
      const mt = REQUIRED_TOOLS.filter((t) => !r.tools[t]);
      return mh.length > 0 || mv.length > 0 || mt.length > 0;
    }).length;
    console.log(JSON.stringify({ ok: true, dshHome: DSH_HOME, failed: failedJson, reports }, null, 2));
    return failedJson;
  }

  let failed = 0;

  console.log("DSH_HOME = " + DSH_HOME);
  process.exitCode = 0;
  for (const r of reports) {
    console.log("\n=== session " + r.sessionId);
    console.log("    ws=" + r.workspace + "  archive " + fmt(r.archiveBytes) + " bytes  assistant/message " + r.assistantCount);
    console.log("    --- head pack（ctx.systemPrompt.section，取最后一个 system/message）");
    if (r.headPackSeq === null) console.log("    [MISS] 归档里没有含段标记的 system/message（插件未加载 / headPack 关闭）");
    else {
      console.log("    seq=" + r.headPackSeq + "  系统提示全长 " + fmt(r.headPackChars) + " chars");
      for (const s of r.headRows) {
        const mark = s.hit ? "PASS" : "none";
        console.log("    [" + mark + "] " + String(s.key).padEnd(20) + (s.hit ? fmt(s.chars) + " chars" : "-"));
      }
    }
    console.log("    --- volatile（user/message, source.kind=plugin:tdb-agemem-dsh）: " + r.volatileCount + " 次 / " + fmt(r.volatileChars) + " chars");
    for (const s of r.volRows) console.log("    [" + (s.events ? "PASS" : "none") + "] " + String(s.label || s.key).padEnd(22) + s.events + " 次 / " + fmt(s.chars) + " chars");
    console.log("    --- 原生工具（tool/ptc-dispatch; 代码模式下插件工具只在这里出现）");
    const names = Object.keys(r.tools).sort((a, b) => r.tools[b].calls - r.tools[a].calls);
    for (const n of names) {
      const s = r.tools[n];
      const isSkill = n.startsWith("skill_") || n.startsWith("knowledge_") || n === "memory_recall";
      console.log("    " + (isSkill ? "[" + (s.errors ? "ERR" : "PASS") + "] " : "      ") + n.padEnd(24) + s.calls + " 次" + (s.errors ? " / " + s.errors + " 错" : ""));
    }
    const missingTools = REQUIRED_TOOLS.filter((t) => !r.tools[t]);
    // cloud_skills 与 available_skills 是同一能力的两种标签（core 渲染串 vs 旧标签），任一命中即算有。
    const skillAliasHit = r.headRows.some((s) => (s.key === "cloud_skills" || s.key === "available_skills") && s.hit);
    const missingHead = r.headRows
      .filter((s) => REQUIRED_HEAD.includes(s.key) && !s.hit)
      .filter((s) => !((s.key === "cloud_skills" || s.key === "available_skills") && skillAliasHit))
      .map((s) => s.key);
    const missingVol = r.volRows.filter((s) => REQUIRED_VOL.includes(s.key) && !s.events).map((s) => s.key);
    console.log("    MISSING: head=[" + (missingHead.join(",") || "无") + "] volatile=[" + (missingVol.join(",") || "无") + "] tools=[" + (missingTools.join(",") || "无") + "]");
    if (missingHead.length || missingVol.length || missingTools.length) failed += 1;
  }
  return failed;
}

if (process.argv.includes("--selftest")) {
  const ok = selftest();
  if (!ok) process.exitCode = 1;
} else {
const failedSessions = main();
// --strict：任一会话缺段/缺工具 ⇒ exit 1（发布门禁 G7 用）；不带 --strict 只打印。
if (process.argv.includes("--strict") && Number(failedSessions) > 0) process.exitCode = 1;
}