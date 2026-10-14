/**
 * P0-1A（issue #1 cxin21/tdb-hechen）：存量价值锚 description 回填（一次性，可重入）。
 *
 * 背景：2026-10-04 前的写路径（auto-growth 主题采纳 / 早期 panel 新增）丢弃 rationale，
 *   落库 attrs_json="{}" → soul 渲染层 desc 门（宁缺毋滥）把裸关键词锚整行跳过，
 *   锚存在但「没有具体内容」。本脚本对缺 description 的 theme/person 锚：
 *   1. 从 l1_records 按 label（+person 的 aliases）捞证据行（significance DESC）
 *   2. 抽取含 label 的首个完整句 → sanitizeAnchorDescription（episode/断尾/超长无句读
 *      置空——与 soul 渲染门同一单一源，宁缺毋滥）
 *   3. 合并写回 attrs_json（只动 description 键，role/aliases/source/facts 原样保留）
 * 确定性证据句路径，零 LLM（LLM 合成回填属运行期发现任务，见 anchor-growth 发现提示词
 * 的 rationale 规范——本脚本只收存量确定性可证部分）。
 *
 * 默认 dry-run（只打印提案）；加 --apply 真写。可重入：已有非空 description 的行跳过。
 * 用法: node --import tsx scripts/backfill-anchor-description.ts [--apply] [--db=路径] [--evidence=5]
 *
 * #20 T13：--contract=v2 存量合同审计模式——对已有非空 description 的 active
 *   theme/person 锚跑 passesDescContractV2（ADR-0002「情境短语+行为取向」合同），
 *   非合同 desc 落 jsonl 报告（off-contract）转人工/LLM 重述通道（#11 维护环）。
 *   本模式只读不写；可与默认回填模式叠加执行。
 */
import { VectorStore } from "../src/core/store/sqlite.js";
import { sanitizeAnchorDescription, passesDescContractV2 } from "../src/core/hooks/anchor-desc.js";

const apply = process.argv.includes("--apply");
const contractMode = process.argv.includes("--contract=v2");
const dbArg = process.argv.find((a) => a.startsWith("--db="))?.slice(5);
// 两轮审查修正：不做机器耦合默认路径——库路径必须显式给出（--db 或 TDB_VECTORS_DB）。
const dbPath = dbArg ?? process.env.TDB_VECTORS_DB;
if (!dbPath) {
  console.error("用法: tsx scripts/backfill-anchor-description.ts [--apply] --db=<vectors.db 路径> [--evidence=5] [--report=<jsonl 路径>] [--contract=v2]");
  process.exit(2);
}
const evidenceCap = Number(process.argv.find((a) => a.startsWith("--evidence="))?.slice(11) ?? 5) || 5;
const reportPath = process.argv.find((a) => a.startsWith("--report="))?.slice(9);

const vs = new VectorStore(dbPath, 0, console as never);
await vs.init();

interface Db {
  prepare(sql: string): { all(...args: (string | number)[]): unknown[]; run(...args: (string | number)[]): void };
}
const db = (vs as unknown as { db: Db }).db;

interface AnchorRow {
  rowid: number;
  value_id: string;
  label: string;
  node_type: string;
  attrs_json: string;
  team_id: string;
  user_id: string;
  agent_id: string;
}

interface EvidenceRow {
  content: string;
}

// 1. 目标行：active theme/person 锚，attrs_json 无非空 description
const anchors = db
  .prepare(
    `SELECT rowid, value_id, label, node_type, attrs_json, team_id, user_id, agent_id
     FROM core_values
     WHERE state='active' AND node_type IN ('theme','person')
       AND (CASE
             WHEN attrs_json IS NULL OR attrs_json='' OR attrs_json='{}' THEN 1
             WHEN json_valid(attrs_json)=0 THEN 1
             WHEN json_extract(attrs_json,'$.description') IS NULL THEN 1
             WHEN json_extract(attrs_json,'$.description')='' THEN 1
             ELSE 0 END)=1`,
  )
  .all() as AnchorRow[];

// 2. 证据查询（LIKE 全文近似；FTS 表列结构与检索路径耦合，脚本侧用宽匹配即可）
// Standards 终审 #1（硬伤，2026-10-13）：按锚自身租户过滤证据——单库多租户下
// 无过滤的 --apply 会用其他租户的记忆句给锚写 description（跨租户数据污染）。
// IFNULL 兜底 'default' 与建表默认对齐（NULL 行不静默匹配任何锚）。
const evStmt = db.prepare(
  `SELECT content FROM l1_records
   WHERE content LIKE ? ESCAPE '\\'
     AND IFNULL(team_id,'default')=IFNULL(?,'default')
     AND IFNULL(user_id,'default')=IFNULL(?,'default')
     AND IFNULL(agent_id,'default')=IFNULL(?,'default')
   ORDER BY significance DESC, created_time DESC LIMIT ?`,
);

let proposed = 0, applied = 0, noEvidence = 0, rejected = 0, failed = 0;
const proposals: Array<{ label: string; nodeType: string; scope: string; description: string }> = [];
// issue #1 B（Spec 审查 a4 落实）：无证据 / 证据全被 sanitizer 拒绝的锚 → needs-human
// 清单落盘（JSONL），转人工/LLM 判定，不再只计数吞掉。
const needsHuman: Array<{ label: string; nodeType: string; scope: string; reason: "no-evidence" | "sanitizer-rejected"; evidenceCount: number }> = [];

for (const a of anchors) {
  const terms = [a.label];
  try {
    const attrs = a.attrs_json && a.attrs_json !== "{}" ? (JSON.parse(a.attrs_json) as { aliases?: unknown }) : {};
    if (Array.isArray(attrs.aliases)) for (const al of attrs.aliases) if (typeof al === "string" && al.trim()) terms.push(al.trim());
  } catch { /* attrs_json 坏行：按 label 单词回填 */ }

  const evidence: string[] = [];
  // 对抗审查修复（#6 minor）：LIKE 通配符转义——label/alias 含 % 或 _（"50%远程"、"CI_CD"）
  // 会匹配无关行 → 取错证据句 → --apply 写错 description。ESCAPE '\\' + 参数化。
  const likeEscape = (s: string): string => s.replace(/[\\%_]/g, "\\$&");
  for (const term of terms) {
    if (evidence.length >= evidenceCap) break;
    for (const r of evStmt.all(`%${likeEscape(term)}%`, a.team_id, a.user_id, a.agent_id, evidenceCap) as EvidenceRow[]) {
      if (evidence.length >= evidenceCap) break;
      if (!evidence.includes(r.content)) evidence.push(r.content);
    }
  }
  if (evidence.length === 0) {
    noEvidence++;
    needsHuman.push({ label: a.label, nodeType: a.node_type, scope: `${a.team_id}/${a.user_id}/${a.agent_id}`, reason: "no-evidence", evidenceCount: 0 });
    continue;
  }

  // 3. 抽含 label/alias 的首个完整句 → 单一源 sanitizer
  let description = "";
  for (const text of evidence) {
    const lowerTerms = terms.map((t) => t.toLowerCase());
    const sentences = text.split(/(?<=[。！？；!?\n])/).map((s) => s.trim()).filter(Boolean);
    const hit = sentences.find((s) => lowerTerms.some((t) => s.toLowerCase().includes(t)));
    if (!hit) continue;
    const cleaned = sanitizeAnchorDescription(hit, 60);
    if (cleaned) { description = cleaned; break; }
    rejected++;
  }
  if (!description) {
    rejected++;
    needsHuman.push({ label: a.label, nodeType: a.node_type, scope: `${a.team_id}/${a.user_id}/${a.agent_id}`, reason: "sanitizer-rejected", evidenceCount: evidence.length });
    continue;
  }

  proposed++;
  const scope = `${a.team_id}/${a.user_id}/${a.agent_id}`;
  proposals.push({ label: a.label, nodeType: a.node_type, scope, description });
  if (!apply) continue;

  // 4. 合并写回：只动 description 键（F1 教训 UR-09——其他 attrs 字段原样保留）
  let merged: Record<string, unknown> = {};
  try {
    const existing = a.attrs_json && a.attrs_json !== "{}" ? (JSON.parse(a.attrs_json) as Record<string, unknown>) : {};
    merged = typeof existing === "object" && existing !== null ? { ...existing } : {};
  } catch { merged = {}; }
  merged.description = description;
  try {
    db.prepare(`UPDATE core_values SET attrs_json=? WHERE rowid=?`).run(JSON.stringify(merged), a.rowid);
    applied++;
  } catch (err) {
    // 对抗审查修复（#6 minor）：单行失败不中止整批，计数后继续
    failed++;
    console.error(`  UPDATE failed rowid=${a.rowid} (${a.label}): ${err instanceof Error ? err.message : String(err)}`);
  }
}

for (const p of proposals) {
  console.log(`  [${p.nodeType}] ${p.label} @ ${p.scope} → 「${p.description}」`);
}
console.log(
  `P0-1A anchor-description backfill (${apply ? "APPLY" : "DRY-RUN"}): scanned=${anchors.length}, ` +
  `proposed=${proposed}, applied=${applied}, failed=${failed}, no-evidence=${noEvidence}, rejected=${rejected} (episode/断尾/无句读置空)`,
);
// 注意：直写库不会失效运行中 MemoryCore 进程的 valuesCache（TTL 60s 读旧值）——
// --apply 后建议在服务低峰执行或等待 TTL 自然过期。
// needs-human 清单：无证据 / 证据被质量门全拒 → 落盘转人工（默认 anchor-description-needs-human-<ts>.jsonl）
if (needsHuman.length > 0) {
  const out = reportPath ?? `anchor-description-needs-human-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}.jsonl`;
  const { writeFileSync } = await import("node:fs");
  writeFileSync(out, needsHuman.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  console.log(`  needs-human 清单（${needsHuman.length} 条）→ ${out}`);
}

// ── #20 T13：--contract=v2 存量合同审计（只读）─────────────────────────────
// ADR-0002 合同：desc =「情境短语+行为取向」；非合同 desc 不改写（改写归 #11 LLM 重述
// 通道，带 lastDescRefreshAt/manual origin 守卫），此处仅落报告转人工。
if (contractMode) {
  const descRows = db
    .prepare(
      `SELECT rowid, value_id, label, node_type, attrs_json, team_id, user_id, agent_id
       FROM core_values
       WHERE state='active' AND node_type IN ('theme','person')
         AND json_valid(attrs_json)=1
         AND json_extract(attrs_json,'$.description') IS NOT NULL
         AND json_extract(attrs_json,'$.description') != ''`,
    )
    .all() as AnchorRow[];
  const offContract: Array<{ label: string; nodeType: string; scope: string; description: string; verdict: "off-contract" }> = [];
  let conforming = 0;
  for (const a of descRows) {
    let desc = "";
    try {
      const attrs = JSON.parse(a.attrs_json) as { description?: unknown };
      if (typeof attrs.description === "string") desc = attrs.description;
    } catch { continue; }
    if (!desc) continue;
    if (passesDescContractV2(desc)) { conforming++; continue; }
    offContract.push({ label: a.label, nodeType: a.node_type, scope: `${a.team_id}/${a.user_id}/${a.agent_id}`, description: desc, verdict: "off-contract" });
  }
  console.log(`contract=v2 审计：scanned=${descRows.length}, conforming=${conforming}, off-contract=${offContract.length}（重述由 #11 维护环承担，本脚本不改写）`);
  for (const r of offContract) console.log(`  [off-contract] [${r.nodeType}] ${r.label} @ ${r.scope} → 「${r.description}」`);
  if (offContract.length > 0) {
    const outC = `anchor-desc-contract-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}.jsonl`;
    const { writeFileSync } = await import("node:fs");
    writeFileSync(outC, offContract.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
    console.log(`  off-contract 清单（${offContract.length} 条）→ ${outC}`);
  }
}
if (!apply) console.log("  加 --apply 真写");
await vs.destroy?.();
