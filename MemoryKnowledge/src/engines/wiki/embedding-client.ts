/**
 * Wiki embedding 客户端（知识库向量化 Task 2）。
 *
 * 复用记忆侧火山 doubao 服务：POST `{baseUrl}/embeddings`，OpenAI 兼容格式：
 *   headers: Content-Type: application/json, Authorization: Bearer {apiKey}
 *   body:    { input: [text], model, dimensions }
 * 与 MemoryCore `OpenAIEmbeddingService._callApi`（embedding.ts）请求格式一致。
 *
 * 2026-11-03（授权）：429 防护对齐记忆侧。病灶实证——2026-10-22 10:58:27 生产日志
 * `[wiki-embed] HTTP 429` ×2 → `FAIL after 2 attempts` → 该次 /v3/wiki/search 降级纯 FTS。
 * 旧实现固定 300ms 重试，必然落在 Ark 账号级限流 ≥30–60s 的惩罚窗内，等于没有重试。
 */

export interface WikiEmbeddingConfig {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  dimensions: number;
  /** 2026-11-03：两次 provider 请求最小间隔（ms）。缺省 0 = 不节流（逐位旧行为）。 */
  paceMinIntervalMs?: number;
  /** 2026-11-03：60s 窗口内字符预算。缺省 0 = 不限（逐位旧行为）。 */
  charsPerMinute?: number;
}

/** 从 config 读取 embedding 段；未配置（缺 baseUrl/apiKey/model 或 dimensions<=0）→ null（不启用向量）。 */
export function getEmbeddingConfig(cfg: unknown): WikiEmbeddingConfig | null {
  const e = (cfg as any)?.embedding;
  if (!e || !e.baseUrl || !e.apiKey || !e.model || !(e.dimensions > 0)) return null;
  return {
    provider: e.provider ?? "openai_compatible",
    baseUrl: e.baseUrl,
    apiKey: e.apiKey,
    model: e.model,
    dimensions: e.dimensions,
    // 2026-11-03：节流旋钮与记忆侧同名同义（clamp 规则也一致），未配 = 关。
    paceMinIntervalMs: clampPace(e.paceMinIntervalMs),
    charsPerMinute: clampCharsPerMinute(e.charsPerMinute),
  };
}

function clampPace(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(60_000, Math.floor(n));
}

function clampCharsPerMinute(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(1_000, Math.floor(n));
}

/** 429 耗尽 / 非 429 的 4xx：不重试，直接抛。 */
class NonRetryableEmbedError extends Error {}

export class WikiEmbeddingClient {
  private cooldownUntil = 0;
  private lastRequestAt = 0;
  private windowStart = 0;
  private windowChars = 0;
  private readonly paceMs: number;
  private readonly charsPerMinute: number;

  constructor(private cfg: WikiEmbeddingConfig) {
    // 归一化 baseUrl 尾部斜杠，与记忆侧 OpenAIEmbeddingService（embedding.ts:427）一致。
    // embed() 内的 replace 为双保险。
    this.cfg = { ...cfg, baseUrl: cfg.baseUrl.replace(/\/+$/, "") };
    this.paceMs = clampPace(cfg.paceMinIntervalMs);
    this.charsPerMinute = clampCharsPerMinute(cfg.charsPerMinute);
  }

  isReady(): boolean {
    return true;
  }

  /**
   * 单文本 embed。带 AbortController 超时（防上游挂起卡死 rebuild）。
   *
   * 失败语义（2026-11-03）：
   * - 429 → 指数退避 1s/2s/4s/8s + 0–250ms 抖动（`Retry-After` 作下界），共 1+4 次尝试；
   *   与记忆侧同策略、同账号额度下不会因 300ms 硬重试白丢。
   * - 网络/超时/坏响应 → 保留旧的一次轻量重试（300ms）。
   * - 非 429 的 4xx → 立即抛（重试无意义，且旧实现会白等 300ms）。
   * - 发车节流：`paceMinIntervalMs` / `charsPerMinute` 未配时零开销（逐位旧行为）。
   */
  async embed(text: string): Promise<Float32Array> {
    // 截断超长输入（按 UTF-8 字节）：模型对 input 有字节上限（doubao-embedding-vision ≤ 100_000 字节）。
    // 超长页（如 index.md 208KB）原样发送会 400 InvalidParameter "string too long"；见 truncateInput 回归测试。
    const payload = truncateUtf8Bytes(text, MAX_INPUT_BYTES);
    const url = `${this.cfg.baseUrl.replace(/\/+$/, "")}/embeddings`;
    const chars = payload.length;
    let lastErr: unknown;
    let transientAttempts = 0;
    let rateLimitAttempt = 0;
    for (;;) {
      await this.awaitTurn(chars);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);
      try {
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.cfg.apiKey}` },
          body: JSON.stringify({ input: [payload], model: this.cfg.model, dimensions: this.cfg.dimensions }),
          signal: controller.signal,
        });
        if (!resp.ok) {
          const body = (await resp.text().catch(() => "")).slice(0, 300);
          console.log(`[wiki-embed] HTTP ${resp.status} (attempt ${rateLimitAttempt + 1}): ${body}`);
          if (resp.status === 429) {
            const err = new NonRetryableEmbedError(`embed HTTP 429: ${body}`);
            lastErr = err;
            this.noteRateLimit(rateLimitAttempt, parseRetryAfterMs(resp.headers.get("retry-after"), Date.now()));
            if (rateLimitAttempt < MAX_429_RETRIES) {
              rateLimitAttempt += 1;
              continue; // 下一轮开头的 awaitTurn 会等冷却
            }
            throw err;
          }
          throw new NonRetryableEmbedError(`embed HTTP ${resp.status}: ${body}`);
        }
        const json = (await resp.json()) as { data: Array<{ embedding: number[] }> };
        const v = json.data?.[0]?.embedding;
        if (!v || v.length !== this.cfg.dimensions) throw new Error(`embed bad response dims=${v?.length}`);
        console.log(`[wiki-embed] OK dims=${v.length} model=${this.cfg.model}`);
        return Float32Array.from(v);
      } catch (err) {
        lastErr = err;
        if (err instanceof NonRetryableEmbedError) throw err;
        if (transientAttempts < EMBED_MAX_RETRIES) {
          transientAttempts += 1;
          await sleep(EMBED_RETRY_DELAY_MS);
          continue;
        }
        break;
      } finally {
        clearTimeout(timeoutId);
      }
    }
    console.log(`[wiki-embed] FAIL after ${transientAttempts + 1} attempts`);
    throw new Error(
      `embed failed after ${transientAttempts + 1} attempts: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
    );
  }

  /** 429 撞限：指数退避 + 抖动；`Retry-After` 只作下界（服务端说了算）。 */
  private noteRateLimit(attempt: number, retryAfterMs?: number): void {
    const backoff = Math.min(RATE_LIMIT_BACKOFF_MAX_MS, RATE_LIMIT_BACKOFF_BASE_MS * 2 ** attempt);
    const jitter = Math.floor(Math.random() * RATE_LIMIT_JITTER_MS);
    const waitMs = Math.max(backoff + jitter, retryAfterMs ?? 0);
    this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + waitMs);
    console.log(
      `[wiki-embed] rate limited (429), attempt ${attempt + 1}/${MAX_429_RETRIES + 1}; cooling down ${waitMs}ms`,
    );
  }

  /** 等冷却 + 发车间隔/字符预算，然后把本次请求记入账本。 */
  private async awaitTurn(chars: number): Promise<void> {
    const waitMs = this.delayMs(Date.now(), chars);
    if (waitMs > 0) await sleep(waitMs);
    this.charge(Date.now(), chars);
  }

  private delayMs(now: number, chars: number): number {
    let wait = Math.max(0, this.cooldownUntil - now);
    if (this.paceMs > 0 && this.lastRequestAt > 0) {
      wait = Math.max(wait, this.lastRequestAt + this.paceMs - now);
    }
    if (this.charsPerMinute > 0 && now - this.windowStart < CHARS_WINDOW_MS) {
      if (this.windowChars + chars > this.charsPerMinute) {
        wait = Math.max(wait, this.windowStart + CHARS_WINDOW_MS - now);
      }
    }
    return Math.max(0, Math.ceil(wait));
  }

  private charge(now: number, chars: number): void {
    if (this.charsPerMinute > 0) {
      if (now - this.windowStart >= CHARS_WINDOW_MS) {
        this.windowStart = now;
        this.windowChars = 0;
      }
      this.windowChars += chars;
    }
    this.lastRequestAt = now;
  }
}

/** embed 单次请求超时（ms），对齐记忆侧 MemoryCore DEFAULT_API_TIMEOUT_MS=10_000。 */
const EMBED_TIMEOUT_MS = 10_000;
/** 网络/超时类轻量重试次数（首失败后重试，共 1+EMBED_MAX_RETRIES 次尝试）。 */
const EMBED_MAX_RETRIES = 1;
/** 网络/超时类重试间隔（ms）。 */
const EMBED_RETRY_DELAY_MS = 300;
/** 2026-11-03：429 最大重试次数（共 1+MAX_429_RETRIES 次尝试），与记忆侧一致。 */
const MAX_429_RETRIES = 4;
const RATE_LIMIT_BACKOFF_BASE_MS = 1_000;
const RATE_LIMIT_BACKOFF_MAX_MS = 30_000;
const RATE_LIMIT_JITTER_MS = 250;
const CHARS_WINDOW_MS = 60_000;
/** 模型 input 允许的最大 UTF-8 字节数（doubao-embedding-vision 上限 100_000；留余量到 90000）。 */
const MAX_INPUT_BYTES = 90_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `Retry-After` 支持秒数与 HTTP 日期两种写法；解析不了返回 undefined。 */
function parseRetryAfterMs(header: string | null, now: number): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.max(0, Math.round(Number(trimmed) * 1000));
  const at = Date.parse(trimmed);
  if (!Number.isFinite(at)) return undefined;
  return Math.max(0, at - now);
}

/**
 * 按 UTF-8 字节数截断文本到 maxBytes 内，避免超长输入触发模型 400。
 * 逐字符累计字节（而非简单 slice），确保不会把一个多字节字符切成无效字节。
 */
function truncateUtf8Bytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let bytes = 0;
  let i = 0;
  for (; i < text.length; i++) {
    const c = Buffer.byteLength(text[i], "utf8");
    if (bytes + c > maxBytes) break;
    bytes += c;
  }
  const truncated = text.slice(0, i);
  console.log(`[wiki-embed] input truncated ${Buffer.byteLength(text, "utf8")} -> ${bytes} bytes (model ${MAX_INPUT_BYTES} B limit)`);
  return truncated;
}
