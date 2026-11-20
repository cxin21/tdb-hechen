#!/usr/bin/env node
/**
 * 灵魂层全量测试 harness（阶段 0 基线）。
 * 只读写 os.tmpdir() 下的临时库；生产库只读比对快照版本（E6）。
 * 用法：cd MemoryCore && node --import tsx scripts/soul-fulltest-harness.mjs [--days=N] [--json=path]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { VectorStore } = await import("../src/core/store/sqlite.ts");
const { runSoulMaintenance } = await import("../src/core/soul/worker.ts");
const { resolveSoulConfig } = await import("../src/core/soul/types.ts");
const { createPersonProfiler } = await import("../src/core/person/profile-distiller.ts");
const { resolvePerson } = await import("../src/core/person/resolve.ts");
const { assembleSoulCard } = await import("../src/core/soul/card-service.ts");
const { makeRewriter } = await import("./soul-ft-stub.mjs");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
// 允许换语料（90 天对照/场景扩展）：SOUL_FULLTEST_CORPUS=<path>
const FIXTURE = process.env.SOUL_FULLTEST_CORPUS
  ? path.resolve(process.env.SOUL_FULLTEST_CORPUS)
  : path.join(HERE, "fixtures", "soul-fulltest-corpus.json");
const OUT_DIR = path.join(ROOT, ".scratch", "soul-fulltest");
const argDays = process.argv.find((a) => a.startsWith("--days="));
// R32-8（a5 指出）：原先每次 mkdtempSync 一个随机临时目录，result.dbPath 不可复跑、也不便当 --db2 用。
// 改成仓库内稳定路径：默认 .scratch/soul-fulltest/harness-vectors.db；上一轮自动留成 -prev.db 供 E1 对比。
const argDb = process.argv.find((a) => a.startsWith("--db="));
const MAX_DAYS = argDays ? Number(argDays.split("=")[1]) : 999;

const TEAM = "team-ft";
const USER = "usr-ft";
const AGENT = "agt-ft-yanzhou";
const TENANT = { teamId: TEAM, userId: USER, agentId: AGENT };
const dayKey = (iso) => String(iso).slice(0, 10);

/** T-agent「砚舟」的声明层（等价于 POST /v3/meta/agent-persona/save 落库后 readAgentProfile 的返回）。 */
const AGENT_PROFILE = {
  name: "砚舟",
  pronoun: "他",
  selfImage: "一个靠核对把事做实的工程搭档，话不多，交付前一定自己跑一遍。",
  voice: "先给结论，短句，不绕弯；不确定就说不确定。",
  purpose: "帮人把没验过的结论变成验过的结论。",
  traits: [
    { label: "严谨", weight: 0.4 },
    { label: "好奇", weight: 0.3 },
    { label: "温和", weight: 0.3 },
  ],
  redlines: [
    { text: "不做没验证就声称已验证的事。", active: true, createdAt: "2026-08-01T00:00:00.000Z" },
    { text: "不替用户承诺他自己没答应的事。", active: true, createdAt: "2026-08-01T00:00:00.000Z" },
    { text: "不把别人的私事写进对外的话里。", active: true, createdAt: "2026-08-01T00:00:00.000Z" },
  ],
};
const readAgentProfile = async () => AGENT_PROFILE;

function loadFixture() {
  if (!fs.existsSync(FIXTURE)) throw new Error("missing fixture " + FIXTURE);
  return JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
}

/** 人物先建档：生产里由 L1 抽取的 persons[] 触发，这里直接调 resolvePerson 等价物。 */
async function seedPersons(store, fixture) {
  const map = new Map();
  for (const p of fixture.persons) {
    if (!p.platformId) continue;
    const row = await resolvePerson(store, TENANT, {
      platform: p.platform ?? "tdai",
      platformId: p.platformId,
      displayName: p.displayName,
    });
    map.set(p.key, row.personKey);
  }
  return map;
}

function seedL0(store, session, turn, i) {
  const id = session.sessionKey + "-l0-" + String(i + 1);
  const ok = store.upsertL0(
    {
      id,
      sessionKey: session.sessionKey,
      sessionId: session.sessionKey,
      teamId: TEAM,
      // 租户轴固定：queryL0ByIds 按 tenant.userId 过滤，L0 若写发言人的 id，
      // 人物档案取原话会查不到 → 引文全变成「（原话未采集）」。发言人靠 fixture 映射，不靠这一列。
      userId: USER,
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

function seedL1(store, session, turn, i, personKeys) {
  if (turn.role !== "user") return 0;
  const key = personKeys.get(PERSON_BY_USER.get(turn.userId) ?? "");
  const persons = key ? [{ key, role: "speaker" }] : [];
  const id = session.sessionKey + "-l1-" + String(i + 1);
  try {
    store.db
      .prepare(
        "INSERT OR IGNORE INTO l1_records (record_id, content, team_id, user_id, agent_id, created_time, metadata_json, source_message_ids) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      // source_message_ids 必须指向真实 L0 行：人物档案的 quote 校验只认「原话」，
      // 链接缺失时 prompt 里那一列是「（原话未采集）」，档案与关系都会 0 产出（不是产品缺陷）。
      .run(
        id,
        turn.text,
        TEAM,
        USER,
        AGENT,
        turn.at,
        JSON.stringify({ persons, occurredAt: turn.at }),
        JSON.stringify([session.sessionKey + "-l0-" + String(i + 1)]),
      );
  } catch (err) {
    return 0;
  }
  L1_ALL.push({ id, content: turn.text, at: turn.at });
  return persons.length > 0 ? 1 : 0;
}

let PERSON_BY_USER = new Map();
const L1_ALL = [];

function stubRewriter(fixture) {
  return async (req) => {
    const episodes = (req.episodes ?? []).map((line) => {
      const parts = String(line).split(" | ");
      return { id: parts[0]?.trim() ?? "", kind: parts[1] ?? "", obj: parts[3] ?? "", quotes: parts[4] ?? "" };
    }).filter((e) => e.id.startsWith("ep-"));
    const ids = episodes.map((e) => e.id);
    const idsFor = (kinds, n) => episodes.filter((e) => kinds.some((k) => e.kind.includes(k))).map((e) => e.id).slice(0, n);
    const has = (layer, needle) => (req.existing ?? []).some((e) => e.layer === layer && e.text.includes(needle));
    const out = [];
    const miss = (layer) => !(req.existing ?? []).some((e) => e.layer === layer);
    const correction = idsFor(["correction", "boundary", "repair"], 3);
    const work = idsFor(["work", "trust", "mentor", "pressure", "promise"], 3);
    if (miss("identity") && correction.length >= (req.minEvidence ?? 2)) {
      out.push({ layer: "identity", text: "被当面指出没验证就交活时，我先认下，再把验证补上。", evidenceIds: correction });
    }
    if (miss("values") && work.length >= (req.minEvidence ?? 2)) {
      out.push({ layer: "values", text: "宁可晚交，也不交没验证的东西。", evidenceIds: work });
    }
    if (miss("boundary") && correction.length >= 1) {
      out.push({ layer: "boundary", text: "不做没验证就声称已验证的事。", evidenceIds: correction.slice(0, 1) });
    }
    if (miss("relationship") && req.personName) {
      const withQuote = episodes.find((e) => /「.{8,}」/.test(e.quotes)) ?? episodes[0];
      if (withQuote) {
        out.push({ layer: "relationship", text: "他说" + (withQuote.quotes.match(/「.{8,}」/) ?? ["「这件事我记下了，你按自己节奏来。」"])[0] + "，我把这条当作我们之间的约定。", evidenceIds: [withQuote.id] });
      }
    }
    if (miss("voice") && (req.voiceQuotes ?? []).length >= 2 && ids.length >= 1) {
      out.push({
        layer: "voice",
        text: "说话先给结论，短句，不绕。",
        evidenceIds: [ids[0]],
        fewShot: (req.voiceQuotes ?? []).slice(0, 2).map((line) => {
          const m = /「([\s\S]+)」\s*\|\s*(\S+)/.exec(String(line));
          return m ? { quote: m[1], recordId: m[2] } : null;
        }).filter(Boolean),
      });
    }
    if (miss("self") && work.length >= 1) {
      out.push({ layer: "self", text: "我答应自己：每次交付前先跑一遍验证。", evidenceIds: work.slice(0, 1) });
    }
    const seen = new Set();
    return out.filter((c) => {
      const k = c.layer + ":" + c.text.slice(0, 12);
      if (seen.has(k) || has(c.layer, c.text.slice(0, 12))) return false;
      seen.add(k);
      return true;
    }).slice(0, req.maxCandidates ?? 3);
  };
}

function profileStub() {
  const runner = {
    async run(params) {
      const prompt = String(params?.prompt ?? "");
      if (!globalThis.__PROMPT_DUMPED__ && prompt.includes("## 记忆")) {
        globalThis.__PROMPT_DUMPED__ = true;
        try {
          const fsp = await import("node:fs");
          fsp.writeFileSync("../.scratch/profile-prompt.txt", prompt);
        } catch (err) {
          console.error("dump failed", err);
        }
      }
      const lines = prompt.split("\n");
      const focusName = (/^人物：(.+)$/m.exec(prompt)?.[1] ?? "").trim();
      const known = new Map();
      for (const line of lines) {
        const m = /^- (p_[a-z0-9]+) \| (.+)$/.exec(line);
        if (m) known.set(m[2].trim(), m[1]);
      }
      // 记忆行全量解析：字段与关系都从「原话」列取，不再靠整行关键字命中——
      // 旧桩只认固定句子，90 天回放里 8 个人只长出 3 条档案、0 条关系，测不出产品真实上限。
      const mem = [];
      for (const line of lines) {
        const parts = line.replace(/^- /, "").split(" | ");
        if (parts.length !== 6) continue;
        const [recordId, at, who, role, summary, original] = parts.map((s) => s.trim());
        if (!/^[a-z0-9-]+-\d+$/.test(recordId)) continue;
        if (original === "" || original === "（原话未采集）") continue;
        mem.push({ recordId, at, self: who === "本人", role, summary, original });
      }
      // quote 必须是原话的连续子串（产品的逐字引文门就是这条），所以按关键词位置切片。
      const quoteOf = (m, kw) => {
        const at = m.original.indexOf(kw);
        if (at < 0) return "";
        return m.original.slice(Math.max(0, at - 12), Math.min(m.original.length, at + kw.length + 18));
      };
      const fields = [];
      for (const [kw, field, tpl] of [
        ["答应过自己", "promise", (q) => "答应过自己：" + q.slice(0, 28)],
        ["负责", "focus", (q) => "负责的事：" + q.slice(0, 28)],
        ["在做", "focus", (q) => "在做的：" + q.slice(0, 28)],
        ["喜欢", "likes", (q) => "偏好：" + q.slice(0, 28)],
        ["反感", "dislikes", (q) => "反感：" + q.slice(0, 28)],
        ["叫我", "alias", (q) => "称呼：" + q.slice(0, 24)],
      ]) {
        if (fields.some((f) => f.field === field)) continue;
        const hit = mem.find((m) => m.self && m.original.includes(kw));
        if (!hit) continue;
        const quote = quoteOf(hit, kw);
        if (quote === "") continue;
        fields.push({ field, text: tpl(quote), recordId: hit.recordId, quote, op: "add" });
      }
      // 关系：名字必须与原话同现，谓词取话里的关系词；不写死某个 fixture 句子。
      const relations = [];
      const PRED = [
        [/上级|领导|汇报线/, "上级", "out"],
        [/带出来|徒弟|师父/, "徒弟", "out"],
        [/同事|一个组/, "同事", "mutual"],
        [/客户/, "客户", "out"],
      ];
      const seenRel = new Set();
      for (const m of mem) {
        if (!m.self) continue;
        for (const [name, key] of known) {
          if (name === "" || name === focusName || !m.original.includes(name)) continue;
          for (const [re, pred, dir] of PRED) {
            const hit = re.exec(m.original);
            if (!hit) continue;
            const sig = pred + ":" + key;
            if (seenRel.has(sig)) continue;
            const quote = quoteOf(m, hit[0]);
            if (quote === "") continue;
            seenRel.add(sig);
            // obj 必须是对象形状（{key}）：契约里 objKey 读的是 raw.obj.key，
            // 直接塞字符串会被当成「没给对象」→ obj_unresolved（90 天回放里关系全丢的真因）。
            relations.push({ pred, obj: { key }, direction: dir, recordId: m.recordId, quote, op: "add" });
          }
        }
      }
      return JSON.stringify({ fields, relations });
    },
  };
  return createPersonProfiler(runner);
}

function counts(store) {
  const q = (sql, ...args) => {
    try { return store.db.prepare(sql).all(...args); } catch { return []; }
  };
  const layers = q("select layer, count(*) c, sum(state='active') active from soul_persona group by layer");
  return {
    persons: q("select count(*) c from soul_person")[0]?.c ?? 0,
    episodes: q("select count(*) c from soul_episodes")[0]?.c ?? 0,
    emotions: q("select count(*) c from soul_emotions")[0]?.c ?? 0,
    emotionsWithObject: q("select count(*) c from soul_emotions where object_person is not null and object_person != ''")[0]?.c ?? 0,
    personaByLayer: Object.fromEntries(layers.map((r) => [r.layer, r.c])),
    personaActive: Object.fromEntries(layers.map((r) => [r.layer, r.active])),
    relations: q("select count(*) c from soul_person_relation")[0]?.c ?? 0,
    humanRows: q("select count(*) c from soul_persona where layer='human'")[0]?.c ?? 0,
    promise: q("select outcome, count(*) c from soul_promises group by outcome"),
    gate: q("select code, count(*) c from soul_gate_stats group by code order by c desc limit 20"),
    snapshots: q("select count(*) c, max(version) v from soul_snapshots")[0] ?? {},
    ledger: q("select action, count(*) c from soul_ledger group by action"),
    l1: q("select count(*) c from l1_records")[0]?.c ?? 0,
  };
}

/** 每层 active/degraded/frozen 计数：判「八层是否真的都活着」而不是只看总行数。 */
async function layerStats(store) {
  const items = await store.listSoulPersona(TENANT);
  const out = {};
  for (const it of items) {
    const row = (out[it.layer] ??= { active: 0, degraded: 0, frozen: 0, other: 0 });
    if (it.state === "active") row.active += 1;
    else if (it.state === "degraded") row.degraded += 1;
    else if (it.state === "frozen") row.frozen += 1;
    else row.other += 1;
  }
  return out;
}

async function main() {
  const fixture = loadFixture();
  PERSON_BY_USER = new Map(fixture.persons.filter((p) => p.platformId).map((p) => [p.platformId, p.key]));
  const dbPath = argDb ? path.resolve(argDb.split("=")[1]) : path.join(OUT_DIR, "harness-vectors.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  if (fs.existsSync(dbPath)) fs.copyFileSync(dbPath, dbPath.replace(/\.db$/u, "-prev.db"));
  if (fs.existsSync(dbPath)) fs.rmSync(dbPath);
  const store = new VectorStore(dbPath, 0);
  const init = store.init();
  if (!init || store.isDegraded?.()) throw new Error("store init failed");
  const personKeys = await seedPersons(store, fixture);
  const missing = fixture.persons.filter((p) => p.platformId && !personKeys.has(p.key)).map((p) => p.key);

  const byDay = new Map();
  for (const s of fixture.sessions) {
    const d = dayKey(s.startAt);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(s);
  }
  // 回放必须是「日历天」而不是「有对话的天」：沉默日也要跑 tick，
  // 否则 30 天生命周期降级、21 天断联失效这些时间不变量永远测不到。
  const days = [];
  const spanFrom = fixture.span?.from ? dayKey(fixture.span.from) : [...byDay.keys()].sort()[0];
  const spanTo = fixture.span?.to ? dayKey(fixture.span.to) : [...byDay.keys()].sort().slice(-1)[0];
  for (let t = Date.parse(spanFrom + "T00:00:00.000Z"); t <= Date.parse(spanTo + "T00:00:00.000Z"); t += 86400000) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  if (days.length === 0) days.push(...[...byDay.keys()].sort());
  days.splice(Math.max(0, MAX_DAYS));
  // maxUpdatedPerCycle 是「每 tick 最多接受几条改写候选」：缺省 3 对 8 层人格明显不够，
  // 90 天回放里 identity/values/self 长期抢不到名额、被生命周期降级后救不回来。
  // 这里调到 8 验证「名额够就不衰亡」，生产缺省是否跟着调另行评估。
  const config = { ...resolveSoulConfig({}), updateIntervalHours: 0, episodeWindowDays: 120, personName: "何辰", maxUpdatedPerCycle: 8 };
  const rewriter = makeRewriter();
  const profiler = profileStub();
  const timeline = [];
  let seeded = 0;

  for (const day of days) {
    const now = day + "T18:00:00.000Z";
    let l1Refs = 0;
    for (const s of byDay.get(day) ?? []) {
      s.turns.forEach((t, i) => {
        seedL0(store, s, t, i);
        seeded += 1;
        l1Refs += seedL1(store, s, t, i, personKeys);
      });
    }
    const rows = [];
    for (const s of fixture.sessions) {
      if (dayKey(s.startAt) > day) continue;
      s.turns.forEach((t, i) => {
        rows.push({
          record_id: s.sessionKey + "-l0-" + String(i + 1),
          session_id: s.sessionKey,
          role: t.role,
          user_id: t.role === "user" ? t.userId || "" : "",
          agent_id: AGENT,
          message_text: t.text,
          recorded_at: t.at,
          timestamp: Date.parse(t.at),
        });
      });
    }
    const recentL0 = async () => rows;
    const report = await runSoulMaintenance({
      store,
      tenant: TENANT,
      now,
      trigger: "manual",
      config,
      recentL0,
      recentRecords: async () => L1_ALL.slice(-200),
      llmCallBudget: 8,
      readAgentProfile,
      rewriter,
      personProfiler: profiler,
    });
    if (report.personProfile) {
      console.log("PROF", day, JSON.stringify(report.personProfile).slice(0, 700));
    }
    timeline.push({ day, seeded, l1Refs, admitted: report.admitted, rejected: report.rejected, frozen: report.frozen, degraded: report.degraded, ...counts(store) });
    console.log(day, "ep=" + counts(store).episodes, "persona=" + JSON.stringify(counts(store).personaByLayer), "rel=" + counts(store).relations, "human=" + counts(store).humanRows);
  }

  const final = counts(store);
  const card = await assembleSoulCard({ store, tenant: TENANT, persist: false, now: new Date(days[days.length - 1] + "T18:00:00.000Z").toISOString(), readAgentProfile });
  const result = {
    dbPath,
    days: days.length,
    seeded,
    fixtureTurns: fixture.sessions.reduce((a, s) => a + s.turns.length, 0),
    personsSeeded: personKeys.size,
    personsMissing: missing,
    final,
    timeline,
    card: {
      chars: card.chars,
      hash: card.hash,
      warnings: card.warnings,
      identity: String((card.identity && (card.identity.text ?? card.identity)) ?? ""),
      anchor: String((card.anchor && (card.anchor.text ?? card.anchor)) ?? ""),
      layers: await layerStats(store),
    },
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const jsonPath = path.join(OUT_DIR, "harness-result.json");
  fs.writeFileSync(jsonPath, JSON.stringify(result, null, 1));
  console.log("wrote " + jsonPath);
  console.log(JSON.stringify({ final, card: result.card }, null, 1));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
