// Golden replay v2 with LIVE engine data cached once, then in-memory config sweep.
// Goal: pick (typeWeights, absGate, relGate, domainRouter) maximizing positive Recall
// while minimizing negative/meta injected noise.
//
// v2（T19 修复，2026-09-09）——对照 v1 的问题（W1b①②/W6）：
//   1. W1b②：v1 的 LIBS 键（Coding/Standards/AgentSkill）与 router.keywords 键
//      （Coding-WiKi/…）错位 → router 在本脚本恒 no-op。v2 键名统一为生产
//      injector 的 w.name 口径（WIKI_NAMES 常量共享），并在 router 启用时校验。
//   2. W6：v1 硬编码 18 条 GOLDEN（漏 p6）。v2 从 queries.jsonl 运行时读取，
//      消除"脚本集与 golden 文件漂移"。
//   3. W6：v1 正例相关集被手工裁剪。v2 读 queries.jsonl 完整 should_recall。
//   4. W6：v1 从不读 should_not_recall。v2 启用：负例命中计入 precision 断言。
//   5. W1b①：新增 --archive 模式，把 gitSha/语料指纹/逐 query 快照落盘
//      runs/<ISO时间>.json —— README 历史数字不可复现的病根即"未归档快照"。
// v2.1（Task19+20 fix1，2026-09-09）——对照 v2 的问题（I-3/M-3）：
//   6. I-3：notRecallHits 从"只打印的指标"升级为失败门 —— 任一配置
//      notRecallHits > 0 → 输出 FAIL 明细 + exit 1（--archive 模式仍在归档 JSON
//      落 passed 字段后再退出）。此前恒 exit 0，"0 误召"永远绿色，门形同虚设。
//   7. M-3：逐 query 快照的 hit 字段拆分为 posHit（正例命中，true=好）与
//      negRecalled（负例误召，true=坏），避免布尔语义在同一字段里正负混读。
import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const BRIDGE = "http://10.4.100.30:8421/v3/tools/call";
const HEADERS = { "Content-Type": "application/json", "x-tdai-service-id": "default", "x-conversation-id": "dsh-session-53ae397c-4a0b-4199-a534-4e2d14111fd7" };
// 唯一键名源：与生产 injector 的 w.name（绑定 wiki 资源名）完全一致。
// LIBS 的键与 domainRouter.keywords 的键都必须由此派生（W1b② 修复）。
const WIKI_NAMES = ["Coding-WiKi", "Standards-WiKi", "AgentSkill-WiKi"];
const LIBS = {
  "Coding-WiKi": "wiki-d7l7gdjw",
  "Standards-WiKi": "wiki-jr9mq6at",
  "AgentSkill-WiKi": "wiki-f4f59nnl",
};
const SCRIPT_VERSION = "replay-v2.1 (fix1: notRecallHits fail-gate + pos/neg hit split)";
const TOPK = 5;
const HERE = dirname(fileURLToPath(import.meta.url));

// ── GOLDEN：运行时从 queries.jsonl 读取（W6：删硬编码，golden 文件是唯一源）──
// should_recall / should_not_recall 条目是 wiki path 或裸 id；作为匹配词时取
// basename 去掉 .md（与引擎回传 title 对齐），匹配统一大小写不敏感。
const GOLDEN = readFileSync(join(HERE, "queries.jsonl"), "utf8")
  .trim().split(/\r?\n/)
  .map((line) => JSON.parse(line))
  .map((j) => ({
    id: String(j.id),
    q: String(j.query),
    rel: (j.should_recall ?? []).map((p) => String(p).split(/[\\/]/).pop().replace(/\.md$/, "")),
    neg: (j.should_not_recall ?? []).map((p) => String(p).split(/[\\/]/).pop().replace(/\.md$/, "")),
  }));

async function search(kid, q) {
  try {
    const r = await fetch(BRIDGE, { method: "POST", headers: HEADERS, body: JSON.stringify({ knowledge_id: kid, tool_name: "search", params: { query: q, limit: 8 } }) });
    const j = await r.json();
    return (j?.data?.results ?? []).map((x) => ({ title: String(x.title ?? ""), type: String(x.type ?? "other"), score: Number(x.score ?? 0), absScore: x.absScore == null ? undefined : Number(x.absScore), wiki: kid }));
  } catch { return []; }
}
// cache per (query,lib)
const cache = {};
async function getHits(q, kid) { const k = q + "|" + kid; if (!(k in cache)) cache[k] = await search(kid, q); return cache[k]; }
const ci = (s) => s.toLowerCase();
// golden 条目是文件名 slug（"报表-top-上限"/"n-1-查询禁令"/"begin-end-差量计算模式"），
// 引擎回传 title 是人读形态（"报表 top 上限"/"N+1 查询禁令"/"Begin-End 差量计算模式"）。
// 文件名 slugify 会把空格/+/斜杠折叠成 -，两侧匹配前统一小写并去掉分隔符再比较，
// 否则产生系统性假阴性（p3/p4/p5/p10 全 miss 的假象）。
const canon = (s) => ci(s).replace(/[-+/_\s]+/g, "");
const matchesTerm = (title, term) => canon(title).includes(canon(term));

async function runQuery(g, cfg) {
  const { tw, absGate, relGate, router } = cfg;
  const pool = [];
  for (const [wname, kid] of Object.entries(LIBS)) {
    const kws = router && router.keywords[wname];
    const n = kws ? kws.filter((x) => x && g.q.includes(x)).length : 0;
    const w = n > 0 ? 1 + (Math.min(n, 3) / 3) * (router.boost ?? 1.5) : 1;
    for (const h of await getHits(g.q, kid)) {
      const s = h.score * (tw[h.type] ?? 1) * w;
      if (h.absScore !== undefined && h.absScore < absGate) continue;
      pool.push({ title: h.title, score: s });
    }
  }
  const top = (() => {
    if (pool.length === 0) return [];
    const sc = pool.map((h) => h.score), mn = Math.min(...sc), mx = Math.max(...sc);
    return pool.map((h) => ({ ...h, norm: (h.score - mn) / Math.max(mx - mn, 1e-9) }))
      .sort((a, b) => b.norm - a.norm).slice(0, TOPK).filter((h) => h.norm >= relGate);
  })();
  const titles = top.map((h) => h.title);
  const matchedRel = g.rel.filter((t) => titles.some((title) => matchesTerm(title, t)));
  const matchedNeg = g.neg.filter((t) => titles.some((title) => matchesTerm(title, t)));
  return { injected: top.length, matchedRel, matchedNeg };
}

const routers = {
  off: null,
  on: { boost: 1.5, keywords: {
    "Coding-WiKi": ["结算", "金额", "冲回", "暂估", "合同", "订单", "出库", "尾差", "精度", "双口径", "临时表", "跨模块", "分录", "差量"],
    "Standards-WiKi": ["规范", "异常", "并发", "线程", "事务", "边界", "命名", "接口", "性能", "约束"],
    "AgentSkill-WiKi": ["查询", "报表", "权限", "范式", "交互", "脚本", "保存", "编辑", "列表", "卡片", "N+1"],
  } },
};
// W1b② 防回归钉：router 启用时其 keywords 键必须 ⊆ WIKI_NAMES（生产 w.name 口径），
// 否则本脚本的 router 会静默 no-op（v1 的静默缺陷），直接抛错。
if (routers.on) {
  for (const k of Object.keys(routers.on.keywords)) {
    if (!WIKI_NAMES.includes(k)) throw new Error(`router.keywords 键 "${k}" 不在 WIKI_NAMES 内 —— router 将静默 no-op（W1b② 防回归）`);
  }
  for (const k of Object.keys(LIBS)) {
    if (!WIKI_NAMES.includes(k)) throw new Error(`LIBS 键 "${k}" 不在 WIKI_NAMES 内 —— router 将静默 no-op（W1b② 防回归）`);
  }
}

const configs = [
  { label: "A cur-prod(tw08 rel0.7,no router)", tw: { entity: 0.6, concept: 0.8 }, absGate: 1.5, relGate: 0.7, router: routers.off },
  { label: "B (tw09 rel0.6, router on)",         tw: { entity: 0.6, concept: 0.9 }, absGate: 1.5, relGate: 0.6, router: routers.on },
  { label: "C (tw09 rel0.7, router on)",         tw: { entity: 0.6, concept: 0.9 }, absGate: 1.5, relGate: 0.7, router: routers.on },
  { label: "D (tw09 rel0.5, router on)",         tw: { entity: 0.6, concept: 0.9 }, absGate: 1.5, relGate: 0.5, router: routers.on },
  // C3（2026-09-10）router-off@部署参数锚点：与 B 唯一差异 = router off。
  // 同一轮语料快照内成对对照（B on vs E off），归因纪律：翻默认前先归档此点。
  { label: "E (tw09 rel0.6, router off) = B minus router (C3 anchor)", tw: { entity: 0.6, concept: 0.9 }, absGate: 1.5, relGate: 0.6, router: routers.off },
];

async function runConfig(cfg) {
  const perQuery = [];
  let posRel = 0, posTotal = 0, negInj = 0, negTermHits = 0, injectedTotal = 0;
  for (const g of GOLDEN) {
    const r = await runQuery(g, cfg);
    injectedTotal += r.injected;
    if (g.rel.length > 0) {
      posRel += r.matchedRel.length;
      posTotal += g.rel.length;
    } else {
      negInj += r.injected; // 无正例期望的 query 上任何注入都算噪音（v1 口径保留）
    }
    negTermHits += r.matchedNeg.length; // should_not_recall 命中（W6 修复：precision 断言生效）
    perQuery.push({
      id: g.id,
      // M-3：hit 字段拆分 —— posHit（正例命中，true=好）与 negRecalled（负例误召，
      // true=坏）分开，不再共用一个布尔字段正负混读。不适用侧为 undefined
      // （JSON 序列化时省略该字段）。
      posHit: g.rel.length > 0 ? r.matchedRel.length > 0 : undefined,
      negRecalled: g.rel.length === 0 ? r.matchedNeg.length > 0 : undefined,
      matchedTerms: r.matchedRel,
      notRecallHits: r.matchedNeg,
      injectedCount: r.injected,
    });
  }
  const metrics = {
    posRecall: Number((posRel / posTotal).toFixed(2)),
    posMatched: posRel,
    posTotal,
    negInjected: negInj,
    notRecallHits: negTermHits,
    injectedTotal,
  };
  return { label: cfg.label, metrics, perQuery };
}

// ── 语料指纹（W1b①：锚点必须可复现）──
// golden 侧：本地 golden 文件 mtime+size+内容 sha256（queries.jsonl 是评测语料源）。
// 引擎侧：本轮全部检索命中（每库逐 query 的 title|type|score 序列）sha256 ——
// 远端 wiki 语料本体在本机不可 stat，用检索快照哈希锁定"本次归档看到的语料状态"。
function corpusFingerprint() {
  const goldenFile = join(HERE, "queries.jsonl");
  const st = statSync(goldenFile);
  const sha = (s) => createHash("sha256").update(s).digest("hex");
  const engine = {};
  for (const [wname, kid] of Object.entries(LIBS)) {
    const parts = [];
    for (const g of GOLDEN) {
      for (const h of cache[g.q + "|" + kid] ?? []) parts.push(`${g.q}|${h.title}|${h.type}|${h.score}`);
    }
    engine[wname] = sha(parts.sort().join("\n"));
  }
  return {
    golden: { file: "queries.jsonl", mtime: st.mtime.toISOString(), size: st.size, sha256: sha(readFileSync(goldenFile)) },
    engine,
  };
}

function gitSha() {
  try { return execSync("git rev-parse HEAD", { cwd: HERE, encoding: "utf8" }).trim(); }
  catch { return "unknown"; }
}

const results = [];
for (const cfg of configs) results.push(await runConfig(cfg));
for (const r of results) {
  const m = r.metrics;
  console.log(`${r.label} :: posRecall=${m.posRecall.toFixed(2)} (${m.posMatched}/${m.posTotal}) negInjected=${m.negInjected} notRecallHits=${m.notRecallHits}/${GOLDEN.reduce((a, g) => a + g.neg.length, 0)} (0=PASS, >0=FAIL)`);
}

// ── I-3（fix1）：notRecallHits 失败门 ──
// 词表口径负例误召（should_not_recall 命中）是断言而非参考指标：任一配置 >0
// 即输出 FAIL 明细并 exit 1，让 CI/调用方能感知宁缺毋滥门被击穿（v2 恒 exit 0）。
const failures = results.flatMap((r) =>
  r.perQuery
    .filter((q) => (q.notRecallHits ?? []).length > 0)
    .map((q) => ({ config: r.label, queryId: q.id, notRecallHits: q.notRecallHits })),
);
const passed = failures.length === 0;
if (!passed) {
  console.error(`\nFAIL: notRecallHits > 0（词表口径负例误召，宁缺毋滥门被击穿）—— ${failures.length} 处明细：`);
  for (const f of failures) {
    console.error(`  - [${f.config}] query=${f.queryId} 误召=${JSON.stringify(f.notRecallHits)}`);
  }
}

if (process.argv.includes("--archive")) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const runsDir = join(HERE, "runs");
  mkdirSync(runsDir, { recursive: true });
  const archive = {
    archivedAt: new Date().toISOString(),
    gitSha: gitSha(),
    scriptVersion: SCRIPT_VERSION,
    passed, // I-3：词表口径负例误召失败门结果（false = 本轮有配置 notRecallHits > 0）
    goldenQueries: GOLDEN.length,
    goldenRelTerms: GOLDEN.reduce((a, g) => a + g.rel.length, 0),
    goldenNegTerms: GOLDEN.reduce((a, g) => a + g.neg.length, 0),
    corpusFingerprint: corpusFingerprint(),
    configs: results,
  };
  const out = join(runsDir, `${ts}.json`);
  writeFileSync(out, JSON.stringify(archive, null, 2), "utf8");
  console.log(`\n[archive] ${out} passed=${passed}`);
}

if (!passed) process.exit(1);
