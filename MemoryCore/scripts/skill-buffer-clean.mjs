#!/usr/bin/env node
/**
 * skill-buffer-clean — 清理 skill 会话 buffer（L2 抽取前的暂存区）的运维脚本。
 *
 * 为什么需要它：`/v3/skill/conversation/add` 在触发归档前把消息攒在
 * `<dataDir>/skill_buffer/<user>/<team>/<agent>/<session>/`（data-current.jsonl +
 * meta.json，路径规则见 src/core/skill/conversation-add/buffer-storage.ts:153-158）。
 * 探针/联调会留下大量 `probe-*` 目录，而 **L2 归档后没有任何删除 API**，所以
 * buffer 是唯一能在不碰库的前提下清掉的现场。
 *
 * 边界（不要越界实现）：
 *   - 只删 session 级 buffer 目录（data-current.jsonl / data-*.jsonl / meta.json）。
 *     不动 <agent>/_tasks.json（队列状态），不动任何数据库、skills、records。
 *   - 已归档进 `scene_blocks/` 的 L2 行没有删除 API —— 属既有能力缺口，本脚本不处理。
 *
 * 安全不变量（防止"一个 glob 把生产 buffer 清了"）：
 *   1. 缺省 dry-run；真删必须显式 `--yes`。
 *   2. 不做通配：每个目标都是"skill_buffer 下恰好 4 层目录"且 basename 与选择器
 *      **精确相等**（`--all-probe` 也只接受 `^probe-[A-Za-z0-9._-]+$` 的字面名）。
 *   3. 目标目录必须自身含 meta.json 或 data-*.jsonl，否则跳过（不靠命名猜结构）。
 *   4. 链路上出现 symlink 一律跳过；删除前复核目标仍在 buffer 根之下。
 *   5. 不删空的 user/team/agent 父目录（可能还有别的 session 或 _tasks.json）。
 *
 * 用法（MemoryCore 目录下）：
 *   node scripts/skill-buffer-clean.mjs --list
 *   node scripts/skill-buffer-clean.mjs --session probe-conf-1793455078781-p5 [--namespace dshprobe:dshprobe:dshprobe]
 *   node scripts/skill-buffer-clean.mjs --all-probe                 # dry-run，只打印
 *   node scripts/skill-buffer-clean.mjs --all-probe --yes           # 真删
 *   node scripts/skill-buffer-clean.mjs --all-probe --yes --root D:/TDB/data
 *
 * 参数：
 *   --root <path>       数据根目录（其下应有 skill_buffer/）。缺省：TDAI_DATA_DIR env
 *                       → <MemoryCore>/tdai-gateway.yaml 的 data.baseDir。
 *   --config <path>     gateway yaml 路径（缺省 MemoryCore/tdai-gateway.yaml）。
 *   --session <id>      精确 session 目录名；可重复，也可用逗号分隔。
 *   --namespace <a:b:c> 限定 user:team:agent 三段（顺序 = 磁盘嵌套顺序，见
 *                       buffer-storage.ts:158，与票面写的 team:agent:user 不同）。
 *   --all-probe         选中所有 basename 形如 probe-<token> 的 session 目录。
 *   --list              只列出 buffer 里现存 session（不做选择，不删）。
 *   --dry-run           显式 dry-run（缺省行为；写进脚本时用）。
 *   --yes               真删。缺省（或无 --yes）一律只打印。
 *
 * 退出码：0 正常；2 用法/环境错误（例如同时没给选择器）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import YAML from "yaml";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG = path.resolve(SCRIPT_DIR, "..", "tdai-gateway.yaml");
const PROBE_RE = /^probe-[A-Za-z0-9._-]+$/;

const USAGE = `skill-buffer-clean — 清 skill 会话 buffer（只删 <dataDir>/skill_buffer/<user>/<team>/<agent>/<session>）

  node scripts/skill-buffer-clean.mjs --list
  node scripts/skill-buffer-clean.mjs --session <id> [--namespace user:team:agent] [--yes]
  node scripts/skill-buffer-clean.mjs --all-probe [--yes]
  node scripts/skill-buffer-clean.mjs --root <dataDir> [...]

缺省 dry-run；真删必须 --yes。`;

function parseCli() {
  const { values } = parseArgs({
    options: {
      root: { type: "string" },
      config: { type: "string" },
      session: { type: "string", multiple: true },
      namespace: { type: "string" },
      "all-probe": { type: "boolean", default: false },
      list: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
  });
  return values;
}

function die(msg) {
  console.error(`[skill-buffer-clean] ERROR: ${msg}`);
  console.error(USAGE);
  process.exit(2);
}

/** 与 scripts/lib/read-llm-credential.ts:8 同序：--root → TDAI_DATA_DIR → yaml data.baseDir。 */
function resolveRoot(values) {
  if (values.root && values.root.trim()) return path.resolve(values.root.trim());
  const envDir = process.env["TDAI_DATA_DIR"];
  if (envDir && envDir.trim()) return path.resolve(envDir.trim());
  const yamlPath = values.config ? path.resolve(values.config) : DEFAULT_CONFIG;
  try {
    const doc = YAML.parse(fs.readFileSync(yamlPath, "utf8"));
    const bd = doc && typeof doc === "object" && doc.data && typeof doc.data === "object" ? doc.data.baseDir : undefined;
    if (typeof bd === "string" && bd.trim()) {
      return path.resolve(bd.trim().startsWith("~") ? path.join(os.homedir(), bd.trim().slice(1)) : bd.trim());
    }
  } catch (err) {
    die(`读不到 ${yamlPath} 的 data.baseDir（${err instanceof Error ? err.message : String(err)}）；请用 --root 指定数据根目录`);
  }
  die("无法确定数据根目录：--root 未给，TDAI_DATA_DIR 未设，yaml 的 data.baseDir 也没有");
}

function isDir(p) {
  try {
    return fs.lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 枚举 buffer 根：<root>/skill_buffer 与 <root>/instances/<id>/skill_buffer（service 模式）。 */
function findBufferRoots(root) {
  const roots = [];
  const direct = path.join(root, "skill_buffer");
  if (isDir(direct)) roots.push(direct);
  const instances = path.join(root, "instances");
  if (isDir(instances)) {
    for (const inst of names(instances)) {
      const cand = path.join(instances, inst, "skill_buffer");
      if (isDir(cand)) roots.push(cand);
    }
  }
  return roots;
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function names(dir) {
  return safeReaddir(dir).filter((e) => e.isDirectory()).map((e) => e.name);
}

/** 单个 session 目录内部的文件清单（非递归：buffer 只写这一层）。 */
function sessionFiles(dir) {
  return safeReaddir(dir)
    .filter((e) => e.isFile())
    .map((e) => e.name);
}

/** 判定"这确实是一个 skill session 目录"，而不是随便一层同名目录。 */
function looksLikeSessionDir(dir) {
  const files = sessionFiles(dir);
  return files.includes("meta.json") || files.some((f) => /^data-.*\.jsonl$/.test(f));
}

function dirBytes(dir) {
  let bytes = 0;
  let files = 0;
  for (const e of safeReaddir(dir)) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const nested = dirBytes(p);
      bytes += nested.bytes;
      files += nested.files;
    } else if (e.isFile()) {
      files += 1;
      try {
        bytes += fs.statSync(p).size;
      } catch {
        /* ignore */
      }
    }
  }
  return { bytes, files };
}

function human(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(2)} MiB`;
}

/** 列出所有 session：{bufferRoot, user, team, agent, session, dir, depthOk}。 */
function enumerateSessions(bufferRoots) {
  const out = [];
  for (const bufferRoot of bufferRoots) {
    for (const user of names(bufferRoot)) {
      const userDir = path.join(bufferRoot, user);
      if (!isDir(userDir)) continue;
      for (const team of names(userDir)) {
        const teamDir = path.join(userDir, team);
        if (!isDir(teamDir)) continue;
        for (const agent of names(teamDir)) {
          const agentDir = path.join(teamDir, agent);
          if (!isDir(agentDir)) continue;
          for (const session of names(agentDir)) {
            const dir = path.join(agentDir, session);
            // 只认恰好这一层：更深的结构（未来扩展）不猜、不动。
            if (!isDir(dir)) continue;
            if (!looksLikeSessionDir(dir)) continue;
            out.push({ bufferRoot, user, team, agent, session, dir });
          }
        }
      }
    }
  }
  return out;
}

function fmtRow(s) {
  const { files, bytes } = dirBytes(s.dir);
  return `  ${s.dir}\n      files=${files} size=${human(bytes)} (${bytes} bytes)`;
}

function within(parent, child) {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** 删除前逐条复核（安全不变量 2/3/4/5）。返回 null 表示允许删除，否则返回拒绝原因。 */
function checkTarget(bufferRoot, s) {
  if (!within(bufferRoot, s.dir)) return `目标不在 buffer 根之下：${s.dir}`;
  const rel = path.relative(bufferRoot, s.dir).split(path.sep);
  if (rel.length !== 4) return `目标层级不是 <user>/<team>/<agent>/<session>（实际 ${rel.length} 层）`;
  const chain = [bufferRoot, path.join(bufferRoot, rel[0]), path.join(bufferRoot, rel[0], rel[1]), path.join(bufferRoot, rel[0], rel[1], rel[2]), s.dir];
  for (const p of chain) {
    try {
      if (fs.lstatSync(p).isSymbolicLink()) return `链路含 symlink，拒绝：${p}`;
    } catch {
      return `路径不可访问：${p}`;
    }
  }
  if (!looksLikeSessionDir(s.dir)) return `不像 session 目录（无 meta.json / data-*.jsonl）：${s.dir}`;
  return null;
}

function main() {
  const values = parseCli();
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const root = resolveRoot(values);
  if (!isDir(root)) die(`数据根目录不存在：${root}`);

  const bufferRoots = findBufferRoots(root);
  if (bufferRoots.length === 0) die(`${root} 下没有找到 skill_buffer/（standalone: <root>/skill_buffer；service: <root>/instances/<id>/skill_buffer）`);

  const all = enumerateSessions(bufferRoots);

  if (values.list) {
    console.log(`[skill-buffer-clean] root: ${root}`);
    console.log(`[skill-buffer-clean] buffer roots: ${bufferRoots.length}`);
    for (const r of bufferRoots) console.log(`  ${r}`);
    console.log(`[skill-buffer-clean] sessions: ${all.length}`);
    for (const s of all) console.log(`  ${s.user}/${s.team}/${s.agent}/${s.session}`);
    return;
  }

  const sessions = (values.session ?? []).flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);
  let namespace = null;
  if (values.namespace) {
    const parts = values.namespace.split(":").map((v) => v.trim());
    if (parts.length !== 3 || parts.some((v) => !v)) die(`--namespace 需要三段 user:team:agent（实际 ${values.namespace}）`);
    namespace = parts;
  }
  const allProbe = values["all-probe"] === true;

  if (sessions.length === 0 && !allProbe) {
    die("没有选择器：请给 --session <id>、--all-probe，或 --list 先看看有哪些 session");
  }

  const selected = all.filter((s) => {
    if (namespace && (s.user !== namespace[0] || s.team !== namespace[1] || s.agent !== namespace[2])) return false;
    if (allProbe && !PROBE_RE.test(s.session)) return false;
    if (sessions.length > 0 && !sessions.includes(s.session)) return false;
    return true;
  });

  const missing = sessions.filter((id) => !all.some((s) => s.session === id));
  if (missing.length > 0) {
    console.error(`[skill-buffer-clean] WARN: 以下 --session 在 buffer 里找不到（不会猜前缀匹配）：${missing.join(", ")}`);
  }

  console.log(`[skill-buffer-clean] root: ${root}`);
  for (const r of bufferRoots) console.log(`[skill-buffer-clean] buffer root: ${r}`);
  console.log(`[skill-buffer-clean] matched sessions: ${selected.length} / total ${all.length}`);

  // 逐条复核 + 汇总（复核失败的目标绝不进入删除列表）。
  const accepted = [];
  const rejected = [];
  for (const s of selected) {
    const reason = checkTarget(s.bufferRoot, s);
    if (reason) rejected.push({ s, reason });
    else accepted.push(s);
  }

  let totalBytes = 0;
  let totalFiles = 0;
  for (const s of accepted) {
    const { bytes, files } = dirBytes(s.dir);
    totalBytes += bytes;
    totalFiles += files;
    console.log(fmtRow(s));
  }
  for (const { s, reason } of rejected) console.log(`  SKIP ${s.dir} — ${reason}`);

  console.log(`[skill-buffer-clean] total: ${accepted.length} sessions, ${totalFiles} files, ${human(totalBytes)} (${totalBytes} bytes)`);

  if (!values.yes || values["dry-run"]) {
    console.log("[skill-buffer-clean] dry-run：未删除任何东西。复核上面的路径后加 --yes 才会真删。");
    console.log("[skill-buffer-clean] 边界：只清 buffer；已归档进 scene_blocks 的 L2 行没有删除 API（既有缺口）。");
    return;
  }

  let deleted = 0;
  for (const s of accepted) {
    try {
      fs.rmSync(s.dir, { recursive: true, force: false });
      if (fs.existsSync(s.dir)) {
        console.error(`[skill-buffer-clean] ERROR: 删除后仍存在：${s.dir}`);
      } else {
        deleted += 1;
        console.log(`  DELETED ${s.dir}`);
      }
    } catch (err) {
      console.error(`[skill-buffer-clean] ERROR: 删除失败 ${s.dir}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(`[skill-buffer-clean] deleted ${deleted}/${accepted.length} sessions, freed ${human(totalBytes)} (${totalBytes} bytes)`);
  console.log("[skill-buffer-clean] 边界：只清 buffer；已归档进 scene_blocks 的 L2 行没有删除 API（既有缺口）。");

  // 删除后复核：再枚举一次，确认这些 session 目录已消失。
  const after = new Set(enumerateSessions(bufferRoots).map((s) => s.dir));
  const leftovers = accepted.filter((s) => after.has(s.dir));
  if (leftovers.length > 0) {
    console.error(`[skill-buffer-clean] ERROR: 复核失败，仍有 ${leftovers.length} 个 session 目录存在：`);
    for (const s of leftovers) console.error(`  ${s.dir}`);
    process.exitCode = 1;
  }
}

main();
