#!/usr/bin/env node
/**
 * 41 用例矩阵（Round3 阶段0 交付物）。
 *
 * 口径：docs/specs/2026-11-08-soul-fulltest-plan.md §6 的 33 条（A5/B12/C6/D4/E6）
 * + 8 条补充契约用例（S1–S8，来自 issue #180 的需求条目与 ADR-0028 的声明）。
 * 判定只有三种：PASS / FAIL / 未验证（缺场景或需要生产/HTTP，绝不把「没测」写成通过）。
 *
 * 用法：
 *   node scripts/soul-fulltest-matrix.mjs [--result .scratch/soul-fulltest/harness-result.json]
 *                                         [--db2 <另一个回放的 vectors.db>] [--out .scratch/soul-fulltest/41-case-matrix.json]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
// R32-8（a5 指出）：相对默认值会随 cwd 落两份同名产物（仓库根 / MemoryCore/.scratch 各一份），
// 且 --db2 常被填成随机临时目录。默认值一律按脚本自身定位到仓库根，report 里记 cwd 便于对账。
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const resultPath = arg("--result", path.join(REPO_ROOT, ".scratch", "soul-fulltest", "harness-result.json"));
const db2Path = arg("--db2", path.join(REPO_ROOT, ".scratch", "soul-fulltest", "harness-vectors-prev.db"));
const outPath = arg("--out", path.join(REPO_ROOT, ".scratch", "soul-fulltest", "41-case-matrix.json"));
const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
const db = new DatabaseSync(result.dbPath);
// Round28（r28g-a5）：--db2 必须指向**另一次**回放库。早先我把同一个库同时传给 --result 与 --db2，
// E1「90 天回放可重放」变成同一文件自比，恒真通过；缺失或路径写错又会静默降级成「未验证」。
if (db2Path !== "" && path.resolve(db2Path) === path.resolve(String(result.dbPath))) {
  throw new Error("--db2 与 --result 指向同一个库（E1 会变成自比）。请传另一次回放的 dbPath。");
}
if (db2Path !== "" && !fs.existsSync(db2Path)) {
  throw new Error("--db2 指定的库不存在：" + db2Path + "（不会静默降级成未验证）");
}
const db2 = db2Path !== "" ? new DatabaseSync(db2Path) : null;

const all = (d, sql, ...p) => {
  try {
    return d.prepare(sql).all(...p);
  } catch {
    return [];
  }
};
const one = (d, sql, ...p) => {
  try {
    return d.prepare(sql).get(...p);
  } catch {
    return undefined;
  }
};
const parse = (text, fallback) => {
  try {
    const v = JSON.parse(text);
    return v ?? fallback;
  } catch {
    return fallback;
  }
};

const tenant = one(db, "SELECT team_id, user_id, agent_id FROM soul_persona LIMIT 1") ?? {};
const T = [tenant.team_id ?? "", tenant.user_id ?? "", tenant.agent_id ?? ""];
// 每张表的租户列不同：persona 家族是 team_id/user_id/agent_id，soul_trait_label 只有 tenant_id
//（A5 Round19 CP5：硬编码 team_id 让它 no such column → all() 吞异常返回 []，B9 永远未验证）。
const colCache = new Map();
const colsOf = (table) => {
  if (!colCache.has(table)) {
    colCache.set(table, new Set(all(db, `PRAGMA table_info(${table})`).map((c) => String(c.name))));
  }
  return colCache.get(table);
};
const scoped = (table, extra = "") => {
  if (T[0] === "") return all(db, `SELECT * FROM ${table} ${extra}`);
  const cols = colsOf(table);
  if (cols.has("team_id")) {
    return all(db, `SELECT * FROM ${table} WHERE team_id = ? AND user_id = ? AND agent_id = ? ${extra}`, ...T);
  }
  if (cols.has("tenant_id")) {
    return all(db, `SELECT * FROM ${table} WHERE tenant_id = ? ${extra}`, T[0]);
  }
  return all(db, `SELECT * FROM ${table} ${extra}`);
};

const l0 = scoped("l0_conversations");
const episodes = scoped("soul_episodes");
const persona = scoped("soul_persona");
const relations = all(db, "SELECT * FROM soul_person_relation");
const emotions = scoped("soul_emotions");
const gate = scoped("soul_gate_stats");
const promises = scoped("soul_promises");
const traits = scoped("soul_trait_state");
const labels = scoped("soul_trait_label");
const narrative = scoped("soul_narrative");
const ledger = scoped("soul_ledger");
const snapshots = scoped("soul_snapshots");
const persons = scoped("soul_person");

const card = result.card ?? {};
const cardChars = Number(card.chars ?? 0);
const identity = String(typeof card.identity === "string" ? card.identity : card.identity?.text ?? card.segments?.identity ?? "");
const anchor = String(typeof card.anchor === "string" ? card.anchor : card.anchor?.text ?? card.segments?.anchor ?? "");
const warnings = (card.warnings ?? []).join(" | ");

const rows = [];
const push = (id, title, status, evidence, note = "") => rows.push({ id, title, status, evidence, note });
const gateBy = (code) => Number(gate.find((g) => String(g.code ?? g.name ?? "") === code)?.count ?? 0);
const layerOf = (layer, state) => persona.filter((p) => p.layer === layer && (state ? p.state === state : true));

// ── A 身份与数据层 ──
const redlines = ["不做没验证就声称已验证的事", "不替用户承诺他自己没答应的事", "不把别人的私事写进对外的话里"];
const redlineHit = redlines.filter((r) => identity.includes(r)).length;
const seedState = traits[0] ? parse(traits[0].seed_state_json ?? traits[0].seed_json ?? "[]", []) : [];
const seedLabels = Array.isArray(seedState)
  ? seedState.map((s) => String(s?.label ?? s?.name ?? "")).filter((s) => s !== "")
  : Object.keys(seedState ?? {});
const declaredTraits = ["严谨", "好奇", "温和"].filter((t) => seedLabels.includes(t)).length;
push("A1", "T-agent 人格写入可回读", identity.length > 0 && redlineHit === 3 ? "PASS" : "未验证",
  `identity chars=${identity.length}，三条红线命中 ${redlineHit}/3，seed 轴命中 ${declaredTraits}/3（${seedLabels.join("、") || "无"}）；warnings=${warnings.slice(0, 100)}`,
  redlineHit < 3 ? "卡里红线被预算裁掉或声明未进卡，需要核 card-v13 redline 渲染" : "");
push("A2", "L0 灌入后按租户隔离", l0.length === Number(result.fixtureTurns ?? result.seeded ?? 0) ? "PASS" : "FAIL",
  `l0_conversations（本租户）=${l0.length}，fixtureTurns=${result.fixtureTurns ?? "-"}，seeded=${result.seeded ?? "-"}`);
const epWithPersons = episodes.filter((e) => String(e.persons_json ?? "").trim() !== "" && String(e.persons_json ?? "").trim() !== "[]").length;
push("A3", "事件由 L0 长出且带人", episodes.length >= 24 && epWithPersons / Math.max(1, episodes.length) >= 0.8 ? "PASS" : "FAIL",
  `episodes=${episodes.length}（≥24）；persons_json 非空 ${epWithPersons}/${episodes.length} = ${(epWithPersons / Math.max(1, episodes.length) * 100).toFixed(0)}%`);
push("A4", "同段重复灌入不翻倍", "未验证", "回放只灌了一遍；hasRecentL0Duplicate 有单测但本条要求同 fixture 灌两遍", "最小验证：同一 fixture 再跑一次，比较 soul_episodes 增量 ≤1");
const days = Array.isArray(result.timeline) ? result.timeline : [];
const badAt = episodes.filter((e) => String(e.at ?? "").slice(0, 10) !== String(e.day ?? "")).length;
push("A5", "时间戳语义正确", episodes.length > 0 && badAt === 0 ? "PASS" : "FAIL",
  `soul_episodes=${episodes.length}，at 与 day 不一致 ${badAt} 条；timeline 天数=${days.length}`);

// ── B 派生层 ──
const emotionCodes = ["emotion:candidate", "emotion:object_ok", "emotion:appraised", "emotion:anchor_hit", "emotion:intensity_ok", "emotion:committed"];
const codeCounts = emotionCodes.map((c) => `${c}=${gateBy(c)}`);
push("B1", "六档情绪漏斗每档有样本", emotionCodes.every((c) => gateBy(c) >= 1) ? "PASS" : "FAIL", codeCounts.join("，"));
const withObject = emotions.filter((e) => String(e.object_person ?? "").trim() !== "").length;
const byObject = new Map();
for (const e of emotions) {
  const k = String(e.object_person ?? "").trim();
  if (k !== "") byObject.set(k, (byObject.get(k) ?? 0) + 1);
}
const repeatObject = [...byObject.values()].filter((n) => n >= 2).length;
push("B2", "情绪有对象锚且可复议", withObject >= 12 && repeatObject >= 1 ? "PASS" : "FAIL",
  `object_person 非空 ${withObject} 行（≥12）；同一对象 ≥2 条的对象数 ${repeatObject}`);
push("B3", "半衰期真的衰减", "CITED", "src/core/soul/__tests__/soul-emotion.test.ts:662/:697/:720（decayedStoredIntensity 与模板半衰期、缩放系数）");
push("B4", "情绪到期后不出陈旧行", "CITED", "src/core/soul/__tests__/card-service.test.ts:326「情绪强度归零/已过期，不再写『正在消退』」（now 与 emotionAt 相差 18 天 > 6×半衰期）");
const relationText = persona.filter((p) => p.layer === "relationship").map((p) => String(p.text ?? "")).join(" / ");
const conflictKinds = ["没做到", "顶了回去", "只回了话", "后来补上"].filter((k) => relationText.includes(k));
push("B5", "冲突-修复四态各有样本", conflictKinds.length === 4 ? "PASS" : "未验证",
  `relationship 文本命中四态 ${conflictKinds.length}/4（${conflictKinds.join("、") || "无"}）`, "fixture 未含 S6 冲突-修复四态场景");
const human = persona.filter((p) => p.layer === "human");
const fieldCountByPerson = new Map();
for (const h of human) {
  const meta = parse(h.meta_json, {});
  const key = String(meta?.person?.key ?? "");
  if (key === "") continue;
  const set = fieldCountByPerson.get(key) ?? new Set();
  if (meta.profileField) set.add(meta.profileField);
  fieldCountByPerson.set(key, set);
}
const richPeople = [...fieldCountByPerson.values()].filter((s) => s.size >= 3).length;
push("B6", "人物档案九字段", richPeople >= 6 ? "PASS" : "未验证",
  `human 行 ${human.length} 条，覆盖 ${fieldCountByPerson.size} 人，≥3 字段的 ${richPeople} 人（要求 ≥6 人）`, "stub 词表只产 3 条 human 行；缺口在语料/桩，不在产品");
const preds = [...new Set(relations.map((r) => String(r.pred ?? "")))];
const emptyPred = relations.filter((r) => String(r.pred ?? "").trim() === "").length;
const activeRels = relations.filter((r) => String(r.status ?? "active") === "active");
const seenEdge = new Set();
let dupEdges = 0;
for (const r of activeRels) {
  const k = `${r.subj_key}|${r.pred}|${r.obj_key}`;
  if (seenEdge.has(k)) dupEdges += 1;
  else seenEdge.add(k);
}
const noValidFrom = relations.filter((r) => String(r.valid_from ?? "").trim() === "").length;
const badRelId = relations.filter((r) => !/^rel-[0-9a-f]{16}$/.test(String(r.rel_id ?? ""))).length;
const b7ok = relations.length >= 1 && emptyPred === 0 && dupEdges === 0 && noValidFrom === 0 && badRelId === 0;
push("B7", "关系边谓词开放集合且边去重", b7ok ? "PASS" : "FAIL",
  `relations=${relations.length}，谓词=${preds.join("、") || "无"}；空谓词 ${emptyPred}；活跃边重复 ${dupEdges}；valid_from 空 ${noValidFrom}；rel_id 非确定性格式 ${badRelId}`,
  "规格已改：谓词是开放集合（soul-person-ddl.ts:80-82），本条改判「谓词非空 + 三元组去重 + valid_from 必填 + rel_id 内容哈希格式」");
const axis = traits[0] ? parse(traits[0].axis_json, {}) : {};
const axisKeys = Object.keys(axis ?? {});
push("B8", "特质 6 轴漂移有净票", axisKeys.length === 6 ? "未验证" : "FAIL",
  `soul_trait_state 行=${traits.length}，axis keys=${axisKeys.length}，ledger drift=${ledger.filter((l) => l.action === "drift").length}`, "无向量器时判断轨不判（已决策），本回放 0 次 drift");
// 表 soul_trait_label 用 status 区分种子/准入（没有 is_seed 列）；旧形态保留兼容。
const newLabels = labels.filter((l) =>
  typeof l.status === "string" ? l.status !== "seed" : l.is_seed === 0 || l.is_seed === "0" || l.seed === 0,
);
push("B9", "标签随经历生长", newLabels.length >= 1 ? "PASS" : "未验证", `soul_trait_label=${labels.length}，非种子 ${newLabels.length}`, "回放语料 24 类情绪只命中 7 类，标签未生长");
const promiseStates = promises.reduce((acc, p) => {
  const s = String(p.status ?? "");
  acc[s] = (acc[s] ?? 0) + 1;
  return acc;
}, {});
push("B10", "承诺三态齐全", (promiseStates.kept ?? 0) >= 2 && (promiseStates.broken ?? 0) >= 1 && (promiseStates.open ?? 0) >= 1 ? "PASS" : "未验证",
  `soul_promises 状态分布=${JSON.stringify(promiseStates)}`, "fixture 未含 6 条自我承诺场景（S10）");
const humanWithKey = human.filter((h) => String(parse(h.meta_json, {})?.person?.key ?? "") !== "").length;
const humanFromL1Loop = human.filter((h) => String(parse(h.meta_json, {})?.source ?? "") === "l1+model+episode").length;
push("B11", "单写者", human.length > 0 && humanWithKey === human.length && humanFromL1Loop === 0 ? "PASS" : "FAIL",
  `human 行 ${human.length}，带 person.key ${humanWithKey}，来源 l1+model+episode 的 ${humanFromL1Loop}`);
const closedRelations = relations.filter((r) => String(r.valid_to ?? "") !== "").length;
push("B12", "断联后失效", "未验证", `relations=${relations.length}，带 valid_to ${closedRelations}`, "fixture 未含 S9 断联人场景");

// ── C 注入层 ──
push("C1", "两段注入都有内容", identity.length > 0 && anchor.length > 0 ? "PASS" : "FAIL",
  `segments: identity=${identity.length} chars，anchor=${anchor.length} chars；card chars=${cardChars}`);
const firstLine = identity.split("\n")[0] ?? "";
const axisNameHit = /(严谨|好奇|亲和|α|tanh|权重|direction)/i.test(identity);
push("C2", "读法常量在最前", firstLine.includes("读法") && !axisNameHit ? "PASS" : "FAIL", `identity 首行：${firstLine.slice(0, 40)}`);
push("C3", "按人过滤 [冒烟]", "CITED", "src/core/soul/__tests__/card-persons.test.ts「persons:[A]」「persons:[]」+ src/gateway/__tests__/soul-card-participants.test.ts 全绿（14 tests）");
push("C4", "未知会话不过滤", "CITED", "src/gateway/__tests__/soul-card-participants.test.ts「session 指向无 episode / persons_json 为空的会话」（7 tests 全绿）");
push("C5", "红线永不裁剪", "CITED", "src/core/soul/__tests__/card-v13.test.ts「整卡 ≤2400…超预算先丢最近的变化与生活」：13 条红线逐条仍在卡里（本轮新增断言）");
push("C6", "注入量回报对账", "CITED", "src/gateway/__tests__/soul-injection-stats-endpoint.test.ts「卡 chars 与召回整卡 chars 定义不同：不得记成 charMismatch」+「同会话 card.hash 与 sessionInit.hash 逐字相等（合成口径）…生产应为 0」；段级交付证据只认 persona-injection.jsonl section-read.hash vs /v3/soul/card identity/anchor.hash（不作为本矩阵 PASS 依据）");

// ── D 面板与读面 ──
push("D1", "人物列表", "CITED", `soul_person=${persons.length} 行；读面由 src/gateway/__tests__/soul-persons-endpoint.test.ts 覆盖（全量 vitest 通过）`);
push("D2", "单人详情", "CITED", "src/gateway/__tests__/soul-person-endpoint.test.ts（九字段 + evidence quote）全绿");
push("D3", "关系图", "CITED", `现行边 ${relations.filter((r) => String(r.valid_to ?? "") === "").length} 条；src/gateway/__tests__/soul-person-endpoint.test.ts 覆盖`);
push("D4", "空态与错误码", "CITED", "src/gateway/__tests__/soul-persons-endpoint.test.ts / soul-person-endpoint.test.ts（400/404/503 透出）全绿");

// ── E 时间与不变量 ──
const personaIds = persona.map((p) => String(p.item_id)).sort();
const personaIds2 = db2 ? all(db2, "SELECT item_id FROM soul_persona").map((p) => String(p.item_id)).sort() : null;
push("E1", "90 天回放可重放", personaIds2 ? (JSON.stringify(personaIds) === JSON.stringify(personaIds2) ? "PASS" : "FAIL") : "未验证",
  personaIds2 ? `两次回放 itemId 集合：${personaIds.length} vs ${personaIds2.length}，完全一致=${JSON.stringify(personaIds) === JSON.stringify(personaIds2)}` : "只跑了一次回放（传 --db2 可对比第二次）");
const activeCount = persona.filter((p) => p.state === "active").length;
const nonActive = persona.filter((p) => p.state !== "active");
const nonActiveWithValidTo = nonActive.filter((p) => String(p.valid_to ?? "") !== "").length;
push("E2", "滑出窗口不冻结", "未验证",
  `active=${activeCount}/${persona.length}，frozen=${persona.filter((p) => p.state === "frozen").length}，非 active 且带 valid_to ${nonActiveWithValidTo}/${nonActive.length}`,
  "方案 E2 要求失效行带 valid_to；当前失效语义只靠 state=degraded（planLifecycle 不写 valid_to），口径需产品决策" );
const frozen = persona.filter((p) => p.state === "frozen");
push("E3", "无永久冻结", frozen.length <= 2 ? "PASS" : "FAIL", `frozen=${frozen.length}`);
const alerts = ledger.filter((l) => l.action === "alert");
push("E4", "告警不刷屏", alerts.length <= 90 * 3 ? "PASS" : "FAIL", `ledger alert=${alerts.length}（上限 90×3=270）`, "6h 同码去重由 worker 告警抑制保证，未按窗口细分");
// admit 是「新建」，没有 before 文本；只要求 after_hash。其余变更动作必须成对。
const hashActions = new Set(["update", "degrade", "revive", "invalidate", "rollback", "drift", "consolidate"]);
const mutations = ledger.filter((l) => hashActions.has(String(l.action ?? "")) || String(l.action ?? "") === "admit");
const withHash = mutations.filter((l) =>
  String(l.after_hash ?? "") !== "" &&
  (String(l.action ?? "") === "admit" || String(l.before_hash ?? "") !== "")).length;
push("E5", "账本可追", mutations.length > 0 && withHash === mutations.length ? "PASS" : "FAIL",
  `变更类 ledger=${mutations.length}，before/after_hash 成对 ${withHash}（全量 ledger=${ledger.length}，含 cadence/alert 等非变更行）`);
push("E6", "生产 agent 未被污染", "CITED", `回放全程使用临时库 ${result.dbPath}，未连接生产库；生产侧快照版本在阶段3只读对账`);

// ── S1–S8 补充契约用例 ──
push("S1", "降级条目复现有测试", "CITED", "src/core/soul/__tests__/soul-worker.test.ts「A1 Round8：复现不带新证据时不刷 lastEvidenceAt（degraded 才能按 30/90 天正常老化）」");
push("S2", "事件史续命不占改写名额", "CITED", "src/core/soul/worker.ts「续命（不降级）」（测试标题不含该串，引用实现处）");
push("S3", "无向量器时漂移只观测", "CITED", "src/core/soul/__tests__/soul-worker.test.ts「漂移：无向量器时词面分只观测，不以 lexical 低分迁移状态」");
push("S4", "过期情绪不进卡与尾巴", "CITED", "src/core/soul/__tests__/card-service.test.ts「情绪强度归零/已过期…」「卡：过期即时情绪不进卡」");
push("S5", "档案水位吃修订时间", "CITED", "src/core/person/__tests__/profile-distiller.test.ts「编辑/合并只刷 updated_time 也进候选；水位只推到读到的最新修订时间（A3）」");
push("S6", "关系 valid_from/valid_to 取证据时间", "CITED", "src/core/person/__tests__/profile-distiller.test.ts「新建边的 valid_from = 那条 L1 的时间」「结束边的 valid_to 也取证据时间」");
push("S7", "collective 收敛为 fail-closed", "CITED", "src/core/soul/card-service.ts personFilter（key==='' → false）+ card-persons/participants 14 tests");
push("S8", "存量 valid_from 回填脚本", "CITED", "src/core/store/__tests__/soul-relation-validfrom-migration.test.ts（演练不写库/apply 夹取/重跑幂等）");

const summary = rows.reduce((acc, r) => {
  acc[r.status] = (acc[r.status] ?? 0) + 1;
  return acc;
}, {});
const report = {
  generatedAt: new Date().toISOString(),
  cwd: process.cwd(),
  resultPath,
  dbPath: result.dbPath,
  db2Path: db2Path || null,
  caseCount: rows.length,
  summary,
  rows,
};
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
const md = ["| 用例 | 判据 | 判定 | 证据 | 备注 |", "| --- | --- | --- | --- | --- |"]
  .concat(rows.map((r) => `| ${r.id} | ${r.title} | ${r.status} | ${String(r.evidence).replace(/\|/g, "/")} | ${String(r.note).replace(/\|/g, "/")} |`))
  .join("\n");
fs.writeFileSync(outPath.replace(/\.json$/, ".md"), md + "\n");
console.log(`41 用例矩阵：${rows.length} 条 → ${JSON.stringify(summary)}`);
// CITED = 只在单元测试里有证据、没从回放库读数（删掉被引用用例矩阵不会变红）。不算 PASS，单列。
console.log(`  静态引用（CITED，非回放证据）：${summary.CITED ?? 0} 条`);
for (const r of rows.filter((x) => x.status === "FAIL" || x.status === "未验证")) console.log(`  ${r.status} ${r.id} ${r.title} :: ${r.note || r.evidence}`);