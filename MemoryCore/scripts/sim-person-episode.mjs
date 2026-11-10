#!/usr/bin/env node
/**
 * 仿真（人格系统 v4 阶段 2 收尾 / §P2-E + §P2-F）：事件挂人 → human 层 per-person → 卡端点回显。
 *
 * 生产事实：`soul_episodes.persons_json` 在改动前不存在，`soul_persona` 的 human 层也没有
 * `meta.person`。所以「事件真的挂上了人」「human 行真的按人取」只能靠仿真证明。这里全部在
 * `mkdtemp` 临时目录里跑真 `VectorStore` + 真 `runSoulMaintenance` + 真 `handleSoulCardRoute`：
 *   - 两个自然人：何晨（p_name_he）、林一（p_name_lin）；
 *   - 两轮 tick 分别灌 s1（何晨）/ s2（林一）的 L0 对话，走真 mineEpisodes → resolvePerson；
 *   - 第三条 tick 用 rewriter 各给一条 human 候选，验证 meta.person 的写入与「不猜」；
 *   - 最后按卡端点断言 `?participants=A` 只含 A、不带参两段都在、未知 session 不过滤。
 *
 * 用法：cd MemoryCore && node scripts/sim-person-episode.mjs
 * 退出码：0 = 全部 PASS；1 = 有 FAIL 或环境降级。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TSX_ENV = "__SIM_PERSON_EPISODE_TSX__";
if (!process.env[TSX_ENV]) {
  const child = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, [TSX_ENV]: "1" },
  });
  process.exit(typeof child.status === "number" ? child.status : 1);
}

const { VectorStore } = await import("../src/core/store/sqlite.ts");
const { runSoulMaintenance } = await import("../src/core/soul/worker.ts");
const { resolveSoulConfig } = await import("../src/core/soul/types.ts");
const { handleSoulCardRoute } = await import("../src/gateway/soul-card-endpoint.ts");

const TAG = "[sim-person-episode]";
const TEAM = "t-sim";
const USER = "u-sim";
const AGENT = "a-sim";
const TENANT = { teamId: TEAM, userId: USER, agentId: AGENT };

const KEY_A = "p_name_he";
const KEY_B = "p_name_lin";
const NAME_A = "何晨";
const NAME_B = "林一";

// 带分类标记的句子：mineEpisodes 只认 correction/decision/… 这几类，平铺陈述挖不出事件。
const USER_TEXT_A = "不对，你又没跑门禁就报绿，先取证再回话";
const USER_TEXT_B = "先灰度再全量，不要一次全推，这是原则";
const HUMAN_TEXT_A = "他没跑门禁就报绿，先取证再回话";
const HUMAN_TEXT_B = "他要求先灰度再全量，不要一次全推";

const CHECKS = [];
let total = 0;
let passed = 0;
function check(name, actual, expected) {
  total += 1;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed += 1;
  CHECKS.push({ name, ok, actual, expected });
  console.log(`${ok ? "PASS" : "FAIL"} ${name} 实测=${JSON.stringify(actual)} = 期望=${JSON.stringify(expected)}`);
}
function ok(name, actual) {
  check(name, actual, true);
}

function humanBlock(text) {
  const m = /## 关于你\n([\s\S]*?)\n\n## /.exec(text);
  return m ? m[1].split("\n") : null;
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sim-person-episode-"));
const dbPath = path.join(dir, "vectors.db");
const store = new VectorStore(dbPath, 0);
const initRes = store.init();
if (store.isDegraded()) {
  console.error(`${TAG} 临时库初始化降级（环境问题，非断言失败）：${initRes.reason}`);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(1);
}

const NOW = () => new Date().toISOString();
function seedL0(sessionId, rows) {
  let t = Date.now() - rows.length * 1000;
  for (const [i, row] of rows.entries()) {
    t += 1000;
    const rec = store.upsertL0(
      {
        id: `${sessionId}-l0-${i + 1}`,
        sessionKey: sessionId,
        sessionId,
        teamId: TEAM,
        userId: USER,
        agentId: AGENT,
        role: row.role,
        messageText: row.text,
        recordedAt: new Date(t).toISOString(),
        timestamp: t,
      },
      undefined,
    );
    if (!rec) throw new Error(`upsertL0 failed for ${sessionId}#${i + 1}`);
  }
}

const RECORDS = [
  { id: "r1", content: "我把召回链路的空结果定位到投影漏列，先取证再改代码。", valence: -0.2, arousal: 0.4 },
  { id: "r2", content: "评审被打回时我没有辩解，直接认领笔误并重跑门禁。", valence: -0.3, arousal: 0.3 },
  { id: "r3", content: "我先跑门禁再回话。", valence: 0, arousal: 0.2 },
];

function baseConfig(personName) {
  return { ...resolveSoulConfig({}), updateIntervalHours: 0, personName };
}

async function tick(config, rewriter) {
  return runSoulMaintenance({
    store,
    tenant: TENANT,
    now: NOW(),
    trigger: "manual",
    config,
    recentRecords: async () => RECORDS,
    llmCallBudget: 2,
    rewriter,
  });
}

async function card(query) {
  const sendJson = (...args) => {
    captured = args;
  };
  let captured;
  const handled = await handleSoulCardRoute(
    new URL(`/v3/soul/card?team=${TEAM}&user=${USER}&agent=${AGENT}${query}`, "http://localhost"),
    "GET",
    sendJson,
    {},
    { getStore: () => store, getReadAgentProfile: async () => ({ name: "小满" }) },
  );
  if (!handled) throw new Error(`card route not handled（${query}）`);
  const [, status, payload] = captured;
  if (status !== 200) throw new Error(`card ${query} status=${status}`);
  return payload.data;
}

try {
  // 两个人先存在：resolvePerson 按展示名唯一命中，复用我们给的 person_key。
  for (const person of [
    { personKey: KEY_A, displayName: NAME_A, platform: "cli", platformId: "u-he" },
    { personKey: KEY_B, displayName: NAME_B, platform: "cli", platformId: "u-lin" },
  ]) {
    store.upsertSoulPerson(TENANT, person);
  }
  check("soul_person 行数（A/B）", store.listSoulPersons(TENANT).length, 2);

  // 第 1 轮：s1 = 何晨。cfg.personName 是展示名，participants 落的是它。
  seedL0("s1", [
    { role: "user", text: USER_TEXT_A },
    { role: "assistant", text: "好，我先补取证再回话。" },
  ]);
  const rep1 = await tick(baseConfig(NAME_A), async () => []);
  check("第 1 轮 episode inserted = 1", rep1.episodes?.inserted, 1);

  // 第 2 轮：s2 = 林一。s1 已入账，按 episodeId 跳过，只新增 s2。
  seedL0("s2", [
    { role: "user", text: USER_TEXT_B },
    { role: "assistant", text: "记下了，先灰度再全量。" },
  ]);
  const rep2 = await tick(baseConfig(NAME_B), async () => []);
  check("第 2 轮 episode inserted = 1", rep2.episodes?.inserted, 1);

  // 断言 1：两条 episode 各自带 persons_json，且恰好是各自那个人。
  const episodes = await store.listSoulEpisodes(TENANT, { limit: 50 });
  check("soul_episodes 行数", episodes.length, 2);
  const bySession = new Map(episodes.map((ep) => [ep.sessionId, ep]));
  check("s1.persons_json", bySession.get("s1")?.persons, [KEY_A]);
  check("s2.persons_json", bySession.get("s2")?.persons, [KEY_B]);
  ok("persons 里没有 assistant/user", episodes.every((ep) => !(ep.persons ?? []).some((p) => /^(assistant|user|system)$/i.test(p))));
  check("participants 仍保留展示名（与 persons 分工）", bySession.get("s1")?.participants, [NAME_A, "assistant"]);

  const epA = bySession.get("s1")?.episodeId;
  const epB = bySession.get("s2")?.episodeId;
  if (!epA || !epB) throw new Error("episodeId 缺失，无法构造 human 候选");

  // 第 3 轮：两条 human 候选，各引自己那条 episode。
  const humanCandidate = (text, episodeId) => ({
    layer: "human",
    text,
    evidenceIds: [episodeId, "r1", "r2"],
  });
  const rep3 = await tick(baseConfig(NAME_A), async () => [
    humanCandidate(HUMAN_TEXT_A, epA),
    humanCandidate(HUMAN_TEXT_B, epB),
  ]);

  // 断言 2：两条 human 行，各带各自 meta.person.key（唯一在场人才写）。
  const humans = store.listSoulPersona(TENANT).filter((it) => it.layer === "human");
  check("human 行数", humans.length, 2);
  const humanByText = new Map(humans.map((it) => [it.text, it]));
  check("human(A).meta.person.key", humanByText.get(HUMAN_TEXT_A)?.meta?.person?.key, KEY_A);
  check("human(B).meta.person.key", humanByText.get(HUMAN_TEXT_B)?.meta?.person?.key, KEY_B);
  check("human(A).meta.person.displayName", humanByText.get(HUMAN_TEXT_A)?.meta?.person?.displayName, NAME_A);
  ok("human 层没有给出无主行", humans.every((it) => typeof it.meta?.person?.key === "string" && it.meta.person.key !== ""));
  check("第 3 轮 admitted ≥ 2", rep3.admitted >= 2, true);

  // 断言 3：卡端点——?participants=A 只含 A 的 human 行；B 反之。
  const onlyA = await card(`&participants=${KEY_A}`);
  check("participants=A 回显 persons", onlyA.persons, [KEY_A]);
  ok("participants=A 卡内含 A 的 human 行", String(onlyA.text).includes(HUMAN_TEXT_A));
  ok("participants=A 卡内不含 B 的 human 行", !String(onlyA.text).includes(HUMAN_TEXT_B));

  const onlyB = await card(`&participants=${KEY_B}`);
  check("participants=B 回显 persons", onlyB.persons, [KEY_B]);
  ok("participants=B 卡内含 B 的 human 行", String(onlyB.text).includes(HUMAN_TEXT_B));
  ok("participants=B 卡内不含 A 的 human 行", !String(onlyB.text).includes(HUMAN_TEXT_A));

  // 断言 4：不带 participants / session → 不过滤、不回显，两段都在。
  const legacy = await card("");
  ok("不带参：不出现 data.persons", !("persons" in legacy));
  ok("不带参：A 的 human 行在", String(legacy.text).includes(HUMAN_TEXT_A));
  ok("不带参：B 的 human 行在", String(legacy.text).includes(HUMAN_TEXT_B));

  // 断言 5：反例——session 指向没有 episode 的会话：未知≠没有，不过滤且不回显。
  const unknown = await card("&session=s-no-such-session");
  ok("未知 session：不出现 data.persons", !("persons" in unknown));
  check("未知 session：text 与不带参逐字节相同", unknown.text === legacy.text, true);
  check("未知 session：hash 相同", unknown.hash, legacy.hash);
  check("未知 session：human 段仍是两行", humanBlock(unknown.text), [HUMAN_TEXT_A, HUMAN_TEXT_B]);

  // 断言 6：session 路径正例——按该会话 persons_json 回显并过滤。
  const bySessionCard = await card("&session=s1");
  check("session=s1 回显 persons", bySessionCard.persons, [KEY_A]);
  ok("session=s1 只含 A", String(bySessionCard.text).includes(HUMAN_TEXT_A) && !String(bySessionCard.text).includes(HUMAN_TEXT_B));
} finally {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

const result = { tag: TAG, passed, total, ok: passed === total, checks: CHECKS };
console.log(`RESULT_JSON ${JSON.stringify(result)}`);
console.log(`SUMMARY ${passed}/${total}`);
process.exit(passed === total ? 0 : 1);
