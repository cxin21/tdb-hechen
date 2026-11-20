#!/usr/bin/env node
/**
 * 契约断言（只读）：把 /v3/soul/card、/v3/soul/turn、/v3/soul/injection/stats 的
 * 响应字段逐条断言一遍，并把卡与 soul_snapshots 的最新一行做内部一致性对账。
 *
 * 生产库只用快照副本：先用只读连接 VACUUM INTO 临时目录，再让 store 打开副本，
 * 不碰 D:/TDB/data/vectors.db（不开写事务、不跑迁移）。
 *
 *   node --import tsx scripts/soul-contract-assert.mjs \
 *     --data-dir D:/TDB/data --team <team> [--user <u>] [--agent <a>]
 *
 * 退出码：0 = 除「待部署字段」外全通过；1 = 有实质断言失败。
 * 「待部署字段」= 代码已实现、生产 bundle 还在旧构建，字段必然缺席；单独计数，
 * 不当成通过，也不当成回归失败。
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseConfig } from "../src/config.ts";
import { createStoreBundle } from "../src/core/store/factory.ts";
import { handleSoulCardRoute, handleSoulLabelsRoute } from "../src/gateway/soul-card-endpoint.ts";
import { handleSoulInjectionStatsRoute } from "../src/gateway/soul-injection-stats-endpoint.ts";

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const dataDir = arg("--data-dir");
if (!dataDir) {
  console.error("usage: node --import tsx scripts/soul-contract-assert.mjs --data-dir <dir> --team <team> [--user u] [--agent a]");
  process.exit(1);
}
const team = arg("--team", "");
const user = arg("--user", "");
const agent = arg("--agent", "default");
const sha256 = (t) => createHash("sha256").update(String(t ?? ""), "utf8").digest("hex");

const passed = [];
const failed = [];
const pending = [];
const check = (id, ok, detail, opts = {}) => {
  if (ok) {
    passed.push(id);
    console.log("✓ " + id + (detail ? " — " + detail : ""));
  } else if (opts.pendingDeploy) {
    pending.push(id);
    console.log("… " + id + "（待部署）" + (detail ? " — " + detail : ""));
  } else {
    failed.push(id);
    console.log("✗ " + id + (detail ? " — " + detail : ""));
  }
};

// ── 1. 生产库快照副本（只读）─────────────────────────────────────────────
const sourceDb = path.join(dataDir, "vectors.db");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "soul-contract-"));
const snapshotDb = path.join(tmpDir, "vectors.db");
{
  const src = new DatabaseSync(sourceDb, { readOnly: true });
  try {
    src.exec("VACUUM INTO '" + snapshotDb.replace(/'/g, "''") + "'");
  } finally {
    src.close();
  }
}
console.log("# snapshot: " + snapshotDb);

const bundle = createStoreBundle(parseConfig({}), { dataDir: tmpDir });
const store = bundle.store;
const res = { fake: true };

async function callCard(pathname, params) {
  let captured = null;
  const url = new URL("http://local" + pathname + "?" + params.toString());
  await handleSoulCardRoute(url, "GET", (_res, status, payload) => { captured = { status, payload }; }, res, {
    getStore: () => store,
    getReadAgentProfile: () => undefined,
  });
  return captured;
}
const tenantParams = new URLSearchParams({ team, user, agent });

// ── 2. 卡：字段存在且自洽 ────────────────────────────────────────────────
const card = await callCard("/v3/soul/card", tenantParams);
const c = card?.payload?.data ?? {};
check("card.http", card?.status === 200, "status=" + card?.status);
// 脏卡（当前 material 与上次落盘不同）允许 version=0：此时卡是现算的，没有版本号可言。
check("card.version", Number.isInteger(Number(c.version)) && (Number(c.version) > 0 || c.dirty === true),
  "version=" + c.version + " dirty=" + c.dirty);
check("card.identity.text", typeof c.identity?.text === "string" && c.identity.text.trim() !== "", "chars=" + (c.identity?.chars ?? 0));
check("card.identity.hash", c.identity?.hash === sha256(c.identity?.text), "sha256(segment) 相等");
check("card.anchor.hash", c.anchor?.hash === sha256(c.anchor?.text), "chars=" + (c.anchor?.chars ?? 0));
check("card.textHash", c.textHash === sha256(c.text), "sha256(text) 相等");
check("card.chars", c.chars === String(c.text ?? "").length, "chars=" + c.chars);
check("card.labels", Array.isArray(c.labels), "n=" + (c.labels?.length ?? 0));
check("card.warnings", Array.isArray(c.warnings), "n=" + (c.warnings?.length ?? 0));
check("card.sources", c.sources !== null && typeof c.sources === "object", Array.isArray(c.sources) ? "array" : "object");

// ── 3. 尾巴：字段存在且自洽 ──────────────────────────────────────────────
const turn = await callCard("/v3/soul/turn", tenantParams);
const t = turn?.payload?.data ?? {};
check("turn.http", turn?.status === 200, "status=" + turn?.status);
check("turn.text", typeof t.text === "string" && t.text.trim() !== "", "chars=" + (t.chars ?? 0));
check("turn.chars", t.chars === String(t.text ?? "").length);
check("turn.openLoops", Array.isArray(t.openLoops), "n=" + (t.openLoops?.length ?? 0));
check("turn.state", t.state === undefined || (t.state !== null && typeof t.state === "object"), t.state === undefined ? "absent(fail-open)" : "present");

// ── 4. 快照内部一致性 + 与卡的版本对账 ───────────────────────────────────
const snapDb = new DatabaseSync(snapshotDb, { readOnly: true });
// r25b-a5：原来没有租户过滤、还按 version DESC 取「最新」——不同 agent 的 version 序列互不相干，
// 于是取到的可能是另一个 agent 的旧行，provenanceDrift 永远看不到本 agent 的新锚。
// 现在按调用方给的租户三元组过滤（只加非空项），并按 ts 取真正的最新一行。
const snapWhere = [];
const snapArgs = [];
if (team !== "") { snapWhere.push("team_id = ?"); snapArgs.push(team); }
if (user !== "") { snapWhere.push("user_id = ?"); snapArgs.push(user); }
if (agent !== "" && agent !== "default") { snapWhere.push("agent_id = ?"); snapArgs.push(agent); }
const snap = snapDb.prepare(
  "SELECT version, content_hash, payload_json, ts, agent_id FROM soul_snapshots" +
  (snapWhere.length > 0 ? " WHERE " + snapWhere.join(" AND ") : "") +
  " ORDER BY ts DESC LIMIT 1").get(...snapArgs);
snapDb.close();
if (!snap) {
  check("snapshot.row", false, "soul_snapshots 为空");
} else {
  const payload = JSON.parse(String(snap.payload_json ?? "{}"));
  check("snapshot.identity.hash", payload.identity?.hash === sha256(payload.identity?.text), "v" + snap.version + " chars=" + (payload.identity?.chars ?? 0));
  check("snapshot.anchor.hash", payload.anchor?.hash === sha256(payload.anchor?.text), "chars=" + (payload.anchor?.chars ?? 0));
  check("snapshot.payload.hash", payload.hash === snap.content_hash, "列 content_hash 与 payload.hash 相等");
  check("snapshot.traits", payload.traits !== undefined && payload.traitLabels !== undefined,
    payload.traits === undefined ? "缺 traits/traitLabels" : "有 6 轴与标签投影", { pendingDeploy: true });
  // V24-1（Round24）：payload 新增 provenance——逐条 itemId/evidenceIds + 最近一次漂移的锚 id。
  // 判据 1 要求「追到哪条输入导致哪次漂移」，所以这里不只断言键存在，还要断言条目带出处。
  const prov = payload.provenance;
  const provItems = Array.isArray(prov?.items) ? prov.items : [];
  const firstWithEvidence = provItems.find((it) => Array.isArray(it.evidenceIds) && it.evidenceIds.length > 0);
  const firstWithDrift = provItems.find((it) => it.drift && Array.isArray(it.drift.anchorIds) && it.drift.anchorIds.length > 0);
  check("snapshot.provenance", provItems.length > 0 && !!firstWithEvidence,
    provItems.length === 0
      ? "缺 provenance.items"
      : "items=" + provItems.length + "；首条带 evidenceIds 的 itemId=" + String(firstWithEvidence?.itemId ?? "") +
        "；带漂移锚的行=" + (firstWithDrift ? String(firstWithDrift.itemId) + "(" + firstWithDrift.drift.anchorIds.length + " 个锚)" : "0（本版无近窗漂移）"),
    { pendingDeploy: true });
  // 非真空化（r24-a5 反证：删掉 worker.ts 的 anchorIds 落盘后本脚本仍全绿）：
  // 只要快照里有带 drift 的条目，就必须每条都带锚 id；一条 drift 都没有时不给 PASS，
  // 记为「待观测」——没有样本不等于链路通了。
  // 只对「部署之后新产生的漂移」要求锚：条目上的 drift 是 meta.lastDrift 的历史值，
  // 一次漂移会一直留在快照里直到下次漂移覆盖它，所以部署前的旧锚天然没有 anchorIds。
  const driftSince = arg("--drift-since", "2026-11-19T05:59:27.000Z");
  const driftItems = provItems.filter((it) => it.drift && typeof it.drift === "object");
  const hasAnchor = (it) => Array.isArray(it.drift.anchorIds) && it.drift.anchorIds.length > 0;
  const freshDrift = driftItems.filter((it) => {
    const at = Date.parse(String(it.drift.at || ""));
    return Number.isFinite(at) && at >= Date.parse(driftSince);
  });
  const freshMissing = freshDrift.filter((it) => !hasAnchor(it));
  const legacyMissing = driftItems.filter((it) => !freshDrift.includes(it) && !hasAnchor(it));
  check("snapshot.provenanceDrift", freshDrift.length > 0 && freshMissing.length === 0,
    "带 drift 条目=" + driftItems.length + "（部署后 " + freshDrift.length + "）；缺锚=" +
      (freshMissing.length + legacyMissing.length) + "（其中部署后缺锚=" + freshMissing.length + "）" +
      (freshMissing.length > 0 ? "（" + freshMissing.slice(0, 3).map((it) => String(it.itemId)).join(",") + "）" : "") +
      "；cutoff=" + driftSince,
    { pendingDeploy: freshDrift.length === 0 });
  // Round27（r27h-a1）：只判 anchorIds 非空等于没判——id 可能是编的，或已被归档。
  // Round32（R32-10）：锚 id 有两个命名空间。ep-* 是心智事件（soul_episodes.episode_id），
  // msg-* 是原始消息（l1_records.record_id / l1_archive.record_id / l1_records.source_message_ids）。
  // 早先把两类一起按 l1 的 record_id 回查，8 个 msg 锚全被判「解析不到」，是断言自己的口径错（r32h-a4 指出）。
  // 现在按前缀分命名空间回查；仍解析不到的才算悬空锚（数据缺陷，不降级通过）。
  const anchored = freshDrift.concat(driftItems.filter((it) => hasAnchor(it)));
  const anchorIds = Array.from(new Set(anchored.flatMap((it) => it.drift.anchorIds.map((x) => String(x)))));
  if (anchorIds.length === 0) {
    check("snapshot.provenanceDrift.resolve", false,
      "没有任何可回查的锚 id（要么没有漂移样本，要么落盘把锚丢了）",
      { pendingDeploy: freshDrift.length === 0 });
  } else {
    const tally = { ep: 0, msgRecord: 0, msgArchive: 0, msgSource: 0 };
    const missingIds = [];
    let resolveNote = "";
    try {
      const adb = new DatabaseSync(snapshotDb, { readOnly: true });
      const hasTable = (name) => Boolean(adb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name));
      const epTable = hasTable("soul_episodes");
      for (const id of anchorIds) {
        if (id.startsWith("ep-")) {
          const hit = epTable ? adb.prepare("SELECT 1 AS x FROM soul_episodes WHERE episode_id = ? LIMIT 1").get(id) : null;
          if (hit) tally.ep += 1; else missingIds.push(id);
          continue;
        }
        const byRecord = adb.prepare("SELECT 1 AS x FROM l1_records WHERE record_id = ? LIMIT 1").get(id);
        if (byRecord) { tally.msgRecord += 1; continue; }
        const byArchive = adb.prepare("SELECT 1 AS x FROM l1_archive WHERE record_id = ? LIMIT 1").get(id);
        if (byArchive) { tally.msgArchive += 1; continue; }
        const bySource = adb.prepare("SELECT 1 AS x FROM l1_records WHERE source_message_ids LIKE ? LIMIT 1").get("%\"" + id + "\"%");
        if (bySource) { tally.msgSource += 1; continue; }
        missingIds.push(id);
      }
      adb.close();
    } catch (err) {
      resolveNote = "（回查失败：" + (err instanceof Error ? err.message : String(err)) + "）";
    }
    const resolved = tally.ep + tally.msgRecord + tally.msgArchive + tally.msgSource;
    // Round32（R32-10）：悬空锚若已被「漂移锚清理器」从活数据摘掉（审计文件留证），
    // 历史快照里残留的那几条不再算失败——它们是修复前的历史事实，删改有审计可复查；
    // 没有审计留证的悬空锚仍然是 FAIL，不许默默放行。
    const auditRemoved = new Set();
    let auditSeen = "";
    try {
      const backupDir = path.join(dataDir, "backups");
      for (const name of fs.readdirSync(backupDir)) {
        if (!/^drift-anchor-prune-.*\.json$/u.test(name)) continue;
        const doc = JSON.parse(fs.readFileSync(path.join(backupDir, name), "utf8"));
        for (const it of Array.isArray(doc.items) ? doc.items : []) {
          for (const id of Array.isArray(it.removed) ? it.removed : []) auditRemoved.add(String(id));
        }
        auditSeen = name;
      }
    } catch { /* 审计目录缺失只影响豁免，不影响其它断言 */ }
    const stillDangling = missingIds.filter((id) => !auditRemoved.has(id));
    check("snapshot.provenanceDrift.resolve", stillDangling.length === 0 && resolved > 0,
      "锚 id=" + anchorIds.length + "（ep=" + tally.ep + "，msg 按 record=" + tally.msgRecord +
        "，按归档=" + tally.msgArchive + "，按原始消息=" + tally.msgSource + "），解析不到=" + missingIds.length +
        "，其中已按审计清理=" + (missingIds.length - stillDangling.length) +
        (auditSeen ? "（审计 " + auditSeen + "）" : "") +
        (missingIds.length > 0 ? "（" + missingIds.slice(0, 3).join(",") + "）" : "") + resolveNote,
      { pendingDeploy: freshDrift.length === 0 && resolveNote === "" });
  }
  const sameMaterial = c.hash === payload.hash;
  console.log("# 卡 v" + c.version + "（identity " + (c.identity?.chars ?? 0) + " 字）vs 快照 v" + snap.version +
    "（identity " + (payload.identity?.chars ?? 0) + " 字）：material hash " + (sameMaterial ? "相等" : "不同") +
    "；快照是最后一次落盘版本，卡按当前人格行现算（dirty=" + c.dirty + "）。差异有两种成因：本版尚未落盘，或线上写卡的是旧 bundle（看 payload.traits 是否存在、content_hash 是否两值交替），本条不单独断言成因");
}

// ── 4.5 标签读面（V19-1 新增端点）：字段、缺省过滤与计数口径 ─────────────
async function callLabels(params) {
  let captured = null;
  const url = new URL("http://local/v3/soul/labels?" + params.toString());
  await handleSoulLabelsRoute(url, "GET", (_res, status, payload) => { captured = { status, payload }; }, res, {
    getStore: () => store,
  });
  return captured;
}
const labDefault = await callLabels(tenantParams);
const ld = labDefault?.payload?.data ?? {};
check("labels.http", labDefault?.status === 200 && labDefault?.payload?.code === 0, "status=" + labDefault?.status);
const LABEL_STATUSES = ["seed", "admitted", "dormant", "proposed"];
const countsTotal = (c) =>
  Object.entries(c ?? {}).reduce((n, [, v]) => n + (Number.isFinite(Number(v)) ? Number(v) : 0), 0);
check(
  "labels.counts",
  ["seed", "admitted", "dormant"].every((k) => Number.isInteger(Number(ld?.counts?.[k] ?? 0)) && Number(ld?.counts?.[k] ?? 0) >= 0) &&
    Number(ld?.counts?.seed ?? 0) >= 1,
  JSON.stringify(ld?.counts ?? null),
);
// labels 里出现的每个状态都必须在 counts 里有名额，否则就是「隐身行」（A1 Round19）
check(
  "labels.countsCoversStatuses",
  Array.isArray(ld?.labels) &&
    ld.labels.every((r) => Number(ld?.counts?.[String(r.status ?? "")] ?? 0) >= 1),
  "statuses=" + JSON.stringify(Array.from(new Set((ld?.labels ?? []).map((r) => r.status)))),
);
const dormantCount = Number(ld?.counts?.dormant ?? 0);
if (dormantCount === 0) {
  // R32-6：dormant=0 时「排除」退化成 N === N，过滤写反也全绿 → 样本为 0 记待部署，不记通过。
  pending.push("labels.defaultExcludesDormant（counts.dormant=0，无 dormant 样本，排除逻辑不可判）");
} else {
  check(
    "labels.defaultExcludesDormant",
    Array.isArray(ld?.labels) &&
      dormantCount >= 1 &&
      ld.labels.every((r) => r && r.status !== "dormant") &&
      ld.labels.length === countsTotal(ld?.counts) - dormantCount,
    "labels=" + (ld?.labels?.length ?? "?") + " dormant=" + dormantCount + " total-dormant=" + (countsTotal(ld?.counts) - dormantCount),
  );
}
check(
  "labels.fields",
  Array.isArray(ld?.labels) &&
    ld.labels.every(
      (r) =>
        typeof r.label === "string" &&
        r.label !== "" &&
        typeof r.status === "string" &&
        LABEL_STATUSES.includes(r.status) &&
        typeof r.definition === "string" &&
        Number.isFinite(Number(r.evidence)) &&
        Number.isFinite(Date.parse(String(r.firstSeen))) &&
        Number.isFinite(Date.parse(String(r.lastSeen))),
    ),
  "n=" + (ld?.labels?.length ?? 0),
);
const labAll = await callLabels(new URLSearchParams({ ...Object.fromEntries(tenantParams), includeDormant: "1" }));
const la = labAll?.payload?.data ?? {};
if (dormantCount === 0) {
  // 同上：没有 dormant 行时 includeDormant 两侧都只证明「总数相等」，证明不了过滤开关生效。
  pending.push("labels.includeDormant（counts.dormant=0，无 dormant 样本，includeDormant 开关不可判）");
} else {
  check(
    "labels.includeDormant",
    labAll?.status === 200 &&
      la?.includeDormant === true &&
      Array.isArray(la?.labels) &&
      la.labels.length === countsTotal(la?.counts) &&
      la.labels.some((r) => r && r.status === "dormant"),
    "all=" + (la?.labels?.length ?? "?") + " total=" + countsTotal(la?.counts) + " dormant=" + (la?.counts?.dormant ?? "?"),
  );
}

// ── 5. stats：按 reason 聚合 + 测试身份默认排除 ──────────────────────────
async function callStats(params) {
  let captured = null;
  await handleSoulInjectionStatsRoute(
    new URL("http://local/v3/soul/injection/stats?" + params.toString()),
    "GET",
    (_res, status, payload) => { captured = { status, payload }; },
    res,
    {
      journalDir: path.join(dataDir, "logs", "recall"),
      pluginLogPath: path.join(dataDir, "logs", "persona-injection.jsonl"),
      // A5 Round11：不传 journalOpts 会走 journal_disabled 分支，usage 恒为 0——
      // 那样的「通过」是常量零，不是证据。对齐 server.ts 的 statsJournalCfg 形状。
      journalOpts: { enabled: true, rotationSizeMB: 5, maxFiles: 5 },
    },
  );
  return captured;
}
const baseStats = new URLSearchParams({ team, user, agent, hours: "720" });
const stats = await callStats(baseStats);
const p = stats?.payload?.data?.plugin ?? {};
check("stats.http", stats?.status === 200, "status=" + stats?.status);
// A5 Round11：byReason 不能只是「键在」——五个桶的合计必须等于失败总数，否则
// 新增一个 reason 就能静默从统计里消失（与上一轮 FAIL 同源）。
const reasonSum = ["http_status", "timeout", "empty", "parse", "other"]
  .reduce((acc, k) => acc + (typeof p.byReason?.[k] === "number" ? p.byReason[k] : 0), 0);
// Round11：failReasons 五桶（含 section_install_failed）必须都在响应里——面板按桶判红，
// 少一个桶就会让「人格段没进提示词」假绿。
const fr = stats?.payload?.data?.failReasons;
const frKeys = ["http_status", "timeout", "empty", "parse", "section_install_failed"];
const rowsTotal = Number(p?.rows ?? 0);
const frSum = fr === null ? 0 : frKeys.reduce((n, k) => n + (fr?.[k] ?? 0), 0);
if (fr === null) {
  // R32-6：fr===null 曾用 `fr === null || ...` 短路成通过——零证据拿 ✓。改成待部署，与 testExcludedByDefault 同口径。
  pending.push("stats.failReasons.buckets（窗口内无失败上报，五个分桶都不可判）");
} else {
  // R32-7（a5 指出 frSum <= rowsTotal 是代数恒等：带 failReason 的行必计入 rows）：这里只留形态检查；
  // 真校验是下面 stats.failReasons.recount——本租户「带 failReason 的行数」从插件日志独立重数再比。
  check("stats.failReasons.buckets",
    fr === null || frKeys.every((k) => Number.isInteger(fr[k]) && fr[k] >= 0),
    JSON.stringify(fr) + " sum=" + frSum + " rows=" + rowsTotal);
}
check("stats.byReason.sum", reasonSum === p.cardBoundFailed,
  "sum(byReason)=" + reasonSum + " vs cardBoundFailed=" + p.cardBoundFailed);
check("stats.cardBound.split", ["cardBound", "cardBoundEmpty", "cardBoundFailed", "cardEmpty", "otherRows", "noIdentityRows", "unassociated"].every((k) => typeof p[k] === "number")
  && p.cardBound + p.cardBoundEmpty <= p.rows && p.cardBoundFailed <= p.rows,
  "cardBound=" + p.cardBound + " empty=" + p.cardBoundEmpty + " (cardEmpty=" + p.cardEmpty + ") failed=" + p.cardBoundFailed + " other=" + p.otherRows + " noIdentity=" + p.noIdentityRows + " rows=" + p.rows);
check("stats.sectionRead.split",
  p.sectionReadNoCard + p.sectionReadEmptySegment + p.sectionReadNoSession <= p.sectionRead,
  "read=" + p.sectionRead + " noCard=" + p.sectionReadNoCard + " emptySeg=" + p.sectionReadEmptySegment + " noSession=" + p.sectionReadNoSession);
// R32-6（A5 Round32 指出）：这里原有 stats.rowsBuckets.selfConsistent，断言 rows === 五桶之和。
// 但 countedEvent 与五桶增量在端点里是逐行一对一（soul-injection-stats-endpoint.ts 的 countedEvent 与五桶分支），
// 两侧同出一份 p，代入任何真实数据都成立——破不了就等于没断言，还白占「通过」名额。已删除；
// 真正的行数校验是下面的 stats.rowsIdentity.recount（从插件日志独立重数再比）。
// A5 Round10/Round11：无身份行只能进集群级桶。数字不看「字段在不在」，而是**从插件
// 日志独立重数一遍**再逐字比对——这样重复计数、漏计数、串租户都会让断言失败。
const TEST_RE = /^(?:test-)|(?:-test$)|(?:-key$)/;
function recountSectionRead() {
  const files = [path.join(dataDir, "logs", "persona-injection.jsonl"), path.join(dataDir, "logs", "persona-injection.jsonl.1")];
  // 与端点同口径：窗口只有下界（端点 :382 只跳过 ts < from），身份串会 trim（:383）。
  const fromMs = Date.parse(stats?.payload?.data?.window?.from ?? "");
  const out = { attributed: 0, unattributed: 0, excluded: 0, excludedAll: 0, all: 0, ubCard: 0, ubEmpty: 0, ubFailed: 0, clearedTenant: 0, clearedCluster: 0, clearedTenantDeclined: 0, clearedTenantUnconfigured: 0, clearedClusterUnconfigured: 0, ubOther: 0, tenantFailRows: 0 };
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      if (line.trim() === "") continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      const ts = Date.parse(String(ev.ts ?? ""));
      if (Number.isFinite(fromMs) && Number.isFinite(ts) && ts < fromMs) continue;
      const identity = typeof ev.identity === "string" ? ev.identity.trim() : "";
      const evt = String(ev.event ?? "").trim();
      const parts = identity === "" ? [] : identity.split("/");
      const isTest = parts.some((part) => part !== "" && TEST_RE.test(part));
      if (isTest) out.excludedAll += 1;
      // Round26：用户主动「本次不关联」的清卡行——端点单列 unassociated（不进 rows/cardBoundEmpty）。
      // 行数同样从日志独立重数，避免「字段在但永远是 0」的假绿。
      // 事件名 trim 后再比：端点用 asString 归一，脚本早先严格 ===，
      // 带空白的事件名（测试就构造了 " card-cleared "）会变成端点 3 / 重数 2 的假红。
      // r26e-a1：端点的清卡计数不再「无条件累加给任何调用方」——无身份的行只进 unattributed，
      // 有身份的行只进本租户。重数必须按同一口径分成两笔，否则「租户读到别人的清卡」不会红。
      if (evt === "card-cleared" && !isTest) {
        // r26f-a1：recount 必须和端点一样按 reason 分桶，否则租户里一条 unconfigured
        // 清卡会让「unassociated 应等于带身份清卡总数」假红；集群桶也要能单独对 unconfiguredCleared。
        const unconf = String(ev && typeof ev.reason === "string" ? ev.reason : "").trim() === "unconfigured";
        if (parts.length < 3) {
          out.clearedCluster += 1;
          if (unconf) out.clearedClusterUnconfigured += 1;
        } else if (parts[0] === team && parts[2] === agent && (user === "" || parts[1] === user)) {
          out.clearedTenant += 1;
          if (unconf) out.clearedTenantUnconfigured += 1;
          else out.clearedTenantDeclined += 1;
        }
      }
      // 独立的集群级重数：card-bound 按 chars 分两桶、card-bound-failed 计失败。
      // 只在无身份行上数（与端点 unattributed 同口径）；带身份的行走租户桶，与这里无关。
      const epParts = identity === "" ? [] : identity.split("/");
      if ((evt === "card-bound" || evt === "card-bound-failed") && !isTest && epParts.length < 3) {
        const chars = Number(ev.chars ?? 0);
        if (evt === "card-bound") { if (chars > 0) out.ubCard += 1; else out.ubEmpty += 1; }
        else out.ubFailed += 1;
      }
      if (!isTest && epParts.length < 3 && evt !== "card-bound" && evt !== "card-bound-failed" && evt !== "card-cleared" && evt !== "section-read") out.ubOther += 1;
      // R32-7（a5 指出 frSum <= rowsTotal 是代数恒等）：独立重数「本租户带 failReason 的行」，
      // 口径对齐端点 :885-893 的 injections 过滤（usage-only 行不算）与 :916 的 failReason !== undefined。
      if (
        !isTest &&
        parts.length >= 3 &&
        parts[0] === team &&
        parts[2] === agent &&
        (user === "" || parts[1] === user) &&
        ev.failReason !== undefined &&
        !(ev.usage !== undefined && ev.card === undefined && ev.volatile === undefined)
      ) out.tenantFailRows += 1;
      if (evt !== "section-read") continue;
      out.all += 1;
      if (isTest) { out.excluded += 1; continue; }
      if (parts.length < 3) { out.unattributed += 1; continue; }
      if (parts[0] !== team || parts[2] !== agent) continue;
      if (user !== "" && parts[1] !== user) continue;
      out.attributed += 1;
    }
  }
  return out;
}
const re = recountSectionRead();
// R32-7：失败原因五桶之和必须等于日志里本租户带 failReason 的行数（独立重数，非恒等）。
// fr === null 表示窗口内无失败上报，此时重数也必须为 0，否则是「有行却没有分桶」的漏计。
// 零证据不给 ✓：fr === null 表示窗口内没有任何失败上报，此时重数必然也是 0，
// 相等是退化恒等（A5 Round32 指出 R32-6 只修了 buckets、这条还漏着）。
if (fr === null) {
  pending.push("stats.failReasons.recount（fr=null，窗口内无失败上报，重数 0 与 0 相等不可判）");
} else {
  check("stats.failReasons.recount",
    frSum === re.tenantFailRows,
    "sum=" + frSum + " vs tenantFailRows=" + re.tenantFailRows);
}
// 重数是**后读**的：端点扫描上界是请求时刻，重数上界是读文件时刻，这中间照常有新注入在追加。
// 所以只允许「重数 >= 端点」且差值小（追加只会让重数变多）；重数比端点少说明日志被截断/轮转，
// 那才是真问题。早先写成严格相等，实测同一命令三次出现 36/1/1 与 37/0/1 两种结论
// （excludedTestRows 7283 vs 7285，实时追加 2 行）——r24b-a5 CP2。
// 50 太宽：r24c-a4 用 50 条 ts 不可解析的幻影行仍能通过（Δ50 <= 50）。端点请求与读文件相隔秒级，
// 本轮实测自然 Δ 恒为 0，留 10 已经足够吸收读写间隙的追写，又不至于把口径差当追写。
const APPEND_SLACK = 10;
const oneSided = (endpointN, logN) => logN >= endpointN && logN - endpointN <= APPEND_SLACK;
// A4 Round24 CP1：rows 的独立证据只能来自「从日志重数计账事件」，不能来自四桶求和。
// 与 recountSectionRead 同口径：窗口只有下界、身份串 trim、默认排除测试身份；上界同样是读文件时刻，所以仍用 oneSided。
const COUNTED_EVENTS = new Set(["section-read", "card-bound", "card-bound-failed", "card-empty"]);
function recountRows() {
  const files = [path.join(dataDir, "logs", "persona-injection.jsonl"), path.join(dataDir, "logs", "persona-injection.jsonl.1")];
  const fromMs = Date.parse(stats?.payload?.data?.window?.from ?? "");
  let n = 0;
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      if (line.trim() === "") continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      const ts = Date.parse(String(ev.ts ?? ""));
      if (Number.isFinite(fromMs) && Number.isFinite(ts) && ts < fromMs) continue;
      const identity = typeof ev.identity === "string" ? ev.identity.trim() : "";
      const parts = identity === "" ? [] : identity.split("/");
      if (parts.some((part) => part !== "" && TEST_RE.test(part))) continue;
      if (parts.length < 3) continue;
      if (parts[0] !== team || parts[2] !== agent) continue;
      if (user !== "" && parts[1] !== user) continue;
      if (COUNTED_EVENTS.has(String(ev.event ?? "").trim())) n += 1;
    }
  }
  return n;
}
// Round27（r27g-a4）：rows 必须有外部对照物，且不能靠 APPEND_SLACK 放行幻影行。
// 端点读的是 journal 快照，日志在两次读之间还会追加，所以先读一次；不相等就复取端点再比，
// 复取后仍不相等才判红——这样「端点凭空多算 N 行」不再被 slack 放过。
const rowsLogN = recountRows();
let rowsAgain = Number(p.rows);
if (rowsAgain !== rowsLogN) {
  const again = await callStats(baseStats);
  rowsAgain = Number(again?.payload?.data?.plugin?.rows ?? -1);
}
const rowsOk = rowsAgain === rowsLogN || rowsAgain === recountRows();
check("stats.rowsIdentity.recount", rowsOk,
  "endpoint rows=" + p.rows + "（不等则复取=" + rowsAgain + "，须等于最新日志重数） vs 日志重数（带身份、非测试、计账事件）=" + rowsLogN +
  "；五桶之和=" + (p.sectionRead + p.cardBound + p.cardBoundEmpty + p.cardEmpty + p.cardBoundFailed) + "（恒等，仅自检）");
check("stats.unattributed.recount",
  oneSided(p.sectionRead, re.attributed) && oneSided(Number(p.unattributed?.sectionRead ?? 0), re.unattributed),
  "endpoint read=" + p.sectionRead + " / unattributed=" + p.unattributed?.sectionRead +
  " vs 日志重数（后读，允许 +" + APPEND_SLACK + " 追写）attributed=" + re.attributed +
  "（Δ" + (re.attributed - p.sectionRead) + "） unattributed=" + re.unattributed +
  "（Δ" + (re.unattributed - Number(p.unattributed?.sectionRead ?? 0)) + "） excluded=" + re.excluded + " all=" + re.all);
// Round25（判据6）：无身份行的绑定/失败必须在集群级可见，且 byReason 之和等于 cardBoundFailed。
// 真实会话的插件行大多没有 identity，旧实现把失败全沉进 noIdentityRows → 面板永远读到 0。
const un = p.unattributed ?? {};
const unReasons = un.byReason ?? {};
const unReasonSum = Object.values(unReasons).reduce((a, b) => a + (typeof b === "number" ? b : NaN), 0);
check("stats.unattributed.failures",
  typeof un.cardBound === "number" && typeof un.cardBoundEmpty === "number" && typeof un.cardBoundFailed === "number"
    && ["http_status", "timeout", "empty", "parse", "other"].every((k) => typeof unReasons[k] === "number")
    && unReasonSum === un.cardBoundFailed,
  "unattributed=" + JSON.stringify(un));
// r25b-a4 反证：只比「byReason 之和 == cardBoundFailed」是纯代数，把 +=1 改成 +=0 依旧全绿。
// 这里回到日志独立重数三桶，再与端点比（单向：日志可因追写略多）。
check("stats.unattributed.cardCounts.recount",
  oneSided(Number(un.cardBound ?? 0), re.ubCard)
    && oneSided(Number(un.cardBoundEmpty ?? 0), re.ubEmpty)
    && oneSided(Number(un.cardBoundFailed ?? 0), re.ubFailed),
  "endpoint un.cardBound=" + un.cardBound + "/empty=" + un.cardBoundEmpty + "/failed=" + un.cardBoundFailed +
  " vs 日志重数=" + re.ubCard + "/" + re.ubEmpty + "/" + re.ubFailed +
  "（Δ" + (re.ubCard - Number(un.cardBound ?? 0)) + "/" + (re.ubEmpty - Number(un.cardBoundEmpty ?? 0)) + "/" + (re.ubFailed - Number(un.cardBoundFailed ?? 0)) + "）"); const UNB = ["sectionRead", "cardBound", "cardBoundEmpty", "cardBoundFailed", "cleared", "other"]; const unSum = UNB.reduce((n, k) => n + Number(un[k] ?? NaN), 0); check("stats.unattributed.bucketConservation", UNB.every((k) => typeof un[k] === "number") && unSum === p.noIdentityRows, "noIdentityRows=" + p.noIdentityRows + " vs 六桶和=" + unSum + " " + JSON.stringify(un)); const pf = (stats?.payload?.data?.proof && typeof stats.payload.data.proof === "object") ? stats.payload.data.proof : {}; const pfShape = ["sectionReadCount", "textHashMatched", "sessionsWithProof", "sectionCardHashCount"].every((k) => typeof pf[k] === "number") && pf.sectionCardHashCount <= Number(p.sectionRead ?? 0); const pfBound = Number(p.cardBound ?? 0); const pfNoCard = pfShape && Number(pf.sectionCardHashCount) === 0 && Number(pf.sectionReadCount) > 0 && pfBound === 0; const pfStale = pfShape && Number(pf.sectionCardHashCount) === 0 && Number(pf.sectionReadCount) > 0 && pfBound > 0; const pfPending = pfNoCard || pfStale; const pfWhy = pfNoCard ? "；本窗口 cardBound=0（没有任何 card-bound 行）→ 先判定这些段读所在会话是否已绑定身份，再看插件产物是否在宿主生效；两种情况都不能读作通过" : (pfStale ? "；有 cardBound 但段行不带 cardHash —— 先判定段读样本所在会话是否已绑定身份（未绑定时段读无卡、无 cardHash，proof 结构性为 0），再看插件产物是否在宿主生效；两种情况都不能读作通过" : ""); check("stats.proof.shape", pfShape && !pfPending, JSON.stringify(pf) + " (sectionRead=" + p.sectionRead + ", cardBound=" + pfBound + ")" + pfWhy, { pendingDeploy: pfPending });
// Round26：清卡（用户主动不关联）必须能从统计里看见，且不能混进零字节绑定。
// Round26 修订：APPEND_SLACK 对集群级清卡计数太宽——端点 0 / 日志 10 时 Δ10<=10 仍判绿，
// 正是这条断言要防的「字段在但永远是 0」（r26d-a3 反证：把 +=1 改成 +=0 不变红）。
// 改成：相等直接过；不等就立刻重取端点，要求它追平日志（真实追写会涨，死计数不会）。
// r26f-a1：这条断言原来还藏着两个洞——①集群桶用 oneSided + APPEND_SLACK=10，
// 集群清卡 ≤10 时「+=1 改 +=0」仍绿；②「多算」方向永远放行（端点 3 > 日志 2 也绿）。
// 现在两条都改成「必须精确相等；不等就用最新日志与最新端点再比一次」，两端都是 append-only，
// 追写只会让两边一起涨；多算/少算/串租户都会红。
const clearedLogN = re.clearedTenantDeclined;
const clearedFirst = Number(p.unassociated ?? -1);
let clearedAgain = clearedFirst;
if (clearedFirst !== clearedLogN) {
  const again = await callStats(baseStats);
  clearedAgain = Number(again?.payload?.data?.plugin?.unassociated ?? -1);
}
// 租户桶只装 declined：unconfigured 有自己的键，混在一起会让一条配置缺口清卡把这条判红。
const clearedLogUnconfTenant = re.clearedTenantUnconfigured;
check("stats.unassociated.recount", clearedFirst === clearedLogN || clearedAgain === recountSectionRead().clearedTenantDeclined,
  "endpoint unassociated=" + clearedFirst + "（不等则复取=" + clearedAgain + "，须等于最新日志重数）" +
  " vs 日志重数（带身份、本租户、reason≠unconfigured）card-cleared=" + clearedLogN +
  "；另有本租户 unconfigured=" + clearedLogUnconfTenant + "、endpoint unconfigured=" + p.unconfigured + "、cardBoundEmpty=" + p.cardBoundEmpty);
check("stats.unconfigured.recount", Number(p.unconfigured ?? -1) === clearedLogUnconfTenant || Number(p.unconfigured ?? -1) === recountSectionRead().clearedTenantUnconfigured,
  "endpoint unconfigured=" + p.unconfigured + " vs 日志重数（带身份、本租户、reason=unconfigured）=" + clearedLogUnconfTenant);
// 无身份的清卡只能进集群级桶，且集群桶必须与「无身份清卡总数」精确相等。
const clusterFirst = Number(un.cleared ?? 0);
check("stats.unattributed.cleared.recount", clusterFirst === re.clearedCluster || clusterFirst === recountSectionRead().clearedCluster,
  "endpoint un.cleared=" + clusterFirst + " vs 日志重数（无身份）card-cleared=" + re.clearedCluster +
  "（Δ" + (re.clearedCluster - clusterFirst) + "，不等则须等于最新重数）；其中 reason=unconfigured 日志 " + re.clearedClusterUnconfigured + " / endpoint " + un.unconfiguredCleared);
// 无身份里 reason=unconfigured 的那一撮必须单独对上：只比总数会让「配置缺口」被清卡总数掩盖
// （a4 Round27 反证：把这一桶 +1 改成 +7，端点 35 vs 日志 5，旧断言仍全绿）。
const unconfClusterFirst = Number(un.unconfiguredCleared ?? -1);
let unconfClusterAgain = unconfClusterFirst;
if (unconfClusterFirst !== re.clearedClusterUnconfigured) {
  const againUnconf = await callStats(baseStats);
  unconfClusterAgain = Number(againUnconf?.payload?.data?.plugin?.unattributed?.unconfiguredCleared ?? -1);
}
check("stats.unattributed.unconfiguredCleared.recount",
  unconfClusterFirst === re.clearedClusterUnconfigured || unconfClusterAgain === recountSectionRead().clearedClusterUnconfigured,
  "endpoint un.unconfiguredCleared=" + unconfClusterFirst + "（不等则复取=" + unconfClusterAgain + "）" +
  " vs 日志重数（无身份、reason=unconfigured）=" + re.clearedClusterUnconfigured);
const otherFirst = Number(un.other ?? -1);
if (otherFirst !== re.ubOther) {
  const otherAgainResponse = await callStats(baseStats);
  const otherAgain = Number(otherAgainResponse?.payload?.data?.plugin?.unattributed?.other ?? -1);
  check("stats.unattributed.other.recount", otherAgain === re.ubOther || otherAgain === recountSectionRead().ubOther,
    "endpoint un.other=" + otherFirst + "（复取=" + otherAgain + "） vs 日志重数（无身份、非四类计账事件、非清卡）=" + re.ubOther + "（Δ" + (re.ubOther - otherFirst) + "）");
} else {
  // 不能写 check(..., true, ...)：Δ0 分支同样要给真判定（A5 Round32 指出这是装饰性常量）。
  check("stats.unattributed.other.recount", otherFirst === re.ubOther, "endpoint un.other=" + otherFirst + "（Δ0） vs 日志重数=" + re.ubOther);
}
check("stats.excludedCounter", oneSided(p.excludedTestRows, re.excludedAll),
  "excludedTestRows=" + p.excludedTestRows + " vs 日志重数（后读）excludedAll=" + re.excludedAll +
  "（Δ" + (re.excludedAll - p.excludedTestRows) + "）");
// A5 Round10：不存在的租户必须读不到任何属于别人的数字（串租户回归）。
const ghost = await callStats(new URLSearchParams({ team: "team-nonexistent-a5", user: "usr-ghost", agent: "agt-ghost", hours: "720" }));
const gh = ghost?.payload?.data ?? {};
check("stats.tenantIsolation", gh.rows === 0 && (gh.plugin?.sectionRead ?? 0) === 0 && (gh.plugin?.cardBound ?? 0) === 0
  && (gh.plugin?.cardBoundFailed ?? 0) === 0 && (gh.usage?.rows ?? 0) === 0,
  "ghost rows=" + gh.rows + " sectionRead=" + (gh.plugin?.sectionRead ?? 0) + " cardBound=" + (gh.plugin?.cardBound ?? 0) + " usageRows=" + (gh.usage?.rows ?? 0));
// A4 Round5/Round9 + A5 Round11：usage 不只看键在不在，还要内部自洽
// （会话数不超过行数、命中数不超过总行数、均值不超过最大值、0 行时没有 lastAt）。
const u = stats?.payload?.data?.usage ?? {};
check("stats.usage.shape", ["rows", "sessions", "withOverlap", "avgOverlapPct", "maxOverlapPct"].every((k) => typeof u[k] === "number")
  && u.withOverlap <= u.rows && u.sessions <= u.rows && u.avgOverlapPct <= u.maxOverlapPct
  && (u.rows > 0 || u.lastAt === null),
  "usage=" + JSON.stringify({ rows: u.rows, sessions: u.sessions, withOverlap: u.withOverlap, avg: u.avgOverlapPct, max: u.maxOverlapPct, lastAt: u.lastAt }));

// 测试身份：默认必须查不到，includeTest=1 必须查得到（同一份日志、同一窗口）
const testIdentity = { team: "team-test", user: "usr-test", agent: "agt-test" };
const testDefault = await callStats(new URLSearchParams({ ...testIdentity, hours: "720" }));
const testIncluded = await callStats(new URLSearchParams({ ...testIdentity, hours: "720", includeTest: "1" }));
const td = testDefault?.payload?.data?.plugin ?? {};
const ti = testIncluded?.payload?.data?.plugin ?? {};
if (ti.rows > 0) {
  check("stats.testExcludedByDefault", td.rows === 0,
    "默认 rows=" + td.rows + " / includeTest rows=" + ti.rows + "（" + testIdentity.team + "/" + testIdentity.user + "/" + testIdentity.agent + "）");
} else {
  // 窗口内没有 test 身份的行时，这条断言不可判读：记为待部署，而不是用 td.rows===0 假装通过
  pending.push("stats.testExcludedByDefault（72h 窗口内无 test 行，默认/含测试两侧都是 " + td.rows + "/" + ti.rows + "）");
}

// Round30（r30b 自检）：includeTest=1 曾经是空转参数——它只绕过了 continue，测试行随后仍被
// 租户比较静默丢弃，于是「显式可取回」在生产上与默认逐字节相同。现在两头都必须可断言：
// 默认侧有 excludedTestRows 这个事实，显式侧必须有 testRows 且与它守恒。
const inclPlugin = (await callStats(new URLSearchParams({ team, user, agent, hours: "720", includeTest: "1" })))?.payload?.data?.plugin ?? {};
if (Number(p.excludedTestRows ?? 0) > 0) {
  const tr = inclPlugin.testRows ?? {};
  const trSum = ["rows", "otherRows", "cleared"].reduce((n, k) => n + Number(tr[k] ?? NaN), 0);
  check("stats.includeTest.retrievable",
    inclPlugin.includeTest === true && typeof tr.sectionRead === "number" && trSum === Number(p.excludedTestRows),
    "excludedTestRows=" + p.excludedTestRows + " testRows=" + JSON.stringify(tr));
} else {
  pending.push("stats.includeTest.retrievable（窗口内无测试行）");
}

// R29：快照里出处被截断时必须标出总数（旧代码静默 slice(0,5)，读快照的人以为只有 5 个出处）。
let provItemsR29 = [];
try {
  // 快照 payload 在上面的快照块里用局部 const 解析过，作用域不在这里——重新按最新一行读一次。
  const latest = store.readLatestSoulSnapshot
    ? await store.readLatestSoulSnapshot({ teamId: team, userId: user, agentId: agent })
    : null;
  const raw = latest?.payloadJson ?? latest?.payload_json ?? null;
  const parsed = raw ? JSON.parse(String(raw)) : null;
  provItemsR29 = Array.isArray(parsed?.provenance?.items) ? parsed.provenance.items : [];
} catch {
  provItemsR29 = [];
}
const truncatedProv = provItemsR29.filter((it) => typeof it?.evidenceTotal === "number");
if (truncatedProv.length > 0) {
  const truncOk = truncatedProv.every(
    (it) => Array.isArray(it.evidenceIds) && it.evidenceIds.length === 5 && it.evidenceTotal > 5,
  );
  check("snapshot.provenanceEvidence", truncOk, "截断条目 n=" + truncatedProv.length);
} else {
  pending.push("snapshot.provenanceEvidence（快照里没有 >5 出处的条目）");
}

// R29：lastCard 的散列改名 textHash —— 插件记的是 sha256(卡正文)，与 GET /v3/soul/card 的
// material hash 同名不同义（r28e-a4 就踩过）。旧键必须彻底消失，不能两义并存。
const lcR29 = stats?.payload?.data?.lastCard;
if (lcR29) {
  check(
    "stats.lastCard.textHash",
    typeof lcR29.textHash === "string" && !("hash" in lcR29),
    "keys=" + Object.keys(lcR29).join("/"),
  );
} else {
  pending.push("stats.lastCard.textHash（窗口内没有卡片绑定行）");
}

const summary = "契约断言：通过 " + passed.length + " / 失败 " + failed.length + " / 待部署 " + pending.length;
console.log("\n" + summary + (failed.length ? "（失败：" + failed.join(", ") + "）" : "") + (pending.length ? "（待部署：" + pending.join(", ") + "）" : ""));
try { await store.close?.(); } catch { /* ignore */ }
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows 仍持有句柄时留 tmp */ }
process.exit(failed.length === 0 ? 0 : 1);