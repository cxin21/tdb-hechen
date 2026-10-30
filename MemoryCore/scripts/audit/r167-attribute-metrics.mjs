/**
 * #167 度量脚本：受控 attribute 的覆盖率 / 分布 / 同键跨轮重复率。
 *
 * 用法：
 *   node --import tsx scripts/audit/r167-attribute-metrics.mjs  *     --cache .eval-data/bench/facts-cache-v4  *     --dataset ../.eval-data/longmemeval_oracle.json  *     --out .eval-data/bench/r167-metrics-v4.json
 *
 * 口径（与 #167 票面一致）：
 * - 同键跨轮重复率 = 跨 ≥2 个 turn 出现的 (subject,key) / 不同键总数；
 *   - v3 旧口径：key = (normSubject, normPredicate)
 *   - v4 新口径：有 attribute 时 key = (normSubject, attribute)，否则回落旧口径
 * - coverage = 带 attribute 的三元组 / 全部三元组
 * - 分布按 attribute 计数，并列 cardinality（词表档位）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { factKeyOf } from "../../src/core/record/supersession.ts";
import { attributeCardinalityOf, FACT_ATTRIBUTES, normalizeFactAttribute, resolveFactCardinality } from "../../src/core/record/fact-attribute.ts";
import { classifyCardinality } from "../../src/core/record/cardinality.ts";

const argv = process.argv.slice(2);
function arg(name, dflt) {
  const i = argv.indexOf("--" + name);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
}
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const cacheDir = path.resolve(repo, String(arg("cache", path.join(repo, ".eval-data", "bench", "facts-cache-v4"))));
const datasetPath = path.resolve(repo, String(arg("dataset", path.join(repo, "..", ".eval-data", "longmemeval_oracle.json"))));
const outPath = arg("out", null) ? path.resolve(repo, String(arg("out"))) : null;

const dataset = JSON.parse(fs.readFileSync(datasetPath, "utf8"));
const caseType = new Map(dataset.map((c) => [c.question_id, c.question_type]));

const factsDir = path.join(cacheDir, "facts");
const files = fs.existsSync(factsDir) ? fs.readdirSync(factsDir).filter((f) => f.endsWith(".json")) : [];

function turnOrder(turnId) {
  const m = /-s(\d+)-t(\d+)$/.exec(turnId);
  return m ? [Number(m[1]), Number(m[2])] : [1e9, 1e9];
}

const perCase = [];
let triplesTotal = 0, withAttr = 0, turnsTotal = 0;

for (const f of files.sort()) {
  const doc = JSON.parse(fs.readFileSync(path.join(factsDir, f), "utf8"));
  const caseId = doc.caseId ?? f.replace(/\.json$/, "");
  const turns = Object.keys(doc.byTurn ?? {}).sort((a, b) => {
    const [as, at] = turnOrder(a), [bs, bt] = turnOrder(b);
    return as - bs || at - bt;
  });
  turnsTotal += turns.length;
  const rows = [];
  for (const turnId of turns) {
    for (const t of doc.byTurn[turnId]?.triples ?? []) {
      const attribute = normalizeFactAttribute(t.attribute);
      rows.push({
        turnId,
        subject: String(t.subject ?? ""),
        predicate: String(t.predicate ?? ""),
        value: String(t.value ?? ""),
        attribute,
        rawCardinality: t.cardinality ?? "unspecified",
        // 解析后的实际基数（与生产 resolveFactCardinality 同一阶梯），不是词表档位。
        cardinality: resolveFactCardinality(attribute, t.cardinality, classifyCardinality(String(t.predicate ?? ""), String(t.value ?? ""))).cardinality,
      });
    }
  }
  triplesTotal += rows.length;
  withAttr += rows.filter((r) => r.attribute).length;
  perCase.push({ caseId, type: caseType.get(caseId) ?? "unknown", turns, rows });
}

function keyStats(useAttribute) {
  let distinct = 0, crossTurn = 0, excess = 0;
  const keyMap = new Map(); // key -> [{turnId, row}]
  for (const c of perCase) {
    for (const r of c.rows) {
      const key = useAttribute && r.attribute ? factKeyOf(r.subject, r.predicate, r.attribute) : factKeyOf(r.subject, r.predicate);
      const arr = keyMap.get(key) ?? [];
      arr.push({ caseId: c.caseId, type: c.type, ...r });
      keyMap.set(key, arr);
    }
  }
  distinct = keyMap.size;
  for (const arr of keyMap.values()) {
    const turns = new Set(arr.map((x) => x.turnId));
    if (turns.size >= 2) crossTurn += 1;
    excess += arr.length - 1;
  }
  return { distinctKeys: distinct, crossTurnKeys: crossTurn, crossTurnRate: distinct ? crossTurn / distinct : 0, excessOccurrences: excess };
}

const v3 = keyStats(false);
const v4 = keyStats(true);

/**
 * 跨轮键的基数构成：一个键可能混着 single/multi 行（v3 谓词键尤其如此）。
 * 键按「组内出现过 single 行」归为 single 键，否则 multi 键；另出出现次数（excess 已够，
 * 这里数的是跨轮键命中的事实条数），避免用「键占比」冒充「失效收益占比」。
 */
function crossTurnMix(useAttribute) {
  let singleKeys = 0, multiKeys = 0, singleOccurrences = 0, multiOccurrences = 0;
  for (const c of perCase) {
    const map = new Map();
    for (const r of c.rows) {
      const key = useAttribute && r.attribute ? factKeyOf(r.subject, r.predicate, r.attribute) : factKeyOf(r.subject, r.predicate);
      const arr = map.get(key) ?? [];
      arr.push(r);
      map.set(key, arr);
    }
    for (const arr of map.values()) {
      if (new Set(arr.map((x) => x.turnId)).size < 2) continue;
      if (arr.some((x) => x.cardinality === "single")) {
        singleKeys += 1;
        singleOccurrences += arr.length;
      } else {
        multiKeys += 1;
        multiOccurrences += arr.length;
      }
    }
  }
  return { singleKeys, multiKeys, singleOccurrences, multiOccurrences, totalKeys: singleKeys + multiKeys, singleKeyShare: singleKeys / (singleKeys + multiKeys || 1) };
}
const v3Mix = crossTurnMix(false);
const v4Mix = crossTurnMix(true);

/**
 * 题内口径（配对读数用）：每 case 独立算「跨 ≥2 turn 的键 / 不同键」，再分别给
 * micro（全题合并的键数加权）与 macro（各题 rate 的算术平均）。
 * 全局池化会把不同 case 的同名属性并成一个键，只适合与 §22 的旧口径对齐，
 * 不能单独当作「同一记忆内的重复」；两口径都出，避免拿错尺子。
 */
function perCaseKeyStats(useAttribute, { singleOnly = false, requireAttribute = false } = {}) {
  let sumDistinct = 0, sumCross = 0, sumRate = 0;
  for (const c of perCase) {
    const map = new Map();
    for (const r of c.rows) {
      if (singleOnly && r.cardinality !== "single") continue;
      if (requireAttribute && !r.attribute) continue;
      const key = useAttribute && r.attribute ? factKeyOf(r.subject, r.predicate, r.attribute) : factKeyOf(r.subject, r.predicate);
      const arr = map.get(key) ?? [];
      arr.push(r);
      map.set(key, arr);
    }
    let cross = 0;
    for (const arr of map.values()) if (new Set(arr.map((x) => x.turnId)).size >= 2) cross += 1;
    sumDistinct += map.size;
    sumCross += cross;
    sumRate += map.size ? cross / map.size : 0;
  }
  return {
    distinctKeys: sumDistinct,
    crossTurnKeys: sumCross,
    microRate: sumDistinct ? sumCross / sumDistinct : 0,
    macroRate: perCase.length ? sumRate / perCase.length : 0,
  };
}

const v3Case = perCaseKeyStats(false);
const v4Case = perCaseKeyStats(true);
// 失效只发生在 single 行上：multi 同键共存本来就不触发失效。
// 所以 additionally 出「只统计解析后 single 行」的题内重复率——这是「可失效触发面」的诚实分母。
// requireAttribute 版单独看「attribute 且 single」的键命中率，用来说明 attribute 自身的键收敛效果，
// 不能拿它冒充整库收益。
const v3Single = perCaseKeyStats(false, { singleOnly: true });
const v4Single = perCaseKeyStats(true, { singleOnly: true });
const v4SingleAttr = perCaseKeyStats(true, { singleOnly: true, requireAttribute: true });

// attribute 分布（按 canonical 名）
const dist = new Map();
for (const c of perCase) for (const r of c.rows) {
  if (!r.attribute) continue;
  const d = dist.get(r.attribute) ?? {
    attribute: r.attribute,
    count: 0,
    cardinality: attributeCardinalityOf(r.attribute),
    cases: new Set(),
    observed: { single: 0, multi: 0, unspecified: 0 },
  };
  d.count += 1;
  d.cases.add(c.caseId);
  d.observed[r.rawCardinality === "single" || r.rawCardinality === "multi" ? r.rawCardinality : "unspecified"] += 1;
  dist.set(r.attribute, d);
}
const distribution = [...dist.values()]
  .map((d) => ({
    attribute: d.attribute,
    count: d.count,
    share: withAttr ? d.count / withAttr : 0,
    cardinality: d.cardinality,
    cases: d.cases.size,
    observed: d.observed,
  }))
  .sort((a, b) => b.count - a.count || a.attribute.localeCompare(b.attribute));
// 词表侧对照：哪些 canonical 名在语料里从未被抽出（top-N 表的另一面）。
const observedNames = new Set(distribution.map((d) => d.attribute));
const unobservedAttributes = FACT_ATTRIBUTES.map((a) => a.name).filter((n) => !observedNames.has(n));

// KU 切片：裁决为 single 且同键跨轮的具体清单（供人工抽样）。
// 注意：这里必须收「解析后 single」的全部行——含没有 attribute、靠显式标注/谓词启发式判 single 的行，
// 否则会把团队人数这类真单值更新链漏掉，低估触发面。
const kuRows = [];
for (const c of perCase) {
  if (c.type !== "knowledge-update") continue;
  for (const r of c.rows) if (r.cardinality === "single") kuRows.push({ caseId: c.caseId, ...r });
}
const kuKeyMap = new Map();
for (const r of kuRows) {
  // 题内口径：键按 caseId 隔离——跨 case 的同名属性不可能是同一条记忆的更新链。
  const key = r.caseId + "\u0000" + factKeyOf(r.subject, r.predicate, r.attribute);
  const arr = kuKeyMap.get(key) ?? [];
  arr.push(r);
  kuKeyMap.set(key, arr);
}
const kuSingleCrossTurn = [...kuKeyMap.entries()]
  .filter(([, arr]) => new Set(arr.map((x) => x.turnId)).size >= 2)
  .map(([key, arr]) => ({
    key: key.split("\u0000")[1] ?? key,
    attribute: arr[0].attribute ?? null,
    caseId: arr[0].caseId,
    distinctValues: new Set(arr.map((x) => String(x.value).trim().toLowerCase())).size,
    occurrences: arr.map((x) => ({ turnId: x.turnId, subject: x.subject, predicate: x.predicate, value: x.value })),
  }));

// KU 总体（含 multi）对照：旧键口径 vs 属性键口径
const kuCases = perCase.filter((c) => c.type === "knowledge-update");
function kuStats(useAttribute) {
  const keyMap = new Map();
  for (const c of kuCases) for (const r of c.rows) {
    // 题内口径（与 #146 §22.3 的「KU 切片触发面」一致）：键按 caseId 隔离。
    const base = useAttribute && r.attribute ? factKeyOf(r.subject, r.predicate, r.attribute) : factKeyOf(r.subject, r.predicate);
    const key = c.caseId + "\u0000" + base;
    const arr = keyMap.get(key) ?? [];
    arr.push(r);
    keyMap.set(key, arr);
  }
  let cross = 0, multiVal = 0;
  for (const arr of keyMap.values()) {
    if (new Set(arr.map((x) => x.turnId)).size >= 2) {
      cross += 1;
      const vals = new Set(arr.map((x) => String(x.value).trim().toLowerCase()));
      if (vals.size >= 2) multiVal += 1;
    }
  }
  return { distinctKeys: keyMap.size, crossTurnKeys: cross, crossTurnRate: keyMap.size ? cross / keyMap.size : 0, crossTurnWithMultiValues: multiVal };
}

// KU 上「显式 single 但被 multi 属性压成 multi」的触发面：量化词表把多少条旧链改判成 multi。
// 这不是要恢复的行为（multi 属性不失效是正确性），而是给「v3 的 16 条 single 触发面去哪了」一个可核对的数字。
const kuExplicitSingle = [];
for (const c of kuCases) for (const r of c.rows) {
  if (r.rawCardinality === "single" && r.attribute && r.cardinality === "multi") kuExplicitSingle.push({ caseId: c.caseId, ...r });
}
const kuExplicitMap = new Map();
for (const r of kuExplicitSingle) {
  const key = r.caseId + "\u0000" + factKeyOf(r.subject, r.predicate);
  const arr = kuExplicitMap.get(key) ?? [];
  arr.push(r);
  kuExplicitMap.set(key, arr);
}
const kuExplicitSlots = [...kuExplicitMap.entries()]
  .filter(([, arr]) => new Set(arr.map((x) => x.turnId)).size >= 2 && new Set(arr.map((x) => String(x.value).trim().toLowerCase())).size >= 2)
  .map(([key, arr]) => ({
    key: key.split("\u0000")[1] ?? key,
    caseId: arr[0].caseId,
    attribute: arr[0].attribute,
    predicate: arr[0].predicate,
    occurrences: arr.map((x) => ({ turnId: x.turnId, value: x.value })),
  }));

const report = {
  generatedAt: new Date().toISOString(),
  cache: path.relative(repo, cacheDir),
  dataset: path.relative(repo, datasetPath),
  cases: perCase.length,
  turns: turnsTotal,
  triples: triplesTotal,
  attributeCoverage: triplesTotal ? withAttr / triplesTotal : 0,
  attributeTriples: withAttr,
  distribution,
  observedAttributes: distribution.length,
  unobservedAttributes,
  attributeCardinalityAgreement: (() => {
    let explicit = 0, agree = 0;
    for (const c of perCase) for (const r of c.rows) {
      if (!r.attribute) continue;
      if (r.rawCardinality !== "single" && r.rawCardinality !== "multi") continue;
      explicit += 1;
      if (r.rawCardinality === r.cardinality) agree += 1;
    }
    return { explicit, agree, rate: explicit ? agree / explicit : null };
  })(),
  keyStats: { v3LegacyKey: v3, v4AttributeKey: v4, v3LegacyKeyPerCase: v3Case, v4AttributeKeyPerCase: v4Case },
  crossTurnMix: { v3LegacyKey: v3Mix, v4AttributeKey: v4Mix },
  perCaseSingleOnly: { v3LegacyKey: v3Single, v4AttributeKey: v4Single, v4AttributeSingle: v4SingleAttr },
  kuSlots: {
    total: kuSingleCrossTurn.length,
    distinctValueSlots: kuSingleCrossTurn.filter((s) => s.distinctValues >= 2).length,
    repeatedValueOnly: kuSingleCrossTurn.filter((s) => s.distinctValues < 2).length,
  },
  ku: {
    cases: kuCases.length,
    triples: kuCases.reduce((n, c) => n + c.rows.length, 0),
    singleTriples: kuRows.length,
    singleAttributeTriples: kuRows.filter((r) => r.attribute).length,
    legacyKey: kuStats(false),
    attributeKey: kuStats(true),
    singleCrossTurnSlots: kuSingleCrossTurn,
    suppressedSingleUnderMultiAttr: { triples: kuExplicitSingle.length, slots: kuExplicitSlots },
  },
};

if (outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n");
}

console.log(JSON.stringify({
  cases: report.cases, turns: report.turns, triples: report.triples,
  attributeTriples: report.attributeTriples, attributeCoverage: report.attributeCoverage,
  topAttributes: distribution.slice(0, 15),
  vocabularySize: FACT_ATTRIBUTES.length,
  observedAttributes: report.observedAttributes,
  unobservedAttributes: report.unobservedAttributes,
  attributeCardinalityAgreement: report.attributeCardinalityAgreement,
  keyStats: report.keyStats,
  perCase: {
    v3LegacyKey: v3Case,
    v4AttributeKey: v4Case,
    singleOnly: { v3LegacyKey: v3Single, v4AttributeKey: v4Single, v4AttributeSingle: v4SingleAttr },
  },
  kuSlots: {
    total: kuSingleCrossTurn.length,
    distinctValueSlots: kuSingleCrossTurn.filter((s) => s.distinctValues >= 2).length,
    repeatedValueOnly: kuSingleCrossTurn.filter((s) => s.distinctValues < 2).length,
  },
  ku: { cases: report.ku.cases, triples: report.ku.triples, singleTriples: report.ku.singleTriples,
    singleAttributeTriples: report.ku.singleAttributeTriples, legacyKey: report.ku.legacyKey, attributeKey: report.ku.attributeKey, singleCrossTurnSlotCount: kuSingleCrossTurn.length },
  out: outPath ? path.relative(repo, outPath) : null,
}, null, 2));
