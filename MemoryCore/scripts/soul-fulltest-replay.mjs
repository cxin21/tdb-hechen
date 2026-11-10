#!/usr/bin/env node
/**
 * 灵魂层全量测试主实验：临时库 90 天回放。
 * 只读写 os.tmpdir() 下 mkdtemp 库。绝不碰生产库。
 * 用法：cd MemoryCore && node scripts/soul-fulltest-replay.mjs
 * 退出码：0 = 脚本跑完（逐条 PASS/FAIL 写报告，不在这里改阈值）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TSX_ENV = "__SOUL_FULLTEST_REPLAY_TSX__";
if (!process.env[TSX_ENV]) {
  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", fileURLToPath(import.meta.url), ...process.argv.slice(2)],
  );
  process.exit(typeof child.status === "number" ? child.status : 1);
}

const { VectorStore } = await import("../src/core/store/sqlite.ts");
const { runSoulMaintenance } = await import("../src/core/soul/worker.ts");
const { resolveSoulConfig } = await import("../src/core/soul/types.ts");
const { createPersonProfiler } = await import("../src/core/person/profile-distiller.ts");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const FIXTURE = path.join(HERE, "fixtures", "soul-fulltest-corpus.json");
const REPORT = path.join(ROOT, ".scratch", "soul-fulltest", "soul-fulltest-replay-report.md");

const TEAM = "team-ft";
const USER = "usr-ft";
const AGENT = "agt-ft-yanzhou";
const TENANT = { teamId: TEAM, userId: USER, agentId: AGENT };

function loadFixture() {
  if (!fs.existsSync(FIXTURE)) {
    console.error("missing fixture " + FIXTURE + " — run soul-fulltest-corpus.mjs --write first");
    process.exit(2);
  }
  return JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
}

function dayKey(iso) {
  return String(iso).slice(0, 10);
}

function seedTurn(store, session, turn, i) {
  const id = session.sessionKey + "-l0-" + String(i + 1);
  const ok = store.upsertL0(
    {
      id,
      sessionKey: session.sessionKey,
      sessionId: session.sessionKey,
      teamId: TEAM,
      userId: turn.role === "user" ? (turn.userId || USER) : USER,
      agentId: AGENT,
      role: turn.role,
      messageText: turn.text,
      recordedAt: turn.at,
      timestamp: Date.parse(turn.at),
    },
    undefined,
  );
  if (!ok) throw new Error("upsertL0 failed " + id);
}

function stubRewriter(fixture, day) {
  return async (req) => {
    const episodes = req.episodes ?? [];
    const ids = episodes.map((line) => String(line).split("|")[0].trim()).filter((id) => id.startsWith("ep-"));
    if (ids.length === 0) return [];
    const out = [];
    const seen = new Set();
    for (const s of fixture.sessions) {
      if (dayKey(s.startAt) > day) continue;
      const w = s.expect?.wordings ?? [];
      for (const word of w) {
        if (seen.has(word)) continue;
        seen.add(word);
        const text = wordingText(word);
        if (!text) continue;
        out.push({ layer: "relationship", text, evidenceIds: ids.slice(0, 3) });
      }
    }
    return out.slice(0, req.maxCandidates ?? 4);
  };
}

function wordingText(word) {
  if (word === "顶了回去") return "上级指出交付未验证时，我当场顶了回去。";
  if (word === "后来补上了") return "这事先顶了回去，后来补上了。";
  if (word === "没做到") return "这条我还没做到。";
  if (word === "只回了话") return "我只回了话，没改。";
  return "";
}

async function main() {
  const fixture = loadFixture();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "soul-fulltest-"));
  const dbPath = path.join(dir, "vectors.db");
  const store = new VectorStore(dbPath, 0);
if (!store.init() || store.isDegraded()) {
    console.error("store init failed");
    process.exit(3);
  }
  let n = 0;
  for (const s of fixture.sessions) {
    s.turns.forEach((t, i) => {
      seedTurn(store, s, t, i);
      n += 1;
    });
  }
  console.log("seeded " + n + " L0 into " + dbPath);


  const byDay = new Map();
  for (const s of fixture.sessions) {
    const d = dayKey(s.startAt);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(s);
  }
  const days = [...byDay.keys()].sort();
  const lines = ["# soul fulltest replay", "", "db: " + dbPath, "seeded: " + n, ""];
  lines.push("| day | ticks | episodes | emotions | persona | relations | admitted | rejected | frozen | degraded |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");

  for (const day of days) {
    const now = day + "T18:00:00.000Z";
    const recentL0 = async () => {
      const rows = [];
      for (const s of fixture.sessions) {
        if (dayKey(s.startAt) > day) continue;
        s.turns.forEach((t, i) => {
          rows.push({
            record_id: s.sessionKey + "-l0-" + String(i + 1),
            session_id: s.sessionKey,
            role: t.role,
            user_id: t.role === "user" ? (t.userId || "") : "",
            agent_id: "agt-ft-yanzhou",
            message_text: t.text,
            recorded_at: t.at,
            timestamp: Date.parse(t.at),
          });
        });
      }
      const ids = new Set(rows.filter((r) => r.role === "user" && r.user_id).map((r) => r.user_id));
      const empty = rows.filter((r) => r.role === "user" && !r.user_id).length;
      if (day === days[0]) console.log("day0 userIds=" + ids.size + " empty=" + empty + " sample=" + JSON.stringify(rows.find((r) => r.role === "user")));
      return rows;
    };
    const rep = await runSoulMaintenance({
      store,
      tenant: TENANT,
      now,
      trigger: "manual",
      config: { ...resolveSoulConfig({}), updateIntervalHours: 0, episodeWindowDays: 120, personName: "" },
      recentL0,
      recentRecords: async () => [],
      llmCallBudget: 0,
      rewriter: stubRewriter(fixture, day),
      personProfiler: profileStub(store),
    });
    const ep = store.listSoulEpisodes ? (store.listSoulEpisodes(TENANT, { limit: 5000 }) ?? []).length : "?";
    const emo = typeof store.listSoulEmotions === "function" ? store.listSoulEmotions(TENANT, { limit: 5000 }).length : "?";
    const persona = typeof store.listSoulPersona === "function" ? (store.listSoulPersona(TENANT) ?? []).length : "?";
    const rel = typeof store.listSoulPersonRelations === "function" ? store.listSoulPersonRelations(TENANT, { includeClosed: true }).length : "?";
    lines.push("| " + [day, 1, ep, emo, persona, rel, rep.admitted, rep.rejected, rep.frozen, rep.degraded].join(" | ") + " |");
    console.log(day + " episodes=" + ep + " admitted=" + rep.admitted + " rejected=" + rep.rejected);
    const known = new Map(((store.listSoulPersons?.(TENANT)) ?? []).map((p) => [p.platformId, p.personKey]));
    for (const s of byDay.get(day)) {
      s.turns.forEach((t, i) => {
        if (t.role !== "user") return;
        const key = known.get(t.userId);
        if (!key) return;
        const id = s.sessionKey + "-l1-" + String(i + 1);
        store.db.prepare(
          "INSERT OR IGNORE INTO l1_records (record_id, content, team_id, user_id, agent_id, created_time, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).run(id, t.text, TEAM, USER, AGENT, t.at, JSON.stringify({ persons: [{ key, role: "speaker" }] }));
      });
    }
  }
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  fs.writeFileSync(REPORT, lines.join("\n"));
  const { mineEpisodes } = await import("../src/core/soul/episode.ts");
  const probeRows = [];
  for (const s of fixture.sessions) {
    s.turns.forEach((t, i) => {
      probeRows.push({
        record_id: s.sessionKey + "-l0-" + String(i + 1),
        session_id: s.sessionKey,
        role: t.role,
        user_id: t.role === "user" ? (t.userId || "") : "",
        message_text: t.text,
        recorded_at: t.at,
        timestamp: Date.parse(t.at),
      });
    });
  }
  const mined = mineEpisodes(probeRows, {}, { windowDays: 120 });
  const speakers = new Map();
  for (const ep of mined.episodes) {
    const id = ep.speaker?.userId || "(none)";
    speakers.set(id, (speakers.get(id) ?? 0) + 1);
  }
  console.log("mined speakers " + [...speakers.entries()].map(([k, v]) => k + ":" + v).join(" "));
  const withSpeaker = mined.episodes.filter((ep) => ep.speaker?.userId).length;
  console.log("mined withSpeaker=" + withSpeaker + "/" + mined.episodes.length);
  const { resolvePerson } = await import("../src/core/person/resolve.ts");
  for (const id of ["usr-ft-peer-a", "usr-ft-peer-b", "usr-ft-client"]) {
    try {
      const p = await resolvePerson(store, TENANT, { platform: "tdai", platformId: id, displayName: id });
      console.log("probe " + id + " -> " + p.personKey);
    } catch (err) {
      console.log("probe fail " + id + " " + (err instanceof Error ? err.message : String(err)));
    }
  }
  console.log("report " + REPORT);
  console.log("temp db kept at " + dbPath);
}


function profileStub(store) {
  const runner = {
    async run(params) {
      const prompt = String(params?.prompt ?? "");
      const selfLines = prompt.split(/\n/).filter((l) => l.includes("| 本人 |"));
      const fields = [];
      const take = (field, line) => {
        if (!line || fields.some((f) => f.field === field)) return;
        const parts = line.split(" | ");
        const recordId = parts[0].replace(/^- /, "").trim();
        const content = parts.slice(4).join(" | ").trim();
        if (!recordId || !content) return;
        fields.push({ field, text: content.slice(0, 24), recordId, quote: content.slice(0, 16), op: "add" });
      };
      take("focus", selfLines[0]);
      take("style", selfLines[1]);
      take("story", selfLines[2]);
      // 关系边：只认本人原话里的明确说法，对象从提示词的已知人物表按名字对。
      const REL = [
        ["周衡", "是我的上级", "上级"],
        ["小唐", "我带的新人", "下属"],
        ["林夏", "是我的同事", "同事"],
        ["陈屿", "是我的客户", "客户"],
      ];
      const known = new Map();
      for (const line of prompt.split(String.fromCharCode(10))) {
        const m = line.match(/^- (p_[a-z0-9_]+) | (.+)$/);
        if (m) known.set(m[2].trim(), m[1]);
      }
      const relations = [];
      const src = selfLines[0];
      if (src) {
        const parts = src.split(" | ");
        const recordId = parts[0].replace(/^- /, "").trim();
        const quote = parts.slice(4).join(" | ").trim();
        for (const [name, needle, pred] of REL) {
          if (!quote.includes(needle)) continue;
          const obj = known.get(name);
          if (!obj) continue;
          relations.push({ pred, obj, direction: "out", recordId, quote: quote.slice(0, 40), op: "add" });
        }
      }
      return JSON.stringify({ fields, relations });
    },
  };
  return createPersonProfiler(runner);
}
main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
