#!/usr/bin/env node
/**
 * 归档既有 bench 报告（审计 M7 配套，一次性把历史数据救回来）。
 *
 * 病根：重跑用同名文件就地覆盖 ⇒ r141 五臂的判分行被后来的检索-only 跑覆盖，
 * 只剩 cov、judged=0，20 张票的旧结论失去原始读数。
 *
 * 做法（缺省 --dry-run，只打印计划）：
 *   <stem>.json → <stem>-<yyyymmdd-HHMMSS>-<配置指纹 sha8>.json（同名再加 -2）
 *   时间戳取报告里的 generatedAt（缺失则退化为文件 mtime）；指纹优先取
 *   config.effectiveFingerprint，缺失则按 sha256(canonical(config)) 现算。
 * 已符合命名规则的（-\d{8}-\d{6}-[0-9a-f]{8}(-\d+)?\.json$）跳过；
 * latest.json / *.manifest.json / *.md 不算报告本体（.md 跟随 .json 一起改名）。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf("--" + n);
  return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : true) : d;
};
const dir = String(flag("dir", path.resolve(process.cwd(), ".eval-data/bench")));
const apply = argv.includes("--apply");

const CANON_RE = /-\d{8}-\d{6}-[0-9a-f]{8}(-\d+)?\.json$/;

function compactFrom(iso, fallbackMs) {
  const d = iso ? new Date(iso) : new Date(fallbackMs ?? Date.now());
  const t = isNaN(d.getTime()) ? new Date(fallbackMs ?? Date.now()) : d;
  return t.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
}

function fpOf(config) {
  if (!config) return "nofp";
  const given = config.effectiveFingerprint;
  if (typeof given === "string" && given) return given;
  const canon = JSON.stringify(config.effective ?? config.effectiveConfig ?? config);
  return crypto.createHash("sha256").update(canon).digest("hex").slice(0, 8);
}

if (!fs.existsSync(dir)) {
  console.error(`[archive] 目录不存在: ${dir}`);
  process.exit(2);
}

const entries = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "latest.json" && !/\.manifest\.json$/.test(f));
const plan = [];
for (const f of entries.sort()) {
  if (CANON_RE.test(f)) continue;
  const full = path.join(dir, f);
  let report = null;
  try {
    report = JSON.parse(fs.readFileSync(full, "utf8"));
  } catch (e) {
    console.warn(`[archive] 跳过（不是合法 JSON）: ${f}`);
    continue;
  }
  if (!report || !Array.isArray(report.rows)) {
    console.warn(`[archive] 跳过（无 rows，不是 bench 报告）: ${f}`);
    continue;
  }
  const stem = f.replace(/\.json$/, "");
  const compact = compactFrom(report.generatedAt, fs.statSync(full).mtimeMs);
  const fp = fpOf(report.config);
  let target = `${stem}-${compact}-${fp}`;
  for (let n = 2; fs.existsSync(path.join(dir, target + ".json")) || fs.existsSync(path.join(dir, target + ".md")); n++) {
    target = `${stem}-${compact}-${fp}-${n}`;
  }
  plan.push({ from: f, to: target + ".json", mdFrom: stem + ".md", mdTo: target + ".md" });
}

if (!plan.length) {
  console.log("[archive] 没有需要归档的报告（全部已符合 <stem>-<时间戳>-<指纹> 命名）");
  process.exit(0);
}

for (const p of plan) {
  console.log(`[archive] ${apply ? "改名" : "将改名"} ${p.from} → ${p.to}`);
  if (!apply) continue;
  fs.renameSync(path.join(dir, p.from), path.join(dir, p.to));
  if (fs.existsSync(path.join(dir, p.mdFrom))) {
    fs.renameSync(path.join(dir, p.mdFrom), path.join(dir, p.mdTo));
  }
}

// latest 指针：指向 generatedAt 最新的报告（不是 mtime，改名会保留 mtime 但内容时间才是读数时间）。
const latestPath = path.join(dir, "latest.json");
if (apply) {
  const reports = fs.readdirSync(dir).filter((f) => CANON_RE.test(f));
  let best = null;
  for (const f of reports) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      const t = Date.parse(j.generatedAt ?? 0) || 0;
      if (!best || t > best.t) best = { f, t, tag: j.config?.tag ?? null };
    } catch {
      /* 坏报告不参与 */
    }
  }
  if (best) {
    let prev = null;
    try { prev = JSON.parse(fs.readFileSync(latestPath, "utf8")); } catch { /* 首次 */ }
    fs.writeFileSync(latestPath, JSON.stringify({
      generatedAt: new Date(best.t).toISOString(),
      report: best.f,
      tag: best.tag,
      note: "由 archive-bench-reports.mjs 重建",
      previous: prev?.report ?? null,
    }, null, 2) + "\n", "utf8");
    console.log(`[archive] latest.json → ${best.f}`);
  }
  console.log(`[archive] 完成：改名 ${plan.length} 份`);
} else {
  console.log(`\n[archive] dry-run：共 ${plan.length} 份待改名。确认后加 --apply 执行。`);
}
