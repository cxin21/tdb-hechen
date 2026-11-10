/**
 * R1（2026-11-07）：POST /v3/soul/injection —— 插件回传「本轮实际注入了什么」。
 *
 * 解决的问题：召回日志里 `soul.sessionInit/turnChars` 是 Core 侧**估算**
 * （读落库快照 meta + 现场再渲染一次），与插件真正拼进 prompt 的字节不等：
 *   - volatile 块被 `<soul-feeling>` 等包裹后比内文多 30+ 字符；
 *   - 相同文本 3 轮内插件直接 skip，日志却照记字符数；
 *   - 卡在会话中途改版时，日志记新版本、模型看旧版本。
 *
 * 合同：
 *   - 只收 **长度与指纹**，绝不上送卡正文/注入正文/token（本条是隐私边界，勿放宽）；
 *   - best-effort：任何字段异常都只 400/忽略，不阻塞会话；写日志失败也不报错；
 *   - 与召回行同文件、同轮转，靠 `kind:"injection"` 区分，用 `sessionKey + turn` 关联。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RecallJournalInjection, RecallJournalOpts } from "../core/recall/recall-journal.js";
import { appendRecallJournalInjection } from "../core/recall/recall-journal.js";

export const SOUL_INJECTION_PATH = "/v3/soul/injection";

export interface SoulInjectionRouteDeps {
  /** 与 auto-recall 同源：`<dataDir>/logs/recall`。 */
  journalDir: string;
  journalOpts: RecallJournalOpts;
  logger?: { info?: (msg: string) => void; warn?: (msg: string) => void };
  now?: () => Date;
}

function asString(value: unknown, max = 200): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > max) return undefined;
  return trimmed;
}

function asCount(value: unknown, max = 10_000_000): number | undefined {
  const n = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(n) || n < 0 || n > max) return undefined;
  return Math.floor(n);
}

function asHash(value: unknown): string | undefined {
  const s = asString(value, 128);
  return s && /^[0-9a-zA-Z._-]+$/.test(s) ? s : undefined;
}

function asCard(value: unknown): RecallJournalInjection["card"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  const version = asCount(v.version, 1_000_000);
  const hash = asHash(v.hash);
  const chars = asCount(v.chars);
  if (version === undefined || hash === undefined || chars === undefined) return undefined;
  return { version, hash, chars };
}

function asVolatile(value: unknown): RecallJournalInjection["volatile"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  const chars = asCount(v.chars);
  const hash = asHash(v.hash);
  const skipped = v.skipped === true;
  if (chars === undefined || hash === undefined) return undefined;
  return { chars: skipped ? 0 : chars, hash, skipped };
}

function asPhase(value: unknown, hasCard: boolean, hasVolatile: boolean): RecallJournalInjection["phase"] {
  const explicit = asString(value, 16);
  if (explicit === "card" || explicit === "volatile" || explicit === "mixed") return explicit;
  // 旧版插件不带 phase：按在场字段推断（两边都在 = mixed，理论上不该出现）。
  if (hasCard && hasVolatile) return "mixed";
  if (hasCard) return "card";
  if (hasVolatile) return "volatile";
  return undefined;
}

export async function handleSoulInjectionRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  method: string,
  parseJsonBody: <T>(req: IncomingMessage) => Promise<T>,
  sendJson: (res: ServerResponse, status: number, payload: unknown) => void,
  deps: SoulInjectionRouteDeps,
): Promise<boolean> {
  if (pathname !== SOUL_INJECTION_PATH) return false;
  if (method !== "POST") {
    sendJson(res, 405, { code: 405, message: "method_not_allowed" });
    return true;
  }
  let body: Record<string, unknown>;
  try {
    body = await parseJsonBody<Record<string, unknown>>(req);
  } catch {
    sendJson(res, 400, { code: 400, message: "bad_json" });
    return true;
  }
  const team = asString(body?.team, 128);
  if (!team) {
    sendJson(res, 400, { code: 400, message: "missing_team" });
    return true;
  }
  const card = asCard(body?.card);
  const volatile = asVolatile(body?.volatile);
  if (!card && !volatile) {
    sendJson(res, 400, { code: 400, message: "empty_injection" });
    return true;
  }
  const user = asString(body?.user, 128);
  const agent = asString(body?.agent, 128);
  const sessionKey = asString(body?.sessionKey, 400);
  const turnRaw = body?.turn;
  const turn = typeof turnRaw === "number" && Number.isFinite(turnRaw) ? Math.floor(turnRaw) : null;
  const phase = asPhase(body?.phase, card !== undefined, volatile !== undefined);
  const entry: RecallJournalInjection = {
    kind: "injection",
    ts: (deps.now?.() ?? new Date()).toISOString(),
    teamId: team,
    ...(user ? { userId: user } : {}),
    ...(agent ? { agentId: agent } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    turn,
    ...(card ? { card } : {}),
    ...(volatile ? { volatile } : {}),
    ...(phase ? { phase } : {}),
  };
  appendRecallJournalInjection(deps.journalDir, { teamId: team, agentId: agent }, entry, deps.journalOpts);
  sendJson(res, 200, { code: 0, data: { ok: true } });
  return true;
}
