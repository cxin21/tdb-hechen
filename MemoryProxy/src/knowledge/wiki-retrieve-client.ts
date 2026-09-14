// MemoryProxy/src/knowledge/wiki-retrieve-client.ts
export interface WikiSearchHit {
  path: string;
  title: string;
  snippet: string;
  score: number;
  type: string;
  hop: number;
  via?: string;
  /** 向量通道原始相关分（未归一化，来自引擎 absScore）；向量不可用时缺省。 */
  absScore?: number;
}

export interface WikiRetrieveClientOptions {
  timeoutMs?: number;
}

export interface WikiSearchEnvelope {
  code: number;
  message?: string;
  data?: { results?: WikiSearchHit[]; count?: number };
}

const TAG = "[wiki-recall]";

export class WikiRetrieveClient {
  private readonly baseUrl: string;
  private readonly serviceId: string;
  private readonly timeoutMs: number;
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis);

  constructor(baseUrl: string, serviceId: string, opts: WikiRetrieveClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.serviceId = serviceId;
    this.timeoutMs = opts.timeoutMs ?? 3000;
  }

  async search(params: {
    wikiId: string;
    query: string;
    limit?: number;
    minScore?: number;
    hop?: number;
    decay?: number;
  }): Promise<WikiSearchHit[]> {
    if (!params.wikiId || !params.query.trim()) return [];
    const body: Record<string, unknown> = {
      wiki_id: params.wikiId,
      query: params.query,
    };
    if (params.limit !== undefined) body.limit = params.limit;
    if (params.minScore !== undefined) body.minScore = params.minScore;
    if (params.hop !== undefined) body.hop = params.hop;
    if (params.decay !== undefined) body.decay = params.decay;

    try {
      const resp = await this.fetchImpl(`${this.baseUrl}/wiki/search`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-tdai-service-id": this.serviceId,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!resp.ok) {
        console.warn(`${TAG} search failed url=${this.baseUrl}/wiki/search wikiId=${params.wikiId} status=${resp.status}`);
        return [];
      }
      const env = (await resp.json()) as WikiSearchEnvelope;
      if (!env || env.code !== 0 || !Array.isArray(env.data?.results)) {
        console.debug(`${TAG} search non-ok code url=${this.baseUrl}/wiki/search wikiId=${params.wikiId} code=${env?.code ?? "no-envelope"}`);
        return [];
      }
      // Strip `related` (deliberate): keeps only the fields the recall needs
      return env.data.results.map((r) => ({
        path: String(r.path ?? ""),
        title: String(r.title ?? ""),
        snippet: String(r.snippet ?? ""),
        score: Number(r.score ?? 0),
        type: String(r.type ?? "unknown"),
        hop: Number(r.hop ?? 0),
        ...(typeof r.absScore === "number" ? { absScore: Number(r.absScore) } : {}),
        ...(r.hop !== undefined && Number(r.hop) > 0 && r.via !== undefined
          ? { via: String(r.via) }
          : {}),
      }));
    } catch (err) {
      console.debug(`${TAG} search threw url=${this.baseUrl}/wiki/search wikiId=${params.wikiId} reason=${err instanceof Error ? err.message : String(err)}`);
      return []; // graceful degradation — recall is non-critical
    }
  }
}