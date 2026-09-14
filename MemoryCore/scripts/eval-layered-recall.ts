/**
 * eval-layered-recall：分层评估框架 E1+E2 —— 方案 A 纯函数离线重放 + 双锚补采
 * （DS-EVAL-LAYERED-001 §3.2 方案 A / §6 实施顺序 E1+E2 实施）。
 *
 * 做法（spec §3.2 方案 A）：
 *   golden query 集（memory-recall-golden/labels.jsonl）+ 评测语料（生产 DB 只读快照的
 *   work_fact 语料行 + scene_index.json 场景块）→ 导入 selectL2Conclusions 纯函数
 *   （R7-1 单一源，禁第二份）离线重放结论选择 → 逐 query 结论集 →
 *   CC / CC'（computeCC）+ CTR / ALD / SD（computeLayeredMetrics）→
 *   写入目标锚点归档的**派生副本** `<原名>.layered.json` 的 layeredMetrics 字段
 *   （A1 Minor ② 修复：原档**永不改写**——2026-09-12 失败轮曾原地覆盖
 *   runs/12-11-49.json 指标靠 git 还原；旧锚内嵌 layeredMetrics 保持原样可读）。
 *
 * A1 塌方侦测线：计算完 CC 后与 runs/ 中**上一份已归档锚**的 CC 对比（选取口径见
 *   pickPreviousAnchorRun：排除 .layered.json 派生副本，按文件名前导时间戳取严格早于
 *   当前锚的最大者；上一锚 CC 双源兼容——原档内嵌 layeredMetrics 优先，旁挂副本兜底）。
 *   相对降幅 > 50%（CC_COLLAPSE_THRESHOLD，3 锚带宽 0 校准 2026-09-12 裁定）→
 *   stderr loud 红牌 + 归档副本登记 ccCollapse { previous, current, ratio }；
 *   不阻塞 exit code（红牌不阻塞是本仓惯例）。
 *
 * 口径登记（评估侧裁决，报告与归档 JSON 均如实记录）：
 *   1. golden query 集 = memory-recall-golden/labels.jsonl（10 条，记忆召回 golden）。
 *      不用 recall-golden/queries.jsonl（19 条 wiki golden）——spec §5 明确禁止把 wiki
 *      语料或 wiki 标注词引入记忆召回指标计算。
 *   2. CC 标注词集 = 该 query 的 relevant 标注记录（L1 record id）语料内容经 buildFtsQuery
 *      分词（jieba 单一源）的 token 集（去重、长度 ≥2——与 selectL2Conclusions textHit
 *      的 ≥2 防单字噪声口径一致）；标注场景集 = 空（expectedScenes 属 E3 一次性标注）。
 *      非循环性：标注词来自标注记录内容，结论选择判定用的是 query token / 场景名——
 *      两路输入不同源（判定样本逐 query 落档供人工复核）。
 *   3. 经验层注入行 = 目标锚点归档 perQuery.on 的 L1 id 排序 × 语料内容经
 *      formatMemoryLine（单一源）格式化。A 口径限制（spec §3.2 风险条目如实登记）：
 *      归档只存 id，补池通道标注（[graph:ppr]/[value:]/[scene:]）不可复原——SD 的
 *      补池分量在 A 口径下不可观测，需方案 B（注入快照）端到端实证。
 *   4. 幂等缓存 / 预算切分组装形态不在重放内（spec §3.2 已登记）；结论层选择结果一致
 *      （选择函数纯确定性），CC 度量不受影响。
 *
 * 隔离纪律：生产 DB（D:/tdai-data/vectors.db）只 DatabaseSync readOnly；scene_index.json
 *   只读；tdai-gateway.yaml 只读；不派生子代理；不碰 D:/tdai-data/ 生产进程。
 *
 * 用法（在 MemoryCore 目录下）：
 *   node --import tsx scripts/eval-layered-recall.ts [runs/<ts>.json]
 *   （缺省目标 = runs/ 目录最新的锚归档 JSON——排除 .layered.json 派生副本）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import YAML from "yaml";

// 生产同构模块（tsx 直跑；单一源复用，禁第二份）。
// 导入后缀用 .js（NodeNext 口径，tsx/vite 双运行时映射回 .ts）——A1 起本文件被
// fixture 单测（src/core/recall/__tests__/eval-layered-recall.a1.test.ts）拉入
// tsc typecheck 图，.ts 后缀会触发 TS5097。
const { selectL2Conclusions, parseFtsTokens, formatConclusionLine, truncateConclusionContent } =
  await import("../src/core/hooks/recall-layered.js");
const { buildFtsQuery } = await import("../src/core/store/sqlite.js");
const { isAnalyticalQuery, formatMemoryLine } = await import("../src/core/hooks/auto-recall.js");
const { sanitizeText } = await import("../src/utils/sanitize.js");
const { buildProfileIsolationScope } = await import("../src/core/profile/profile-sync.js");
const {
  computeCC,
  computeLayeredMetrics,
  CC_COLLAPSE_THRESHOLD,
  isLayeredCopyPath,
  deriveLayeredCopyPath,
  pickPreviousAnchorRun,
  detectCcCollapse,
  extractAnchorCc,
} = await import("../src/core/recall/layered-metrics.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORE_DIR = path.resolve(__dirname, "..");
const GOLD_DIR = path.resolve(CORE_DIR, "..", "docs", "superpowers", "evals", "memory-recall-golden");
const RUNS_DIR = path.join(GOLD_DIR, "runs");
const PROD_YAML = path.join(CORE_DIR, "tdai-gateway.yaml");        // 只读
const PROD_DATA_DIR = "D:/tdai-data";                              // 只读（DB / scene_index）
const DB_PATH = path.join(PROD_DATA_DIR, "vectors.db");            // 只读
const SPEC_ID = "DS-EVAL-LAYERED-001";
const ISO = { team_id: "team-2j92u63hre", user_id: "usr-2t8126nehp", agent_id: "agt-2t81sh9zdz" };

const log = (...a: unknown[]) => console.log("[eval-layered]", ...a);
const loud = (...a: unknown[]) => console.error("[eval-layered][WARN]", ...a);

// ── golden query 集（labels.jsonl，过滤 _meta 行） ──────────────────
function loadLabels(): Array<{ query: string; relevant: string[]; rationale?: string }> {
  const file = path.join(GOLD_DIR, "labels.jsonl");
  return fs.readFileSync(file, "utf8").split("\n")
    .map((l) => l.trim()).filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((o: any) => o && typeof o.query === "string" && Array.isArray(o.relevant));
}

// ── 只读 DB 访问 ────────────────────────────────────────────────────
function openRo(): DatabaseSync {
  return new DatabaseSync(DB_PATH, { readOnly: true });
}

function corpusStats(db: DatabaseSync) {
  const scope = `team_id='${ISO.team_id}' AND user_id='${ISO.user_id}' AND agent_id='${ISO.agent_id}'`;
  const total = db.prepare(`select count(*) n from l1_records where ${scope}`).get() as any;
  const byType: Record<string, number> = {};
  for (const r of db.prepare(`select type, count(*) n from l1_records where ${scope} group by type`).all() as any[]) {
    byType[r.type] = r.n;
  }
  return { scopeCount: total.n, byType, scope: ISO };
}

interface WfRow { record_id: string; content: string; scene_name: string | null; significance: number | null }

/** 语料全部 work_fact 行（V2-3 分析型放宽通道重放数据源）。 */
function listWorkFacts(db: DatabaseSync): WfRow[] {
  return db.prepare(
    `select record_id, content, scene_name, significance from l1_records
     where type = 'work_fact' and team_id = ? and user_id = ? and agent_id = ?
     order by significance desc`,
  ).all(ISO.team_id, ISO.user_id, ISO.agent_id) as unknown as WfRow[];
}

/** FTS 词面命中（production searchL1Fts 同款 match + 租户过滤；limit 同 auto-recall r7HalfLimit*2）。 */
function ftsTopIds(db: DatabaseSync, ftsQuery: string, limit: number): string[] {
  const rows = db.prepare(
    `select record_id, bm25(l1_fts) AS rank from l1_fts
     where l1_fts match ? and team_id = ? and user_id = ? and agent_id = ?
     order by rank limit ?`,
  ).all(ftsQuery, ISO.team_id, ISO.user_id, ISO.agent_id, limit) as any[];
  return rows.map((x) => x.record_id);
}

interface L1Row {
  record_id: string; content: string; type: string; scene_name: string | null;
  occurred_at: string | null; certainty: string | null; valence: number | null; significance: number | null;
}

function getL1ByIds(db: DatabaseSync, ids: string[]): Map<string, L1Row> {
  const out = new Map<string, L1Row>();
  const stmt = db.prepare(
    `select record_id, content, type, scene_name, occurred_at, certainty, valence, significance
     from l1_records where record_id = ? and team_id = ? and user_id = ? and agent_id = ?`,
  );
  for (const id of ids) {
    const r = stmt.get(id, ISO.team_id, ISO.user_id, ISO.agent_id) as any;
    if (r) out.set(id, r);
  }
  return out;
}

// ── 目标锚点归档 ────────────────────────────────────────────────────
/**
 * 缺省目标选取：runs/ 目录最新的**锚归档**（排除 .layered.json 派生副本与非 json 文件）。
 * 导出供 fixture 单测（eval-layered-recall.a1.test.ts [L]）。
 */
export function pickLatestAnchorRun(dir: string): string {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && !isLayeredCopyPath(f)).sort();
  if (files.length === 0) throw new Error(`no run archives in ${dir}`);
  return path.join(dir, files[files.length - 1]!);
}

function pickTargetRun(explicit?: string): string {
  if (explicit) {
    const p = path.isAbsolute(explicit) ? explicit : path.resolve(process.cwd(), explicit);
    if (!fs.existsSync(p)) throw new Error(`target run not found: ${p}`);
    return p;
  }
  return pickLatestAnchorRun(RUNS_DIR);
}

/** perQuery.on 兼容两种形态：id 字符串数组（旧）/ {id, score} 数组（现）。 */
function onIdsOf(pq: any): string[] {
  const on = pq?.on;
  if (!Array.isArray(on)) return [];
  return on.map((x: any) => (typeof x === "string" ? x : x?.id)).filter((x: any) => typeof x === "string");
}

// ── A1 · CC 塌方侦测线（与上一份已归档锚对比；红牌不阻塞 exit code） ──
export interface CcCollapseCheckOutcome {
  previousRun: string | null;
  previousCc: number | null;
  trigger: { previous: number; current: number; ratio: number } | null;
}

/** 上一锚 CC 读取（双源兼容）：原档内嵌 layeredMetrics 优先，旁挂 .layered.json 副本兜底（A1 后的新锚）。 */
function readAnchorCc(runsDir: string, anchorName: string): number | null {
  const anchorPath = path.join(runsDir, anchorName);
  try {
    const fromOriginal = extractAnchorCc(JSON.parse(fs.readFileSync(anchorPath, "utf8")));
    if (fromOriginal !== null) return fromOriginal;
  } catch { /* 原档读失败 → 落到副本兜底 */ }
  const copyPath = deriveLayeredCopyPath(anchorPath);
  if (fs.existsSync(copyPath)) {
    try {
      return extractAnchorCc(JSON.parse(fs.readFileSync(copyPath, "utf8")));
    } catch { /* 副本读失败 → 无基线 */ }
  }
  return null;
}

/**
 * 塌方侦测（A1）：在 runsDir 中选"上一份已归档锚"（pickPreviousAnchorRun 口径），
 * 与当前重放 CC 对比；相对降幅 > CC_COLLAPSE_THRESHOLD → stderr loud 红牌并返回触发载荷。
 * 上一锚无 CC 基线 / 无候选 → 不侦测（如实 log，不伪造）。导出供 fixture 单测 [K]。
 */
export async function checkCcCollapseAgainstRuns(
  targetRunPath: string,
  currentCc: number | null,
  runsDir: string = RUNS_DIR,
): Promise<CcCollapseCheckOutcome> {
  const outcome: CcCollapseCheckOutcome = { previousRun: null, previousCc: null, trigger: null };
  let prevName: string | null = null;
  try {
    const names = fs.readdirSync(runsDir).filter((f) => f.endsWith(".json"));
    prevName = pickPreviousAnchorRun(names, path.basename(targetRunPath));
  } catch (e) {
    loud(`cc collapse check: runs 目录读取失败，跳过侦测（不阻塞）: ${e instanceof Error ? e.message : String(e)}`);
    return outcome;
  }
  if (!prevName) {
    log("cc collapse check: 无早于当前锚的已归档锚 → 无基线，跳过侦测");
    return outcome;
  }
  outcome.previousRun = prevName;
  const prevCc = readAnchorCc(runsDir, prevName);
  outcome.previousCc = prevCc;
  if (prevCc === null) {
    log(`cc collapse check: 上一锚 ${prevName} 无 CC 基线（未重放过 layeredMetrics）→ 跳过侦测`);
    return outcome;
  }
  const trigger = detectCcCollapse(prevCc, currentCc);
  outcome.trigger = trigger ?? null;
  if (trigger) {
    loud(
      `CC COLLAPSE RED-CARD: cc ${trigger.previous} → ${trigger.current}（相对降幅 ${(trigger.ratio * 100).toFixed(1)}% > ` +
      `${CC_COLLAPSE_THRESHOLD * 100}% 阈值；3 锚带宽 0 校准 2026-09-12 裁定），上一锚 = ${prevName}。` +
      `红牌不阻塞（本仓惯例），已登记 ccCollapse 至归档副本，请人工核查链路回归。`,
    );
  } else {
    log(`cc collapse check: prev=${prevCc} current=${currentCc} 相对降幅未过 ${CC_COLLAPSE_THRESHOLD * 100}% 阈值 → 无塌方`);
  }
  return outcome;
}

// ── 主流程 ──────────────────────────────────────────────────────────
async function main() {
  const targetRun = pickTargetRun(process.argv[2]);
  const run = JSON.parse(fs.readFileSync(targetRun, "utf8"));
  log(`target run: ${path.basename(targetRun)}`);
  log(`run gitShaResolved: ${run.gitShaResolved ?? "null"}`);

  // 生产 yaml 只读读取（maxResults / conclusionRelaxedForAnalytical——与生产链路同源）
  const prodCfg = YAML.parse(fs.readFileSync(PROD_YAML, "utf8")); // 只读
  const recallCfg = prodCfg?.memory?.recall ?? {};
  const maxResults = recallCfg.maxResults ?? 5;
  const r7HalfLimit = Math.floor(maxResults / 2);
  const relaxedEnabled = recallCfg.conclusionRelaxedForAnalytical !== false;
  // Task CAL C1：结论层注入前截断（auto-recall 同款单一源；配置源 = 生产 yaml
  // memory.recall.conclusionLayer.maxCharsPerMemory，未配置 = 代码默认 2000）
  const conclusionMaxChars = recallCfg.conclusionLayer?.maxCharsPerMemory ?? 2000;
  log(`config: maxResults=${maxResults} halfLimit=${r7HalfLimit} conclusionRelaxedForAnalytical=${relaxedEnabled} conclusionLayer.maxCharsPerMemory=${conclusionMaxChars}`);

  const labels = loadLabels();
  log(`golden queries: ${labels.length}（memory-recall-golden/labels.jsonl，非 wiki golden——spec §5）`);

  const db = openRo();
  const stats = corpusStats(db);
  const workFacts = listWorkFacts(db);
  log(`corpus: scopeCount=${stats.scopeCount} byType=${JSON.stringify(stats.byType)} workFacts=${workFacts.length}`);

  // scene index（生产只读；profile 隔离路径单一源 buildProfileIsolationScope）
  const profileDirName = encodeURIComponent(buildProfileIsolationScope({ teamId: ISO.team_id, agentId: ISO.agent_id }));
  const sceneIndexPath = path.join(PROD_DATA_DIR, "profiles", profileDirName, ".metadata", "scene_index.json");
  let sceneEntries: Array<{ filename: string; summary: string }> = [];
  try {
    const raw = JSON.parse(fs.readFileSync(sceneIndexPath, "utf8"));
    if (Array.isArray(raw)) {
      sceneEntries = raw.filter((e: any) => e && typeof e.filename === "string" && typeof e.summary === "string");
    }
  } catch (e) {
    loud(`scene_index.json 读取失败（场景块候选为空——如实降级）: ${e instanceof Error ? e.message : String(e)}`);
  }
  log(`scene blocks: ${sceneEntries.length}（${sceneIndexPath}）`);

  // ── 逐 query 重放（纯函数 selectL2Conclusions；IO 只在候选收集层） ──
  const missingIds: string[] = [];
  const replayRows = labels.map((label) => {
    const clean = sanitizeText(label.query);
    const ftsQuery = buildFtsQuery(clean);
    const ftsTokens = parseFtsTokens(ftsQuery);

    // ① work_fact 结论候选（auto-recall 同款：FTS top halfLimit*2 → type 过滤）
    const wfCandidates: Array<{ sceneName: string; content: string; source: "work_fact"; recordId: string }> = [];
    if (ftsQuery) {
      const ids = ftsTopIds(db, ftsQuery, r7HalfLimit * 2);
      const rows = getL1ByIds(db, ids);
      for (const id of ids) {
        const r = rows.get(id);
        if (r && r.type === "work_fact") {
          wfCandidates.push({ sceneName: r.scene_name ?? "", content: r.content, source: "work_fact", recordId: r.record_id });
        }
      }
    }
    // ② scene block 候选（scene index 全量，sceneName = filename 去 .md）
    const sceneCandidates = sceneEntries.map((e) => ({
      sceneName: e.filename.replace(/\.md$/i, ""), content: e.summary, source: "scene_block" as const,
    }));

    // ③ 纯函数选择（单一源——R7-1 34 断言单测背书的确定性函数）
    let conclusions = selectL2Conclusions(clean, [...wfCandidates, ...sceneCandidates], { ftsTokens }, r7HalfLimit);

    // ④ V2-3 分析型放宽（auto-recall 同款：significance top-5 work_fact 追加，去重已选）
    if (relaxedEnabled && isAnalyticalQuery(clean)) {
      const selectedIds = new Set(conclusions.map((c) => c.recordId).filter((id): id is string => !!id));
      const relaxed: typeof conclusions = [];
      for (const r of workFacts) {
        if (relaxed.length >= 5) break;
        if (!r.content?.trim()) continue;
        if (selectedIds.has(r.record_id)) continue;
        relaxed.push({ sceneName: r.scene_name ?? "", content: r.content, source: "work_fact" as const, recordId: r.record_id });
      }
      if (relaxed.length > 0) conclusions = [...conclusions, ...relaxed];
    }

    // ④b Task CAL C1：结论层注入前截断（auto-recall 接线同款单一源 truncateConclusionContent；
    // 纯注入层——选择结果不受影响，只影响注入行长度口径 CTR/ALD）
    if (conclusionMaxChars > 0) {
      conclusions = conclusions.map((c) => ({
        ...c,
        content: truncateConclusionContent(c.content, conclusionMaxChars),
      }));
    }

    const conclusionLines = conclusions.map(formatConclusionLine);

    // ⑤ 经验层注入行（A 口径：归档 ON 排序 × 语料内容 × formatMemoryLine 单一源）
    const pq = (run.perQuery ?? []).find((p: any) => p?.query === label.query);
    const ids = onIdsOf(pq);
    const rows = getL1ByIds(db, ids);
    const experienceLines: string[] = [];
    for (const id of ids) {
      const r = rows.get(id);
      if (!r) { missingIds.push(id); continue; }
      experienceLines.push(formatMemoryLine({
        type: r.type, content: r.content, scene_name: r.scene_name ?? undefined,
        occurred_at: r.occurred_at ?? undefined, certainty: r.certainty ?? undefined,
        valence: r.valence ?? undefined, significance: r.significance ?? undefined,
        // recall_channel 缺省：归档只存 id，补池通道标注不可复原（A 口径限制，见文件头口径 3）
      }));
    }

    // ⑥ CC 标注词集（relevant 记录内容 → buildFtsQuery 分词单一源 → 去重、≥2 字、滤数字碎片）
    const relevantRows = getL1ByIds(db, label.relevant);
    const relevantContent = label.relevant.map((id) => relevantRows.get(id)?.content ?? "").filter(Boolean).join("\n");
    const annotationWords = [...new Set(
      parseFtsTokens(buildFtsQuery(relevantContent))
        .filter((t) => t.length >= 2 && !/^\d/.test(t)), // 滤 "2026-09"/"10"/"0.5" 等日期数值碎片（非主题词面证据）
    )];
    const missingRelevant = label.relevant.filter((id) => !relevantRows.has(id));
    if (missingRelevant.length > 0) loud(`query="${label.query}" 的 ${missingRelevant.length} 条 relevant 标注 id 不在当前语料中（语料漂移，如实登记）`);

    return { label, clean, ftsTokens, conclusions, conclusionLines, experienceLines, annotationWords, missingRelevant };
  });
  db.close();

  // ── 三指标计算（纯函数） ────────────────────────────────────────────
  const cc = computeCC(replayRows.map((r) => ({
    queryId: r.label.query,
    conclusions: r.conclusions.map((c) => ({ sceneName: c.sceneName, content: c.content })),
    annotationWords: r.annotationWords,
    annotationScenes: [],
  })));

  const layered = computeLayeredMetrics(replayRows.map((r) => ({
    query: r.label.query,
    conclusionLines: r.conclusionLines,
    experienceLines: r.experienceLines,
  })));

  // ── A1 · CC 塌方侦测线（与上一份已归档锚对比；红牌不阻塞 exit code） ──
  const collapseOutcome = await checkCcCollapseAgainstRuns(targetRun, cc.cc);

  // ── 归档（A1 写副本：layeredMetrics 只落 <原名>.layered.json，原档永不改写） ──
  let replayGitSha: string | null = null;
  try { replayGitSha = execSync("git rev-parse HEAD", { cwd: CORE_DIR, encoding: "utf8" }).trim(); } catch { replayGitSha = null; }

  const runCorpus = run.configSnapshot?.corpus;
  const drift = runCorpus ? { runScopeCount: runCorpus.scopeCount, replayScopeCount: stats.scopeCount, sameCorpus: runCorpus.scopeCount === stats.scopeCount } : null;

  const layeredMetrics = {
    specId: SPEC_ID,
    method: "方案A 纯函数离线重放（selectL2Conclusions 单一源；DS-EVAL-LAYERED-001 §3.2）",
    computedAt: new Date().toISOString(),
    replayGitSha,
    sourceRun: path.basename(targetRun),
    golden: { labelsFile: "memory-recall-golden/labels.jsonl", queryCount: labels.length },
    config: { maxResults, halfLimit: r7HalfLimit, conclusionRelaxedForAnalytical: relaxedEnabled, conclusionLayerMaxChars: conclusionMaxChars },
    corpus: { ...stats, sceneBlocks: sceneEntries.length, driftVsRun: drift },
    annotationRuling: {
      words: "relevant 标注记录语料内容经 buildFtsQuery 分词（jieba 单一源）的 token 集（去重、长度≥2、滤数字开头日期/数值碎片；与 textHit 防单字噪声口径一致）",
      scenes: "空（expectedScenes 一次性标注属 E3）；场景通道判定逻辑在位（detectSceneHit 单一源）",
      nonCircularity: "结论选择判定输入 = query token/场景名；CC 标注词输入 = 标注记录内容——两路不同源",
    },
    limitations: [
      "A 口径重放选择函数而非端到端注入链路（幂等缓存/预算切分组装形态不在重放内——spec §3.2）",
      "经验层行 = 归档 ON 排序 × 语料内容；补池通道标注不可复原 → SD 补池分量 A 口径不可观测（需方案 B）",
      "语料为当前只读快照，与锚点时点存在漂移（见 corpus.driftVsRun）",
    ],
    metrics: {
      cc: cc.cc,
      ccConditional: cc.ccConditional,
      ccCoveredCount: cc.coveredCount,
      totalQueries: cc.totalQueries,
      queriesWithConclusions: cc.queriesWithConclusions,
      ctr: layered.ctr,
      ald: layered.ald,
      sd: { distribution: layered.sd.meanDistribution, entropy: layered.sd.meanEntropy },
    },
    perQuery: replayRows.map((r, i) => ({
      query: r.label.query,
      conclusions: r.conclusions.map((c) => ({ source: c.source, sceneName: c.sceneName, recordId: c.recordId ?? null, content: c.content })),
      conclusionLineCount: r.conclusionLines.length,
      experienceLineCount: r.experienceLines.length,
      totalLineCount: layered.perQuery[i]!.totalLineCount,
      conclusionChars: layered.perQuery[i]!.conclusionChars,
      totalChars: layered.perQuery[i]!.totalChars,
      ctr: layered.perQuery[i]!.ctr,
      ald: layered.perQuery[i]!.ald,
      sd: layered.perQuery[i]!.sd,
      tokens: layered.perQuery[i]!.tokens,
      ccJudgment: cc.perQuery[i] ?? null,
      annotationWordCount: r.annotationWords.length,
      missingRelevantIds: r.missingRelevant,
    })),
    missingExperienceIds: [...new Set(missingIds)],
    // A1 塌方侦测线登记（口径可追溯；trigger 时另附 ccCollapse { previous, current, ratio }）
    ccCollapseCheck: {
      threshold: CC_COLLAPSE_THRESHOLD,
      ruling: "相对降幅 > 50% → 红牌（不阻塞）；3 锚带宽 0（0.40/0.40/0.40）校准，2026-09-12 裁定",
      previousRun: collapseOutcome.previousRun,
      previousCc: collapseOutcome.previousCc,
      collapsed: collapseOutcome.trigger !== null,
    },
    ...(collapseOutcome.trigger ? { ccCollapse: collapseOutcome.trigger } : {}),
  };

  const layeredCopyPath = deriveLayeredCopyPath(targetRun);
  const archivedRun = { ...run, layeredMetrics };
  fs.writeFileSync(layeredCopyPath, JSON.stringify(archivedRun, null, 2), "utf8");

  // ── stdout 摘要 ────────────────────────────────────────────────────
  const pct = (x: number | null) => (x === null ? "null" : (x * 100).toFixed(1) + "%");
  log("==== layeredMetrics（方案 A）====");
  log(`CC  = ${pct(cc.cc)}（${cc.coveredCount}/${cc.totalQueries}）  CC' = ${pct(cc.ccConditional)}（分母 ${cc.queriesWithConclusions}）`);
  log(`CTR = ${(layered.ctr * 100).toFixed(2)}%（结论块字符/注入块总字符 = ${layered.totals.conclusionChars}/${layered.totals.totalChars}）`);
  log(`ALD = ${layered.ald.toFixed(2)} 字符/行（${layered.totals.totalChars}/${layered.totals.totalLines}）`);
  log(`SD  分布均值 = ${JSON.stringify(layered.sd.meanDistribution)}`);
  log(`SD  H 均值   = ${layered.sd.meanEntropy.toFixed(4)} bit（${layered.totals.queriesWithLines} 个有注入 query）`);
  for (const r of replayRows) {
    const j = cc.perQuery[replayRows.indexOf(r)]!;
    log(`  [${r.label.query}] 结论=${r.conclusions.length}行 经验=${r.experienceLines.length}行 covered=${j.covered}${j.hitWords.length ? ` hitWords=${JSON.stringify(j.hitWords.slice(0, 5))}` : ""}${j.hitScenes.length ? ` hitScenes=${JSON.stringify(j.hitScenes)}` : ""}`);
  }
  if (missingIds.length > 0) loud(`${missingIds.length} 条经验 id 在当前语料中缺失（语料漂移，已跳过并登记）`);
  log(`archived: ${layeredCopyPath} → layeredMetrics（A1 写副本：原档 ${path.basename(targetRun)} 未改写）`);
}

// 直接调用守卫：仅 `node --import tsx scripts/eval-layered-recall.ts [runs/<ts>.json]` 时执行 main；
// 被 vitest import（fixture 单测）时不触发 DB 访问。
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try { return pathToFileURL(path.resolve(entry)).href === import.meta.url; } catch { return false; }
})();
if (invokedDirectly) {
  main().catch((e) => { loud("eval failed:", e instanceof Error ? e.stack : String(e)); process.exit(1); });
}
