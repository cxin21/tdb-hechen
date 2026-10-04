/**
 * 灵魂注入质量轮 R2（2026-10-04 何晨专项令）：记忆内容混入灵魂门（episode gate）。
 *
 * 设计依据：灵魂的内容是笼统的价值观/特质，不是具体某一件事的记忆叙述。
 * 活体实锚（sv-f8510ed0 价值锚行 10 锚）：6 锚 desc 混入具体事件特征
 * （A-7b 小节 / 探针 HTTP 200 / 提交 b1ea2e5 / D-4 种子库 / REG-REMAINING-006 / A-3·A-5 勘误），
 * 而「解决问题必须从第一性原理出发…」为合格灵魂级说明。
 *
 * 语义：高置信具体事件特征（宁漏勿错杀——只拦机器可判定的硬特征，语义级混入交生成端
 * prompt 负面清单与后续回填质量）。命中=该 desc 不是灵魂级说明：
 * - 采纳端：descRaw 命中 → coerceCoreValueAnchor 返回 null（门不过 422，pending 保留）；
 *   缺省回退产物命中 → description 置空（锚保留待合格 desc，渲染端宁缺毋滥跳过）。
 * - 渲染端：desc 命中 → 该锚整条跳过（与空 desc 同处理，禁止混事件叙述进入灵魂注入）。
 */
const EPISODE_PATTERNS: RegExp[] = [
  /\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/i, // commit hash（b1ea2e5/3d91234；须含数字防英文词误杀）
  /\b(?:REG|REF)-[A-Z]*-?\d{2,}\b/i, // 登记号（REG-REMAINING-006）
  /(?:^|[\s，、（(「])A-\d/i, // A-3 / A-7b 任务编号
  /(?:^|[\s，、（(「])D-\d/i, // D-4 决策编号
  /(?:^|[\s，、（(「])U-\d/i, // U-A9 用例编号
  /(?:^|[\s，、（(「])T-\d/i, // T-D/T-02 任务线编号
  /HTTP\s*\d{3}/i, // 探针 HTTP 200
  /\d{4}-\d{2}-\d{2}/, // ISO 日期
  /\b\d{1,2}:\d{2}\b/, // 时刻
  /\.(?:ts|js|mjs|cjs|py|md|json|ya?ml|sh)\b/i, // 文件路径后缀
  /(?:^|\s)#\d{1,4}\b/, // #27 类工号
  /提交\s*(?:commit\s*)?[0-9a-f]{6}/i, // 提交 b1ea2e5
];

export function looksLikeEpisode(desc: string): boolean {
  const s = String(desc ?? "").trim();
  if (!s) return false;
  return EPISODE_PATTERNS.some((re) => re.test(s));
}
