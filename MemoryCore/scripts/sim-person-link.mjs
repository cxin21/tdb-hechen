#!/usr/bin/env node
/**
 * 仿真（人格系统 v3 阶段 1 / §6）：2 人 × 3 条记忆 × 2 会话 → 验证写侧挂人真的落库。
 *
 * 全部在 `mkdtemp` 临时目录里跑真 VectorStore + 真 writeMemory（不是 mock）：
 *   - 临时 sqlite 由 VectorStore.init() 自己建表（含 soul_person），验证 DDL 幂等可建；
 *   - 记忆走 L1 唯一 choke point `writeMemory`，验证 persons 是在正确的位置写进去的；
 *   - 断言直接读临时库文件的 `l1_records` / `soul_person`，不信任内存返回值。
 *
 * 用法：node scripts/sim-person-link.mjs
 * 退出码：0 = 全部 PASS；1 = 有 FAIL 或环境降级。
 *
 * 实现：脚本要 import `src` 下的 `.ts` 源码，因此以 tsx loader 重新执行自身（与 migrate-person-refs.mjs 同法）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TSX_ENV = "__SIM_PERSON_LINK_TSX__";
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
const { writeMemory } = await import("../src/core/record/l1-writer.ts");
const { personKeyOf } = await import("../src/core/person/resolve.ts");

const TAG = "[sim-person-link]";
const TEAM = "team-sim";
const USER = "usr-sim";
const AGENT = "agt-sim";

const PERSON_A = { platform: "cli", platformId: "u-1001", displayName: "何晨" };
const PERSON_B = { platform: "cli", platformId: "u-2002", displayName: "阿哲" };
const SESSIONS = ["sess-s1", "sess-s2"];

let failed = 0;
function assert(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${name} 实测=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sim-person-link-"));
const dbPath = path.join(dir, "vectors.db");
const store = new VectorStore(dbPath, 0);
const initRes = store.init();
if (store.isDegraded()) {
  console.error(`${TAG} 临时库初始化降级（环境问题，非断言失败）：${initRes.reason}`);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(1);
}

/** 走真实 writeMemory 落一条记忆（embedding 缺省 → 只写 metadata/FTS，仿真不需要向量）。 */
async function writeOne({ id, content, sessionKey, metadata }) {
  return writeMemory({
    memory: {
      content,
      type: "episodic",
      priority: 3,
      source_message_ids: [`msg-${id}`],
      metadata,
      scene_name: "sim",
    },
    decision: { record_id: id, action: "store", target_ids: [] },
    baseDir: dir,
    sessionKey,
    sessionId: sessionKey,
    taskId: undefined,
    teamId: TEAM,
    userId: USER,
    agentId: AGENT,
    vectorStore: store,
  });
}

let seq = 0;
for (const person of [PERSON_A, PERSON_B]) {
  for (let i = 0; i < 3; i += 1) {
    seq += 1;
    const sessionKey = SESSIONS[i % SESSIONS.length];
    await writeOne({
      id: `m-${seq}`,
      content: `${person.displayName} 第 ${i + 1} 条：偏好先灰度后全量`,
      sessionKey,
      metadata: { participants: [person], speaker: person },
    });
  }
}
const keyA = personKeyOf({ teamId: TEAM, userId: USER, agentId: AGENT, ...PERSON_A });
const keyB = personKeyOf({ teamId: TEAM, userId: USER, agentId: AGENT, ...PERSON_B });

// 转述：说话人 A 说 B 的事 → 主体是 B，A 只能以 mentioned 出现，绝不能拿到 speaker。
await writeOne({
  id: "m-relay",
  content: "何晨说阿哲昨天加班到三点",
  sessionKey: SESSIONS[0],
  metadata: { participants: [PERSON_A, PERSON_B], speaker: PERSON_A, mentioned: [PERSON_A] },
});

// 无人可挂：metadata 里一个线索都没有 → 不得写 persons 键。
await writeOne({
  id: "m-empty",
  content: "今天天气不错，出门走了走",
  sessionKey: SESSIONS[1],
  metadata: {},
});

// 撞 partial 唯一索引：同平台身份换个 person_key 再 upsert，必须挂到既有行而不是造第二个人。
const collide = await store.upsertSoulPerson(
  { teamId: TEAM, userId: USER, agentId: AGENT },
  { personKey: "p_forced_collision", platform: PERSON_A.platform, platformId: PERSON_A.platformId, displayName: "何晨" },
);

store.close();

const db = new DatabaseSync(dbPath, { readOnly: true });
const all = db.prepare("SELECT record_id, session_key, metadata_json FROM l1_records ORDER BY record_id").all();
const personsRows = db
  .prepare("SELECT person_key, display_name, platform, platform_id FROM soul_person WHERE merged_into IS NULL ORDER BY person_key")
  .all();
const soulPersonCount = db.prepare("SELECT count(*) AS c FROM soul_person").get().c;

const parsed = all.map((r) => {
  let meta = null;
  try {
    meta = JSON.parse(r.metadata_json);
  } catch {
    meta = null;
  }
  return { id: String(r.record_id), sessionKey: String(r.session_key), meta: meta ?? {} };
});
const withPersons = parsed.filter((r) => Array.isArray(r.meta.persons) && r.meta.persons.length > 0);
const personsEntries = withPersons.reduce((s, r) => s + r.meta.persons.length, 0);
const noPersonNoRefs = parsed.filter(
  (r) => !(Array.isArray(r.meta.persons) && r.meta.persons.length > 0) && r.meta.personRefs === undefined,
);
const fallbackRows = parsed.filter(
  (r) => !(Array.isArray(r.meta.persons) && r.meta.persons.length > 0) && r.meta.personRefs !== undefined,
);

const relay = parsed.find((r) => r.id === "m-relay");
const relayPersons = Array.isArray(relay?.meta.persons) ? relay.meta.persons : [];
const emptyRow = parsed.find((r) => r.id === "m-empty");

const aLinked = withPersons.filter((r) => r.meta.persons[0]?.key === keyA && r.id !== "m-relay");
const bLinked = withPersons.filter((r) => r.meta.persons[0]?.key === keyB && r.id !== "m-relay");

const db2 = new DatabaseSync(dbPath, { readOnly: true });
// 建表幂等：再 init 一次不应报错、也不应多出表/行。
const store2 = new VectorStore(dbPath, 0);
store2.init();
const soulPersonAfterReinit = store2.listSoulPersons({ teamId: TEAM, userId: USER, agentId: AGENT }).length;
store2.close();
db2.close();

console.log(`${TAG} 临时库：${dbPath}`);
console.log(`${TAG} 落库 ${parsed.length} 条记忆（2 人 × 3 条 × 2 会话 + 1 转述 + 1 无人物）`);
assert("soul_person 行数（未合并）", personsRows.length, 2);
assert("soul_person 总行数（含墓碑）", soulPersonCount, 2);
assert("l1_records 总行数", parsed.length, 8);
assert("含 persons 的行数", withPersons.length, 7);
assert("persons 条目总数", personsEntries, 8);
assert("A 挂到 3 条", aLinked.length, 3);
assert("B 挂到 3 条", bLinked.length, 3);
assert("既无 persons 又无 personRefs 的行", noPersonNoRefs.map((r) => r.id), ["m-empty"]);
assert("personRefs 回退计数（persons 空但有人 refs）", fallbackRows.length, 0);
assert("转述记忆主体 = B", relayPersons[0]?.key, keyB);
assert("转述记忆主体 role", relayPersons[0]?.role, "subject");
assert("转述记忆里没有 speaker 角色", relayPersons.filter((p) => p.role === "speaker").length, 0);
assert("转述说话人只记 mentioned", relayPersons.find((p) => p.key === keyA)?.role, "mentioned");
assert("无人物记忆不写 persons 键", Object.prototype.hasOwnProperty.call(emptyRow?.meta ?? {}, "persons"), false);
assert("撞唯一索引挂到既有行", collide.personKey, keyA);
assert("撞唯一索引不新增行（重复 init 后）", soulPersonAfterReinit, 2);
assert("A 的 key 是 p_<sha1…12>", /^p_[0-9a-f]{12}$/.test(keyA), true);
assert("B 的 key 是 p_<sha1…12>", /^p_[0-9a-f]{12}$/.test(keyB), true);
assert("两把 key 不同", keyA !== keyB, true);

db.close();
fs.rmSync(dir, { recursive: true, force: true });

if (failed > 0) {
  console.error(`${TAG} FAIL：${failed} 条断言未通过`);
  process.exit(1);
}
console.log(`${TAG} PASS：18 条断言全部通过（临时目录已清理）`);
