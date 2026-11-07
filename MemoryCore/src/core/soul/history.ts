/**
 * 从已落库的事件里确定性长出自我与关系史。
 * LLM 不参与。抽不到就返回空，调用方写未采集，不许编。
 */
import type { PersonaItem, SoulEpisode, SoulLayer } from "./types.js";
import { extractAffectReferent } from "./emotion.js";
import { episodeRepaired } from "./episode.js";
import { textHash } from "./gates.js";

export type HistoryKind = "failure" | "promise" | "review" | "reversal" | "conflict" | "repair" | "trust";

export interface HistoryFact {
  kind: HistoryKind;
  layer: SoulLayer;
  text: string;
  object: string;
  episodeIds: string[];
  at: string;
  /** 仅 trust：关系是变好还是变差。缺失=方向未采集，不按 up 兜底。 */
  direction?: "up" | "down";
  /**
   * 仅 promise：后续同一对象的事件是否兑现。
   * 缺失 = 还没核对（open）；kept = 后来按原话补上了；broken = 同一对象后来又失败，且没有更晚的修复。
   */
  fulfillment?: "open" | "kept" | "broken";
}

const REPAIR = /(?:改口|重做|重跑|按原话重做|补上了|没守住|已按原话|已按同一|已对齐|改完|已改|修好|已修|修复)/u;
// 认下方向 ≠ 已修复，但对关系来说已经不是冲突。只认直接认同的措辞，不认泛泛的「收到」。
// 「收到/遵守/理解纠正」也是认了：这类回复不是顶回去，冲突不该记成对峙。
/** 他把「这不对」说给我听时才会用到的词；只用于关系层，不用于自我失败判定。 */
const BLAME_TIGHT = /(?:不对|错了|搞错|弄错|写错|改坏|漏了|没做到|假绿|不靠谱|太丑|难看|离谱|怎么还|为什么还|到底做好了|到底有没有)/u;
/** 我的回复里真正带着反驳/取证时，才配叫「顶了回去」。 */
const PUSHBACK = /(?:根因|实测|真机|截图|验证过|我查到|返回正常|上游|缓存|不是我|并非|不是我的问题|早就|上一轮|先前)/u;
// 「收到/遵守/理解纠正」也是认了：这类回复不是顶回去，冲突不该记成对峙。
const CONCEDE = /(?:你说的对|你说得对|你批评得对|是我的问题|我错了|理解一致|理解纠正|收到|遵守|马上改|我来改)/u;
const FAIL = /(?:没做到|没有做到|漏了|错了|不对|假绿)/u;
// 他说我不对 ≠ 我认了。自我失败要有我这一侧的承认或修复，否则是把我没做过的错写进人格。
// 「收口」是交付词，不算承认（生产里「两件事都能收口」曾被当成失败证据）。
const ADMITTED = /(?:改口|重做|重跑|按原话|补上了|没守住|漏了|没做到|已按|已对齐|改完|已改|修好|已修|修复|你说的对|你说得对|你批评得对|是我的问题|我错了|理解一致|马上改|我来改|方向性错误|质疑有道理)/u;
const REPORT = /(?:结论先行|先说结论|已完成|已经完成|已落地|已经全部落地|已推送|提交|票面|## |Compressed conversation|system-reminder|前置说明)/u;
// 复盘引用的是「后来改成什么」；交付体（任务…完成、交付如下）不是人格，是工作汇报。
// 生产注入里出现过「后来改成：任务六三缺陷修复完成，交付如下：」——自我史读起来像变更日志。
const REPORTISH = /(?:交付如下|改动如下|清单如下|结论先行|先说结论|已完成|已经完成|已推送|任务.{0,8}完成|修复完成|已修复|修复交付|已改完|都已改|门禁|全部通过|结论[:：]|验证链|用户给出|m\d{5}|## )/u;
// 信任下降只认明确的怀疑措辞；「不对/有问题」是就事论事，不升级成不信我。
const DISTRUST = /(?:不靠谱|不敢用|不放心|信不过|靠不住)/u;
// 自我承诺：我说出口、对自己立的约束。只认第一人称对自己说的，不把「我答应你」算进来。
// 承诺与失败无关——只在失败时才记，永远长不出「我答应过自己」。
const PROMISE = /我(?:答应(?:过)?自己|向自己(?:承诺|保证)|承诺|保证|发誓|给自己定|下次一定)/u;

/** 去掉承诺句自己的引导语，注入里不写「我答应过自己：「我答应自己：…」」。 */
function promiseBody(s: string): string {
  return s.replace(/^我(?:答应(?:过)?自己|向自己(?:承诺|保证)|承诺|保证|发誓|给自己定|下次一定)[：:，,]?\s*/u, "").trim();
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/gu, " ").trim();
  return t.length <= n ? t : t.slice(0, n) + "…";
}

/** 我的修复回复常以 markdown 小节/代码块开头；人格行里只留一句人话。 */
function cleanFix(s: string): string {
  // 注入信封（<acp …>m00777</acp>）是代理之间的元数据，不能跑到人格行里冒充我说的话。
  const flat = (s ?? "")
    .replace(/^<acp\b[^>]*>[^<]*<\/acp>\s*/u, "")
    .replace(/<acp\b[^>]*>|<\/acp>/gu, "")
    .replace(/^[#>*\-\s]+/u, "")
    .replace(/\*\*/gu, "");
  return flat.split(/```|[。；;\n]/u)[0]?.trim() ?? "";
}

function referent(ep: SoulEpisode): string {
  return extractAffectReferent(ep.userStance) || extractAffectReferent(ep.object) || "这件事";
}

/** 一条事件最多贡献一种自我事实、一种关系事实。没有我的表态不长自我。 */
export function factsFromEpisode(ep: SoulEpisode): HistoryFact[] {
  const out: HistoryFact[] = [];
  const me = (ep.agentStance ?? "").trim();
  const he = (ep.userStance ?? "").trim();
  // 他纠正之后的这一条回复，才是「我后来怎么改的」；agentStance 是他开口前我上一轮说的话。
  const fix = (ep.outcome ?? "").trim();
  const trusted = /你自己(?:找|选)最优|交给你定|你自己决定/u.test(he);
  if (!trusted && (REPORT.test(he) || REPORT.test(ep.object ?? ""))) return [];
  const who = referent(ep);
  // 关系史的双方是「我和他」：对象固定是这个人，具体争的是什么用他的原话，不用主题词。
  // 团队频道的裁决是 Lead 说的，不是何晨说的。按「何晨」记会把公开评审写成他的私下批评，
  // 关系史从此对着一个没发生过的对话。只认明确的裁决措辞，不猜。
  const fromLead = /(?:^Team message from\s+lead\b|Lead 定夺|裁决 PASS-WITH-CONCERNS)/u.test(he);
  const person = fromLead
    ? "Lead"
    : ((ep.participants ?? []).find((p) => p === "何晨") ?? (ep.participants ?? [])[0] ?? "对方");
  // 中文名直接接动词，拉丁名留一个空格，注入里才不是「Lead指出」。
  const speaker = /^[A-Za-z]/u.test(person) ? person + " " : person;
  // 我这一侧去掉代码块/JSON 后才是「我说了什么」。只剩空白的回复不是顶回去，也不是补上了：
  // 生产注入里出现过「只回了：」后面空无一字，等于凭空断言我顶了他一句。
  const said = cleanFix(me).trim();
  const aftermath = cleanFix(fix || me).trim();
  // 他开口之后我这一条回复才是「我后来怎么做的」；只有 outcome 缺失时才回退上一轮那句。
  // 生产里上一轮常是「导出我已经修好了」——正好是后来被推翻的假声明，引它会把修复
  // 写成「我补上了：导出我已经修好了」。
  const replyText = aftermath;
  const repaired = REPAIR.test(fix) || REPAIR.test(me);
  const fixText = cleanFix(fix).trim();
  const repairQuote = fixText !== "" && !REPORTISH.test(fixText) ? fixText : said;

  // 失败和复盘不是二选一：这次没守住是事实，后来改成了也是事实；两件都记，注入才既有代价也有去向。
  // 只有他明确说「不对/错了/漏了」才算我失败；派活、催进度不算。他原话缺失时宁可记不到，也不能拿我自己的话冒充他的纠正。
  const blamed = ep.kind === "correction" || ep.kind === "complaint";
  // 关系层记的是「他对我说这不对」。派活（「按 R1 出修复方案」）、转发缺陷单（「C1·MEDIUM·语义缺陷」）、
  // 续接交办（「builder 续接：t13 你中断于收尾」）都带「你」也不是冲突，原来被写成「何晨指出…我当场顶了回去」。
  // 团队频道的公开裁决是另一回事：它本来就冲着我这条交付来的，照样算关系事件。
  // 槽位判出来的 complaint（「不管用」+我回「已修」）也是冲着我的交付来的；
  // 只留 BLAME_TIGHT 会把这类事件挡在关系史外（见 soul/slots.ts）。
  const addressed =
    fromLead || ep.kind === "complaint" || BLAME_TIGHT.test(he) || (ep.signals ?? []).some((s) => s.startsWith("slot:") && s !== "slot:instruction" && s !== "slot:quoted");
  // 他只说「写错了」、我回的是取证报告：那是顶回去，不是我失败——自我史不能替我认没认过的账。
  // 认没认账看我对这条消息的回复；他只说「写错了」而我回取证报告时，不能替我认。
  const admitted = aftermath !== "" ? ADMITTED.test(aftermath) : ADMITTED.test(said);
  const failed =
    blamed &&
    he !== "" &&
    said !== "" &&
    !REPORT.test(said) &&
    ep.valence < 0 &&
    (repaired || FAIL.test(aftermath !== "" ? aftermath : said) || (FAIL.test(he) && admitted));
  if (failed) {
    out.push({
      kind: "failure",
      layer: "self",
      text: "我没守住：「" + clip(he, 48) + "」",
      object: who,
      episodeIds: [ep.episodeId],
      at: ep.at,
    });
  }
  if (failed && repaired) {
    // 复盘要能读出「改成什么」；只有交付体可引时，退回我那句表态，两者都不是就宁可不记。
    const changed = !REPORTISH.test(aftermath) ? aftermath : !REPORTISH.test(said) ? said : "";
    // 两边都只有交付体时，不编「改成什么」，只写确有其事的那一步（repaired 已由修复措辞证实）。
    const tail = changed !== "" ? "后来改成：" + clip(changed, 48) : "后来补上了。";
    out.push({
      kind: "review",
      layer: "self",
      text: "我一开始没做对：「" + clip(he, 48) + "」；" + tail,
      object: who,
      episodeIds: [ep.episodeId],
      at: ep.at,
    });
  }
  // 承诺：只从「我对他这条消息的回复」里抽，不要求伴随失败。回看 agentStance 会把上一轮
  // 已经长过的承诺在当前事件上再长一遍（episode id 不同 → itemId 不同 → 注入里重复），
  // 归因也错：那句承诺属于上一轮，不属于这次他说的事。
  const promiseSource = [aftermath].find((t) => t !== "" && PROMISE.test(t));
  if (promiseSource) {
    const body = promiseBody(promiseSource);
    if (body !== "") {
      out.push({
        kind: "promise",
        layer: "self",
        text: "我答应过自己：「" + clip(body, 56) + "」",
        object: who,
        episodeIds: [ep.episodeId],
        at: ep.at,
      });
    }
  }
  if (trusted) {
    out.push({
      kind: "trust",
      layer: "relationship",
      text: speaker + "把方案权交出来：「" + clip(he, 48) + "」",
      object: person,
      episodeIds: [ep.episodeId],
      at: ep.at,
      direction: "up",
    });
  }
  if (!trusted && DISTRUST.test(he) && ep.valence < 0) {
    out.push({
      kind: "trust",
      layer: "relationship",
      text: "他开始不太放心：「" + clip(he, 48) + "」",
      object: person,
      episodeIds: [ep.episodeId],
      at: ep.at,
      direction: "down",
    });
  }
  // 他没被回应：还在排查/只解释了、也没认，这是一条未修复的冲突；后来同类修复另记一条。
  // 汇报腔回复（结论先行/已提交）不算冲突，那是上下文的另一回事，不能把「报进度」写成「顶回去」。
  const unresolved = addressed && blamed && he !== "" && replyText !== "" && !repaired && !CONCEDE.test(replyText) && ep.valence < 0;
  // 认了才叫「还没修好」；没认的也别一律写成「顶了回去」——生产里「好，键 extras 会被透传」
  // 「红线复诵完毕」这类照办/复述都被记成对峙。只有回复里真带取证或反驳才算顶回去，其余中性记。
  const retort = admitted || CONCEDE.test(replyText)
    ? "我当时还没修好，只回了："
    : PUSHBACK.test(replyText)
      ? "我当场顶了回去，回的是："
      : "我当时回的是：";
  if (addressed && he !== "" && replyText !== "" && !REPORT.test(replyText) && !repaired && unresolved) {
    out.push({
      kind: "conflict",
      layer: "relationship",
      text: speaker + "指出：「" + clip(he, 56) + "」；" + retort + clip(replyText, 48),
      object: person,
      episodeIds: [ep.episodeId],
      at: ep.at,
    });
  } else if (addressed && he !== "" && replyText !== "" && !REPORT.test(replyText) && (repaired || FAIL.test(replyText)) && ep.valence < 0) {
    out.push({
      kind: repaired ? "repair" : "conflict",
      layer: "relationship",
      text: repaired
        ? speaker + "指出：「" + clip(he, 56) + "」；我补上了：" + clip(repairQuote, 48)
        : speaker + "指出：「" + clip(he, 56) + "」；我当时只回了：" + clip(replyText, 48),
      object: person,
      episodeIds: [ep.episodeId],
      at: ep.at,
    });
  }
  return out;
}

/**
 * 承诺兑现核对。承诺本身只在说出那一轮记一次；后来同一对象的失败/修复
 * 决定它是还在、做到了、还是没做到。没有后续证据保持 open，不编兑现。
 *
 * 口径与情绪门同一条：修复只认「补上了/已按/已对齐/已改/改完/改口」，
 * 不认 history 自己更宽的 REPAIR（「修好了」「重做」不算兑现）。
 */
export function settlePromises(facts: HistoryFact[], episodes: SoulEpisode[]): HistoryFact[] {
  const promises = facts.filter((f) => f.kind === "promise");
  if (promises.length === 0) return facts;
  const rest = facts.filter((f) => f.kind !== "promise");
  const settled = promises.map((p) => {
    const later = episodes.filter((ep) => ep.at > p.at && referent(ep) === p.object && p.object !== "这件事");
    const repairAt = later
      .filter((ep) => episodeRepaired(ep))
      .map((ep) => ep.at)
      .sort()
      .at(-1);
    // 没做到只认「没守住」，不认一般的负向回复。否则「修好了」这种更宽的修复措辞
    // 会被失败口径误判成 broken，兑现环和情绪门就不再是同一条线。
    const failAt = later
      .filter((ep) => {
        const said = cleanFix(ep.agentStance ?? "").trim();
        const aftermath = cleanFix((ep.outcome ?? "").trim() || (ep.agentStance ?? "")).trim();
        const text = aftermath !== "" ? aftermath : said;
        return ep.object === p.object && text !== "" && /没守住/u.test(text);
      })
      .map((ep) => ep.at)
      .sort()
      .at(-1);
    let fulfillment: HistoryFact["fulfillment"] = "open";
    if (repairAt && (!failAt || repairAt >= failAt)) fulfillment = "kept";
    else if (failAt) fulfillment = "broken";
    const evidence = later
      .filter((ep) => (fulfillment === "kept" ? episodeRepaired(ep) : fulfillment === "broken" && ep.at === failAt))
      .map((ep) => ep.episodeId);
    return {
      ...p,
      fulfillment,
      episodeIds: [...new Set([...p.episodeIds, ...evidence])],
    };
  });
  return [...rest, ...settled];
}

/** 同一对象先失败后修复，才记反悔。只有失败不编。 */
export function reversals(facts: HistoryFact[]): HistoryFact[] {
  const fails = facts.filter((f) => f.kind === "failure");
  const reviews = facts.filter((f) => f.kind === "review");
  const out: HistoryFact[] = [];
  for (const rev of reviews) {
    const prior = fails.find((f) => f.at < rev.at && f.object === rev.object && f.object !== "这件事");
    if (!prior) continue;
    out.push({
      kind: "reversal",
      layer: "self",
      // 给人看的是「在什么事上反悔」；事件编号留在 evidenceIds（historyToItems 会带进条目），不写进注入正文。
      text: "我改过口：在「" + clip(rev.object, 20) + "」上先是没守住，后来按原话重做。",
      object: rev.object,
      episodeIds: [...prior.episodeIds, ...rev.episodeIds],
      at: rev.at,
    });
  }
  return out;
}

/**
 * 矛盾：同对象上更晚的一次「未修复失败」证伪了此前「我补上了/后来改成」这条主张。
 *
 * 判据线与情绪门、承诺核对同一条：修复只认 episodeRepaired，比较用 referent(ep)（条目
 * meta.object 存的就是它），对象抽不出来（「这件事」）时宁可不判，不拿泛指当锚。
 * 幂等锚是 meta.lastContradictionEpisode：同一集事件只记一条矛盾，否则每 10 分钟
 * 一轮 tick 会把同一件事重复计到 freezeContradictions，把条目直接冻掉。
 */
export interface RepairContradiction {
  itemId: string;
  object: string;
  episodeId: string;
  at: string;
}

export function contradictRepairClaims(items: PersonaItem[], episodes: SoulEpisode[]): RepairContradiction[] {
  const out: RepairContradiction[] = [];
  for (const it of items) {
    const meta = it.meta as { historyKind?: string; object?: string; lastContradictionEpisode?: string } | undefined;
    // 只有「我修好了」这一类主张会被后来的失败证伪；失败事实本身不会。
    if (meta?.historyKind !== "repair" && meta?.historyKind !== "review") continue;
    // 只判自我层：自我事实的 object 是「争的是什么事」（referent），能和后来同一件事对上。
    // 关系事实的 object 是那个人，任何一次后续争执都会命中——那会把关系层「我补上了」
    // 成批冻掉，是另一项产品决定。这里不拿人当主题锚，明确留给下一版。
    if (it.layer !== "self") continue;
    const object = (meta.object ?? "").trim();
    if (object === "" || object === "这件事") continue;
    const later = episodes
      .filter((ep) => ep.at > it.lastEvidenceAt && referent(ep) === object)
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    const latest = later[0];
    // 最新一条仍是修复（或查不出结论）：主张还成立，不记矛盾。
    if (!latest || episodeRepaired(latest)) continue;
    // 证据独立性按自然日计：同一天里同一件事的多条记录不算第二次矛盾。
    if (latest.day === it.lastEvidenceAt.slice(0, 10)) continue;
    if (meta.lastContradictionEpisode === latest.episodeId) continue;
    out.push({ itemId: it.itemId, object, episodeId: latest.episodeId, at: latest.at });
  }
  return out;
}

/**
 * 事件史条目是否需要重写：权重和 direction 都是判据的一部分。
 * 只比文本会把「同一句信任事实、后来补上了 direction」永远挡在更新之外——生产关系史
 * 于是停在无方向的旧快照上。
 */
export function historyItemNeedsUpdate(prev: PersonaItem | undefined, next: PersonaItem): boolean {
  if (!prev) return true;
  if (prev.state !== "active" || prev.weight !== next.weight) return true;
  const prevMeta = prev.meta as { direction?: string; fulfillment?: string; object?: string } | undefined;
  const nextMeta = next.meta as { direction?: string; fulfillment?: string; object?: string } | undefined;
  if (prevMeta?.direction !== nextMeta?.direction) return true;
  // 对象锚是矛盾判据的唯一依据：老条目没有 meta.object，不补锚就永远进不了 contradictRepairClaims，
  // 生产者等于不存在。只在「新一轮有锚、旧条目没有」时重写，反向不成立（不能用无锚快照覆盖掉已锚定的条目）。
  if (nextMeta?.object && prevMeta?.object !== nextMeta.object) return true;
  // 承诺后来兑现或失约，文本没变也必须重写，否则注入永远停在「我答应过自己」。
  return prevMeta?.fulfillment !== nextMeta?.fulfillment;
}

export function historyToItems(facts: HistoryFact[], now: string): PersonaItem[] {
  return facts.map((f) => ({
    // 文案进 hash：同一事件换了写法就是新事实，旧文案会退出注入，而不是被幂等更新挡住。
    // 承诺的后续证据不进 id：兑现只改 meta，不新开一条。否则旧的「我答应过自己」
    // 会和「后来做到了」同时停在注入里，兑现环看起来接上了，读的人却看到两条。
    itemId: f.layer + ":hx-" + textHash(f.kind + "|" + f.text + "|" + (f.kind === "promise" ? f.episodeIds[0] ?? "" : f.episodeIds.join(","))).slice(0, 12),
    layer: f.layer,
    text: f.text,
    state: "active" as const,
    // 注入按权重取行：反悔已带上是哪件事，和复盘并列排在失败之前——
    // 否则 600 字自我段先被十条具体失败占满，反悔永远进不了注入。
    // 关系层：信任升降(0.9) 排最前，其次修复(0.8)，再排具体冲突(0.6)。
    // 信任是关系的状态，修复是那次的事；槽位判据上线后修复行变多(2026-11-06 生产 28 条)，
    // 0.7 的信任行立刻被挤出注入，注入里只剩「我补上了」。
    // 900 字/12 条只够「我补上了」×4 + 一两句冲突；信任是关系的状态，冲突是那次的事，
    // 同权重时冲突会把「他开始不太放心」整排挤出注入（2026-11-06 生产实拍）。
    weight:
      f.kind === "repair"
        ? 0.8
        : f.kind === "review"
          ? 0.75
          : f.kind === "reversal"
            ? 0.73
            : f.kind === "trust"
              ? 0.9
              : f.kind === "promise"
                ? 0.72
                : f.kind === "failure"
                  ? 0.7
                  : 0.6,
    evidenceIds: f.episodeIds,
    evidenceDays: [f.at.slice(0, 10)],
    evidenceOrigins: ["episode" as const],
    createdAt: now,
    updatedAt: now,
    lastEvidenceAt: f.at,
    // direction 是 trust 的语义（关系变好/变差），过去在 historyToItems 被丢掉，
    // 账本与注入都看不出升降方向。缺失=未采集，不写 direction 键，不按 up 兜底。
    meta: {
      source: "episode-history",
      historyKind: f.kind,
      // 对象是矛盾判据的锚：没有它就只剩「同一层出现反向主张」这种没法确定性实现的措辞。
      object: f.object,
      ...(f.direction ? { direction: f.direction } : {}),
      // 未核对的承诺不写 fulfillment，避免把「还没证据」伪装成已判定。
      ...(f.fulfillment && f.fulfillment !== "open" ? { fulfillment: f.fulfillment } : {}),
    },
  }));
}
