#!/usr/bin/env node
/**
 * 仿真（人格系统 v4 / §P2-D 判据 5）：按人（person）过滤人格卡的**端到端**链路。
 *
 * 一条链从 L0 真列一路走到底，全程只用真实现，不 mock store：
 *   L0（user_id = 各自平台 id）
 *     → mineEpisodes 的 speaker → personsForEpisode → resolvePerson（平台 id 精确命中）
 *     → soul_episodes.persons_json
 *     → runSoulMaintenance 的 episodePersons → human 条目 meta.person = {key, displayName}
 *     → 真 handleSoulCardRoute 的 ?participants= → human 段按人过滤
 *
 * 两个自然人 A/B 同 team 同 agent、不同平台 id，各说各的话（两个会话）。
 *
 * 为什么 tick 要自己拼 recentL0：`store.recentL0Messages(tenant, …)` 的 SQL 是
 * `WHERE team_id=? AND user_id=? AND agent_id=?`（sqlite.ts 的 recentL0Messages），
 * 即 L0 读面按 tenant.userId 分区，一个 tenant 只能读到该 user_id 的行。而
 * `runSoulMaintenance` 收 L0 恰好走 `deps.recentL0`（worker.ts 的 SoulWorkerDeps 接缝）——
 * 调度侧本来就是把「这个 agent 面向的多个人的会话」合起来喂一次维护。
 * 本脚本照这个口径：按各人 userId 各读一次真库，再按时间合并给 tick。
 * 除此之外没有任何替身：episode 挖掘、挂人、落库、出卡全是真的。
 *
 * 用法：cd MemoryCore && node scripts/sim-person-e2e.mjs
 * 退出码：0 = 全部 PASS；1 = 有 FAIL 或环境降级。
 * 约束：只读写 os.tmpdir() 下 mkdtemp 出来的临时库，跑完即删；绝不碰生产库。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// tsx 自举：本文件的 .ts 依赖靠 --import tsx 才能加载，故进程内先重跑一次自己。
const TSX_ENV = "__SIM_PERSON_E2E_TSX__";
if (!process.env[TSX_ENV]) {
  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: "inherit", env: { ...process.env, [TSX_ENV]: "1" } },
  );
  process.exit(typeof child.status === "number" ? child.status : 1);
}

const { VectorStore } = await import("../src/core/store/sqlite.ts");
const { runSoulMaintenance } = await import("../src/core/soul/worker.ts");
const { resolveSoulConfig } = await import("../src/core/soul/types.ts");
const { EPISODE_SPEAKER_PLATFORM, personsForEpisode } = await import("../src/core/soul/episode.ts");
const { personKeyOf } = await import("../src/core/person/resolve.ts");
const { handleSoulCardRoute } = await import("../src/gateway/soul-card-endpoint.ts");

const TAG = "[sim-person-e2e]";

// ── 身份：同 team、同 agent、不同平台 id（就是 L0 的 user_id 真列） ──────────
const TEAM = "t-e2e";
const AGENT = "a-e2e";
/** 维护面 tenant：soul_* 三张表都按它分区，A/B 共享。 */
const USER = "u-e2e";
const TENANT = { teamId: TEAM, userId: USER, agentId: AGENT };

const PLATFORM_A = "u-plat-A";
const PLATFORM_B = "u-plat-B";
const NAME_A = "何晨";
const NAME_B = "林一";
const KEY_A = personKeyOf({
  teamId: TEAM,
  userId: USER,
  agentId: AGENT,
  platform: EPISODE_SPEAKER_PLATFORM,
  platformId: PLATFORM_A,
});
const KEY_B = personKeyOf({
  teamId: TEAM,
  userId: USER,
  agentId: AGENT,
  platform: EPISODE_SPEAKER_PLATFORM,
  platformId: PLATFORM_B,
});

const SESS_A = "s-e2e-a";
const SESS_B = "s-e2e-b";
/** 一个从没写过 L0、也就不会有 episode 的会话：用来考「未知 ≠ 没有」。 */
const SESS_MISSING = "s-e2e-missing";

const USER_TEXT_A = "不对，你又没跑门禁就报绿，先取证再回话";
const USER_TEXT_B = "先灰度再全量，不要一次全推，这是原则";
const HUMAN_TEXT_A = "他没跑门禁就报绿，先取证再回话";
const HUMAN_TEXT_B = "他要求先灰度再全量，不要一次全推";

const RECORDS = [
  { id: "r1", content: "我把召回链路的空结果定位到投影漏列，先取证再改代码。", valence: -0.2, arousal: 0.4 },
  { id: "r2", content: "评审被打回时我没有辩解，直接认领笔误并重跑门禁。", valence: -0.3, arousal: 0.3 },
  { id: "r3", content: "我先跑门禁再回话。", valence: 0, arousal: 0.2 },
];

// ── 断言 ────────────────────────────────────────────────────────────────
let checks = 0;
let passed = 0;
const results = [];

function check(name, actual, expected) {
  checks += 1;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed += 1;
  results.push({ name, ok, actual, expected });
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name} 实测=${JSON.stringify(actual)} = 期望=${JSON.stringify(expected)}`,
  );
  return ok;
}

const NOW = () => new Date().toISOString();

/** 取卡响应里的 human 段（`## 关于你` 到下一个二级标题之间），按行切成条目。 */
function humanBlock(text) {
  const m = /## 关于你\n([\s\S]*?)\n\n## /.exec(String(text ?? ""));
  if (!m) return [];
  return m[1]
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const sorted = (arr) => [...arr].sort();

function baseConfig(personName) {
  return { ...resolveSoulConfig({}), updateIntervalHours: 0, personName };
}

// ── 临时库 ──────────────────────────────────────────────────────────────
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sim-person-e2e-"));
const dbPath = path.join(DIR, "vectors.db");
const store = new VectorStore(dbPath, 0);
let bootFailed = false;

try {
  if (!store.init()) {
    bootFailed = true;
    console.log(`${TAG} store.init() 失败，环境问题，终止`);
  } else if (store.isDegraded()) {
    bootFailed = true;
    console.log(`${TAG} store 处于降级模式（sqlite 不可用），环境问题，终止`);
  }
} catch (err) {
  bootFailed = true;
  console.log(`${TAG} store 初始化抛错：${err instanceof Error ? err.message : String(err)}`);
}

// ── 造数 ────────────────────────────────────────────────────────────────

/** 写一条 L0。userId 是说话人的平台 id —— 挂人就是从这一列来的。 */
function seedL0(sessionId, userId, rows) {
  const t0 = Date.now() - 10 * 60_000;
  rows.forEach((row, i) => {
    const t = t0 + i * 1000;
    const ok = store.upsertL0(
      {
        id: `${sessionId}-l0-${i + 1}`,
        sessionKey: sessionId,
        sessionId,
        teamId: TEAM,
        userId,
        agentId: AGENT,
        role: row.role,
        messageText: row.text,
        recordedAt: new Date(t).toISOString(),
        timestamp: t,
      },
      undefined,
    );
    if (!ok) throw new Error(`upsertL0 failed for ${sessionId}#${i + 1}`);
  });
}

/** 按某个说话人的分区真读一次 L0（读面就是按 user_id 分区的）。 */
function readL0(userId) {
  return store.recentL0Messages(
    { teamId: TEAM, userId, agentId: AGENT },
    { sinceDays: 30, maxMessages: 200 },
  );
}

/** L1 行：metadata_json.persons 落 {key, role}，读面 listL1ByPerson 按它过滤。 */
function seedL1(id, personKey, content, sessionId) {
  const now = NOW();
  const ok = store.upsertL1(
    {
      id,
      content,
      type: "episodic",
      priority: 60,
      scene_name: "person-e2e",
      source_message_ids: [],
      metadata: { persons: [{ key: personKey, role: "subject" }] },
      timestamps: [now],
      createdAt: now,
      updatedAt: now,
      version: 1,
      sessionKey: sessionId,
      sessionId,
      teamId: TEAM,
      userId: USER,
      agentId: AGENT,
    },
    undefined,
  );
  if (!ok) throw new Error(`upsertL1 failed for ${id}`);
}

async function card(query) {
  let captured;
  const sendJson = (...args) => {
    captured = args;
  };
  const handled = await handleSoulCardRoute(
    new URL(`/v3/soul/card?team=${TEAM}&user=${USER}&agent=${AGENT}${query}`, "http://localhost"),
    "GET",
    sendJson,
    {},
    { getStore: () => store, getReadAgentProfile: async () => ({ name: "小满" }) },
  );
  if (!handled) throw new Error(`handleSoulCardRoute 未处理 ${query || "(无参数)"}`);
  const [, status, payload] = captured;
  if (status !== 200) throw new Error(`卡端点 ${query} 返回 ${status}：${JSON.stringify(payload)}`);
  return payload.data;
}

async function main() {
  if (bootFailed) return;

  // ── 0. 纯函数契约：speaker 的平台 id 就是挂人的来源 ────────────────────
  const pure = personsForEpisode([NAME_A, "assistant"], { userId: PLATFORM_A, agentId: AGENT });
  check("personsForEpisode 剔角色词后只剩展示名", pure.names, [NAME_A]);
  check("personsForEpisode 的 platformId 取 speaker.userId", pure.platformId, PLATFORM_A);
  check(
    "personsForEpisode 无 speaker 时只回名单",
    personsForEpisode([NAME_A, "assistant"], undefined),
    { names: [NAME_A] },
  );

  // ── 1. 预置两个自然人（平台 id 绑定），再灌 L0 与 L1 ───────────────────
  for (const p of [
    { personKey: KEY_A, displayName: NAME_A, platform: EPISODE_SPEAKER_PLATFORM, platformId: PLATFORM_A },
    { personKey: KEY_B, displayName: NAME_B, platform: EPISODE_SPEAKER_PLATFORM, platformId: PLATFORM_B },
  ]) {
    store.upsertSoulPerson(TENANT, p);
  }
  check("A/B 的 person_key 不同", KEY_A !== KEY_B, true);
  check("soul_person 预置行数", store.listSoulPersons(TENANT).length, 2);

  seedL0(SESS_A, PLATFORM_A, [
    { role: "user", text: USER_TEXT_A },
    { role: "assistant", text: "好，我先补取证再回话。" },
  ]);
  seedL0(SESS_B, PLATFORM_B, [
    { role: "user", text: USER_TEXT_B },
    { role: "assistant", text: "明白，先灰度再全量。" },
  ]);
  seedL1("l1-a", KEY_A, "他没跑门禁就报绿，先取证再回话。", SESS_A);
  seedL1("l1-b", KEY_B, "他要求先灰度再全量，不要一次全推。", SESS_B);

  const l0A = readL0(PLATFORM_A);
  const l0B = readL0(PLATFORM_B);
  check("L0 分区读：A 的分区只有 A 的消息", l0A.map((r) => r.record_id), [
    `${SESS_A}-l0-1`,
    `${SESS_A}-l0-2`,
  ]);
  check("L0 分区读：B 的分区只有 B 的消息", l0B.map((r) => r.record_id), [
    `${SESS_B}-l0-1`,
    `${SESS_B}-l0-2`,
  ]);
  // 调度侧口径：两个人各自的会话合并成一次维护的输入。
  const mergedL0 = [...l0A, ...l0B].sort((x, y) =>
    String(x.recorded_at ?? x.timestamp ?? "").localeCompare(String(y.recorded_at ?? y.timestamp ?? "")),
  );

  // ── 2. 第 1 轮维护：真 mineEpisodes → 真 resolvePerson → persons_json ──
  const rep1 = await runSoulMaintenance({
    store,
    tenant: TENANT,
    now: NOW(),
    trigger: "manual",
    config: baseConfig(NAME_A),
    recentRecords: async () => RECORDS,
    recentL0: async () => mergedL0,
    llmCallBudget: 2,
    rewriter: async () => [],
  });
  check("第 1 轮 episode inserted = 2", rep1.episodes?.inserted, 2);

  let eps = store.listSoulEpisodes(TENANT, { limit: 100 });
  check("soul_episodes 行数", eps.length, 2);
  const epA = eps.find((e) => e.sessionId === SESS_A);
  const epB = eps.find((e) => e.sessionId === SESS_B);
  check("A 的 episode 存在且挂到 A 的 key", epA?.persons, [KEY_A]);
  check("B 的 episode 存在且挂到 B 的 key", epB?.persons, [KEY_B]);
  check("A/B 的 episode 各自分区且不串门", epA && epB ? epA.episodeId !== epB.episodeId : false, true);

  // 读面行字段是 recordId / roleInRecord（不是 id）——见 sqlite.ts 的 listL1ByPerson 返回类型。
  const l1A = store.listL1ByPerson(TENANT, KEY_A, 10);
  const l1B = store.listL1ByPerson(TENANT, KEY_B, 10);
  check("listL1ByPerson(A) 只命中 A 的行", l1A.map((r) => r.recordId), ["l1-a"]);
  check("listL1ByPerson(A) 的角色是 subject", l1A.map((r) => r.roleInRecord), ["subject"]);
  check("listL1ByPerson(B) 只命中 B 的行", l1B.map((r) => r.recordId), ["l1-b"]);
  check("listL1ByPerson(B) 的角色是 subject", l1B.map((r) => r.roleInRecord), ["subject"]);

  // ── 3. 第 2 轮维护：stub rewriter 各产一条 human 候选，验证 meta.person ─
  const rewrites = [
    {
      layer: "human",
      text: HUMAN_TEXT_A,
      // evidenceIds 里的 ep-* 就是「这条人格讲的是谁」的唯一依据（没有 episodeIds 字段）。
      evidenceIds: [epA.episodeId, "r1", "r2"],
      fewShot: [{ quote: USER_TEXT_A, recordId: `${SESS_A}-l0-1` }],
    },
    {
      layer: "human",
      text: HUMAN_TEXT_B,
      evidenceIds: [epB.episodeId, "r2", "r3"],
      fewShot: [{ quote: USER_TEXT_B, recordId: `${SESS_B}-l0-1` }],
    },
  ];
  await runSoulMaintenance({
    store,
    tenant: TENANT,
    now: NOW(),
    trigger: "manual",
    config: baseConfig(NAME_A),
    recentRecords: async () => RECORDS,
    recentL0: async () => mergedL0,
    llmCallBudget: 2,
    rewriter: async () => rewrites,
  });

  const items = store.listSoulPersona(TENANT);
  const human = items.filter((it) => it.layer === "human");
  check("human 条目数", human.length, 2);

  const hA = human.find((it) => it.meta?.person?.key === KEY_A);
  const hB = human.find((it) => it.meta?.person?.key === KEY_B);
  check("A 的 human 条目 meta.person.key", hA?.meta?.person?.key, KEY_A);
  check("A 的 human 条目 meta.person.displayName", hA?.meta?.person?.displayName, NAME_A);
  check("B 的 human 条目 meta.person.key", hB?.meta?.person?.key, KEY_B);
  check("B 的 human 条目 meta.person.displayName", hB?.meta?.person?.displayName, NAME_B);
  // 条目主键字段是 itemId（不是 id）——见 sqlite.ts 里 PersonaItem 的行映射。
  check("A/B 的 human 条目是两条不同条目", hA && hB ? hA.itemId !== hB.itemId : false, true);
  check("human 段没有无主（缺 meta.person）的条目", human.filter((it) => !it.meta?.person?.key).length, 0);

  // ── 4. 真卡端点：按人过滤 / 全局 / 未知会话 ────────────────────────────
  const dA = await card(`&participants=${encodeURIComponent(KEY_A)}`);
  check("?participants=A 回显 data.persons", dA.persons, [KEY_A]);
  check("?participants=A 的 human 段只含 A 那一行", humanBlock(dA.text), [HUMAN_TEXT_A]);

  const dB = await card(`&participants=${encodeURIComponent(KEY_B)}`);
  check("?participants=B 回显 data.persons", dB.persons, [KEY_B]);
  check("?participants=B 的 human 段只含 B 那一行", humanBlock(dB.text), [HUMAN_TEXT_B]);

  const dAll = await card("");
  check("不带参：响应里没有 persons 字段", "persons" in dAll, false);
  check("不带参：human 段两行都在（全局视角）", sorted(humanBlock(dAll.text)), sorted([HUMAN_TEXT_A, HUMAN_TEXT_B]));

  // 反例：session 指向一个没有 episode 的会话 —— 未知不等于没有，不过滤。
  const dMissing = await card(`&session=${encodeURIComponent(SESS_MISSING)}`);
  check("未知 session：响应里没有 persons 字段", "persons" in dMissing, false);
  check("未知 session：没有退化成只剩全局行，human 段仍是两行", sorted(humanBlock(dMissing.text)), sorted([HUMAN_TEXT_A, HUMAN_TEXT_B]));

  // 正例：session 指向 A 的会话 —— 靠 episode 的 persons_json 反查，回显 A。
  const dSessA = await card(`&session=${encodeURIComponent(SESS_A)}`);
  check("session=A 的会话：回显 data.persons", dSessA.persons, [KEY_A]);
  check("session=A 的会话：human 段只含 A 那一行", humanBlock(dSessA.text), [HUMAN_TEXT_A]);

  // ── 5. 行数快照（证明自包含、跑完即弃） ────────────────────────────────
  eps = store.listSoulEpisodes(TENANT, { limit: 100 });
  const snap = {
    db: "<tmpdir>/sim-person-e2e-*/vectors.db",
    soul_episodes: eps.length,
    soul_persona_human: store.listSoulPersona(TENANT).filter((it) => it.layer === "human").length,
    soul_person: store.listSoulPersons(TENANT).length,
    persons_json_A: eps.find((e) => e.sessionId === SESS_A)?.persons ?? null,
    persons_json_B: eps.find((e) => e.sessionId === SESS_B)?.persons ?? null,
  };
  console.log(`SNAPSHOT ${JSON.stringify(snap)}`);
  check("快照 soul_episodes = 2", snap.soul_episodes, 2);
  check("快照 soul_persona human = 2", snap.soul_persona_human, 2);
  check("快照 soul_person = 2", snap.soul_person, 2);
}

try {
  await main();
} catch (err) {
  checks += 1;
  console.log(`FAIL 运行期异常 实测=${JSON.stringify(err instanceof Error ? err.message : String(err))} = 期望=无异常`);
  if (err instanceof Error && err.stack) console.log(err.stack);
} finally {
  try {
    store.close();
  } catch {
    /* 关库失败不影响结论 */
  }
  try {
    fs.rmSync(DIR, { recursive: true, force: true });
  } catch {
    /* 临时目录删不掉不算失败 */
  }
}

console.log(`SUMMARY ${passed}/${checks}`);
console.log(
  `RESULT_JSON ${JSON.stringify({ tag: "sim-person-e2e", passed, total: checks, ok: passed === checks, checks: results })}`,
);
process.exit(passed === checks ? 0 : 1);
