/**
 * 内部通道（Round30）：让同机调用方在**只读** soul 面免 Bearer。
 *
 * 背景：Core 只监听 127.0.0.1，外部本来进不来；真正卡住的是本机的运维脚本/面板 BFF/探针
 * ——它们拿不到 TDAI_GATEWAY_API_KEY 就一律 401，于是「四者对账」只能靠人手抄 token。
 * 这里开的是本机回环这一条通道，不是公网豁免：
 *   - 只对 GET 的只读路由生效（card / turn / trait-state / emotions / labels / person* /
 *     injection/stats）；写入类（/v3/soul/injection、/event、/gate）仍然必须 Bearer。
 *   - 默认开启（Core 只 listen 127.0.0.1，回环即本机）；要关掉用
 *     `TDB_SOUL_INTERNAL_CHANNEL=off|0|false|no`。
 *     之所以默认开：env 由 supervisor 在启动时 dot-source，改 env 后只重启 Core 不会重读，
 *     默认关会让「内部通道」依赖一次 supervisor 级重启才能生效（Round30 实测踩到）。
 *   - 判据是 TCP 对端地址，不是任何可伪造的头（X-Forwarded-For 之类一律不看）。
 */

/** 回环地址判定：IPv4、IPv6、以及 IPv4-mapped IPv6 三种写法。 */
export function isLoopbackAddress(addr?: string | null): boolean {
  if (typeof addr !== "string") return false;
  const a = addr.trim().toLowerCase();
  if (a === "") return false;
  if (a === "::1") return true;
  if (a === "::ffff:127.0.0.1") return true;
  return a.startsWith("127.");
}

/** 内部通道开关：默认开；只有显式写 off|0|false|no 才关（用来说明「本部署不要回环免鉴权」）。 */
export function soulInternalChannelEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.TDB_SOUL_INTERNAL_CHANNEL;
  if (typeof raw !== "string") return true;
  const v = raw.trim().toLowerCase();
  if (v === "") return true;
  return !(v === "off" || v === "0" || v === "false" || v === "no");
}
