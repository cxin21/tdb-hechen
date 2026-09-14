/**
 * 数据可靠性：确定性（Rule-based）灵魂字段回填 —— 不依赖 LLM。
 * 模型常不吐 occurred_at/certainty/valence，导致 l1_records 列空。
 * 此处从 content 用规则抽时间锚/情感/重要性，只回填 **空字段**（已有的不动）。
 * best-effort、纯同步、零 LLM。
 */
export interface SoulPatch {
  occurred_at?: string;
  certainty?: "observed" | "inferred";
  valence?: number;
  arousal?: number;
  significance?: number;
}

const VALENCE_POS: Array<[RegExp, number, number]> = [
  [/兴奋|开心|高兴|满意|激动|骄傲|荣幸|感激|喜欢|认可|自豪/, 0.8, 0.8],
  [/不错|挺好|顺利|达成|成功/, 0.6, 0.6],
  [/松一口气|放心|踏实/, 0.5, 0.3],
];
const VALENCE_NEG: Array<[RegExp, number, number]> = [
  [/愤怒|生气|讨厌|反感|恼火/, -0.9, 0.8],
  [/焦虑|担心|紧张|害怕|恐惧|不安/, -0.6, 0.9],
  [/失望|失落|郁闷|沮丧/, -0.6, 0.5],
  [/累|疲惫|矛盾|纠结|为难|无奈/, -0.4, 0.4],
];
const SIGNIFICANT: RegExp[] = [/重要|关键|决定|重大|里程碑|里程碑/, /必须|务必|核心|全局/];

const WEEKDAY = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 从中文 content 解析近一年的相对时间锚 → ISO。找不到返回 undefined。 */
export function parseOccurredAt(content: string, now = new Date()): string | undefined {
  // 绝对月日：X月Y日（可带 [上/下]午/晚上 X点/X点X分/Y点半）
  let m = content.match(/(\d{1,2})月(\d{1,2})[日号]/);
  if (m) {
    const d = new Date(now.getFullYear(), Number(m[1]) - 1, Number(m[2]));
    if (d.getTime() > now.getTime() + 86400000) d.setFullYear(d.getFullYear() - 1); // 未来→去年
    return applyClock(d, content);
  }
  // 昨天 / 今天 / 明天
  const rel = content.match(/昨天|今日|今天|明天/);
  if (rel) {
    let d = new Date(now);
    if (/昨天|昨日/.test(rel[0])) d.setDate(d.getDate() - 1);
    else if (/明天|明日/.test(rel[0])) d.setDate(d.getDate() + 1);
    return applyClock(d, content);
  }
  // 本周/上周 X
  m = content.match(/((?:本|上)周)([一二三四五六日天])/);
  if (m) {
    const wd = WEEKDAY.indexOf(m[2] === "天" ? "周日" : `周${m[2]}`);
    const d = new Date(now);
    const cur = (now.getDay() + 7) % 7;
    const back = m[1] === "上周" ? 7 : 0;
    d.setDate(now.getDate() - cur + wd - back);
    return applyClock(d, content);
  }
  return undefined;
}

/** 给已定日期补时钟（上/下午、X点、X点半、X点X分） */
function applyClock(d: Date, content: string): string {
  let h = 9;
  const hm = content.match(/(上午|早上|中午|下午|晚上|凌晨)?[：:]?(\d{1,2})[点时]半?(\d{0,2})?分?/);
  if (hm) {
    h = Number(hm[2]);
    const p = hm[1];
    if (p === "下午" || p === "晚上") h += 12;
    if (p === "凌晨" && h < 3) h += 24;
  }
  d.setHours(h, hm?.[3] ? Number(hm[3]) : 0, 0, 0);
  return d.toISOString();
}

/** 情感/重要性确定性回填（只填空字段） */
export function patchSoulFromContent(content: string, current: SoulPatch): SoulPatch {
  const out: SoulPatch = {};
  if (!current.occurred_at) {
    const t = parseOccurredAt(content);
    if (t) out.occurred_at = t;
  }
  if (!current.certainty) out.certainty = "observed";
  if (current.valence == null) {
    for (const [re, v, a] of VALENCE_POS) if (re.test(content)) { out.valence = v; out.arousal = a; break; }
    if (out.valence == null) for (const [re, v, a] of VALENCE_NEG) if (re.test(content)) { out.valence = v; out.arousal = a; break; }
  }
  if (current.significance == null && SIGNIFICANT.some((re) => re.test(content))) out.significance = 0.8;
  return out;
}