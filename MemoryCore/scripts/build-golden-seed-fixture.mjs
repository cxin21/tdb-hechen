#!/usr/bin/env node
/**
 * #96-A：golden 种子库快照（fixture）构建脚本。
 *
 * 目的：#77 口径 B 复跑判「假回归」的根因之一是 runner 非密闭——它复放打在生产库的
 * 当日副本上，而 dataset 的期望锚（journal.memoryLines）是 2026-10-20 冻结产物；
 * 库随生产演化（新卡压位 / 旧卡退场 / ageDecay 衰减）后，锚在库中的存在性漂移，
 * 指标随之失真。本脚本把 dataset 全部期望锚按 journal 原行重建为一份**固定种子库**
 * （docs/superpowers/evals/.../recall-precision-2026-10-20/seed-fixture/vectors.db），
 * 之后 recall-precision-eval.mjs 默认对该快照密闭复放：同快照双跑逐位一致；
 * 快照不随生产库变化，锚复现率成为可复现的基线门。
 *
 * 重建口径（#96 票面）：种子库按 journal.memoryLines 重建（锚覆盖 37/37 实证），
 * 渲染行剥缀映射回 l1 记录字段，写入路径与生产同源（createStoreBundle + upsertL1 +
 * 远端 embedding 同款模型/维度），保证检索行为与生产一致。
 *
 * 纪律（红线遵守）：
 *   - 生产 tdai-gateway.yaml / config-override.json 只读；
 *   - 零触生产 vectors.db（本脚本只写 seed-fixture/，不碰 D:/TDB/data/vectors.db）；
 *   - embedding 走生产同款远端 API（只读推理调用，无记忆写入）。
 *
 * 运行：cd MemoryCore && node --import tsx scripts/build-golden-seed-fixture.mjs
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import YAML from "yaml";
import { parseConfig } from "../src/config.ts";
import { createStoreBundle } from "../src/core/store/factory.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORE_DIR = path.resolve(__dirname, "..");
const DS_DIR = path.resolve(CORE_DIR, "..", "docs", "superpowers", "evals", "memory-recall-golden", "recall-precision-2026-10-20");
const DATASET_FILE = path.join(DS_DIR, "dataset.jsonl");
const SEED_DIR = path.join(DS_DIR, "seed-fixture");
const PROD_YAML = path.join(CORE_DIR, "tdai-gateway.yaml"); // 只读

const log = (...a) => { try { fs.writeSync(1, "[build-golden-seed-fixture] " + a.map(String).join(" ") + "\n"); } catch {} };
const sha12 = (s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 12);

// 租户三元组：与 recall-precision-eval.mjs PROD_TEAM/PROD_AGENT + 基线归档 tenant 一致
// （runs/2026-10-20T15-09-36.json tenant 字段实证），种子行按此归属。
const TENANT = { team_id: "team-2k12lgb650", user_id: "usr-2m7b1144d9", agent_id: "agt-2m7buribzz" };

// ── journal 行解析：剥缀（与 formatMemoryLine/MEMORY_LINE_RE 对偶）──────────
// 行形：- [tag] content ·(活动时间: T) ·soul[...] ·[recall_channel]
// 缀逐层从行尾剥除，正文 = 剥缀后剩余（frag32 匹配只看正文前 32 归一化字，缀不参与）。
function parseJournalLine(line) {
  const m = line.match(/^-\s+\[([^\]]+)\]\s+([\s\S]+)$/);
  if (!m) return null;
  let tag = m[1].trim();
  let body = m[2];
  let activity = undefined;   // (活动时间: X) 的 X 原文
  let occurredDate = undefined; // ·soul[发生 YYYY-MM-DD ...] 的日期
  let certainty = undefined;  // 实见→observed / 推断→inferred
  for (let guard = 0; guard < 8; guard++) {
    let m2;
    if ((m2 = body.match(/\s*·\[[^\]]*\]$/))) { body = body.slice(0, body.length - m2[0].length); continue; } // recall_channel（活列，不播种）
    if ((m2 = body.match(/\s*·soul\[([^\]]*)\]$/))) {
      const soul = m2[1];
      const od = soul.match(/发生 (\d{4}-\d{2}-\d{2})/);
      if (od) occurredDate = od[1];
      if (/实见/.test(soul)) certainty = "observed";
      else if (/推断/.test(soul)) certainty = "inferred";
      body = body.slice(0, body.length - m2[0].length); continue;
    }
    if ((m2 = body.match(/\s*·\(活动时间: ([^)]*)\)$/))) { activity = m2[1]; body = body.slice(0, body.length - m2[0].length); continue; }
    if ((m2 = body.match(/\s*\(活动时间: ([^)]*)\)$/))) { activity = m2[1]; body = body.slice(0, body.length - m2[0].length); continue; } // legacy 裸缀
    break;
  }
  // tag→(type, scene_name)：结论行是渲染产物（L2ConclusionSource=work_fact|scene_block，
  // recall-layered.ts:19/:306）→ 落 work_fact + scene_name，R7 结论层即可自产结论行。
  let type, scene = "";
  if (tag === "结论") { type = "work_fact"; }
  else if (tag.startsWith("结论|")) { type = "work_fact"; scene = tag.slice("结论|".length); }
  else { const i = tag.indexOf("|"); type = i >= 0 ? tag.slice(0, i) : tag; scene = i >= 0 ? tag.slice(i + 1) : ""; }
  return { tag, type, scene, content: body, activity, occurredDate, certainty };
}

// 活动时间显示串（"2026-10-16 10:00"）→ 存储 ISO（"2026-10-16T10:00"）。
// formatTimestamp（auto-recall.ts:2971）按 ^YYYY-MM-DD(THH:MM)? 解析回显 "YYYY-MM-DD HH:MM"，
// 故必须 T 分隔存储，渲染 (活动时间) 缀才能与 journal 行逐字节一致。
const dispToIso = (s) => s.trim().replace(" ", "T");

// ── 主流程 ────────────────────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(DATASET_FILE)) throw new Error("dataset 缺失: " + DATASET_FILE);
  const rounds = [];
  let meta = null;
  for (const line of fs.readFileSync(DATASET_FILE, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const o = JSON.parse(line);
    if (o && o._meta) meta = o; else rounds.push(o);
  }
  if (!meta || !rounds.length) throw new Error("dataset.jsonl 缺 _meta 或空");

  // 1) 解析全部 journal.memoryLines → 记录草稿（跨轮去重：同卡多轮命中=同一条库记录）
  const drafts = new Map(); // key → draft
  const unknownTypes = new Set();
  const MEM_TYPES = new Set(["persona", "episodic", "instruction", "work_fact", "work_task", "work_method", "work_artifact"]);
  let rowsParsed = 0;
  for (const round of rounds) {
    const j = round.journal || {};
    for (const raw of j.memoryLines || []) {
      const p = parseJournalLine(raw);
      if (!p) { log("WARN unparseable journal line (round " + round.id + "): " + raw.slice(0, 80)); continue; }
      rowsParsed++;
      if (!MEM_TYPES.has(p.type)) unknownTypes.add(p.type);
      const key = p.type + "\u0000" + p.scene + "\u0000" + p.content;
      if (!drafts.has(key)) {
        drafts.set(key, { ...p, firstRound: round.id, ts: j.ts || round.ts || undefined, sessionKey: j.sessionKey || "golden-seed" });
      }
    }
  }
  log("journal rows=" + rowsParsed + " → unique records=" + drafts.size);
  if (unknownTypes.size) log("NOTE non-MemoryType tags kept verbatim (TEXT col): " + [...unknownTypes].join(", "));

  // 2) 生产配置（只读）→ seed cfg：override 层合并（与网关 settings-override 叶级语义一致）
  const prod = YAML.parse(fs.readFileSync(PROD_YAML, "utf8"));
  const baseDir = prod && prod.data && prod.data.baseDir;
  if (!baseDir) throw new Error("data.baseDir 缺失");
  const overrideSrc = path.join(String(baseDir), "config-override.json");
  let override = null;
  if (fs.existsSync(overrideSrc)) {
    override = JSON.parse(fs.readFileSync(overrideSrc, "utf8"));
    log("config-override.json loaded (embedding/rerank/penalty 层保真)");
  } else {
    log("WARN config-override.json absent — seed 用 yaml 兜底层（embedding apiKey 占位将失败）");
  }
  const raw = JSON.parse(JSON.stringify(prod));
  raw.data = Object.assign({}, prod.data, { baseDir: SEED_DIR });
  if (override) {
    raw.llm = Object.assign({}, prod.llm, override.llm || {});
    raw.memory = raw.memory || {};
    raw.memory.embedding = Object.assign({}, prod.memory && prod.memory.embedding, override.embedding || {});
    if (override.rerank) raw.memory.rerank = Object.assign({}, prod.memory && prod.memory.rerank, override.rerank);
    if (override.importancePenalty && raw.memory.recall) raw.memory.recall.importancePenalty = override.importancePenalty;
  }
  // parseConfig 的入参=记忆插件配置本体（config.ts:1026 c=memory 组），非整个网关 yaml；
  // data.baseDir 不在解析面内（store 路径由 createStoreBundle 的 dataDir 参数决定）。
  const cfg = parseConfig(raw.memory);

  // 3) 建 store（与生产同款组合根）→ 逐条 upsertL1
  fs.rmSync(SEED_DIR, { recursive: true, force: true });
  fs.mkdirSync(SEED_DIR, { recursive: true });
  const bundle = createStoreBundle(cfg, { dataDir: SEED_DIR, logger: { debug: () => {}, info: log, warn: log, error: log } });
  const store = bundle.store;
  await store.init(bundle.embedding ? bundle.embedding.getProviderInfo() : undefined);
  if (!bundle.embedding) throw new Error("embedding service 未创建（config.embedding 未启用或缺 apiKey）——种子库必须有向量，检索行为才与生产一致");

  const keys = [...drafts.keys()];
  const texts = keys.map((k) => drafts.get(k).content);
  log("embedding " + texts.length + " 条（provider=" + (bundle.embedding.getProviderInfo ? JSON.stringify(bundle.embedding.getProviderInfo()) : "?") + "）");
  // Ark /embeddings 单请求 input 上限 10（2026-10-25 HTTP 400 实证）→ 本地分批 ≤8。
  const vecs = [];
  for (let i = 0; i < texts.length; i += 8) {
    const part = await bundle.embedding.embedBatch(texts.slice(i, i + 8));
    if (!Array.isArray(part) || part.length !== Math.min(8, texts.length - i)) throw new Error("embedBatch 批次数量不符 @" + i);
    vecs.push(...part);
    log("embedded " + Math.min(i + 8, texts.length) + "/" + texts.length);
  }
  if (vecs.length !== texts.length) throw new Error("embedBatch 返回数量不符: " + vecs.length + " vs " + texts.length);

  let written = 0, failed = 0;
  for (let i = 0; i < keys.length; i++) {
    const d = drafts.get(keys[i]);
    // activity 三形态：A ~ B（段，进 metadata）→ 渲染段缀；A起/至B/点 → timestamps[0]（点缀）
    let activityStart, activityEnd, pointTs;
    if (d.activity) {
      const range = d.activity.split("~").map((s) => s.trim());
      if (range.length === 2) { activityStart = dispToIso(range[0]); activityEnd = dispToIso(range[1]); }
      else if (/起$/.test(d.activity)) { activityStart = dispToIso(d.activity.replace(/起$/, "")); }
      else if (/^至/.test(d.activity)) { activityEnd = dispToIso(d.activity.replace(/^至/, "")); }
      else { pointTs = dispToIso(d.activity); }
    }
    const rec = {
      id: "gseed-" + sha12(d.type + "\u0000" + d.scene + "\u0000" + d.content),
      content: d.content,
      type: d.type,
      priority: 50,
      scene_name: d.scene || "",
      source_message_ids: [],
      metadata: Object.assign(
        {},
        activityStart ? { activity_start_time: activityStart } : {},
        activityEnd ? { activity_end_time: activityEnd } : {}
      ),
      timestamps: [pointTs || activityStart || d.ts].filter(Boolean),
      createdAt: d.ts || new Date().toISOString(),
      updatedAt: d.ts || new Date().toISOString(),
      sessionKey: d.sessionKey,
      sessionId: "golden-seed-" + d.firstRound,
      teamId: TENANT.team_id, userId: TENANT.user_id, agentId: TENANT.agent_id,
      occurred_at: d.occurredDate,
      certainty: d.certainty,
      source: "golden-seed-replay",
      // importance 不设：NULL 落库 = 未评分永不降权（不伪造默认分，l1-writer.ts 纪律）
    };
    const ok = await store.upsertL1(rec, vecs[i]);
    if (ok) written++; else { failed++; log("WARN upsertL1 false: " + rec.id + " " + d.content.slice(0, 40)); }
  }
  log("upserted " + written + "/" + keys.length + (failed ? " (failed=" + failed + ")" : ""));
  store.close();

  // 4) config-override.json 净化后写入 seedDir（eval 时网关配置层保真机制沿用）：
  //    apiKey/token/secret 类真实凭据替换为 REDACTED 占位——fixture 随仓入库不泄密钥（#96 安全收尾）；
  //    真实密钥由 runner 运行时从生产 baseDir 只读合并（recall-precision-eval.mjs override 合并段）。
  if (override) {
    const sanitized = JSON.parse(JSON.stringify(override));
    const redact = (o) => {
      if (!o || typeof o !== "object") return;
      for (const [k, v] of Object.entries(o)) {
        if (/key|token|secret/i.test(k) && typeof v === "string" && v) o[k] = "REDACTED";
        else if (v && typeof v === "object") redact(v);
      }
    };
    redact(sanitized);
    fs.writeFileSync(path.join(SEED_DIR, "config-override.json"), JSON.stringify(sanitized, null, 2) + "\n");
    log("config-override.json written (sanitized: credentials→REDACTED)");
  }

  // 5) manifest（溯源）
  const dsSha = crypto.createHash("sha256").update(fs.readFileSync(DATASET_FILE)).digest("hex");
  const manifest = {
    builtAt: new Date().toISOString(),
    purpose: "#96-A golden 专用种子库快照：journal.memoryLines 重建，锚密闭复放",
    dataset: { file: DATASET_FILE, sha256: dsSha, rounds: rounds.length },
    rows: { journalLines: rowsParsed, uniqueRecords: drafts.size, written, failed },
    tenant: TENANT,
    embedding: { provider: cfg.embedding.provider, model: cfg.embedding.model, dimensions: cfg.embedding.dimensions },
    note: "重建脚本 MemoryCore/scripts/build-golden-seed-fixture.mjs；再建=同命令重跑（先删后建，幂等）",
  };
  fs.writeFileSync(path.join(SEED_DIR, "seed-manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

  // 6) 自校验：副本直查（node:sqlite 避开 vec0 虚表）——逐锚 instr 存在性
  const db = new DatabaseSync(path.join(SEED_DIR, "vectors.db"), { readOnly: true });
  const cnt = db.prepare("select count(*) n from l1_records").get();
  let anchorHit = 0, anchorMiss = [];
  for (const round of rounds) {
    for (const e of round.expected || []) {
      const body = e.rowText.replace(/^- \[[^\]]+\] /, "");
      const probe = body.slice(0, 20);
      const row = db.prepare("select count(*) n from l1_records where instr(content, ?) > 0").get(probe);
      if (row && row.n > 0) anchorHit++;
      else anchorMiss.push(round.id + "#" + e.rowIndex + " " + probe.slice(0, 24));
    }
  }
  db.close();
  log("self-check: l1_rows=" + cnt.n + " anchors=" + anchorHit + "/" + (anchorHit + anchorMiss.length) + (anchorMiss.length ? " MISS:\n  " + anchorMiss.join("\n  ") : "（全命中）"));
  if (anchorMiss.length) { log("FAIL 存在未命中锚——种子库不完整"); process.exit(1); }
  log("fixture ready: " + SEED_DIR);
}

main().then(() => process.exit(0)).catch((e) => { log("FAILED: " + (e && e.stack || String(e))); process.exit(1); });
