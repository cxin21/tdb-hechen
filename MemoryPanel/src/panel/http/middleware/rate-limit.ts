import { createMiddleware } from 'hono/factory';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';
import { respondControlError } from '../envelope.js';

/**
 * /api/v1/* 请求限速（红队 2026-11-01 §MEDIUM-无限速）。
 *
 * 为什么需要：`/v3/meta/auth/verify` 实测 20 连发假 key 全部 200、均 1ms、
 * 零延迟零锁定（scratch/probe-red/results-02.json），而历史账号的 user-key
 * 就是明文用户名（4–7 字符），够短到可离线穷举。限速是这一层的唯一防线。
 *
 * 两条腿：
 *   - 按 user-key：120 次/分钟 —— 挡住单凭据的洪泛与枚举复用；
 *   - 按客户端 IP：60 次/分钟 —— 挡住换 key 的爆破（每个假 key 各自独立，
 *     只有 IP 维度能收敛）。
 *
 * 回环地址（127.0.0.1 / ::1）与「拿不到客户端地址」不参与 IP 限速：
 *   - 本机运维、面板自身探活、开发期的 Vite 代理都走回环；
 *   - 把回环和 LAN 混进同一个桶，等于让本机操作替攻击者背锅（自我 DoS）。
 *   威胁模型是 LAN 侧，回环不是。
 *
 * 固定窗口（非滑窗）：实现简单、内存可控，代价是窗口边界可放过 2× 突发。
 * 对本场景够用——真正要的是「不能无限打」，不是精确整形。
 */

export interface RateLimitRule {
  /** 窗口内允许的最大请求数 */
  max: number;
  /** 窗口长度（毫秒） */
  windowMs: number;
}

export interface RateLimitOptions {
  /** 按 user-key 限速；false 关闭该维度 */
  key?: RateLimitRule | false;
  /** 按客户端 IP 限速；false 关闭该维度 */
  ip?: RateLimitRule | false;
  /** 时钟注入（测试用） */
  now?: () => number;
  /** 客户端地址解析（测试用）；默认取 node 连接信息，回环返回 undefined */
  clientIp?: (c: Context) => string | undefined;
  /** 桶表上限，超过时清理过期桶（防内存膨胀） */
  maxBuckets?: number;
}

export const DEFAULT_KEY_RULE: RateLimitRule = { max: 120, windowMs: 60_000 };
export const DEFAULT_IP_RULE: RateLimitRule = { max: 60, windowMs: 60_000 };

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1']);

interface Bucket {
  count: number;
  resetAt: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** 被拒时建议的等待秒数（向上取整，至少 1） */
  retryAfterSec: number;
}

/**
 * 纯函数形态的判定器，便于单测直接打，不必起 HTTP。
 * 命中且未超限时计数 +1；超限时不计数（避免被拒请求把窗口无限延后）。
 */
export function takeToken(
  buckets: Map<string, Bucket>,
  bucketKey: string,
  rule: RateLimitRule,
  now: number,
): RateLimitDecision {
  const existing = buckets.get(bucketKey);
  if (!existing || now >= existing.resetAt) {
    buckets.set(bucketKey, { count: 1, resetAt: now + rule.windowMs });
    return { allowed: true, retryAfterSec: 0 };
  }
  if (existing.count >= rule.max) {
    const remainingMs = Math.max(1, existing.resetAt - now);
    return { allowed: false, retryAfterSec: Math.ceil(remainingMs / 1000) };
  }
  existing.count += 1;
  return { allowed: true, retryAfterSec: 0 };
}

function defaultClientIp(c: Context): string | undefined {
  try {
    const info = getConnInfo(c);
    const addr = info?.remote?.address;
    if (!addr) return undefined;
    const bare = addr.startsWith('::ffff:') ? addr.slice('::ffff:'.length) : addr;
    if (LOOPBACK.has(bare) || LOOPBACK.has(addr)) return undefined;
    return bare;
  } catch {
    // 非 node-server 环境（单测里 app.fetch）或取不到连接信息：不参与 IP 限速。
    return undefined;
  }
}

export function rateLimit(options: RateLimitOptions = {}) {
  const keyRule = options.key === false ? null : (options.key ?? DEFAULT_KEY_RULE);
  const ipRule = options.ip === false ? null : (options.ip ?? DEFAULT_IP_RULE);
  const now = options.now ?? (() => Date.now());
  const clientIp = options.clientIp ?? defaultClientIp;
  const maxBuckets = options.maxBuckets ?? 10_000;
  const buckets = new Map<string, Bucket>();

  function sweep(t: number): void {
    if (buckets.size <= maxBuckets) return;
    for (const [k, b] of buckets) {
      if (t >= b.resetAt) buckets.delete(k);
    }
    // 清完还超（大量活跃窗口）：退化为整表清空，宁可放过一轮也不无限膨胀。
    if (buckets.size > maxBuckets) buckets.clear();
  }

  return createMiddleware(async (c, next) => {
    const t = now();
    sweep(t);

    const ip = clientIp(c);
    if (ipRule && ip) {
      const decision = takeToken(buckets, `ip:${ip}`, ipRule, t);
      if (!decision.allowed) {
        c.header('Retry-After', String(decision.retryAfterSec));
        return respondControlError(c, 429, 'RATE_LIMITED');
      }
    }

    const userKey = c.req.header('x-tdai-user-key')?.trim();
    if (keyRule && userKey) {
      const decision = takeToken(buckets, `key:${userKey}`, keyRule, t);
      if (!decision.allowed) {
        c.header('Retry-After', String(decision.retryAfterSec));
        return respondControlError(c, 429, 'RATE_LIMITED');
      }
    }

    await next();
  });
}
