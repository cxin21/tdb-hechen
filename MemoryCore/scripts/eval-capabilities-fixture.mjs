// eval-capabilities-fixture.mjs — P1 Task 1：构造式验收 fixture 语料模块
//
// 目标：为记忆系统能力验收（Task 2 评估脚本 import 本模块）提供确定性的
// 语料 + 期望。两条确定性道：
//   1. buildFixtures(themeIndex) → { records, expectations }：纯数据构造，
//      records 为 MemoryRecord 形状（l1-writer.ts 接口），expectations 描述
//      时间探针 / 会话探针 / 更新探针 / 噪声查询四类验收点。
//   2. seedStore(store, records) → 逐条 store.upsertL1(record, undefined)。
//      embedding 传 undefined = BM25-only 确定性道（sqlite.ts upsertL1 对
//      undefined embedding 只写 metadata+FTS，不写 vec0，不依赖 embedding 服务）。
//
// 设计约定：
//   - 不 import 任何运行时依赖（node:sqlite 由调用方 store 承载），零 npm 依赖。
//   - 主题包可轮换：THEME_PACKS[0]=部署迁移（主包）、[1]=观测告警（同构换域词）。
//   - 所有 id 确定性生成（fx{theme}-…），updateProbe.newId/oldId 可直接反查。
//   - soul 字段逐位按任务书：certainty="observed", significance=0.6,
//     valence=0, arousal=0.3, source="fixture", type="episodic",
//     occurred_at=T(m,d)，metadata 缺省 "{}"（冲突对写 subject）。

/** 2026 年 m 月 d 日 10:00（UTC ISO）——任务书逐字工具。 */
const T = (m, d) => `2026-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}T10:00:00.000Z`;

/** 单条 MemoryRecord 构造（补齐 l1-writer.ts MemoryRecord 必填 + soul 字段）。 */
function mkRecord({ id, content, occurredAt, sessionId, metadata }) {
  return {
    id,
    content,
    type: "episodic",
    priority: 50,
    scene_name: "fixture",
    source_message_ids: [],
    metadata: metadata ?? {},
    timestamps: [occurredAt],
    createdAt: occurredAt,
    updatedAt: occurredAt,
    version: 1,
    sessionKey: sessionId,
    sessionId,
    // ── soul 字段（任务书逐位）──
    occurred_at: occurredAt,
    certainty: "observed",
    source: "fixture",
    valence: 0,
    arousal: 0.3,
    significance: 0.6,
  };
}

/**
 * 主题包定义。
 * 每包固定结构：timeSpread 12 条（8 条逐字 + 4 条补位，月份 2-9），
 * conflictPairs 3 组 old→new 同 subject，multiSession 4 session × 2 条，
 * noise 10 条与全部 query 无词面/语义交集（花卉养护、菜谱、星座）。
 * 期望字段（timeQueries/windowMonths/sessionQuery/minSessions/updateQuery/
 * noiseQueries）随包给出，供 buildFixtures 组装 expectations。
 */
const THEME_PACKS = [
  {
    domain: "部署迁移",
    timeSpread: [ // 12 条，跨 2-9 月，每条 occurred_at 唯一月
      { content: "2月完成旧版向量库选型对比记录", occurred_at: T(2, 12) },
      { content: "3月敲定 sqlite-vec 作为本地向量引擎", occurred_at: T(3, 15) },
      { content: "4月完成 BM25 中文分词接入", occurred_at: T(4, 20) },
      { content: "5月梳理租户隔离三元组方案", occurred_at: T(5, 11) },
      { content: "6月部署第一版记忆网关", occurred_at: T(6, 8) },
      { content: "7月完成召回分层预算切分", occurred_at: T(7, 19) },
      { content: "8月上线价值锚自发现流水线", occurred_at: T(8, 23) },
      { content: "9月初完成云端部署与验证", occurred_at: T(9, 3) },
      // 另 4 条同格式分散在 3/5/6/8 月，主题各异
      { content: "3月补充本地向量库性能基准测试记录", occurred_at: T(3, 26) },
      { content: "5月补充多租户配额评审记录", occurred_at: T(5, 27) },
      { content: "6月补充灰度发布演练记录", occurred_at: T(6, 17) },
      { content: "8月补充容量压测复盘记录", occurred_at: T(8, 9) },
    ],
    conflictPairs: [ // 3 组：old → new 同 subject，new 更晚
      { old: { content: "服务部署在阿里云杭州", occurred_at: T(4, 1) },
        new: { content: "服务已整体迁移到腾讯云上海", occurred_at: T(8, 1) } },
      // 2 组同构（数据库引擎更换 / 主模型更换）
      { old: { content: "数据库引擎使用 MySQL 8.0", occurred_at: T(3, 5) },
        new: { content: "数据库引擎已更换为 PostgreSQL 16", occurred_at: T(7, 2) } },
      { old: { content: "对话主模型使用 GPT-4o", occurred_at: T(5, 9) },
        new: { content: "对话主模型已更换为 DeepSeek-V3", occurred_at: T(9, 1) } },
    ],
    multiSession: [ // 4 个 session × 2 条，同主题"数据库选型"
      { session: "sess-db-1", items: ["数据库选型第一轮讨论记录", "数据库选型补充了延迟数据"] },
      { session: "sess-db-2", items: ["数据库选型第二轮引入成本维度", "数据库选型最终结论归档"] },
      // sess-db-3 / sess-db-4 同构
      { session: "sess-db-3", items: ["数据库选型第三轮压测对比记录", "数据库选型回归验证完成"] },
      { session: "sess-db-4", items: ["数据库选型跨团队评审意见汇总", "数据库选型评审结论达成一致"] },
    ],
    noise: [ /* 10 条与全部 query 无词面/语义交集的内容：花卉养护、菜谱、星座 */
      "多肉植物夏季养护要控制浇水频率",
      "绿萝适合放在散射光通风的窗台",
      "红烧排骨焯水后要炒糖色再炖四十分钟",
      "清蒸鲈鱼旺火八分钟淋热油提香",
      "双子座本周末适合整理旧物断舍离",
      "摩羯座月初容易在通勤路上遇到老朋友",
      "栀子花黄叶多是土壤偏碱导致",
      "家庭版咖喱鸡肉炖土豆要收汁到浓稠",
      "天蝎座近期适合把搁置的计划重新捡起来",
      "阳台种小葱用浅盆每隔三天浇透一次",
    ],
    // ── 期望字段 ──
    timeQueries: ["向量库选型对比", "BM25 中文分词接入", "记忆网关部署", "召回分层预算切分"],
    windowMonths: 2,
    sessionQuery: "数据库选型",
    minSessions: 3,
    updateQuery: "服务部署在哪个云",
    noiseQueries: ["向量库选型对比", "数据库选型最终结论", "服务部署在哪个云", "主模型更换", "BM25 中文分词"],
  },
  // THEME_PACKS[1] 同构，领域词全换
  {
    domain: "观测告警",
    timeSpread: [ // 12 条，跨 2-9 月，每条 occurred_at 唯一月
      { content: "2月完成监控指标体系选型对比记录", occurred_at: T(2, 12) },
      { content: "3月敲定 Prometheus 作为本地指标采集引擎", occurred_at: T(3, 15) },
      { content: "4月完成日志结构化解析接入", occurred_at: T(4, 20) },
      { content: "5月梳理告警分级路由方案", occurred_at: T(5, 11) },
      { content: "6月部署第一版告警网关", occurred_at: T(6, 8) },
      { content: "7月完成告警降噪预算切分", occurred_at: T(7, 19) },
      { content: "8月上线值班排班自动生成流水线", occurred_at: T(8, 23) },
      { content: "9月初完成全链路观测验收", occurred_at: T(9, 3) },
      { content: "3月补充仪表盘模板整理记录", occurred_at: T(3, 26) },
      { content: "5月补充 SLO 目标定义评审记录", occurred_at: T(5, 27) },
      { content: "6月补充慢查询追踪专项记录", occurred_at: T(6, 17) },
      { content: "8月补充容量水位复盘记录", occurred_at: T(8, 9) },
    ],
    conflictPairs: [ // 3 组：old → new 同 subject，new 更晚
      { old: { content: "告警通知走短信通道", occurred_at: T(4, 1) },
        new: { content: "告警通知已整体切换到企业微信机器人", occurred_at: T(8, 1) } },
      { old: { content: "指标存储使用 MySQL 8.0", occurred_at: T(3, 5) },
        new: { content: "指标存储已更换为 VictoriaMetrics", occurred_at: T(7, 2) } },
      { old: { content: "值班摘要使用规则引擎", occurred_at: T(5, 9) },
        new: { content: "值班摘要已更换为 LLM 智能生成", occurred_at: T(9, 1) } },
    ],
    multiSession: [ // 4 个 session × 2 条，同主题"告警降噪"
      { session: "sess-alert-1", items: ["告警降噪第一轮讨论记录", "告警降噪补充了误报率数据"] },
      { session: "sess-alert-2", items: ["告警降噪第二轮引入分级维度", "告警降噪最终结论归档"] },
      { session: "sess-alert-3", items: ["告警降噪第三轮压测对比记录", "告警降噪回归验证完成"] },
      { session: "sess-alert-4", items: ["告警降噪跨团队评审意见汇总", "告警降噪评审结论达成一致"] },
    ],
    noise: [ /* 10 条与全部 query 无词面/语义交集的内容：花卉养护、菜谱、星座 */
      "兰花换盆要等花后修剪根系再上苔藓",
      "薄荷耐修剪越掐尖长得越旺",
      "酸菜鱼鱼片上浆后滑油三十秒最嫩",
      "戚风蛋糕蛋白要打到干性发泡再翻拌",
      "处女座本周适合重新规划书桌收纳",
      "射手座旅行建议提前订好返程车票",
      "发财树烂根多半是盆底积水闷的",
      "台式卤肉饭要点是小火煸出洋葱酥",
      "水瓶座适合把收藏夹里落灰的教程实践一遍",
      "水培铜钱草冬天要搬到室内南窗",
    ],
    // ── 期望字段 ──
    timeQueries: ["监控指标体系选型", "日志结构化解析接入", "告警网关部署", "告警降噪预算切分"],
    windowMonths: 2,
    sessionQuery: "告警降噪",
    minSessions: 3,
    updateQuery: "告警通知走哪个渠道",
    noiseQueries: ["监控指标体系选型", "告警降噪最终结论", "告警通知走哪个渠道", "指标存储更换", "日志结构化解析"],
  },
];

/** 确定性 id：fx{theme}-<组>-<序>（updateProbe 直接引用 fx{theme}-conflict-N-{old|new}）。 */
const rid = (theme, group, i) => `fx${theme}-${group}-${String(i + 1).padStart(2, "0")}`;

/**
 * 构造一个主题包的验收语料与期望。
 * @param {number} themeIndex 主题包下标（0=部署迁移，1=观测告警）
 * @returns {{ records: Array, expectations: {
 *   timeProbe: { queries: string[], windowMonths: number },
 *   sessionProbe: { query: string, minSessions: number },
 *   updateProbe: { query: string, newId: string, oldId: string },
 *   noiseQueries: string[] } }}
 */
export function buildFixtures(themeIndex = 0) {
  const pack = THEME_PACKS[themeIndex];
  if (!pack) {
    throw new Error(`buildFixtures: 未知 themeIndex=${themeIndex}（可用 0..${THEME_PACKS.length - 1}）`);
  }
  const records = [];

  // ① 时间散布组：单 session，12 条
  pack.timeSpread.forEach((it, i) => {
    records.push(mkRecord({
      id: rid(themeIndex, "time", i),
      content: it.content,
      occurredAt: it.occurred_at,
      sessionId: `sess-fx${themeIndex}-time`,
    }));
  });

  // ② 冲突对组：每组 old/new 同 subject（写进 metadata），new 更晚；同 session
  pack.conflictPairs.forEach((pair, i) => {
    const subject = `conflict-${i + 1}`;
    records.push(mkRecord({
      id: `fx${themeIndex}-conflict-${i + 1}-old`,
      content: pair.old.content,
      occurredAt: pair.old.occurred_at,
      sessionId: `sess-fx${themeIndex}-conflict-${i + 1}`,
      metadata: { subject },
    }));
    records.push(mkRecord({
      id: `fx${themeIndex}-conflict-${i + 1}-new`,
      content: pair.new.content,
      occurredAt: pair.new.occurred_at,
      sessionId: `sess-fx${themeIndex}-conflict-${i + 1}`,
      metadata: { subject },
    }));
  });

  // ③ 多会话组：4 session × 2 条，同主题
  pack.multiSession.forEach((grp, i) => {
    grp.items.forEach((content, k) => {
      records.push(mkRecord({
        id: `fx${themeIndex}-sess-${i + 1}-${k + 1}`,
        content,
        occurredAt: T(7 + (i % 2), 5 + k * 2 + i), // 同主题条目时间就近、跨 session 交错
        sessionId: grp.session,
      }));
    });
  });

  // ④ 噪声组：与全部 query 无交集
  pack.noise.forEach((content, i) => {
    records.push(mkRecord({
      id: rid(themeIndex, "noise", i),
      content,
      occurredAt: T(2 + (i % 8), 1 + (i % 27)),
      sessionId: `sess-fx${themeIndex}-noise`,
    }));
  });

  const expectations = {
    timeProbe: { queries: pack.timeQueries, windowMonths: pack.windowMonths },
    sessionProbe: { query: pack.sessionQuery, minSessions: pack.minSessions },
    updateProbe: {
      query: pack.updateQuery,
      newId: `fx${themeIndex}-conflict-1-new`,
      oldId: `fx${themeIndex}-conflict-1-old`,
    },
    noiseQueries: pack.noiseQueries,
  };

  return { records, expectations };
}

/**
 * 把语料逐条播种进 store（BM25-only 确定性道：embedding=undefined，
 * sqlite.ts upsertL1 对 undefined 只写 metadata+FTS，不写 vec0 表）。
 * @param {object} store IMemoryStore（生产同构 VectorStore，须先 init()）
 * @param {Array} [records] 缺省 = buildFixtures(0).records
 * @returns {Promise<number>} 成功播种条数
 */
export async function seedStore(store, records) {
  const list = records ?? buildFixtures(0).records;
  for (const r of list) {
    const ok = store.upsertL1(r, undefined); // undefined embedding：BM25-only 确定性道
    if (!ok) throw new Error(`seed failed: ${r.id}`);
  }
  return list.length;
}

/** 主题包元信息（评估脚本展示/校验用）。 */
export function listThemePacks() {
  return THEME_PACKS.map((p, i) => ({
    themeIndex: i,
    domain: p.domain,
    counts: {
      timeSpread: p.timeSpread.length,
      conflictPairs: p.conflictPairs.length,
      multiSession: p.multiSession.length * p.multiSession[0].items.length,
      noise: p.noise.length,
    },
  }));
}
