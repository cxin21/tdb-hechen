/**
 * 验收门禁汇总（issue #134）：把 LME90 配对报告按票面三条门禁判定。
 *
 * 门禁（票面「验收」）：
 *  1. 召回缺口桶回收 ≥5 题：base turnCov@5 ∈ {0, 0.5} 的题 → trial turnCov@5 ≥ 0.5
 *  2. 判对 ≥ +3pt 且 95%CI 下界 > 0（paired bootstrap on genCorrect）
 *  3. 写入预算：抽取 token/turn 与结论卡数量在预算内（--budget-tokens-per-turn 缺省 800；
 *     --budget-cards-per-group 缺省不判）
 *
 * 用法：
 *   node --import tsx scripts/bench-gates.mjs [<base.json|auto>] <trial.json> [--min-recovered 5] [--min-delta-pp 3]
 *   只给一份报告时自动取登记表的「同 judge 基线」（票面②的默认行为）
 *
 * 判分器一致性（#140）：
 *  - base 与 trial 的 config.judgeModel 不一致 → 拒绝判定（exit 3），除非 --allow-cross-judge；
 *  - `--base auto` → 从基线登记表（manifest 同级 lme-baselines.json）解析「同 judge 基线」，
 *    判分器已变更时报 judge-changed 并要求重跑基线，绝不静默拿旧 judge 基线配对。
 *
 * 退出码：0 = 全过；1 = 有门禁未过；2 = 参数/读文件错误；3 = 判分器不一致/基线不可用（拒判）。
 */
import fs from "node:fs";
import path from "node:path";
import { mcnemarExact, pairedBootstrap, pct, pp } from "./lib/bench/stats.mjs";
import { judgeTokenBudget } from "./lib/bench/stages.mjs";
import { configDiff, configDiffLine, decidePairing, judgeRepairHint } from "./lib/bench/judge.mjs";
import { judgeBaselineAudit, loadRegistry, registryPathForManifest } from "./lib/bench/baseline.mjs";

const argv = process.argv.slice(2);
function arg(name, dflt) {
  const i = argv.indexOf("--" + name);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
}
const files = argv.filter((a) => !a.startsWith("--") && !/^[\d.]+$/.test(a));
// 只给一份报告 = 「拿它跟登记表里的同 judge 基线比」（票面②：门禁默认引用同 judge 基线）。
// 显式给两份时仍按老用法；写 auto 也等价。
const [firstFile, secondFile] = files;
const baseFile = secondFile === undefined ? (firstFile ? "auto" : undefined) : firstFile;
const trialFile = secondFile === undefined ? firstFile : secondFile;
if (!baseFile || !trialFile) {
  console.error(
    "用法: node --import tsx scripts/bench-gates.mjs [<base.json|auto>] <trial.json> [--min-recovered 5] [--min-delta-pp 3] [--budget-tokens-per-turn 800]\n" +
      "       [--min-evidence-sufficiency 0.6] [--per-type-floor temporal=0]\n" +
      "  只给一份报告时自动用基线登记表的「同 judge 基线」作 base。",
      "  --min-evidence-sufficiency / --per-type-floor 缺省不判（SKIP），老报告不受影响。",
  );
  process.exit(2);
}
const minRecovered = Number(arg("min-recovered", 5));
const minDeltaPp = Number(arg("min-delta-pp", 3));
const budgetTokensPerTurn = Number(arg("budget-tokens-per-turn", 800));
// 票面门禁3 还要求「结论卡数量在预算内」。缺省不判（历史报告无此数据）；给了阈值就判。
const budgetCardsPerGroup = arg("budget-cards-per-group", undefined) === undefined ? null : Number(arg("budget-cards-per-group"));

const allowCrossJudge = arg("allow-cross-judge", false) === true;
// #141：新增两个可选门禁（缺省 SKIP = 不参与判定，老报告不受影响）。
//  --min-evidence-sufficiency X   证据充分性均值下限（trial 报告 evidenceSufficiency.mean）
//  --per-type-floor temporal=<pp> 分题型判对 Δ 下限（可逗号分隔多个题型）
const minEvidenceSufficiencyArg = arg("min-evidence-sufficiency", undefined);
const minEvidenceSufficiency =
  minEvidenceSufficiencyArg === undefined ? null : Number(minEvidenceSufficiencyArg);
if (minEvidenceSufficiency !== null && (!Number.isFinite(minEvidenceSufficiency) || minEvidenceSufficiency < 0 || minEvidenceSufficiency > 1)) {
  console.error("[gates:error] --min-evidence-sufficiency 需 0~1 的数值（证据充分性口径）");
  process.exit(2);
}
const perTypeFloorArg = arg("per-type-floor", undefined);
const perTypeFloors = [];
if (perTypeFloorArg !== undefined) {
  const raw = perTypeFloorArg === true ? "" : String(perTypeFloorArg);
  for (const part of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^([A-Za-z0-9_-]+)=(-?[\d.]+)$/);
    if (!m) {
      console.error(`[gates:error] --per-type-floor 需形如 temporal=0（收到 ${part}）`);
      process.exit(2);
    }
    perTypeFloors.push({ type: m[1], floorPp: Number(m[2]) });
  }
  if (perTypeFloors.length === 0) {
    console.error("[gates:error] --per-type-floor 需要一个值，例如 temporal=0");
    process.exit(2);
  }
}

/** 登记表里存的是登记时的报告路径；先按 cwd，再按 manifest 目录解析。 */
function resolveReport(ref, manifest) {
  if (path.isAbsolute(ref)) return ref;
  const cands = [path.resolve(ref)];
  if (manifest) cands.push(path.resolve(path.dirname(manifest), ref), path.resolve(path.dirname(manifest), "..", ref));
  return cands.find((p) => fs.existsSync(p)) ?? cands[0];
}

// trial 报告只读一次：基线解析与配对判定共用同一份内存对象。
const B = JSON.parse(fs.readFileSync(trialFile, "utf8"));

// ── 基线解析（#140 目标②）：--base auto = 取「同 judge 基线」──
let resolvedBase = baseFile;
let baselineNote = null;
if (baseFile === "auto") {
  const manifest = B.config?.manifest ?? null;
  if (!manifest) {
    console.error("--base auto 需要 trial 报告记录 config.manifest（无法定位基线登记表）");
    process.exit(2);
  }
  const regPath = registryPathForManifest(manifest);
  const audit = judgeBaselineAudit(loadRegistry(regPath), B);
  if (audit.verdict !== "ok") {
    const lines = ["# 验收门禁（issue #134）", `基线解析: --base auto（登记表 ${regPath}）`];
    if (audit.verdict === "judge-changed") {
      lines.push(
        `REFUSED: 判分器已换成 ${audit.judge ?? "（未记录）"}，登记表里只有 ${audit.staleJudges.join(", ")} 判分的基线——判分器变更必须重跑基线，不能拿旧 judge 基线配对（#140）。`,
      );
    } else {
      lines.push(`REFUSED: 登记表里没有这个 manifest 的基线（判分器 ${audit.judge ?? "（未记录）"}）——先登记一份基线报告。`);
    }
    lines.push(...judgeRepairHint({ trialJudge: audit.judge }));
    lines.push(`登记基线: node scripts/bench-baseline.mjs register <报告.json>`);
    console.log(lines.join("\n"));
    process.exit(3);
  }
  resolvedBase = resolveReport(audit.baseline.report, manifest);
  baselineNote = `基线来源: 登记表 ${audit.baseline.tag}（judge=${audit.baseline.judgeModel ?? "（未记录）"}，commit=${(audit.baseline.repoCommit ?? "").slice(0, 7) || "-"}）`;
  // 登记表入库、报告 JSON 不入库（.eval-data）：异机 clone 后指针必然悬空。给可执行的下一步，而不是抛 ENOENT 栈。
  if (!fs.existsSync(resolvedBase)) {
    console.error(
      [
        `REFUSED: 登记表指向的基线报告不存在: ${resolvedBase}`,
        `  （登记项 ${audit.baseline.tag}：judge=${audit.baseline.judgeModel ?? "（未记录）"}，commit=${audit.baseline.repoCommit ?? "-"}）`,
        "  报告 JSON 是本机 .eval-data 下的评测产物、不入库；换机器后需要重新生成或从原机器拷回。",
        "  下一步：node scripts/bench-baseline.mjs register <新生成的基线报告.json> --gate-baseline",
      ].join("\n"),
    );
    process.exit(2);
  }
}

const A = JSON.parse(fs.readFileSync(resolvedBase, "utf8"));
const decision = decidePairing({
  baseReport: A,
  trialReport: B,
  allowCrossJudge,
  baseLabel: resolvedBase,
  trialLabel: trialFile,
});
const mapById = (r) => new Map(r.rows.map((x) => [x.caseId, x]));
const am = mapById(A);
const bm = mapById(B);
const pairs = [...am.keys()].filter((id) => bm.has(id)).map((id) => ({ id, a: am.get(id), b: bm.get(id) }));

const L = [];
L.push("# 验收门禁（issue #134）");
L.push(`base : ${resolvedBase} (tag=${A.config?.tag ?? "-"})`);
L.push(`trial: ${trialFile} (tag=${B.config?.tag ?? "-"})`);
if (baselineNote) L.push(baselineNote);
for (const line of decision.lines) L.push(line);
L.push(configDiffLine(configDiff(A, B)));
L.push(`配对题数: ${pairs.length}`);
L.push("");
let failed = 0;
let skipped = 0;

// 跨 judge / 身份不可证：先拒判（#140 目标④），别让判对门禁在混尺子下出结论。
if (!decision.allowed) {
  L.push("## 结论：拒绝判定（判分器不一致）");
  console.log(L.join("\n"));
  process.exit(decision.exitCode);
}

// ── 门禁 1：召回缺口桶回收 ──
{
  const gapRows = pairs.filter((p) => typeof p.a["turnCov@5"] === "number" && p.a["turnCov@5"] < 0.5);
  // 回收 = 严格上升且达到 ≥0.5（base cov=0.5 已在桶内，未改善不能算回收）
  const recovered = gapRows.filter(
    (p) => typeof p.b["turnCov@5"] === "number" && p.b["turnCov@5"] >= 0.5 && p.b["turnCov@5"] > p.a["turnCov@5"] + 1e-9,
  );
  const pass1 = recovered.length >= minRecovered;
  if (!pass1) failed++;
  L.push(`## 门禁1 召回缺口桶回收（≥${minRecovered} 题）`);
  L.push(`缺口桶（base cov@5<0.5）: ${gapRows.length} 题；回收（trial cov@5≥0.5）: ${recovered.length} 题 → ${pass1 ? "PASS" : "FAIL"}`);
  if (recovered.length) {
    L.push("回收清单:");
    for (const p of recovered) L.push(`  - ${p.id} [${p.a.questionType}] cov ${p.a["turnCov@5"]} → ${p.b["turnCov@5"]}（判对 ${p.a.genCorrect ?? "-"} → ${p.b.genCorrect ?? "-"}）`);
  }
  L.push("");
}

// ── 门禁 2：判对 Δ ≥ +3pt 且 CI 下界 > 0 ──
{
  const rows = pairs.filter((p) => p.a.genCorrect != null && p.b.genCorrect != null);
  // retrieval-only 档（--gen-limit 0）没有 genCorrect：这是「未测量」，不是「测不过」。
  // 旧实现会让 rows=[] → NaN 渲染成 FAIL，把召回归因档误判成判对退步。
  if (rows.length === 0) {
    skipped++;
    L.push(`## 门禁2 判对（≥+${minDeltaPp}pt 且 CI 下界>0）`);
    L.push("判分: SKIP（两档都没有 genCorrect——retrieval-only 档只比召回覆盖率）");
    L.push("");
  } else if (!decision.pairing.judgedComparable) {
    // --allow-cross-judge 下走到这里：数据只能作参考，不能当门禁结论（#140 目标④）。
    skipped++;
    const deltasRef = rows.map((p) => p.b.genCorrect - p.a.genCorrect);
    const meanRef = deltasRef.reduce((s, x) => s + x, 0) / deltasRef.length;
    const ciRef = pairedBootstrap(deltasRef, { iters: 10000 });
    L.push(`## 门禁2 判对（≥+${minDeltaPp}pt 且 CI 下界>0）`);
    L.push(`参考值: Δ=${pp(meanRef)} 95%CI=[${pp(ciRef.lo)}, ${pp(ciRef.hi)}]（跨判分器，未计入门禁）`);
    L.push("判分: SKIP（两侧判分器不一致——判对 Δ 混着判分器差异，先对齐 judge 或用 bench-rejudge.mjs 重判基线）");
    L.push("");
  } else {
  const deltas = rows.map((p) => p.b.genCorrect - p.a.genCorrect);
  const mean = deltas.reduce((s, x) => s + x, 0) / deltas.length;
  const ci = pairedBootstrap(deltas, { iters: 10000 });
  const b = rows.filter((p) => p.a.genCorrect === 1 && p.b.genCorrect === 0).length;
  const c = rows.filter((p) => p.a.genCorrect === 0 && p.b.genCorrect === 1).length;
  const m = mcnemarExact(b, c);
  const accA = rows.filter((p) => p.a.genCorrect === 1).length / rows.length;
  const accB = rows.filter((p) => p.b.genCorrect === 1).length / rows.length;
  const pass2 = mean * 100 >= minDeltaPp && ci.lo > 0;
  if (!pass2) failed++;
  L.push(`## 门禁2 判对（≥+${minDeltaPp}pt 且 CI 下界>0）`);
  L.push(`correct: base=${pct(accA)} trial=${pct(accB)} Δ=${pp(mean)}  95%CI=[${pp(ci.lo)}, ${pp(ci.hi)}]  McNemar b=${b} c=${c} p=${m.p.toFixed(4)}`);
  L.push(`判分: ${pass2 ? "PASS" : "FAIL"}`);
  const refA = rows.filter((p) => p.a.refused === 1).length / rows.length;
  const refB = rows.filter((p) => p.b.refused === 1).length / rows.length;
  L.push(`refused: base=${pct(refA)} trial=${pct(refB)}`);
  L.push("");
  }
}

// ── 门禁 3：写入预算（token/turn + 热路径延迟）──
{
  const fx = B.config?.factExtraction ?? null;
  const cc = B.config?.conclusionCards ?? null;
  const stats = fx?.stats ?? null;
  const turns = stats?.turns ?? 0;
  // #139 第4项：token 证据不再受"是否走缓存"影响——缓存命中时 facts.mjs 会带回 usage
  // （payload 里的真值，或 estimated-cache 的确定性估算）。这里一律可判；估算参与时
  // 结果标注"（估算口径）"但**不降级为 SKIP**（否则预算门禁在缓存档永远测不出来，
  // 而缓存档恰恰是复跑主场景）。
  const tok = fx?.tokens ?? null;
  const tokens = tok ? (tok.total ?? 0) : (stats?.usage?.prompt ?? 0) + (stats?.usage?.completion ?? 0);
  const estimated = tok ? tok.estimatedCalls > 0 : false;
  const cacheHits = stats?.cacheHits ?? 0;
  const groups = stats?.groups ?? 0;
  // 判定与展示分离：展示串带「（估算口径）」后缀，判定用干净 verdict——
  // 否则 "FAIL（估算口径）" !== "FAIL"，failed 不累加，最终 exit 0 报「全部 PASS」（假绿）。
  // 判定走 stages.judgeTokenBudget（与展示分离，单测可断言「估算了也照样 FAIL」）。
  const judged = judgeTokenBudget({ tokens, turns, budgetTokensPerTurn });
  const verdict3 = fx ? judged.verdict : "SKIP";
  let status3;
  if (!fx) status3 = "SKIP（本档未启用事实抽取）";
  else if (verdict3 === "SKIP" && judged.reason === "turns-missing") status3 = "SKIP（有 token 但 turns 统计缺失，无法算 token/turn）";
  else if (verdict3 === "SKIP") status3 = "SKIP（无可测 token 证据：既无 provider usage，也无法从缓存语料估算）";
  else status3 = verdict3 + (estimated ? "（估算口径）" : "");
  if (verdict3 === "FAIL") failed++;
  if (verdict3 === "SKIP") skipped++;
  L.push("## 门禁3 写入预算（离线抽取 token/turn ≤ " + budgetTokensPerTurn + "）");
  if (fx) {
    L.push("抽取: groups=" + groups + "（缓存命中 " + cacheHits + "） turns=" + turns + " phrases=" + (stats?.phrases ?? 0) + " 失败批=" + (stats?.failedBatches ?? 0));
    L.push(
      "token: prompt=" + (stats?.usage?.prompt ?? 0) + " completion=" + (stats?.usage?.completion ?? 0) +
        " → " + (turns ? (tokens / turns).toFixed(1) : "0.0") + " token/turn" +
        (estimated
          ? "（含估算 " + tok.estimatedCalls + " 组，其中 mixed=" + (tok.mixedCalls ?? 0) + "；live=" + (tok.liveCalls ?? 0) + " cache=" + (tok.cacheCalls ?? 0) + "）"
          : ""),
    );
    L.push("离线抽取耗时: " + ((stats?.extractMs ?? 0) / 1000).toFixed(0) + "s（缓存命中档为 0——不计入写入热路径）");
  }
  if (cc) {
    const cs = cc.stats ?? {};
    const cardsPerGroup = cs.groups ? (cs.cards ?? 0) / cs.groups : 0;
    L.push("结论卡: groups=" + (cs.groups ?? 0) + "（缓存命中 " + (cs.cacheHits ?? 0) + "） cards=" + (cs.cards ?? 0) + " 平均 " + cardsPerGroup.toFixed(2) + " 卡/组 蒸馏耗时=" + ((cs.ms ?? 0) / 1000).toFixed(0) + "s");
    const ct = cc.tokens;
    if (ct) L.push("结论卡 token: prompt=" + ct.prompt + " completion=" + ct.completion + (ct.estimatedCalls ? "（含估算 " + ct.estimatedCalls + " 组）" : ""));
    // 票面门禁3 的前半句（「结论卡数量在预算内」）：只在给了阈值且本档确实产卡时判。
    if (budgetCardsPerGroup !== null && (cs.groups ?? 0) > 0) {
      const okCards = !Number.isFinite(budgetCardsPerGroup) || cardsPerGroup <= budgetCardsPerGroup;
      if (!okCards) failed++;
      L.push("卡数预算: ≤" + budgetCardsPerGroup + " 卡/组 → " + (okCards ? "PASS" : "FAIL（实际 " + cardsPerGroup.toFixed(2) + "）"));
    }
  }
  const ing = B.config?.ingest ?? {};
  L.push("灌库: turns=" + (ing.turns ?? 0) + " written=" + (ing.written ?? 0) + " embedded=" + (ing.embedded ?? 0) + "（失败 " + (ing.embedFailed ?? 0) + "）superseded=" + (ing.superseded ?? 0) + "/" + (ing.supersedeOps ?? 0) + " conclusions=" + (ing.conclusionsWritten ?? 0) + " links=" + (ing.conclusionLinks ?? 0));
  L.push("判分: " + status3);
  L.push("");
}

// ── 门禁 4：抽取噪声抽样验收（读取 fact-extract-gate 报告）──
{
  const gatePath = arg("fact-gate", undefined);
  L.push("## 门禁4 抽取噪声抽样验收");
  if (typeof gatePath !== "string" || !gatePath) {
    // 只有「未提供报告」才是 SKIP（确实没做这项测量）。
    skipped++;
    L.push("未提供 --fact-gate 报告 → 未能核验（SKIP）");
  } else {
    try {
      const g = JSON.parse(fs.readFileSync(gatePath, "utf8"));
      const ok = g?.pass === true && (g?.scored?.total ?? 0) >= 30;
      if (!ok) failed++;
      const status4 = ok
        ? "PASS（accuracy " + (g.scored?.accuracy * 100).toFixed(1) + "% ≥ 阈值，样本 " + (g.scored?.total ?? 0) + " 条 ≥ 30）"
        : "FAIL（accuracy " + (g.scored?.accuracy * 100).toFixed(1) + "%，样本 " + (g.scored?.total ?? 0) + " 条；要求 ≥90% 且 ≥30 条）";
      L.push("报告: " + gatePath + "（样本 " + (g.sampleVerified ?? 0) + " turn / " + (g.scored?.total ?? 0) + " 条事实，阈值 " + ((g.threshold ?? 0) * 100).toFixed(0) + "%）→ " + status4);
    } catch (e) {
      // 指定了报告却读不到/解析失败 = 防线静默失效，判 FAIL（旧实现落 SKIP → exit 0 假绿）。
      failed++;
      L.push("报告: " + gatePath + " → FAIL（报告读取/解析失败: " + String(e?.message ?? e) + "）");
    }
  }
  L.push("");
}

// ── 门禁 5：证据充分性（#141 新增指标；缺省 SKIP）──
{
  L.push("## 门禁5 证据充分性（#141 可答性近似：trial 均值 ≥ 阈值）");
  const esB = B.evidenceSufficiency?.mean;
  const esA = A.evidenceSufficiency?.mean;
  const fmt = (v) => (typeof v === "number" ? v.toFixed(3) : "-");
  if (minEvidenceSufficiency === null) {
    // 缺省不判：这是新指标，历史报告里没有，默认参与判定会把老档全变 SKIP/FAIL。
    skipped++;
    L.push("证据充分性: SKIP（未设 --min-evidence-sufficiency；base=" + fmt(esA) + " trial=" + fmt(esB) + "）");
  } else if (typeof esB !== "number") {
    // 有阈值但报告缺字段 = 本档没采这个指标 → 未测量，不是测不过。
    skipped++;
    L.push("证据充分性: SKIP（trial 报告无 evidenceSufficiency——该档未采集此指标；先跑含该字段的档）");
  } else {
    const ok = esB >= minEvidenceSufficiency;
    if (!ok) failed++;
    L.push("证据充分性: base=" + fmt(esA) + " trial=" + fmt(esB) + "（阈值 ≥" + minEvidenceSufficiency + "）→ " + (ok ? "PASS" : "FAIL"));
  }
  // 注入行类型归因（#158）：只做展示，不设门禁——它解释「谁在为覆盖率买单」，不是验收线。
  const lt = B.lineTypeTotals;
  if (lt && typeof lt === "object") {
    const parts = Object.entries(lt).map(([t, v]) => t + " " + (v?.lines ?? 0) + " 行/gold " + (v?.goldLines ?? 0));
    L.push("注入行类型（trial）: " + parts.join(" · "));
  }
  // #169 证据包：只做展示，不设门禁——它量的是「补进来的上下文」，与 turnCov/sessionCov 严格分开。
  const ia = B.injectionAdjacency;
  if (ia && ia.enabledCases > 0) {
    L.push(
      "证据包（trial）: 邻接 +" +
        (ia.adjacencyLines ?? 0) +
        " 行 / seed " +
        (ia.seedLines ?? 0) +
        " 行 · 越窗拒 " +
        (ia.skippedWindow ?? 0) +
        " · 触帽拒 " +
        (ia.skippedCap ?? 0) +
        " · 开会话 " +
        (ia.sessionsQueried ?? 0) +
        " · 覆盖 " +
        ia.enabledCases +
        " 题",
    );
  }
  L.push("");
}

// ── 门禁 6：分题型判对地板（#141 验收：temporal 不得低于基线；缺省 SKIP）──
{
  L.push("## 门禁6 分题型判对地板（--per-type-floor）");
  if (perTypeFloors.length === 0) {
    skipped++;
    L.push("分题型: SKIP（未设 --per-type-floor，例如 temporal=0）");
  } else {
    for (const { type, floorPp } of perTypeFloors) {
      // 题型名支持前缀匹配：写 temporal 即命中 temporal-reasoning（LME 题型多是 "<族>-<子类>"）；
      // 精确名照样命中。两档都要有 genCorrect 才算可判。
      const matchType = (qt) => {
        const s = String(qt ?? "");
        return s === type || s.startsWith(type + "-") || s.startsWith(type + "_");
      };
      const rows = pairs.filter((p) => matchType(p.b.questionType ?? p.a.questionType) && p.a.genCorrect != null && p.b.genCorrect != null);
      if (rows.length === 0) {
        // 区分两种「零行」：题型名根本不存在（拼写错）→ 门禁凭空消失必须 FAIL；
        // 题型存在但这一档没判分（未生成作答）→ SKIP 才诚实。
        const knownTypes = [...new Set(pairs.map((p) => String(p.b.questionType ?? p.a.questionType ?? "")).filter(Boolean))];
        const named = knownTypes.some(matchType);
        if (!named) {
          failed++;
          L.push(type + ": FAIL（报告里没有匹配的题型；已见题型: " + knownTypes.join(", ") + "）");
        } else {
          skipped++;
          L.push(type + ": SKIP（题型存在但没有可配对判分行——该档未生成作答？）");
        }
        continue;
      }
      const deltas = rows.map((p) => p.b.genCorrect - p.a.genCorrect);
      const mean = deltas.reduce((s, x) => s + x, 0) / deltas.length;
      const ok = mean * 100 >= floorPp;
      if (!ok) failed++;
      const accB = rows.filter((p) => p.b.genCorrect === 1).length / rows.length;
      L.push(type + ": n=" + rows.length + " Δ=" + pp(mean) + "（地板 ≥" + floorPp + "pp；trial 判对 " + pct(accB) + "）→ " + (ok ? "PASS" : "FAIL"));
    }
  }
  L.push("");
}

L.push(`## 结论：${failed === 0 ? (skipped > 0 ? "门禁通过，但 " + skipped + " 项 SKIP（未能测量）" : "全部门禁 PASS") : failed + " 项门禁 FAIL"}`);
console.log(L.join("\n"));
process.exit(failed === 0 ? 0 : 1);