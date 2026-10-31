/**
 * #168 长会话多值更新场景生成器（纯函数：零网络、零写盘、确定性可复现）。
 *
 * 目的（issue #168 / docs/optimization-results.md §26.4 差距①）：
 *   现有 LME/LoCoMo 语料里「同一实体的同一属性被反复更新」的样本太少，写侧固化开关
 *   （write.factKey / write.supersession / consolidation）的收益与代价无法量化。这里生成
 *   30-50 条同实体多值更新序列（每条 20-60 轮、5-10 次同属性更新），并自带**确定性 ground truth**
 *   （每条更新 = (entity, attribute, value, ts)），因此：
 *     - 不需要 LLM 抽取即可拿到三元组（离线 arm 跑法的前提）；
 *     - 判分不依赖 LLM judge（gold 是生成时就知道的字面值）——度量口径无「判分器混用」风险。
 *
 * 语义约定（与生产写侧口径对齐）：
 *   - 每条更新单独占一个 session（时间戳互不相同），避免 valid_end 并列导致「同一时刻既失效又有效」；
 *   - 更新轮的内容只含「实体 + 属性 + 新值」，不复述旧值（否则旧值字面会污染召回块，
 *     把「旧值注入率」算成假阳性）；
 *   - 属性族对齐 src/core/record/fact-attribute.ts 的封闭词表（address/residence/age/
 *     occupation/marital_status）或 #136 的 single 谓词线索（粉丝数/预算/体重/负责人），
 *     保证 computeSupersessions 的基数判定是 single（可失效），而不是 multi（additive）。
 *
 * 本模块只产出数据；写库、召回、判分在 scripts/gen-long-session-bench.mjs。
 */

export const LONG_SESSION_SCHEMA_VERSION = 1;

/** 确定性 PRNG（mulberry32）：同 seed 同参数 → 同语料，跨机器可复现。 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PROJECTS = ["星火", "北极星", "潮汐", "长河", "天穹", "萤火", "山海", "归墟", "白鹭", "青岚"];
const PEOPLE = ["张伟", "李娜", "王强", "陈静", "刘洋", "赵磊", "孙芳", "周涛", "吴敏", "郑凯", "冯雪", "何川"];
const CITIES = ["上海", "杭州", "成都", "南京", "武汉", "西安", "苏州", "厦门", "长沙", "青岛", "合肥", "宁波"];
const ACCOUNTS = ["星野摄影", "老周说车", "山间茶事", "夜航手记", "小满食堂", "方格笔记", "远山实验室"];

/**
 * 属性族：attribute 走封闭词表（#167），无词表项的属性靠 #136 的 single 谓词线索。
 * value(i, rnd) 必须保证同一 case 内唯一（i = 第几次更新，从 0 起）。
 */
export const ATTRIBUTE_FAMILIES = [
  {
    key: "owner",
    label: "负责人",
    subjectKind: "project",
    predicate: "负责人",
    attribute: undefined,
    value: (i) => PEOPLE[i % PEOPLE.length],
  },
  {
    key: "address",
    label: "住址",
    subjectKind: "person",
    predicate: "住址",
    attribute: "address",
    value: (i) => `北京市朝阳区望京街 ${10 + i * 7} 号院 ${i + 1} 号楼`,
  },
  {
    key: "fans",
    label: "粉丝数",
    subjectKind: "account",
    predicate: "粉丝数",
    attribute: undefined,
    value: (i) => String(430 + (i + 1) * 137),
  },
  {
    key: "budget",
    label: "预算",
    subjectKind: "project",
    predicate: "预算",
    attribute: undefined,
    value: (i) => `${120 + (i + 1) * 35} 万元`,
  },
  {
    key: "weight",
    label: "体重",
    subjectKind: "person",
    predicate: "体重",
    attribute: undefined,
    value: (i) => `${(62 + i * 0.8).toFixed(1)} 公斤`,
  },
  {
    key: "residence",
    label: "常住城市",
    subjectKind: "person",
    predicate: "常住城市",
    attribute: "residence",
    value: (i) => CITIES[i % CITIES.length],
  },
];

const FILLER_TEMPLATES = [
  (s) => `${s}这周的例会照常，进度下周再对。`,
  (s) => `${s}今天把材料过了一遍，暂时没有阻塞。`,
  (s) => `${s}的评审会挪到了下周一。`,
  (s) => `${s}那边反馈说环境已经准备好了。`,
  (s) => `${s}这周主要在收尾，细节下次同步。`,
  (s) => `${s}的文档还差最后一节。`,
  (s) => `${s}例会改成了线上。`,
];

function pad2(n) {
  return String(n).padStart(2, "0");
}

/** 第 i 个 session 的墙钟时间：从 2024-01-04 09:00 起，每次更新间隔 9-21 天。 */
// 注意：dayStep 必须由调用方在一条 case 内固定（见 generateCase），否则 session 日期会
// 随会话序号抖动，导致「按 ordinal 的最后一次更新」不是时间上最后一次 —— supersession 会
// 按时间正确失效掉「gold」，度量的当前值命中率就变成假读数。
function sessionDateFor(i, dayStep) {
  const d = new Date(Date.UTC(2024, 0, 4 + i * dayStep, 9, 0, 0));
  return {
    iso: `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}T09:00:00`,
    human: `${d.getUTCFullYear()}年${pad2(d.getUTCMonth() + 1)}月${pad2(d.getUTCDate())}日`,
    lme: `${d.getUTCFullYear()}/${pad2(d.getUTCMonth() + 1)}/${pad2(d.getUTCDate())} (Mon) 09:00`,
  };
}

function entityOf(kind, rnd) {
  if (kind === "project") return `项目${PROJECTS[Math.floor(rnd() * PROJECTS.length)]}`;
  if (kind === "account") return `账号${ACCOUNTS[Math.floor(rnd() * ACCOUNTS.length)]}`;
  const name = PEOPLE[Math.floor(rnd() * PEOPLE.length)];
  return `用户${name}`;
}

/**
 * 生成一条 case（一个实体、一个属性、k 次更新、n 轮）。
 *
 * @param {number} index   case 序号（0 起）
 * @param {object} opts    { seed, turnsMin, turnsMax, updatesMin, updatesMax, fillerTurnsMin, fillerTurnsMax }
 * @returns {object} case
 */
export function generateCase(index, opts = {}) {
  const seed = (opts.seed ?? 20261031) >>> 0;
  const rnd = mulberry32(seed + 7919 * (index + 1));
  const turnsMin = opts.turnsMin ?? 20;
  const turnsMax = opts.turnsMax ?? 60;
  const updatesMin = opts.updatesMin ?? 5;
  const updatesMax = opts.updatesMax ?? 10;
  const caseId = `ls-${seed.toString(36)}-${String(index + 1).padStart(2, "0")}`;

  const family = ATTRIBUTE_FAMILIES[(index + Math.floor(rnd() * ATTRIBUTE_FAMILIES.length)) % ATTRIBUTE_FAMILIES.length];
  const entity = entityOf(family.subjectKind, rnd);
  const k = updatesMin + Math.floor(rnd() * (updatesMax - updatesMin + 1));
  const perSessionMin = opts.fillerTurnsMin ?? 3;
  const perSessionMax = opts.fillerTurnsMax ?? 6;

  // 每条 case 内 session 日期间隔固定 ⇒ 日期随更新序号严格递增（时间线单调）。
  const dayStep = 9 + Math.floor(rnd() * 13);
  const updates = [];
  const groups = [];
  let turnSeq = 0;
  for (let u = 0; u < k; u++) {
    const sessionIdx = u + 1;
    const date = sessionDateFor(u, dayStep);
    const value = family.value(u, rnd);
    const fillerCount = perSessionMin + Math.floor(rnd() * (perSessionMax - perSessionMin + 1));
    const turns = [];
    // 更新轮插在 session 中部（前后都有 filler），更像自然对话。
    const updatePos = Math.floor(rnd() * (fillerCount + 1));
    for (let t = 0; t < fillerCount + 1; t++) {
      turnSeq++;
      const id = `${caseId}-s${sessionIdx}-t${t + 1}`;
      const isUpdate = t === updatePos;
      const text = isUpdate
        ? `${entity} 的${family.label}现在更新为${value}。`
        : FILLER_TEMPLATES[Math.floor(rnd() * FILLER_TEMPLATES.length)](`${entity}的${u + 1}号事项`);
      turns.push({
        id,
        role: t % 2 === 0 ? "user" : "assistant",
        speaker: t % 2 === 0 ? "User" : "Assistant",
        text,
        tsISO: date.iso,
        ...(isUpdate ? { updateOrdinal: u + 1, updateValue: value, updateAttribute: family.key } : {}),
      });
      if (isUpdate) {
        updates.push({
          ordinal: u + 1,
          turnId: id,
          sessionId: `${caseId}-s${sessionIdx}`,
          value,
          prev: u === 0 ? null : updates[u - 1]?.value ?? null,
          tsISO: date.iso,
          humanDate: date.human,
        });
      }
    }
    groups.push({ sessionId: `${caseId}-s${sessionIdx}`, dateISO: date.iso, dateLme: date.lme, turns });
  }

  // 尾部补一个「没有更新」的收尾 session：让 current 问题的时间点在最后一次更新之后，
  // 同时避免「最后一条就是更新轮」导致 valid_end 与 questionDate 相等（并列边界）。
  const tailDate = sessionDateFor(k, dayStep);
  const tailTurns = [];
  const tailCount = Math.max(perSessionMin, 4);
  for (let t = 0; t < tailCount; t++) {
    turnSeq++;
    tailTurns.push({
      id: `${caseId}-s${k + 1}-t${t + 1}`,
      role: t % 2 === 0 ? "user" : "assistant",
      speaker: t % 2 === 0 ? "User" : "Assistant",
      text: FILLER_TEMPLATES[Math.floor(rnd() * FILLER_TEMPLATES.length)](`${entity}的收尾事项`),
      tsISO: tailDate.iso,
    });
  }
  groups.push({ sessionId: `${caseId}-s${k + 1}`, dateISO: tailDate.iso, dateLme: tailDate.lme, turns: tailTurns });

  // 轮数收紧：目标区间 [turnsMin, turnsMax] —— 通过对 session 内 filler 做裁剪/补齐实现。
  const total = groups.reduce((n, g) => n + g.turns.length, 0);
  if (total > turnsMax) {
    const need = total - turnsMax;
    let drop = need;
    for (let gi = groups.length - 1; gi >= 0 && drop > 0; gi--) {
      const g = groups[gi];
      while (drop > 0 && g.turns.length > (gi === groups.length - 1 ? 2 : 2)) {
        const removed = g.turns.pop();
        drop--;
        if (removed?.updateOrdinal) {
          // 不裁更新轮：放回并跳过该 session（更新轮是 ground truth）。
          g.turns.push(removed);
          break;
        }
      }
    }
  } else if (total < turnsMin) {
    // 补 filler（只补尾部 session）：保证下限与可复现性。
    const g = groups[groups.length - 1];
    let add = turnsMin - total;
    while (add > 0) {
      const t = g.turns.length + 1;
      g.turns.push({
        id: `${caseId}-s${k + 1}-t${t}`,
        role: "user",
        speaker: "User",
        text: FILLER_TEMPLATES[add % FILLER_TEMPLATES.length](`${entity}的收尾事项`),
        tsISO: tailDate.iso,
      });
      add--;
    }
  }

  const questions = buildQuestions({ caseId, entity, family, updates, tailDate, groups });

  return {
    caseId,
    tenant: { team_id: "bench-ls", user_id: caseId, agent_id: "bench-agt" },
    entity,
    attribute: {
      key: family.key,
      label: family.label,
      predicate: family.predicate,
      ...(family.attribute ? { attribute: family.attribute } : {}),
    },
    updates,
    groups,
    questions,
    turnCount: groups.reduce((n, g) => n + g.turns.length, 0),
    meta: { seed, index, family: family.key, updates: k },
  };
}

/** 每题两类：问当下（gold=最后一次更新值）、问历史（gold=第 j 次更新当时的值）。 */
function buildQuestions({ caseId, entity, family, updates, tailDate, groups }) {
  const qs = [];
  const latest = updates[updates.length - 1];
  const allValues = updates.map((u) => u.value);
  const stale = allValues.slice(0, -1);

  qs.push({
    qid: `${caseId}-q-current`,
    kind: "current",
    question: `现在${entity}的${family.label}是什么？`,
    questionDateISO: tailDate.iso,
    gold: latest.value,
    goldOrdinal: latest.ordinal,
    staleValues: stale,
    position: "late",
    askedTurnIndex: groups.reduce((n, g) => n + g.turns.length, 0),
  });

  // 历史问题取中间偏早的更新（避开最后一次，才有「旧值仍可召回」的含义）。
  const j = Math.max(0, Math.floor((updates.length - 1) / 2) - 1);
  const target = updates[j];
  const next = updates[j + 1];
  qs.push({
    qid: `${caseId}-q-history`,
    kind: "history",
    question: `在${target.humanDate}的时候，${entity}的${family.label}是什么？`,
    // 问「当时」，validityNow = 该值成为当前值的那天；next 的失效时刻严格更晚，边界干净。
    questionDateISO: target.tsISO,
    gold: target.value,
    goldOrdinal: target.ordinal,
    staleValues: [next?.value, ...allValues.slice(j + 2)].filter(Boolean),
    position: j < updates.length / 3 ? "early" : j < (2 * updates.length) / 3 ? "mid" : "late",
    askedTurnIndex: countTurnsBefore(groups, target.tsISO),
  });
  return qs;
}

function countTurnsBefore(groups, tsISO) {
  let n = 0;
  for (const g of groups) {
    if (g.dateISO < tsISO) n += g.turns.length;
  }
  return n;
}

/**
 * 生成整批语料 + 写侧事实（三元组）+ 判分金标。
 *
 * @returns {{schemaVersion:number, seed:number, options:object, cases:object[], factsByCase:object}}
 */
export function generateLongSessionCorpus(opts = {}) {
  const cases = opts.cases ?? 40;
  const seed = (opts.seed ?? 20261031) >>> 0;
  const out = [];
  const factsByCase = {};
  for (let i = 0; i < cases; i++) {
    const c = generateCase(i, { ...opts, seed });
    out.push(c);
    factsByCase[c.caseId] = factsForCase(c);
  }
  return { schemaVersion: LONG_SESSION_SCHEMA_VERSION, seed, options: { ...opts, cases, seed }, cases: out, factsByCase };
}

/**
 * 写侧事实 sidecar：turnId → { phrases, triples }。
 *
 * 这是「离线 arm」的前提：bench 的 --write-supersede 需要 LLM 抽取事实，而本语料的
 * ground truth 本来就是 (entity, attribute, value)，无需 LLM 即可喂给
 * src/core/record/supersession.ts 的同一实现（computeSupersessions）。
 */
export function factsForCase(c) {
  const byTurn = {};
  for (const u of c.updates) {
    byTurn[u.turnId] = {
      phrases: [`${c.entity} 的${c.attribute.label}是 ${u.value}`],
      triples: [
        {
          subject: c.entity,
          predicate: c.attribute.predicate,
          value: u.value,
          ...(c.attribute.attribute ? { attribute: c.attribute.attribute } : {}),
        },
      ],
    };
  }
  return byTurn;
}

/**
 * 转 LongMemEval-oracle 形状（一问一条），使 scripts/eval-memory-bench.mjs
 * 能直接 --dataset longmemeval --data-path <file> 消费（带写步骤档，无需 --no-write-steps）。
 * 这是「生成器能在现有 bench 里跑通」的互操作证明；本 runner 自己走 in-memory 路径。
 */
export function toLongMemEvalOracle(corpus) {
  const items = [];
  for (const c of corpus.cases) {
    for (const q of c.questions) {
      const sessionIds = c.groups.map((g) => g.sessionId);
      const answerSessions = new Set();
      const targetTurn = c.updates.find((u) => u.ordinal === q.goldOrdinal);
      for (const g of c.groups) {
        if (g.turns.some((t) => t.id === targetTurn?.turnId)) answerSessions.add(g.sessionId);
      }
      items.push({
        question_id: q.qid,
        question_type: q.kind === "current" ? "knowledge-update" : "temporal-reasoning",
        question: q.question,
        answer: q.gold,
        question_date: dateLmeOf(c, q.questionDateISO),
        haystack_sessions: c.groups.map((g) =>
          g.turns.map((t) => ({ role: t.role, content: t.text, ...(t.id === targetTurn?.turnId ? { has_answer: true } : {}) })),
        ),
        haystack_session_ids: sessionIds,
        haystack_dates: c.groups.map((g) => g.dateLme),
        answer_session_ids: [...answerSessions],
      });
    }
  }
  return items;
}

function dateLmeOf(c, iso) {
  for (const g of c.groups) if (g.dateISO === iso) return g.dateLme;
  const m = String(iso ?? "").match(/^(d{4})-(d{2})-(d{2})T(d{2}):(d{2})/);
  return m ? `${m[1]}/${m[2]}/${m[3]} (Mon) ${m[4]}:${m[5]}` : "";
}

/** 语料概览（CLI dry-run 与报告头用）。 */
export function summarizeCorpus(corpus) {
  const turns = corpus.cases.reduce((n, c) => n + c.turnCount, 0);
  const updates = corpus.cases.reduce((n, c) => n + c.updates.length, 0);
  const byFamily = {};
  for (const c of corpus.cases) byFamily[c.attribute.key] = (byFamily[c.attribute.key] || 0) + 1;
  const sizes = corpus.cases.map((c) => c.turnCount);
  return {
    cases: corpus.cases.length,
    turns,
    updates,
    questions: corpus.cases.reduce((n, c) => n + c.questions.length, 0),
    turnsPerCase: {
      min: sizes.length ? Math.min(...sizes) : 0,
      max: sizes.length ? Math.max(...sizes) : 0,
      mean: sizes.length ? Math.round((turns / sizes.length) * 10) / 10 : 0,
    },
    updatesPerCase: {
      min: Math.min(...corpus.cases.map((c) => c.updates.length)),
      max: Math.max(...corpus.cases.map((c) => c.updates.length)),
    },
    byFamily,
  };
}
