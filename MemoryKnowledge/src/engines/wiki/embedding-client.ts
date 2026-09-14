/**
 * Wiki embedding 客户端（知识库向量化 Task 2）。
 *
 * 复用记忆侧火山 doubao 服务：POST `{baseUrl}/embeddings`，OpenAI 兼容格式：
 *   headers: Content-Type: application/json, Authorization: Bearer {apiKey}
 *   body:    { input: [text], model, dimensions }
 * 与 MemoryCore `OpenAIEmbeddingService._callApi`（embedding.ts）请求格式一致。
 */

export interface WikiEmbeddingConfig {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  dimensions: number;
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
  };
}

export class WikiEmbeddingClient {
  constructor(private cfg: WikiEmbeddingConfig) {
    // 归一化 baseUrl 尾部斜杠，与记忆侧 OpenAIEmbeddingService（embedding.ts:427）一致。
    // embed() 内的 replace 为双保险。
    this.cfg = { ...cfg, baseUrl: cfg.baseUrl.replace(/\/+$/, "") };
  }

  isReady(): boolean {
    return true;
  }

  /**
   * 单文本 embed。带 AbortController 超时（防上游挂起卡死 rebuild）+ 有限重试（防瞬时失败）。
   * API 不变：超时/最终失败抛 Error，由调用方单页降级。
   * 超时/重试参数对齐记忆侧 MemoryCore（DEFAULT_API_TIMEOUT_MS=10s）；本 wiki 用有限重试。
   */
  async embed(text: string): Promise<Float32Array> {
    // 截断超长输入（按 UTF-8 字节）：模型对 input 有字节上限（doubao-embedding-vision ≤ 100_000 字节）。
    // 超长页（如 index.md 208KB）原样发送会 400 InvalidParameter "string too long"；见 truncateInput 回归测试。
    const payload = truncateUtf8Bytes(text, MAX_INPUT_BYTES);
    const url = `${this.cfg.baseUrl.replace(/\/+$/, "")}/embeddings`;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= EMBED_MAX_RETRIES; attempt++) {
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
          console.log(`[wiki-embed] HTTP ${resp.status} (attempt ${attempt + 1}): ${body}`);
          throw new Error(`embed HTTP ${resp.status}: ${body}`);
        }
        const json = (await resp.json()) as { data: Array<{ embedding: number[] }> };
        const v = json.data?.[0]?.embedding;
        if (!v || v.length !== this.cfg.dimensions) throw new Error(`embed bad response dims=${v?.length}`);
        console.log(`[wiki-embed] OK dims=${v.length} model=${this.cfg.model}`);
        return Float32Array.from(v);
      } catch (err) {
        lastErr = err;
        if (attempt < EMBED_MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, EMBED_RETRY_DELAY_MS));
        }
      } finally {
        clearTimeout(timeoutId);
      }
    }
    console.log(`[wiki-embed] FAIL after ${EMBED_MAX_RETRIES + 1} attempts`);
    throw new Error(
      `embed failed after ${EMBED_MAX_RETRIES + 1} attempts: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
    );
  }
}

/** embed 单次请求超时（ms），对齐记忆侧 MemoryCore DEFAULT_API_TIMEOUT_MS=10_000。 */
const EMBED_TIMEOUT_MS = 10_000;
/** embed 最大重试次数（首失败后重试，共 1+EMBED_MAX_RETRIES 次尝试）。 */
const EMBED_MAX_RETRIES = 1;
/** 重试间隔（ms）。 */
const EMBED_RETRY_DELAY_MS = 300;
/** 模型 input 允许的最大 UTF-8 字节数（doubao-embedding-vision 上限 100_000；留余量到 90000）。 */
const MAX_INPUT_BYTES = 90_000;

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