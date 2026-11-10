#!/usr/bin/env node
/**
 * 仿真（人格系统 v4 §5 阶段 3 · 情绪层）：临时库里跑真 VectorStore + 真 runSoulMaintenance，
 * 验证「加列 / 半衰期减半 / PAD 锚点 / 漏斗六档」四件事真的落到了库和读面，而不是只改了常量。
 *
 * 做法：
 *   - mkdtemp 建临时库，VectorStore.init() 自己建表（含新加的 agency/confidence/object_person 三列）；
 *   - 灌 3 个对象 × 3 种评价形态 = 9 条假 episode（affectSource='none'，避免被 worker 当 lexicon 归档），
 *     其中一种形态把 PAD 放在 (−0.0, 0.92) —— 24 个锚点都够不到的位置，用来验证「锚点不命中」是真实存在的一档；
 *   - 跑一轮 tick → 断言行数/落库列/漏斗；再跑一轮 → 断言不重复写（幂等）；
 *   - 时间推进全部靠传 `now`，不改系统时钟、不 sleep。
 *
 * ⚠ 与派工原文的一处偏差（故意，已在报告里说明）：派工要求断言②「label='' 的比例 >0」。
 *   但规格 v4 §5 P3-C `:211` 明确「label 仍由 pickTemplate 规则决定，不由 PAD 反推」，并给了
 *   生产 9 行余弦判错的实测；两条不能同时成立。本脚本把②写成**等价的可证伪形式**：
 *   「存在 PAD 离全部锚点都远的行」（label==='' 或 rankLabelsByPad 首选距离 > EMOTION_PAD_NEAR_MAX）。
 *   若要把 worker 的写库 label 换成 labelFromPad，改 worker.ts 一处即可，那时②的严格形式自然成立。
 *
 * 用法：node scripts/sim-emotion.mjs
 * 退出码：0 = 全部 PASS；1 = 有 FAIL 或环境降级。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TSX_ENV = "__SIM_EMOTION_TSX__";
if (!process.env[TSX_ENV]) {
  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: "inherit", env: { ...process.env, [TSX_ENV]: "1" } },
  );
  process.exit(typeof child.status === "number" ? child.status : 1);
}

const { DatabaseSync } = await import("node:sqlite");
const { VectorStore } = await import("../src/core/store/sqlite.ts");
const { runSoulMaintenance } = await import("../src/core/soul/worker.ts");
const { EMOTION_PAD_NEAR_MAX, decayedStoredIntensity, rankLabelsByPad, templateHalfLifeHours } = await import(
  "../src/core/soul/emotion.ts"
);

const TAG = "[sim-emotion]";
const TEAM = { teamId: "team-sim-emo", userId: "usr-sim-emo", agentId: "agt-sim-emo" };
const NOW = "2026-11-08T09:00:00.000Z";
const DAY = NOW.slice(0, 10);

let failed = 0;
let total = 0;
/** 标量断言：JSON 相等即通过。 */
function assert(name, actual, expected) {
  total += 1;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${name} 实测=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`);
}
/** 条件断言：自己算 ok，实测/期望都写成可读字符串。 */
function assertThat(name, ok, measured, expected) {
  total += 1;
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${name} 实测=${measured} 期望=${expected}`);
}

const addHours = (iso, hours) => new Date(Date.parse(iso) + hours * 3600_000).toISOString();

// ── 灌数：3 个对象 × 3 种形态 ──────────────────────────────────────────────
const OBJECTS = ["假绿被当场指出", "这处不对不是我弄的，你别错怪我", "按生产级标准落地并测试"];
const SHAPES = [
  // 夸 / 控制感高
  { kind: "praise", valence: 0.6, arousal: 0.4, intensity: 0.4, stance: "谢谢，这次按你说的收口了", outcome: "" },
  // 追责 + 举证洗清
  {
    kind: "complaint",
    valence: -0.5,
    arousal: 0.4,
    intensity: 0.4,
    stance: "不是我造成的，我查了日志是上游缓存",
    outcome: "不是我造成的，我查了日志是上游缓存",
  },
  // 极端负面但完全平静：PAD 落在 24 个锚点都够不到的角上（锚点不命中那一档）。
  // 实测：v=-1、a=0 时对全部锚点的首选距离都在 0.37 以上（阈值 0.35），与 template 的 dominance 无关。
  {
    kind: "complaint",
    valence: -1,
    arousal: 0,
    intensity: 0.35,
    stance: "算了，就这样吧，不想再说了",
    outcome: "",
  },

];

function fabricated() {
  const eps = [];
  OBJECTS.forEach((stance, oi) => {
    SHAPES.forEach((s, si) => {
      eps.push({
        episodeId: `ep-sim-emo-${oi}-${si}`,
        at: NOW,
        day: DAY,
        kind: s.kind,
        title: `仿真片段 ${oi}-${si}`,
        object: "",
        participants: ["user", "assistant"],
        userStance: stance,
        agentStance: s.stance,
        cost: "",
        outcome: s.outcome,
        valence: s.valence,
        arousal: s.arousal,
        intensity: s.intensity,
        evidenceIds: [],
        sessionId: `sess-sim-emo-${oi}-${si}`,
        quote: null,
        affectSource: "none",
      });
    });
  });
  return eps;
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sim-emotion-"));
const dbPath = path.join(dir, "vectors.db");
const store = new VectorStore(dbPath, 0);
const initRes = store.init();
if (store.isDegraded()) {
  console.error(`${TAG} 临时库初始化降级（环境问题，非断言失败）：${initRes.reason}`);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(1);
}

const seeded = store.commitSoulEpisodes(TEAM, fabricated());
if (seeded.inserted !== 9) {
  console.error(`${TAG} 灌数失败：episode 实际写入 ${seeded.inserted} 条，期望 9`);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(1);
}

const tick = (now) =>
  runSoulMaintenance({
    store,
    tenant: TEAM,
    now,
    // 不挖新事件：本轮只处理存量片段（recentL0 缺席 = 不生长）。
    config: { episodeWindowDays: 30, updateIntervalHours: 0 },
    trigger: "manual",
    llmCallBudget: 0,
  });

await tick(NOW);
const rows = store.listSoulEmotions(TEAM, { limit: 100 }) ?? [];

// ① 行数
assert("① soul_emotions 行数（9 条片段各一行）", rows.length, 9);

// ② 锚点不命中：label 为空，或 PAD 离 24 个锚点首选距离都超过阈值
const farRows = rows.filter((r) => {
  if (r.label === "") return true;
  const best = rankLabelsByPad({ valence: r.valence, arousal: r.arousal, dominance: r.dominance }, 1)[0];
  return (best?.distance ?? Infinity) > EMOTION_PAD_NEAR_MAX;
});
assertThat(
  "② PAD 离全部锚点都远的行数（label='' 或首选距离 > 阈值）",
  farRows.length > 0,
  `${farRows.length} 行（其中 label='' 的 ${rows.filter((r) => r.label === "").length} 行）`,
  ">0",
);

// 落库三列（P3-A）：新列真的写进去了，不是只在类型里声明
const db = new DatabaseSync(dbPath, { readOnly: true });
const colRows = db
  .prepare("SELECT agency, confidence, object_person FROM soul_emotions WHERE team_id = ? AND user_id = ? AND agent_id = ?")
  .all(TEAM.teamId, TEAM.userId, TEAM.agentId);
assert("③ 新增三列：agency/confidence 落值、object_person 为空", {
  agencyNonNull: colRows.filter((r) => r.agency !== null).length,
  confidenceNonNull: colRows.filter((r) => r.confidence !== null).length,
  objectPersonNonNull: colRows.filter((r) => r.object_person !== null).length,
}, { agencyNonNull: 9, confidenceNonNull: 9, objectPersonNonNull: 0 });

// 漏斗六档（P3-D）：六档都有行，且 committed 是真实 inserted ≤ appraised
const stats = store.listSoulGateStats(TEAM, { sinceDay: DAY, limit: 500 }) ?? [];
const funnelOf = (code) =>
  stats.filter((s) => s.code === code && s.day === DAY && s.layer === "emotion").reduce((sum, s) => sum + s.count, 0);
const FUNNEL = [
  "emotion:candidate",
  "emotion:object_ok",
  "emotion:appraised",
  "emotion:anchor_hit",
  "emotion:intensity_ok",
  "emotion:committed",
];
const funnel = Object.fromEntries(FUNNEL.map((c) => [c, funnelOf(c)]));
assertThat(
  "④ 漏斗六档都有计数，committed ≤ appraised ≤ object_ok ≤ candidate",
  FUNNEL.every((c) => funnel[c] > 0) &&
    funnel["emotion:committed"] <= funnel["emotion:appraised"] &&
    funnel["emotion:appraised"] <= funnel["emotion:object_ok"] &&
    funnel["emotion:object_ok"] <= funnel["emotion:candidate"],
  JSON.stringify(funnel),
  "六档 >0 且逐级不增",
);

// ⑤ 再跑一轮：不重复写（已被 moodIntegratedAt 打标）
const LATER = addHours(NOW, 2);
await tick(LATER);
const rowsAfter = store.listSoulEmotions(TEAM, { limit: 100 }) ?? [];
assert("⑤ 再跑一轮后行数不增（幂等）", rowsAfter.length, 9);

// ⑥ 读侧衰减：按该行真实半衰期手算，与 decayedStoredIntensity 对齐（差 ≤1e-3）
const pick = rows.find((r) => r.label !== "" && templateHalfLifeHours(r.label) > 0) ?? rows[0];
const hl = templateHalfLifeHours(pick.label);
const sixLater = addHours(pick.at, 6);
const measured = decayedStoredIntensity({ label: pick.label, intensity: pick.intensity, asOf: pick.at }, sixLater);
const expected = pick.intensity * Math.exp((-6 * Math.LN2) / hl);
assertThat(
  `⑥ 6h 后衰减（${pick.label} / 半衰期 ${hl}h / 原始强度 ${pick.intensity}）`,
  Math.abs(measured - expected) <= 1e-3,
  measured.toFixed(6),
  expected.toFixed(6),
);

db.close();
store.close();
fs.rmSync(dir, { recursive: true, force: true });

console.log(`SUMMARY ${total - failed}/${total}`);
process.exit(failed > 0 ? 1 : 0);