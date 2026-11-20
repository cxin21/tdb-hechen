/**
 * 全量测试用的确定性「模型」桩：只按 prompt 里给的事实出候选，不猜。
 * 目的是让 90 天回放的产物可复现，从而判「产线能否长出八层」，不是判模型好坏。
 */

const LAYER_TEXT = {
  identity: "被当面指出没验证就交活时，我宁可当场认下再补一遍，也不拿旧结论糊过去。",
  values: "宁可晚交一天，也不交没验过的东西——我认诚实这条，代价是别人觉得我慢。",
  boundary: "不做没验证就声称已验证的事。",
  self: "我答应自己：交付前先自己跑一遍，跑不通就不说做完了。",
  voice: "我说话先给结论，短句，不绕；不确定就直接说不确定。",
};

function parseEpisodeLines(lines) {
  return (lines ?? []).map((raw) => {
    const parts = String(raw).split(" | ");
    const field = (k) => {
      const hit = parts.find((p) => p.startsWith(k + "="));
      return hit ? hit.slice(k.length + 1) : "";
    };
    return {
      id: (parts[0] ?? "").trim(),
      kind: (parts[1] ?? "").trim(),
      day: (parts[2] ?? "").trim(),
      object: field("object"),
      user: field("user"),
      me: field("me"),
      cost: field("cost"),
      raw: String(raw),
    };
  }).filter((e) => e.id.startsWith("ep-"));
}

export function makeRewriter() {
  return async (req) => {
    // existing 现在带 state（产品侧 prompt 第 19 条据此让模型优先救 degraded/frozen）。
    const rows = req.existing ?? [];
    const existing = rows.map((e) => e.layer + "\u0000" + e.text);
    const staleLayers = [...new Set(rows.filter((e) => e.state && e.state !== "active").map((e) => e.layer))];
    const eps = parseEpisodeLines(req.episodes);
    const hasLayer = (layer) => existing.some((x) => x.startsWith(layer + "\u0000"));
    const minEvidence = Number(req.minEvidence ?? 3);
    const corrected = eps.filter((e) => /correction|complaint|pressure|decision|trust|promise/.test(e.kind));
    const voiced = eps.filter((e) => e.user !== "" || e.me !== "");
    const withCost = eps.filter((e) => e.cost !== "" || e.me !== "");
    const pool = (list) => (list.length >= minEvidence ? list : voiced.length >= minEvidence ? voiced : eps);
    const ids = (list, n) => [...new Set(list.map((e) => e.id))].slice(0, Math.max(n, minEvidence));
    // values/identity 的准入还要求 ≥2 个「我表过态」的 episode（gates：episode_missing），
    // 只给 L1 recordId 会在改写/续命路径被拒——这是桩的偏差，不是产品缺陷。
    const epIds = (list, n = 2) => [...new Set(list.filter((e) => e.me !== "").map((e) => e.id))].slice(0, Math.max(2, n));
    const out = [];
    const push = (c) => {
      if (out.length >= Math.max(1, Number(req.maxCandidates ?? 3))) return;
      out.push(c);
    };

    // ① 缺层先长：voice → boundary → values → identity → self。
    // 顺序有意义：maxCandidates=3 时排在后面的层永远分不到名额（旧序 voice/boundary 恒饿死）。
    if (!hasLayer("voice")) {
      const quotes = (req.voiceQuotes ?? [])
        .map((line) => {
          const m = /^「([\s\S]*)」 \| (\S+)$/.exec(String(line));
          return m ? { quote: m[1], recordId: m[2] } : null;
        })
        .filter((q) => q && q.quote.length >= 8)
        .slice(0, 2);
      if (quotes.length >= 2) {
        push({ layer: "voice", text: LAYER_TEXT.voice, evidenceIds: [quotes[0].recordId], fewShot: quotes });
      }
    }
    if (!hasLayer("boundary")) {
      push({ layer: "boundary", text: LAYER_TEXT.boundary, evidenceIds: ids(corrected, 1) });
    }
    if (!hasLayer("values") && ids(pool(withCost), minEvidence).length >= minEvidence) {
      push({ layer: "values", text: LAYER_TEXT.values, evidenceIds: ids(pool(withCost), minEvidence), episodeIds: epIds(pool(withCost)) });
    }
    if (!hasLayer("identity") && ids(pool(corrected), minEvidence).length >= minEvidence) {
      push({ layer: "identity", text: LAYER_TEXT.identity, evidenceIds: ids(pool(corrected), minEvidence), episodeIds: epIds(pool(corrected)) });
    }
    if (!hasLayer("self") && ids(pool(withCost), minEvidence).length >= minEvidence) {
      push({ layer: "self", text: LAYER_TEXT.self, evidenceIds: ids(pool(withCost), minEvidence), episodeIds: epIds(pool(withCost)) });
    }
    // ② 复现即续命：已存在的层被后续证据再印证时，重提同一文本（不改正文，只刷新证据与状态）。
    // 先救 stale（degraded/frozen）——产品 prompt 第 19 条同样把它们排在新增层之前；
    // 再救 active（防止 30 天无证据后被动降级）。
    const repropose = (layer) => {
      const text = LAYER_TEXT[layer];
      if (!hasLayer(layer) || text === undefined) return;
      if (layer === "voice" && !(req.voiceQuotes ?? []).length) return;
      const fresh = layer === "identity" ? pool(corrected) : pool(withCost);
      const freshIds = ids(fresh, minEvidence);
      if (freshIds.length < minEvidence) return;
      push({ layer, text, evidenceIds: freshIds, episodeIds: epIds(fresh) });
    };
    for (const layer of staleLayers) repropose(layer);
    for (const layer of Object.keys(LAYER_TEXT)) repropose(layer);
    return out;
  };
}

/** 人物档案桩：从 prompt 记忆行里挑事实，quote 严格取原文子串。 */
export function makeProfilerKit() {
  return {
    knownFrom(prompt) {
      const known = new Map();
      for (const line of prompt.split("\n")) {
        const m = /^- (p_[a-z0-9]+) \| (.+)$/.exec(line);
        if (m) known.set(m[2].trim(), m[1]);
      }
      return known;
    },
    memories(prompt) {
      const rows = [];
      for (const line of prompt.split("\n")) {
        const m = /^- (\S+) \| (\S+) \| (本人|别人) \| (\S+) \| ([\s\S]*?) \| ([\s\S]*)$/.exec(line);
        if (!m) continue;
        rows.push({ recordId: m[1], at: m[2], self: m[3] === "本人", role: m[4], summary: m[5], original: m[6].trim() });
      }
      return rows;
    },
  };
}
