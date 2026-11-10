/**
 * §5 P3-E：GET /v3/soul/emotions —— 情绪层唯一读面（明细 + 漏斗）。
 *
 * 合同：
 *   - 纯读：只调 listSoulEmotions / listSoulGateStats，不写任何表。
 *   - `decayedIntensity` 由**读侧现算**（decayedStoredIntensity(row, now)），库里存的是
 *     事件当时的原始强度；只衰一次，调用方不要再乘一遍。
 *   - 旧行三列（agency/confidence/objectPerson）补列后是 null：null 表示「当时没这一维」，
 *     不是 0 / "environment"，所以原样回 null，不伪造缺省值。
 *   - 失败即降级：store 未就绪或缺读方法 → 503 soul_emotions_unavailable；
 *     读/渲染异常 → 503 soul_emotions_failed。信封与 /v3/soul/card 同形（{code,data}）。
 */
import type { URL } from "node:url";
import type { ServerResponse } from "node:http";
import type { CoreTenant, IMemoryStore } from "../core/store/types.js";
import { decayedStoredIntensity } from "../core/soul/emotion.js";

/** 一次最多回多少行（URL 不该能拉出无限长清单）。 */
export const SOUL_EMOTIONS_LIMIT_DEFAULT = 50;
export const SOUL_EMOTIONS_LIMIT_MAX = 200;

/** 漏斗六档（§5 P3-D）；顺序即处理顺序，缺一档就是这一段没跑。 */
export const SOUL_EMOTION_FUNNEL_CODES = [
  "emotion:candidate",
  "emotion:object_ok",
  "emotion:appraised",
  "emotion:anchor_hit",
  "emotion:intensity_ok",
  "emotion:committed",
] as const;

export interface SoulEmotionsRouteDeps {
  getStore: () => IMemoryStore | null;
  logger?: { info?: (msg: string) => void; warn?: (msg: string) => void };
  /** 测试注入用的「现在」；缺省取真实时钟。 */
  now?: () => string;
}

function tenantOf(url: URL): CoreTenant {
  const pick = (k: string): string => {
    const v = url.searchParams.get(k);
    return v && v.trim() !== "" ? v.trim() : "default";
  };
  return { teamId: pick("team"), userId: pick("user"), agentId: pick("agent") };
}

/**
 * GET /v3/soul/emotions
 *   参数：team/user/agent（缺省 default）、limit（默认 50，上限 200）、since（ISO，按 at 过滤）。
 *   返回：{ code:0, data:{ rows:[…], funnel:{六键} } }。
 */
export async function handleSoulEmotionsRoute(
  url: URL,
  method: string,
  sendJson: (res: ServerResponse, status: number, payload: unknown) => void,
  res: ServerResponse,
  deps: SoulEmotionsRouteDeps,
): Promise<boolean> {
  if (method !== "GET" || url.pathname !== "/v3/soul/emotions") return false;
  const tenant = tenantOf(url);
  const store = deps.getStore();
  if (!store || typeof store.listSoulEmotions !== "function") {
    sendJson(res, 503, { code: 503, message: "soul_emotions_unavailable" });
    return true;
  }
  // 空串 / 缺参 = 用默认值（Number(null) 是 0，不挡会静默变成 limit=1）。
  const rawLimitText = (url.searchParams.get("limit") ?? "").trim();
  const rawLimit = rawLimitText === "" ? Number.NaN : Number(rawLimitText);
  const limit = Number.isFinite(rawLimit)
    ? Math.max(1, Math.min(SOUL_EMOTIONS_LIMIT_MAX, Math.floor(rawLimit)))
    : SOUL_EMOTIONS_LIMIT_DEFAULT;
  // since 只收能解析的时间：坏值直接丢，别让面板拿到一份「看起来空」的清单当结果。
  const rawSince = (url.searchParams.get("since") ?? "").trim();
  const since = rawSince !== "" && Number.isFinite(Date.parse(rawSince)) ? rawSince : "";
  const now = deps.now?.() ?? new Date().toISOString();
  try {
    const rows = (await Promise.resolve(
      store.listSoulEmotions(tenant, { limit, ...(since === "" ? {} : { since }) }),
    )) ?? [];
    // 漏斗取「今天」这一天的累计（day 由 worker 用 now.slice(0,10) 打，同口径）。
    const day = now.slice(0, 10);
    const stats =
      typeof store.listSoulGateStats === "function"
        ? ((await Promise.resolve(store.listSoulGateStats(tenant, { sinceDay: day, limit: 500 }))) ?? [])
        : [];
    const funnel: Record<string, number> = {};
    for (const code of SOUL_EMOTION_FUNNEL_CODES) {
      funnel[code] = stats
        .filter((s) => s.code === code && s.day === day && s.layer === "emotion")
        .reduce((sum, s) => sum + (Number.isFinite(s.count) ? Number(s.count) : 0), 0);
    }
    sendJson(res, 200, {
      code: 0,
      data: {
        rows: rows.map((r) => ({
          at: r.at,
          object: r.object,
          objectPerson: r.objectPerson ?? null,
          label: r.label,
          valence: r.valence,
          arousal: r.arousal,
          dominance: typeof r.dominance === "number" ? r.dominance : null,
          intensity: r.intensity,
          // 只衰一次：库里是原始强度，读侧按该行标签的半衰期重算。
          decayedIntensity: decayedStoredIntensity({ label: r.label, intensity: r.intensity, asOf: r.at }, now),
          agency: r.agency ?? null,
          confidence: typeof r.confidence === "number" ? r.confidence : null,
          templateVersion: r.templateVersion,
        })),
        funnel,
      },
    });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.logger?.warn?.(`[soul-emotions-endpoint] list failed: ${message}`);
    sendJson(res, 503, { code: 503, message: "soul_emotions_failed" });
    return true;
  }
}