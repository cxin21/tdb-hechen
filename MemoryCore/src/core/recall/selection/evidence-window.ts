/**
 * 证据窗（2026-11-03 LME90 归因，标准行为、无配置项）。
 *
 * 病灶（实测 90 题，maxChars=1600 档）：仍有 7 道题的金标轮**检索到了却一条都装不进块**——
 * 那些 assistant 轮长 1468–3079 字，而选线是「整行装不下就丢、不截断不补位」
 * （layer-ruler 的 chars 丢弃），于是块里明明还剩 1287 字预算却空着，模型只能拒答。
 *
 * 为什么不直接截断：8-11-03 的「证据集」实验（句级压缩到 160 字）把 genCorrect 从 0.40 打到 0.20，
 * 19/19 净损失题都是「答案短语在截断点之后」。所以本模块只在**整行绝对装不下**时才出手，
 * 且用「头 + 命中窗 + 尾」三明治：长轮的事实常常在开头（用户提问）与结尾（assistant 结论），
 * 中间才是可省的细节。宁可不窗（返回 null）也不猜。
 *
 * 边界：
 * - `line.length <= budget` → 返回 null（不动短行，逐位现状）；
 * - 找不到任何可用的句界/命中 → 仍给头 70% + 尾 30% 的窗口（长轮里从来不会只有套话）；
 * - 输出保留 `·(活动时间: …)` 与 `·soul[…]` 尾部锚（时间语境不能丢），并显式标 `…（节选）`；
 * - 纯函数、零 IO、零外呼。
 */

const CJK_STOP_BIGRAMS = new Set([
  "用户",
  "什么",
  "怎么",
  "我们",
  "你们",
  "他们",
  "这个",
  "那个",
  "时候",
  "可以",
  "没有",
  "不是",
  "就是",
  "还是",
  "因为",
  "所以",
  "如果",
  "但是",
]);

/** 查询词面（拉丁词 ≥3 + 中文 2-gram）：只用于在长行里找「最可能回答这题」的那一段。 */
export function queryTerms(query: string): string[] {
  const latin = (query.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter(
    (w) => !/^(the|and|for|was|were|did|does|what|when|where|which|who|how)$/.test(w),
  );
  const cjk = query.match(/[\u4e00-\u9fff]+/g) ?? [];
  const bigrams: string[] = [];
  for (const seg of cjk) {
    for (let i = 0; i + 2 <= seg.length; i++) {
      const bg = seg.slice(i, i + 2);
      if (!CJK_STOP_BIGRAMS.has(bg)) bigrams.push(bg);
    }
  }
  return [...new Set([...latin, ...bigrams])];
}

const SENTENCE_SPLIT = /(?<=[。！？；!?;\n])/;

interface TailAnchors {
  readonly body: string;
  readonly anchors: string;
}

/**
 * 把行拆成「正文本体」与「锚」（`·(活动时间: …)` / `·soul[…]`）。
 *
 * 锚可能在行中也可能在行尾（结论层/合并行常见），所以统一**摘出、去重、追加到尾部**：
 * 只认行尾锚时，行中锚会被头/尾切片拦腰截断（实测产出 `…-01-01)` 与 `·(活动时间:` 这类残片）。
 * 锚承载时间与置信语境，节选后必须完整保留（2026-11-03 证据集实验的另一条负因）。
 */
const ANCHOR_RE = /·(?:\(活动时间:[^)]*\)|soul\[[^\]]*\])/g;

export function splitTailAnchors(line: string): TailAnchors {
  const found = line.match(ANCHOR_RE);
  if (!found || found.length === 0) return { body: line, anchors: "" };
  const body = line.replace(ANCHOR_RE, "").replace(/[ \t]+$/g, "");
  const anchors = [...new Set(found)].join("");
  return { body, anchors };
}

function clipAtBoundary(text: string, limit: number, fromEnd: boolean): string {
  if (text.length <= limit) return text;
  const slice = fromEnd ? text.slice(text.length - limit) : text.slice(0, limit);
  return fromEnd ? `…${slice}` : `${slice}…`;
}

/**
 * 长行 → 可装入预算的证据窗。返回 null 表示「不需要窗」（行本来就装得下）。
 *
 * 预算分配：头部 35% / 命中窗 40% / 尾部 25%（再扣掉锚与省略号）。命中窗选与查询词面重合最多、
 * 且尽量长的一段连续句子；一句都不命中时退化为头 70% + 尾 30%。
 */
export function buildEvidenceWindow(line: string, query: string, budget: number): string | null {
  if (!Number.isFinite(budget) || budget <= 0) return null;
  const cap = Math.floor(budget);
  if (line.length <= cap) return null;

  const { body, anchors } = splitTailAnchors(line);
  const reserveForAnchors = anchors.length;
  const room = cap - reserveForAnchors - 12; // 12 = "…（节选）" 与两处省略号的余量
  if (room < 60) return null; // 预算小到无法给出有意义窗口时宁可不窗

  const sentences = body.split(SENTENCE_SPLIT).filter((s) => s.length > 0);
  const terms = queryTerms(query);

  let best: { start: number; end: number; hits: number } | null = null;
  if (terms.length > 0 && sentences.length > 1) {
    const lower = sentences.map((s) => s.toLowerCase());
    for (let i = 0; i < sentences.length; i++) {
      let hits = 0;
      let end = i;
      let chars = 0;
      for (let j = i; j < sentences.length; j++) {
        const seg = lower[j]!;
        const segHits = terms.reduce((n, t) => n + (seg.includes(t) ? 1 : 0), 0);
        if (segHits === 0 && j > i) break;
        hits += segHits;
        chars += sentences[j]!.length;
        end = j;
        if (chars >= room * 0.4) break;
      }
      if (hits > 0 && (!best || hits > best.hits)) best = { start: i, end, hits };
    }
  }

  // 2026-11-03 实测否决「轻度超预算连续窗」（80/20 与 60/40 两臂分别 70/90、70/90，
  // 均低于基线 71/90，且 refused 15.6%→17.8%/18.9%）：固定比例落刀确实会切掉答案，
  // 但换成「头+尾」同样会切掉中段答案（2318644b），而三段窗的命中段本就覆盖 35–75% 这
  // 一答案高发区，存在即合理。结论：不引入新窗口策略，保留三段窗。
  if (best) {
    const tailBudget = Math.floor(room * 0.25);
    // 命中窗从第一句就开始时没有「头」可言：把头部预算整个让给命中窗，
    // 否则 head 与 mid 重叠，同一句会在节选里出现两遍。
    const headBudget = best.start === 0 ? 0 : Math.floor(room * 0.35);
    const midBudget = room - headBudget - tailBudget;
    // 2026-11-04：命中段只取「连续命中句」，第一句不命中就停 → 窗远小于预算
    // （实测 eaca4986：762 字预算只出 374 字，块尾留下 388 字空预算，答案句被切在窗外）。
    // 这里把命中段用**紧邻的上下文句**向两侧扩到中段预算：先把后文补进来（结论/后续句常在命中句之后），
    // 再往前补。扩的是连续性上下文而不是新证据源，不改变「窗里放什么」的取舍口径。
    let start = best.start;
    let end = best.end;
    let midLen = sentences.slice(start, end + 1).join("").length;
    while (end + 1 < sentences.length && midLen + sentences[end + 1]!.length <= midBudget) {
      end++;
      midLen += sentences[end]!.length;
    }
    while (start - 1 >= 0 && midLen + sentences[start - 1]!.length <= midBudget) {
      start--;
      midLen += sentences[start]!.length;
    }
    const head = headBudget > 0 && start > 0 ? `${body.slice(0, headBudget)}…` : "";
    const mid = sentences.slice(start, end + 1).join("");
    const tail = body.slice(Math.max(0, body.length - tailBudget));
    const clippedMid = mid.length > midBudget ? clipAtBoundary(mid, midBudget, false) : mid;
    const midSuffix = mid.length > midBudget ? "" : "…";
    return `${head}${clippedMid}${midSuffix}${tail}…（节选）${anchors}`;
  }

  // 无词面命中：头 70% + 尾 30%，两端都标省略。
  const headBudget = Math.floor(room * 0.7);
  const tailBudget = room - headBudget;
  const head = body.slice(0, headBudget);
  const tail = body.slice(body.length - tailBudget);
  return `${head}…${tail}…（节选）${anchors}`;
}
