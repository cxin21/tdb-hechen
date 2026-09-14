/**
 * Wiki Source Manager — 管理文档源的注册、扫描、索引、查询生命周期
 *
 * 摄取走 ingest-v2/ 引擎。
 *
 * 索引存储（设计 006）：BM25 全文检索、知识图谱、页元数据不再常驻内存，改存每个
 * wiki 私有的 `index.db`（SQLite：wiki_fts + page_meta + graph_edge）。写走独立事务连接
 * （重建三表），读走 LRU 连接池；内存与 wiki 总数解耦，根治 MiniSearch 全量常驻的 OOM。
 * 图谱小，查询时从 graph_edge 临时构建内存 graphology 实例做多跳 BFS（复用现有算法）。
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "fs";
import { join, basename, relative } from "path";
import Graph from "graphology";
import type DatabaseType from "better-sqlite3";
import pLimit, { type LimitFunction } from "p-limit";
import type {
  WikiPage,
  WikiSourceConfig,
  WikiSourceState,
  GraphNode,
  GraphEdge,
  CommunityInfo,
  SearchResult,
  SearchResponse,
  RelatedPage,
  ResultLink,
} from "./types.js";
import { graphMultiHopSearch } from "./graph-search.js";
import {
  initIndexDb,
  getReadDb,
  withWriteDb,
  withWriteAsync,
  evictWikiDb,
  readSourceStates,
  recordSourceIngestResult,
  deleteSources,
  classifySources,
  sha256,
  type SourceStatus,
} from "./index-db.js";
import { contentSha256 } from "./content-sha.js";
import { createLogger } from "../../logger.js";
import { withSpan } from "../../telemetry.js";
import { getIngestConcurrency } from "../../config.js";
import { slugify } from "./ingest-v2/slug.js";
import { WikiEmbeddingClient, type WikiEmbeddingConfig } from "./embedding-client.js";
import { DEFAULT_SCHEMA, DEFAULT_PURPOSE } from "./ingest-v2/template.js";

const log = createLogger("wiki-mgr");

// ── 内联 frontmatter/wikilink 解析（不依赖外部模块，确保可编译） ──

function extractFrontmatter(content: string): { title: string; type: string; sources: string[]; description: string } {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  const fm = fmMatch ? fmMatch[1] : "";
  const titleMatch = fm.match(/^title:\s*["']?(.+?)["']?\s*$/m);
  const typeMatch = fm.match(/^type:\s*["']?(.+?)["']?\s*$/m);
  const descMatch = fm.match(/^description:\s*["']?(.+?)["']?\s*$/m);
  const sources: string[] = [];
  const sourcesBlockMatch = fm.match(/^sources:\s*\n((?:\s+-\s+.+\n?)*)/m);
  if (sourcesBlockMatch) {
    for (const line of sourcesBlockMatch[1].split("\n")) {
      const itemMatch = line.match(/^\s+-\s+["']?(.+?)["']?\s*$/);
      if (itemMatch) sources.push(itemMatch[1]);
    }
  } else {
    const inlineMatch = fm.match(/^sources:\s*\[([^\]]*)\]/m);
    if (inlineMatch) {
      for (const item of inlineMatch[1].split(",")) {
        const trimmed = item.trim().replace(/^["']|["']$/g, "");
        if (trimmed) sources.push(trimmed);
      }
    }
  }
  let title = titleMatch ? titleMatch[1].trim() : "";
  if (!title) {
    const headingMatch = content.match(/^#\s+(.+)$/m);
    title = headingMatch ? headingMatch[1].trim() : "";
  }
  return {
    title,
    type: typeMatch ? typeMatch[1].trim().toLowerCase() : "other",
    sources,
    description: descMatch ? descMatch[1].trim() : "",
  };
}

function extractWikilinks(content: string): string[] {
  const links: string[] = [];
  const regex = /\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    links.push(match[1].trim());
  }
  return links;
}

// ── Manager Interface ──

export interface SearchOptions {
  /** Multi-hop expansion depth (PRD FR-3). 0 = pure BM25. Range 0~5. */
  hop?: number;
  /** Per-hop score decay factor (0~1). */
  decay?: number;
  /** Minimum score threshold; nodes below this are dropped. */
  minScore?: number;
}

/** ingest 进度回调载荷（KS → Panel）。 */
export interface IngestProgress {
  phase: "extracting" | "merging" | "indexing";
  total: number;
  completed: number;
  failed: number;
  skipped: number;
  percent: number;
}

export type ProgressFn = (progress: IngestProgress) => void;

/** extracting 同阶段节流间隔；阶段切换（merging/indexing）始终立即上报。 */
export const PROGRESS_THROTTLE_MS = 500;

/**
 * 节流 onProgress：阶段切换立即发；同阶段仅在 percent 上升且距上次 ≥ minIntervalMs
 * （或已到 extracting 末段 percent≥90）时发送，避免多源并发打爆 Panel。
 */
export function createThrottledProgressFn(
  onProgress: ProgressFn | undefined,
  minIntervalMs: number = PROGRESS_THROTTLE_MS,
): ProgressFn | undefined {
  if (!onProgress) return undefined;
  let lastPhase: IngestProgress["phase"] | undefined;
  let lastPercent = -1;
  let lastEmitAt = 0;
  return (p) => {
    const now = Date.now();
    const phaseChanged = p.phase !== lastPhase;
    if (!phaseChanged) {
      if (p.percent <= lastPercent) return;
      const nearExtractEnd = p.phase === "extracting" && p.percent >= 90;
      if (!nearExtractEnd && now - lastEmitAt < minIntervalMs) return;
    }
    lastPhase = p.phase;
    lastPercent = p.percent;
    lastEmitAt = now;
    onProgress(p);
  };
}

export interface IngestExecOptions {
  onProgress?: ProgressFn;
  globalLlmLimit?: LimitFunction;
}

/** 向量强制重建状态（spec §6.2；admin /get rebuildStatus 透出）。 */
export interface VectorRebuildStatus {
  status: "idle" | "running" | "done" | "failed";
  reason?: string; startedAt?: string; finishedAt?: string;
}

export interface WikiSourceManager {
  register(config: WikiSourceConfig): WikiSourceState;
  sync(name: string): WikiSourceState;
  get(name: string): WikiSourceState | undefined;
  list(): WikiSourceState[];
  remove(name: string): void;
  search(name: string, query: string, limit?: number, options?: SearchOptions): Promise<SearchResponse>;
  graph(name: string): { nodes: GraphNode[]; edges: GraphEdge[]; communities: CommunityInfo[] };
  readPage(name: string, relPath: string): string | null;
  getPages(name: string): WikiPage[];
  init(config: WikiSourceConfig): WikiSourceState;
  ingest(name: string, llmConfig: any, opts?: IngestExecOptions): Promise<any[]>;
  /** Embedding 客户端（知识库向量化）；未配置 embedding 时为 null（降级纯 FTS）。 */
  embeddingClient: WikiEmbeddingClient | null;
  /** 向量强制重建状态（指纹检测 / forceRevectorizeAll 进度）。 */
  vectorStatus(): VectorRebuildStatus;
  /** 强制全量重建所有 ready wiki 的向量索引（绕过 content_sha 复用）。
   *  F3 诚实语义：true=本次调用真正启动了新一轮；false=被 running 守卫拒绝。 */
  forceRevectorizeAll(): Promise<boolean>;
}

/** 图谱中不参与建边/展示的页类型（如内部 query 页）。 */
const HIDDEN_TYPES = new Set(["query"]);

/**
 * 不参与向量化的结构页类型（自动生成的导航/元数据页）。
 * 这类页（尤其 `index.md` 索引/目录旧式导航页）体积可能远超 embedding 输入上限，
 * 嵌入时会被 `MAX_INPUT_BYTES` 截断丢尾，对语义检索又无增量价值，故整体跳过。
 * 除 type 命中外，根级结构页（index.md/log.md 等，通常无 type 字段）按其基底名判定，
 * 也由 `isStructuralPage` 一并排除。仅匹配固定结构页命名，不会误跳根级内容页。
 */
const NON_EMBED_TYPES = new Set(["index", "schema", "purpose", "overview", "log"]);

/** 结构页判据：命中的结构 type，或根级结构页的基底名（index.md/log.md 等无 type 字段，
 *  按其基底名判定）。只匹配固定结构页基底名，绝不把任意根级内容页（如 wiki/alpha.md）
 *  误当结构页跳过。 */
function isStructuralPage(p: { type: string | null; relPath: string }): boolean {
  if (p.type && NON_EMBED_TYPES.has(p.type)) return true;
  const base = p.relPath.replace(/^wiki\//, "").replace(/\.md$/, "");
  return NON_EMBED_TYPES.has(base);
}

// ── 图谱缓存结构（读时从 index.db 的 graph_edge 临时构建） ──

export interface PageGraph {
  /** Public view (filtered, with linkCount/community). */
  view: { nodes: GraphNode[]; edges: GraphEdge[]; communities: CommunityInfo[] };
  /** graphology instance — undirected, no multi-edges. Used for multi-hop BFS. */
  graph: Graph;
  /** Per-page directed wikilink adjacency (id -> outgoing target ids). */
  outAdj: Map<string, Set<string>>;
  /** Per-page reverse adjacency (id -> ids whose page links into this one). */
  inAdj: Map<string, Set<string>>;
  /** Degree (= linkCount in nodes view). */
  degree: Map<string, number>;
}

/** 页元数据（读模型；正文不在库，snippet 为写入时预生成的静态摘要）。 */
interface PageMeta {
  id: string;
  title: string;
  type: string;
  relPath: string;
  snippet: string;
}

/**
 * 解析页间 wikilink，产出有向边（source → target）用于写入 graph_edge。
 * 只在 visible（非 hidden 类型）页之间建边，过滤自环与无法解析的坏链接，(source,target) 去重。
 */
function resolveEdges(pages: WikiPage[]): Array<{ source: string; target: string }> {
  const visible = pages.filter((p) => !HIDDEN_TYPES.has(p.type));
  const out: Array<{ source: string; target: string }> = [];
  if (visible.length === 0) return out;

  const nodeIds = new Set(visible.map((p) => p.id));
  // title 的 slug → page id 映射：支持 wikilink 以页面标题（而非文件名）引用。
  const titleSlugToId = new Map<string, string>();
  for (const p of visible) {
    const ts = slugify(p.title);
    if (ts && !titleSlugToId.has(ts)) titleSlugToId.set(ts, p.id);
  }

  const seen = new Set<string>();
  for (const page of visible) {
    for (const targetRaw of page.links) {
      const targetId = resolveTarget(targetRaw, nodeIds, titleSlugToId);
      if (!targetId || targetId === page.id) continue;
      const key = `${page.id}\u0000${targetId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ source: page.id, target: targetId });
    }
  }
  return out;
}

/**
 * 从 page_meta + graph_edge 构建内存 PageGraph（读路径）。
 * 节点 = 非 hidden 类型的页；边 = graph_edge 有向边，公共 view 无向去重。
 */
function buildPageGraphFromDb(
  metaById: Map<string, PageMeta>,
  edgeRows: Array<{ source_id: string; target_id: string }>,
): PageGraph {
  const graph = new Graph({ multi: false, type: "undirected" });
  const outAdj = new Map<string, Set<string>>();
  const inAdj = new Map<string, Set<string>>();
  const degree = new Map<string, number>();

  const visible: PageMeta[] = [];
  for (const m of metaById.values()) {
    if (!HIDDEN_TYPES.has(m.type)) visible.push(m);
  }

  for (const m of visible) {
    outAdj.set(m.id, new Set());
    inAdj.set(m.id, new Set());
    degree.set(m.id, 0);
    graph.addNode(m.id, { label: m.title, type: m.type, path: m.relPath });
  }

  const seenEdges = new Set<string>();
  const edges: GraphEdge[] = [];
  for (const { source_id: s, target_id: t } of edgeRows) {
    // 端点必须都是 visible 节点（写库时已保证；读侧防御坏数据）。
    if (!outAdj.has(s) || !inAdj.has(t)) continue;
    outAdj.get(s)!.add(t);
    inAdj.get(t)!.add(s);
    const key = [s, t].sort().join(":::");
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    edges.push({ source: s, target: t, weight: 1 });
    if (!graph.hasEdge(s, t)) graph.addEdge(s, t, { weight: 1 });
    degree.set(s, (degree.get(s) ?? 0) + 1);
    degree.set(t, (degree.get(t) ?? 0) + 1);
  }

  const nodes: GraphNode[] = visible.map((m) => ({
    id: m.id,
    label: m.title,
    type: m.type,
    path: m.relPath,
    linkCount: degree.get(m.id) ?? 0,
    community: 0,
  }));

  return { view: { nodes, edges, communities: [] }, graph, outAdj, inAdj, degree };
}

function resolveTarget(
  raw: string,
  nodeIds: Set<string>,
  titleSlugToId: Map<string, string>,
): string | null {
  if (nodeIds.has(raw)) return raw;

  // wikilink 目标可能是各种花式写法（带 .md 后缀、带斜杠路径、中英混合、大小写不一）。
  // 统一用与文件名同源的 slugify 归一后比对 page id 的 basename（单一事实源，
  // 避免在此重复造一套归一逻辑）。slugify 把 `/`、空格、标点都当段边界，
  // 故 "/v3/wiki/create 接口" 与 "v3-wiki-create-接口" 归一后一致。
  const target = slugify(raw.replace(/\.md$/i, ""));
  if (!target) return null;

  const rawLower = raw.toLowerCase();
  for (const id of nodeIds) {
    if (id.toLowerCase() === rawLower) return id;
    const idBasename = id.split("/").pop() ?? id;
    if (slugify(idBasename) === target) return id;
  }
  // 回退：按页面标题的 slug 命中（wikilink 用页面标题而非文件名引用时）。
  const byTitle = titleSlugToId.get(target);
  if (byTitle) return byTitle;
  return null;
}

// ── Search Engine (SQLite FTS5) ──

const STOP_WORDS = new Set([
  "的", "是", "了", "什么", "在", "有", "和", "与", "对", "从",
  "the", "is", "a", "an", "what", "how", "are", "was", "were",
  "do", "does", "did", "be", "been", "being", "have", "has", "had",
  "it", "its", "in", "on", "at", "to", "for", "of", "with", "by",
  "this", "that", "these", "those",
]);

const SNIPPET_CONTEXT = 80;

/**
 * 预生成页摘要（写入 page_meta.snippet）：优先 frontmatter description，
 * 否则取正文（去 frontmatter/标题）前 SNIPPET_CONTEXT 个字符。
 * 正文不入库，检索时直接返回该静态摘要（消费者主要是 AI，无需按 query 动态高亮）。
 */
function makeSnippet(page: WikiPage): string {
  if (page.description) return page.description;
  const body = page.content
    .replace(/^---\n[\s\S]*?\n---\n?/, "")
    .replace(/^#+\s+.*$/gm, "")
    .trim();
  return [...body].slice(0, SNIPPET_CONTEXT).join("").replace(/\n/g, " ").trim();
}

/**
 * 分词器：中英文混合处理。
 * - 英文：按空格/标点切分，保留完整单词，过滤 stop words
 * - 中文：bigram + 单字
 *
 * 导出供 FTS5 预分词复用（006）与 bm25 评测：写入 FTS5 时把 content/title
 * 经此函数分词后以空格拼接存入，查询时对 query 用同一分词，保证中文逻辑一致。
 */
export function tokenize(text: string): string[] {
  const rawTokens = text
    .toLowerCase()
    .split(/[\s,，。！？、；：""''（）()\-_/\\·~～…\[\]【】{}《》<>]+/)
    .filter((t) => t.length > 0);

  const result: string[] = [];
  for (const token of rawTokens) {
    const hasCJK = /[\u4e00-\u9fff\u3400-\u4dbf]/.test(token);
    const hasLatin = /[a-z]/.test(token);

    if (hasCJK && hasLatin) {
      // 混合 token（如 "l0录入"）：拆分中英文部分分别处理
      const parts = token.split(/(?<=[a-z0-9])(?=[\u4e00-\u9fff])|(?<=[\u4e00-\u9fff])(?=[a-z0-9])/);
      for (const part of parts) {
        if (/[\u4e00-\u9fff]/.test(part) && part.length > 1) {
          const chars = [...part];
          for (let i = 0; i < chars.length - 1; i++) result.push(chars[i] + chars[i + 1]);
          result.push(part);
        } else if (part.length > 0 && !STOP_WORDS.has(part)) {
          result.push(part);
        }
      }
    } else if (hasCJK && token.length > 1) {
      // 纯中文：bigram
      const chars = [...token];
      for (let i = 0; i < chars.length - 1; i++) result.push(chars[i] + chars[i + 1]);
      result.push(token);
    } else if (!STOP_WORDS.has(token) && token.length > 0) {
      // 纯英文/数字：保留完整 token
      result.push(token);
    }
  }
  return result;
}

/**
 * FTS5 检索：query → tokenize → 每 token 加 `*` 前缀 → OR 连接 → MATCH。
 * bm25() 越负越相关，取负转成"越大越相关"的正分，供图扩展的 decay/minScore 使用。
 * title_tok 权重 5.0、content_tok 1.0（对齐原 MiniSearch boost title×5）。
 * 注：跨源量纲问题由 searchInternal 的 weightedFuse（两路归一化后加权合并）在排序层解决，
 * 不再靠压低 title 权重——字面与语义在合并时公平共排。
 */
function ftsSearch(db: DatabaseType.Database, query: string, limit: number): Array<{ id: string; score: number }> {
  const toks = tokenize(query);
  if (toks.length === 0) return [];
  const expr = toks.map((t) => `"${t.replace(/"/g, '""')}"*`).join(" OR ");
  const rows = db
    .prepare(
      "SELECT page_id, bm25(wiki_fts, 5.0, 1.0) AS score FROM wiki_fts WHERE wiki_fts MATCH ? ORDER BY score LIMIT ?",
    )
    .all(expr, limit) as Array<{ page_id: string; score: number }>;
  return rows.map((r) => ({ id: r.page_id, score: -r.score }));
}

/**
 * 向量检索（Task 6）：embed 查询 → wiki_vec cosine top-k，distance 映射为 score。
 * 与写入端一致，查询向量用 `Buffer.from(q.buffer)`。async（embed 是网络调用）。
 */
async function searchVector(
  db: DatabaseType.Database,
  embedding: WikiEmbeddingClient,
  query: string,
  limit: number,
): Promise<Array<{ id: string; score: number }>> {
  const q = await embedding.embed(query);
  const rows = db
    .prepare(
      "SELECT page_id, distance FROM wiki_vec WHERE embedding MATCH ? AND k = ? ORDER BY distance",
    )
    .all(Buffer.from(q.buffer), limit) as Array<{ page_id?: string; distance: number | null }>;
  return rows
    .filter(
      (r): r is { page_id: string; distance: number } => !!r.page_id && r.distance !== null,
    )
    .map((r) => ({ id: r.page_id, score: r.distance === 0 ? 1 : 1 / r.distance }));
}

/**
 * Reciprocal Rank Fusion（RRF）：合并 FTS 与向量两路的 rank，交叠项排名更高。
 * `1/(k+i+1)`，k 默认 60（plan Task6 Step2）。纯函数，可单测。
 */
export function rrfMerge(
  fts: Array<{ id: string; score: number }>,
  vec: Array<{ id: string; score: number }>,
  k = 60,
): Array<{ id: string; score: number }> {
  const rank = new Map<string, number>();
  const add = (list: { id: string }[]) =>
    list.forEach((x, i) => rank.set(x.id, (rank.get(x.id) ?? 0) + 1 / (k + i + 1)));
  add(fts);
  add(vec);
  return [...rank.entries()].map(([id, s]) => ({ id, score: s })).sort((a, b) => b.score - a.score);
}

/**
 * 加权归一化融合（方案二：两套分公平合并）。
 *
 * 背景：BM25（关键词）分数无界偏大、向量（语义）分数用 1/distance 偏小，直接混排会让
 * 字面命中把语义相关页压后。RRF 只看名次，无法表达"更信哪一路"。
 * 这里把两路各自 min-max 归一化到 [0,1] 后，按 alpha（语义权重）加权合并——
 * 语义分不再因量纲小被压，字面与语义按固定比例公平共排。
 * 仅用于 hop=0 的主排序；hop>0 图行走仍走 rrfMerge + BM25 seed（见 searchInternal）。
 *
 * @param alpha 语义（向量）路权重，其余 1-alpha 给字面（FTS）路。0.6 表示更信语义。
 */
export function weightedFuse(
  fts: Array<{ id: string; score: number }>,
  vec: Array<{ id: string; score: number }>,
  alpha = 0.6,
): Array<{ id: string; score: number }> {
  const norm = (list: Array<{ id: string; score: number }>): Map<string, number> => {
    const m = new Map<string, number>();
    if (list.length === 0) return m;
    const min = Math.min(...list.map((x) => x.score));
    const max = Math.max(...list.map((x) => x.score));
    const denom = max - min;
    for (const x of list) {
      m.set(x.id, denom === 0 ? 1 : (x.score - min) / denom);
    }
    return m;
  };
  const fN = norm(fts);
  const vN = norm(vec);
  const scores = new Map<string, number>();
  for (const [id, s] of fN) scores.set(id, (scores.get(id) ?? 0) + (1 - alpha) * s);
  for (const [id, s] of vN) scores.set(id, (scores.get(id) ?? 0) + alpha * s);
  return [...scores.entries()].map(([id, s]) => ({ id, score: s })).sort((a, b) => b.score - a.score);
}

/** 事务内重建三张索引表（wiki_fts + page_meta + graph_edge）。由 withWriteDb 调用。 */
function writeIndex(db: DatabaseType.Database, pages: WikiPage[]): void {
  db.prepare("DELETE FROM wiki_fts").run();
  db.prepare("DELETE FROM page_meta").run();
  db.prepare("DELETE FROM graph_edge").run();
  // 向量表：不再在此 DELETE（增量对账统一由 writeVectors 按 sha 处理，见其注释；避免先删后写使增量复用失效）
  const insFts = db.prepare("INSERT INTO wiki_fts(page_id, title_tok, content_tok) VALUES (?,?,?)");
  const insMeta = db.prepare(
    "INSERT INTO page_meta(page_id, title, type, rel_path, snippet) VALUES (?,?,?,?,?)",
  );
  const insEdge = db.prepare("INSERT OR IGNORE INTO graph_edge(source_id, target_id) VALUES (?,?)");

  for (const p of pages) {
    // wiki_fts + page_meta 收录所有页（含 hidden 类型，供检索）。
    insFts.run(p.id, tokenize(p.title).join(" "), tokenize(p.content).join(" "));
    insMeta.run(p.id, p.title, p.type, p.relPath, makeSnippet(p));
  }
  // graph_edge 只在 visible 页间。
  for (const e of resolveEdges(pages)) insEdge.run(e.source, e.target);
}

/** 从读连接加载读模型：页元数据表 + 图（graph_edge 构建的内存图）。 */
function loadReadModel(db: DatabaseType.Database): { pg: PageGraph; metaById: Map<string, PageMeta> } {
  const metaRows = db
    .prepare("SELECT page_id, title, type, rel_path, snippet FROM page_meta ORDER BY page_id")
    .all() as Array<{ page_id: string; title: string | null; type: string | null; rel_path: string | null; snippet: string | null }>;
  const metaById = new Map<string, PageMeta>();
  for (const r of metaRows) {
    metaById.set(r.page_id, {
      id: r.page_id,
      title: r.title ?? "",
      type: r.type ?? "other",
      relPath: r.rel_path ?? "",
      snippet: r.snippet ?? "",
    });
  }
  const edgeRows = db.prepare("SELECT source_id, target_id FROM graph_edge").all() as Array<{
    source_id: string;
    target_id: string;
  }>;
  const pg = buildPageGraphFromDb(metaById, edgeRows);
  return { pg, metaById };
}

// ── Search Constants & Helpers ──

const HOP_LIMIT = 5;
const DEFAULT_LIMIT = 20;
const DEFAULT_HOP = 0;
const DEFAULT_DECAY = 0.5;
const DEFAULT_MIN_SCORE = 0.1;
const RELATED_CAP = 10;
const EXPANSION_CAP = 200;

/**
 * Build the `related` field for one result page (PRD FR-1).
 *
 * Out-link (this → other), in-link (other → this), or both. Same neighbour
 * keeps a single entry. Sort by neighbour degree descending, cap at RELATED_CAP.
 */
function buildRelated(
  pageId: string,
  pg: PageGraph,
  metaById: Map<string, PageMeta>,
): RelatedPage[] {
  const out = pg.outAdj.get(pageId) ?? new Set<string>();
  const inn = pg.inAdj.get(pageId) ?? new Set<string>();
  const all = new Set<string>([...out, ...inn]);
  const items: RelatedPage[] = [];
  for (const nbId of all) {
    const nbMeta = metaById.get(nbId);
    if (!nbMeta) continue;
    const isOut = out.has(nbId);
    const isIn = inn.has(nbId);
    const direction: RelatedPage["direction"] = isOut && isIn ? "both" : isOut ? "out" : "in";
    items.push({ title: nbMeta.title, path: nbMeta.relPath, type: nbMeta.type, direction });
  }
  items.sort((a, b) => {
    const da = pg.degree.get(idFromPath(a.path)) ?? 0;
    const db = pg.degree.get(idFromPath(b.path)) ?? 0;
    return db - da;
  });
  return items.slice(0, RELATED_CAP);
}

function idFromPath(relPath: string): string {
  return relPath.replace(/^wiki\//, "").replace(/\.md$/, "");
}

function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo;
  return Math.min(Math.max(n, lo), hi);
}

/**
 * Build inter-result wikilink edges (PRD FR-2).
 *
 * Only edges where both endpoints are in `resultIds`. Undirected dedup
 * via sorted-pair key. Self-loops were already excluded at graph-build time.
 */
function buildResultLinks(resultIds: string[], pg: PageGraph, metaById: Map<string, PageMeta>): ResultLink[] {
  const inResults = new Set(resultIds);
  const seen = new Set<string>();
  const links: ResultLink[] = [];
  for (const id of resultIds) {
    const meta = metaById.get(id);
    if (!meta) continue;
    const out = pg.outAdj.get(id) ?? new Set<string>();
    for (const target of out) {
      if (!inResults.has(target)) continue;
      const key = [id, target].sort().join(":::");
      if (seen.has(key)) continue;
      seen.add(key);
      const targetMeta = metaById.get(target);
      links.push({
        source: meta.relPath,
        target: targetMeta ? targetMeta.relPath : target,
        weight: 1,
      });
    }
  }
  return links;
}

// ── 初始化模板 ──

function initWikiProject(projectPath: string): void {
  const dirs = ["raw/sources", "wiki/entities", "wiki/concepts", "wiki/sources", "wiki/comparisons", "wiki/synthesis", ".llm-wiki"];
  for (const dir of dirs) mkdirSync(join(projectPath, dir), { recursive: true });
  const defaultFiles: [string, string][] = [
    ["wiki/schema.md", `---\ntype: schema\ntitle: Wiki Schema\n---\n\n${DEFAULT_SCHEMA}\n`],
    ["wiki/purpose.md", `---\ntype: purpose\ntitle: Wiki Purpose\n---\n\n${DEFAULT_PURPOSE}\n`],
    ["wiki/index.md", "---\ntype: index\ntitle: Index\n---\n\n# Index\n\n## Entities\n\n## Concepts\n\n## Sources\n"],
  ];
  for (const [rel, content] of defaultFiles) {
    const full = join(projectPath, rel);
    if (!existsSync(full)) writeFileSync(full, content, "utf-8");
  }
}

// ── Ingest（ingest-v2；增量抽取见设计 003） ──

/** 单源抽取结果（用于事务内登记 source.status）。 */
interface ProcessedSource {
  filename: string;
  sha256: string;
  size: number;
  ok: boolean;
  error: string | null;
}

interface IngestOutcome {
  /** 兼容旧返回：每个被抽取源的 {source, filesWritten, error}。 */
  results: any[];
  /** 本次尝试抽取的源结果（登记 source 状态用）。 */
  processed: ProcessedSource[];
  /** 表中有但磁盘已无 → 待删 source 行。 */
  deletedSources: string[];
}

/**
 * 增量抽取（设计 003 §3.6 + wiki-ingest-optimization）：
 * 阶段1 并行 LLM 抽取 → 已删源级联清理 → 阶段2 串行 merge 落盘 → overview。
 * 不在此更新 source 表 / 不重建索引——那些交由 ingest() 在同一事务内完成（强一致）。
 * 全部失败检测不在此 throw，由上层 WikiSourceManager.ingest 写事务后判定。
 *
 * 导出供编排层单测（进度相位 / skipped / 全失败不 throw）。
 */
export async function runIngestIncremental(
  projectPath: string,
  oldStates: Map<string, { sha256: string; status: SourceStatus }>,
  llmConfig: any,
  onProgress?: ProgressFn,
  globalLlmLimit?: LimitFunction,
): Promise<IngestOutcome> {
  const { extractSource, commitCandidates, scanExistingPages } = await import("./ingest-v2/index.js");
  const report = createThrottledProgressFn(onProgress);
  const sourcesDir = join(projectPath, "raw", "sources");
  if (!existsSync(sourcesDir)) {
    log.warn("runIngest: raw/sources 不存在，跳过", { projectPath });
    return { results: [], processed: [], deletedSources: [...oldStates.keys()] };
  }

  // 扫描磁盘源，算 sha。filename = 相对 sourcesDir 的 posix 路径（与 rawWrite 的 filename 对齐）。
  const disk = findMdFiles(sourcesDir).map((abs) => {
    const content = readFileSync(abs, "utf-8");
    return {
      abs,
      filename: relative(sourcesDir, abs).replace(/\\/g, "/"),
      sha256: sha256(content),
      size: Buffer.byteLength(content, "utf-8"),
    };
  });

  const { toIngest, skipped, deleted } = classifySources(disk, oldStates);
  const skippedCount = skipped.length;
  const toIngestSet = new Set(toIngest);
  const toIngestDisk = disk.filter((d) => toIngestSet.has(d.filename));
  log.info("runIngest 增量分类", {
    projectPath,
    disk: disk.length,
    toIngest: toIngest.length,
    skipped: skipped.length,
    deleted: deleted.length,
  });

  const existingPages = scanExistingPages(projectPath);
  const concurrency = getIngestConcurrency();
  const wikiLimit = pLimit(concurrency);

  // ── 阶段1：并行 LLM 抽取 ──
  report?.({
    phase: "extracting",
    total: toIngestDisk.length,
    completed: 0,
    failed: 0,
    skipped: skippedCount,
    percent: 0,
  });

  let completed = 0;
  let failed = 0;

  const tasks = toIngestDisk.map((d) =>
    wikiLimit(async () => {
      const t0 = Date.now();
      try {
        const candidates = await withSpan("ingest-source", async (span) => {
          span.setAttribute("source.name", d.filename);
          const run = () => extractSource(projectPath, d.abs, llmConfig, existingPages);
          return globalLlmLimit ? globalLlmLimit(run) : run();
        });
        completed++;
        report?.({
          phase: "extracting",
          total: toIngestDisk.length,
          completed,
          failed,
          skipped: skippedCount,
          percent: Math.round(((completed + failed) / Math.max(toIngestDisk.length, 1)) * 90),
        });
        log.info("runIngest 单源抽取完成", {
          source: d.filename,
          candidates: candidates.size,
          ms: Date.now() - t0,
        });
        return { ...d, ok: true as const, candidates, error: null };
      } catch (err) {
        failed++;
        report?.({
          phase: "extracting",
          total: toIngestDisk.length,
          completed,
          failed,
          skipped: skippedCount,
          percent: Math.round(((completed + failed) / Math.max(toIngestDisk.length, 1)) * 90),
        });
        log.error("runIngest 单源抽取失败", {
          source: d.filename,
          ms: Date.now() - t0,
          error: String(err),
        });
        return {
          ...d,
          ok: false as const,
          candidates: new Map<string, string>(),
          error: String(err),
        };
      }
    }),
  );

  const extractResults = await Promise.all(tasks);

  // ── 已删源级联清理（与现有逻辑对齐）──
  if (deleted.length > 0) {
    try {
      const { deleteSourceFiles } = await import("./ingest-v2/cascade.js");
      await deleteSourceFiles(
        projectPath,
        deleted.map((fn) => join(sourcesDir, fn)),
        { logReason: "wiki/ingest/removed-source" },
      );
    } catch (err) {
      log.warn("已删源级联清理失败", { error: String(err) });
    }
  }

  // ── 阶段2：串行落盘合并 ──
  report?.({
    phase: "merging",
    total: toIngestDisk.length,
    completed,
    failed,
    skipped: skippedCount,
    percent: 90,
  });

  const successResults = extractResults.filter((r) => r.ok);
  const allCandidates = successResults.map((r) => ({
    sourceFilename: r.filename,
    candidates: r.candidates,
  }));

  // B-1：仅在有候选需 merge/overview 时建 client；失败不 throw，保证上层仍能写 source 状态。
  // 纯 no-op（toIngest=0）或抽取全失败时不建 client（commit 只 rebuild index，不调 LLM）。
  let llm: import("./ingest-v2/llm.js").LlmClient | undefined;
  if (allCandidates.length > 0) {
    try {
      const { createLlmClient } = await import("./ingest-v2/llm.js");
      llm = createLlmClient(llmConfig);
    } catch (err) {
      log.error("创建 LLM client 失败（阶段2 merge/overview 将降级，source 状态仍会落库）", {
        error: String(err),
      });
    }
  }

  // 无成功抽取时仍可能需要在级联删除后重建 index.md；skipLog 避免空 batch 日志
  const { written, mergeErrors } = await commitCandidates(projectPath, allCandidates, llm, {
    globalLlmLimit,
    skipLog: allCandidates.length === 0,
  });

  if (mergeErrors.length > 0) {
    log.warn("阶段2 合并部分页失败", { count: mergeErrors.length, errors: mergeErrors });
  }

  // ── 源状态判定（必须在 commitCandidates 之后）──
  const processed: ProcessedSource[] = extractResults.map((r) => {
    if (!r.ok) {
      return { filename: r.filename, sha256: r.sha256, size: r.size, ok: false, error: r.error };
    }
    const sourcePages = [...r.candidates.keys()];
    const allMergeFailed =
      sourcePages.length > 0 &&
      sourcePages.every((p) => mergeErrors.some((e) => e.source === r.filename && e.relPath === p)) &&
      !sourcePages.some((p) => written.includes(p));
    return {
      filename: r.filename,
      sha256: r.sha256,
      size: r.size,
      ok: !allMergeFailed,
      error: allMergeFailed ? "all candidates merge failed" : null,
    };
  });

  // ── 阶段3：overview（FTS 索引由上层 ingest 写事务完成）──
  report?.({
    phase: "indexing",
    total: toIngestDisk.length,
    completed,
    failed,
    skipped: skippedCount,
    percent: 98,
  });

  if (successResults.length > 0) {
    if (!llm) {
      log.warn("overview 跳过：LLM client 不可用（不影响摄取）");
    } else {
      try {
        const { generateOverview } = await import("./ingest-v2/overview.js");
        const runOverview = () => generateOverview(projectPath, llm);
        await (globalLlmLimit ? globalLlmLimit(runOverview) : runOverview());
      } catch (err) {
        log.warn("overview 生成失败（不影响摄取）", { error: String(err) });
      }
    }
  }

  const results = extractResults.map((r) => {
    if (!r.ok) return { source: r.filename, filesWritten: [] as string[], error: r.error };
    const sourcePages = [...r.candidates.keys()];
    const filesWritten = sourcePages.filter((p) => written.includes(p));
    return { source: r.filename, filesWritten, error: null };
  });

  const okCount = processed.filter((p) => p.ok).length;
  log.info("runIngest 全部完成", {
    total: results.length,
    ok: okCount,
    failed: results.length - okCount,
    written: written.length,
  });

  // 全部失败检测：不在此处 throw（由上层写事务后判定，保证 source 状态已持久化）。
  return { results, processed, deletedSources: deleted };
}

function findMdFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...findMdFiles(full));
    else if (entry.endsWith(".md") || entry.endsWith(".txt")) files.push(full);
  }
  return files;
}

// ── Factory ──

export function createWikiSourceManager(
  dataDir: string,
  embeddingConfig: WikiEmbeddingConfig | null = null,
): WikiSourceManager {
  const sources = new Map<string, WikiSourceState>();
  const stateFile = join(dataDir, "wiki-sources.json");

  // 知识库向量化：manager 持有 embedding 客户端；未配置/不可用 → null（降级纯 FTS）。
  // vecDim 由 isReady() 决定 → 传入 initIndexDb 决定是否建 wiki_vec。
  const embeddingClient = embeddingConfig ? new WikiEmbeddingClient(embeddingConfig) : null;
  const vecDim = embeddingClient?.isReady() ? embeddingConfig!.dimensions : 0;

  mkdirSync(dataDir, { recursive: true });

  // ── embedding 指纹（spec §6.2）：provider|model|dimensions 变更 → 启动时强制重建向量 ──
  // 注：放在 mkdirSync 之后（指纹文件写盘依赖 dataDir 存在）；启动检测触发在 loadState/restore
  // 之后执行（见文件尾部检测块），否则 sources 尚空，forceRevectorizeAll 会空跑并误写新指纹。
  const fingerprintFile = join(dataDir, "embedding-fingerprint.json");
  const currentFingerprint = embeddingConfig
    ? `${embeddingConfig.provider ?? ""}|${embeddingConfig.model ?? ""}|${embeddingConfig.dimensions ?? 0}`
    : null;

  let vectorStatus: VectorRebuildStatus = { status: "idle" };

  /**
   * 读取已存指纹（F4 损坏判别）：
   * - 文件不存在（ENOENT 等）→ undefined（首次启用路径，采纳当前配置）；
   * - 文件存在但 JSON.parse 失败 / fingerprint 字段无效 → null（损坏，调用方按指纹不一致处理，
   *   保守触发重建 —— 防旧配置向量与新配置混存）。
   */
  function readStoredFingerprint(): string | null | undefined {
    let raw: string;
    try {
      raw = readFileSync(fingerprintFile, "utf-8");
    } catch {
      return undefined; // 文件不存在 → 首次启用路径不变
    }
    try {
      const parsed = JSON.parse(raw) as { fingerprint?: unknown };
      if (typeof parsed.fingerprint === "string" && parsed.fingerprint) return parsed.fingerprint;
      log.warn("embedding 指纹文件存在但缺少有效 fingerprint 字段 → 视为损坏（启动时将触发重建）", { file: fingerprintFile });
      return null;
    } catch (err) {
      log.warn("embedding 指纹文件存在但内容损坏（JSON 解析失败）→ 视为指纹不一致（启动时将触发重建）", {
        file: fingerprintFile,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
  function writeStoredFingerprint(fp: string): void {
    writeFileSync(fingerprintFile, JSON.stringify({ fingerprint: fp, updatedAt: new Date().toISOString() }), "utf-8");
  }

  /**
   * 强制全量重建所有 ready wiki 的向量索引（绕过 content_sha 复用）。
   * F3 诚实语义：返回 true=本次调用真正启动了新一轮（完成/失败路径均算已启动）；
   * false=被 running 重入守卫拒绝（或 embedding 未就绪，无事可做）。
   * 注意：守卫检查在首个 await 前同步完成，故拒绝方结果微任务级即决。
   */
  async function forceRevectorizeAll(): Promise<boolean> {
    // 重入守卫（防双循环并发）：withWriteAsync 每次新开独立写连接、无写队列，重建运行期间
    // 再次触发会导致重复 embed、vectorStatus 互相覆盖、指纹双写 —— 一律拒绝。
    if (vectorStatus.status === "running") {
      log.warn("forceRevectorizeAll: 已有重建在运行，忽略本次重复触发", { startedAt: vectorStatus.startedAt });
      return false;
    }
    if (!embeddingClient?.isReady() || !currentFingerprint) return false;
    vectorStatus = { status: "running", reason: "embedding fingerprint changed", startedAt: new Date().toISOString() };
    try {
      let totalEmbedded = 0, totalFailed = 0, degradedWikis = 0;
      for (const state of sources.values()) {
        if (state.status !== "ready") continue;
        const pages = scanWikiDir(state.path);
        initIndexDb(state.path, vecDim); // 维度不匹配 → DROP wiki_vec 重建（index-db.ts 既有行为）
        const stats = await writeVectors(state.path, pages, { force: true }); // 绕过 content_sha 复用
        totalEmbedded += stats.embedded;
        totalFailed += stats.failed;
        if (stats.degraded) degradedWikis++;
      }
      // 保守裁决（宁缺毋滥、防混存）：只要有任何页 embed 失败或整体降级，就置 failed 且
      // 不写指纹 —— 成功页已是新配置向量、失败页残留旧配置向量，此时写指纹会把"半新半旧"
      // 的混存状态固化（下次重启不再重跑）。故部分失败（partial）也按失败处理，下次重启重跑。
      if (degradedWikis > 0 || totalFailed > 0) {
        const reason = degradedWikis > 0
          ? `force 重建失败：${degradedWikis} 个 wiki 向量写入降级（连接/schema 异常），embedded=${totalEmbedded} failed=${totalFailed}，指纹未写、下次重启重跑`
          : `force 重建部分失败（partial）：embedded=${totalEmbedded} failed=${totalFailed}，指纹未写、下次重启重跑`;
        vectorStatus = {
          status: "failed",
          reason,
          startedAt: vectorStatus.startedAt,
          finishedAt: new Date().toISOString(),
        };
        log.error("forceRevectorizeAll 失败（状态已置 failed，指纹未写）", { reason });
        return true;
      }
      // 指纹在全部完成后才写入：中途崩溃 → 文件仍旧值 → 下次重启重新检测并重跑（防半新半旧混存）
      writeStoredFingerprint(currentFingerprint);
      vectorStatus = { ...vectorStatus, status: "done", finishedAt: new Date().toISOString() };
      log.info("forceRevectorizeAll 完成", { finishedAt: vectorStatus.finishedAt, embedded: totalEmbedded });
      return true;
    } catch (err) {
      vectorStatus = {
        status: "failed",
        reason: err instanceof Error ? err.message : String(err),
        startedAt: vectorStatus.startedAt,
        finishedAt: new Date().toISOString(),
      };
      log.error("forceRevectorizeAll 失败（状态已置 failed）", { error: vectorStatus.reason });
      return true;
    }
  }

  function persist() {
    writeFileSync(stateFile, JSON.stringify(Object.fromEntries(sources.entries()), null, 2), "utf-8");
  }

  function loadState() {
    if (!existsSync(stateFile)) return;
    try {
      const raw = JSON.parse(readFileSync(stateFile, "utf-8"));
      for (const [name, state] of Object.entries<any>(raw)) {
        if (state.status === "scanning") { state.status = "error"; state.error = "Restart"; }
        sources.set(name, state);
      }
    } catch { /* fresh start */ }
  }

  function scanWikiDir(projectPath: string): WikiPage[] {
    const wikiDir = join(projectPath, "wiki");
    if (!existsSync(wikiDir)) throw new Error(`wiki/ not found: ${wikiDir}`);
    const pages: WikiPage[] = [];
    scanRecursive(wikiDir, wikiDir, pages);
    return pages;
  }

  function scanRecursive(baseDir: string, dir: string, pages: WikiPage[]) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) { if (entry !== "media") scanRecursive(baseDir, full, pages); }
      else if (entry.endsWith(".md")) {
        try {
          const content = readFileSync(full, "utf-8");
          const rel = full.slice(baseDir.length + 1);
          const id = rel.replace(/\.md$/, "").replace(/\\/g, "/");
          const fm = extractFrontmatter(content);
          pages.push({ id, title: fm.title || basename(entry, ".md").replace(/-/g, " "), type: fm.type, path: full, relPath: `wiki/${rel}`, content, sources: fm.sources, links: extractWikilinks(content), description: fm.description });
        } catch { /* skip */ }
      }
    }
  }

  /** 重建 wiki 的 index.db 索引（幂等建库 → 事务重建三表 → 驱逐读连接防 stale）。 */
  function rebuildIndex(name: string, pages: WikiPage[]) {
    const state = sources.get(name);
    if (!state) throw new Error(`rebuildIndex: unknown wiki ${name}`);
    initIndexDb(state.path, vecDim); // 幂等：首次注册即建库+4表（+embedding 启用时建 wiki_vec）；已存在则无操作
    withWriteDb(state.path, (db) => writeIndex(db, pages));
    // 向量异步落库：embed 是 async 不能进同步事务，独立写连接逐条写（允许部分成功）。
    void writeVectors(state.path, pages);
    evictWikiDb(name); // 丢弃可能持有旧快照的读连接，下次查询重开
  }

  /**
   * 向量落库（整体重建的异步写入）：embedding 启用且 wiki_vec 存在时，对每页正文 embed 后
   * INSERT OR REPLACE 进 wiki_vec。在 withWriteDb 同步事务之外、独立写连接逐条写；
   * 单页 embed 失败跳过该页（仍走 FTS），连接/schema 异常整体静默降级纯 FTS，不中断 rebuild。
   * 结构页（导航/元数据/索引页，见 isStructuralPage）不参与向量化：跳过 embed，其旧向量
   * 由末尾孤儿清理统一删除（不进 ids → 落孤儿）。
   *
   * 返回统计 { embedded, failed, degraded? }：既有非 force 调用方（rebuildIndex / ingest）
   * 本就吞掉失败继续，忽略返回值、语义不变；forceRevectorizeAll 据此判定失败可见性
   * （degraded=true = 连接/schema 异常整体降级）。
   */
  async function writeVectors(
    projectPath: string,
    pages: WikiPage[],
    opts?: { force?: boolean },
  ): Promise<{ embedded: number; failed: number; degraded?: boolean }> {
    if (!embeddingClient) return { embedded: 0, failed: 0 }; // 未启用 embedding → 纯 FTS
    const t0 = Date.now();
    try {
      const stats = await withWriteAsync(projectPath, async (db): Promise<{ embedded: number; failed: number }> => {
        const has = db
          .prepare("SELECT count(*) c FROM sqlite_master WHERE type='table' AND name='wiki_vec'")
          .get() as { c: number };
        if (!has || !has.c) { log.debug("writeVectors: wiki_vec 不存在 → 降级纯 FTS", { projectPath }); return { embedded: 0, failed: 0 }; }

        // 读当前 (page_id, content_sha)，用于增量复用判断
        const existing = new Map<string, string>();
        for (const r of db.prepare("SELECT page_id, content_sha FROM wiki_vec").all() as any[]) {
          if (r.page_id !== null && r.page_id !== undefined) existing.set(String(r.page_id), String(r.content_sha ?? ""));
        }

        const delVec = db.prepare("DELETE FROM wiki_vec WHERE page_id = ?");
        const insVec = db.prepare(
          "INSERT INTO wiki_vec(page_id, embedding, updated_time, content_sha) VALUES (?,?,?,?)",
        );
        const ids = new Set<string>();
        let reused = 0, embedded = 0, failed = 0, skippedStructural = 0;
        for (const p of pages) {
          // 结构页不嵌入、也不进 ids → 其旧向量由末尾孤儿清理删除
          if (isStructuralPage(p)) { skippedStructural++; continue; }
          ids.add(p.id);
          const sha = contentSha256(p.content);
          // 复用：内容未变 且 该页已有向量 → 跳过 embed（省调用）；force（embedding 变更重建）时绕过
          if (!opts?.force && existing.has(p.id) && existing.get(p.id) === sha) { reused++; continue; }
          try {
            const vec = await embeddingClient.embed(p.content);
            // ⚠️ vec0 虚拟表不支持 `INSERT OR REPLACE`（对已存在 page_id 抛 UNIQUE 冲突），
            //    刷新变更页必须先 DELETE 再 INSERT。
            delVec.run(p.id);
            insVec.run(p.id, Buffer.from(vec.buffer), new Date().toISOString(), sha);
            embedded++;
          } catch (err) {
            failed++;
            // 单页 embed 失败 → 跳过该页向量，仍走 FTS
            log.warn("writeVectors: 单页 embed 失败，跳过该页向量", { projectPath, page: p.id, error: err instanceof Error ? err.message : String(err) });
          }
        }
        // 末尾清理孤儿：删除不再属于当前页集合的旧向量（删页对账）
        let orphanDeleted = 0;
        if (existing.size > 0) {
          for (const pid of existing.keys()) {
            if (!ids.has(pid)) { db.prepare("DELETE FROM wiki_vec WHERE page_id = ?").run(pid); orphanDeleted++; }
          }
        }
        log.info("writeVectors 完成（增量对账）", { projectPath, pages: pages.length, existing: existing.size, reused, embedded, failed, skippedStructural, orphanDeleted, ms: Date.now() - t0 });
        return { embedded, failed };
      });
      return stats ?? { embedded: 0, failed: 0 };
    } catch (err) {
      // 连接/schema 异常 → 静默降级纯 FTS；degraded=true 上报给 force 调用方判定失败可见
      log.error("writeVectors 降级纯 FTS（连接/schema 异常）", { projectPath, error: err instanceof Error ? err.message : String(err) });
      return { embedded: 0, failed: 0, degraded: true };
    }
  }

  async function searchInternal(name: string, query: string, limit: number, options: SearchOptions): Promise<SearchResponse> {
    const state = sources.get(name);
    if (!state) return { results: [], links: [], count: 0 };

    let db: DatabaseType.Database;
    try {
      db = getReadDb(name, state.path);
    } catch {
      // 库不存在（wiki 未 ingest/未建索引）→ 返回空，与旧"无引擎"行为一致。
      return { results: [], links: [], count: 0 };
    }

    const hop = clamp(options.hop ?? DEFAULT_HOP, 0, HOP_LIMIT);
    const decay = clamp(options.decay ?? DEFAULT_DECAY, 0, 1);
    const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
    const finalLimit = limit > 0 ? limit : DEFAULT_LIMIT;

    // Pull a slightly oversized seed pool so graph expansion still has something
    // to walk from when `limit` is small but `hop>0` is requested.
    const seedPoolSize = Math.max(finalLimit, hop > 0 ? finalLimit * 2 : finalLimit);
    const rawSeeds = ftsSearch(db, query, seedPoolSize); // BM25 尺度
    // 向量检索（embedding 可用时）；失败/未启用 → vecSeeds 空 → 纯 FTS。
    let vecSeeds: Array<{ id: string; score: number }> = [];
    if (embeddingClient) {
      try {
        vecSeeds = await searchVector(db, embeddingClient, query, seedPoolSize);
      } catch (err) {
        // 降级纯 FTS（与现状一致）
        log.warn("searchInternal: 向量检索失败，降级纯 FTS", { wiki: name, error: err instanceof Error ? err.message : String(err) });
      }
    }
    log.debug("searchInternal 混合检索", { wiki: name, query: query.slice(0, 80), ftsSeeds: rawSeeds.length, vecSeeds: vecSeeds.length, strategy: embeddingClient ? (rawSeeds.length>0 && vecSeeds.length>0 ? "hybrid" : vecSeeds.length>0 ? "vec" : "fts") : "fts" });
    // 排序融合：
    //  hop=0（默认）→ weightedFuse：两套分各自归一化 + 加权（语义0.6/字面0.4），治"字面把语义压后"。
    //  hop>0 → 仍用 rrfMerge（名次融合），图行走以 BM25 尺度 rawSeeds 为 seed（F-1）。
    // score 字段：hop=0 用融合分（[0,1] 可比）；hop>0 保留 seedScore（原始尺度，供图行走门槛）。
    const fusedRank = weightedFuse(rawSeeds, vecSeeds, 0.6);
    const mergedRank = rrfMerge(rawSeeds, vecSeeds);
    if (mergedRank.length === 0) {
      return { results: [], links: [], count: 0 };
    }
    const seedScore = new Map<string, number>();
    for (const s of rawSeeds) seedScore.set(s.id, s.score); // FTS 命中保留 BM25 分
    for (const v of vecSeeds) if (!seedScore.has(v.id)) seedScore.set(v.id, v.score); // 向量独有补 distance 分
    const fusedScore = new Map<string, number>();
    for (const f of fusedRank) fusedScore.set(f.id, f.score); // 归一化加权融合分

    const { pg, metaById } = loadReadModel(db);

    const orderIdx = new Map(mergedRank.map((r, i) => [r.id, i]));
    const byRank = (a: string, b: string) => (orderIdx.get(a) ?? Infinity) - (orderIdx.get(b) ?? Infinity);
    let hits: { id: string; score: number; hop: number; via?: string }[];
    if (hop === 0) {
      hits = fusedRank
        .slice(0, finalLimit)
        .map((s) => ({ id: s.id, score: fusedScore.get(s.id) ?? s.score, hop: 0 }));
    } else {
      // hop>0：图行走用 BM25 尺度 rawSeeds 作 seed（RRF 小尺度会被 graphMultiHopSearch 的
      // minScore 门槛过滤成空，见 F-1）；行走结果 + 向量独有结果按 RRF 排序后输出
      // （向量命中 hop=0 / via=undefined）。
      const walked = graphMultiHopSearch(pg.graph, rawSeeds, { hop, decay, minScore, maxNodes: EXPANSION_CAP });
      const walkedIds = new Set(walked.map((h) => h.id));
      const vecOnly: Array<{ id: string; score: number; hop: number; via?: string }> = vecSeeds
        .filter((v) => !walkedIds.has(v.id))
        .map((v) => ({ id: v.id, score: seedScore.get(v.id) ?? v.score, hop: 0 }));
      hits = [...walked, ...vecOnly].sort((a, b) => byRank(a.id, b.id)).slice(0, finalLimit);
    }

    const results: SearchResult[] = [];
    const resultIds: string[] = [];
    // 向量通道原始相关分（未归一化），供绝对门控校准；仅 hop=0 命中且向量可用时带出。
    const vecRaw = new Map<string, number>(
      vecSeeds.filter((v) => Number.isFinite(v.score)).map((v) => [v.id, v.score]),
    );
    for (const hit of hits) {
      const meta = metaById.get(hit.id);
      if (!meta) continue;
      const result: SearchResult = {
        path: meta.relPath,
        title: meta.title,
        snippet: meta.snippet,
        score: hit.score,
        type: meta.type,
        ...(hit.hop === 0 && vecRaw.has(hit.id) ? { absScore: vecRaw.get(hit.id) } : {}),
        hop: hit.hop,
        related: buildRelated(meta.id, pg, metaById),
      };
      if (hit.hop > 0 && hit.via) result.via = hit.via;
      results.push(result);
      resultIds.push(meta.id);
    }

    const links = buildResultLinks(resultIds, pg, metaById);
    return { results, links, count: results.length };
  }

  loadState();
  // 启动时恢复 BM25 搜索索引（重建每个 ready wiki 的 index.db / pagesMap / searchEngines）。
  // loadState 只恢复元数据（sources map）；索引数据虽持久，但为对齐磁盘正文并避免
  // search / pages / graph 在重启后返回空，仍从磁盘扫描重建一次。
  log.info("Restoring wiki indexes", { count: sources.size });
  let restored = 0;
  let failed = 0;
  for (const [name, state] of sources.entries()) {
    if (state.status !== "ready") {
      log.debug("Skip non-ready wiki source", { name, status: state.status });
      continue;
    }
    const wikiDir = join(state.path, "wiki");
    if (!existsSync(wikiDir)) {
      log.warn("Wiki dir missing on disk; mark error and skip restore", { name, path: state.path });
      state.status = "error";
      state.error = `wiki dir not found: ${wikiDir}`;
      failed++;
      continue;
    }
    try {
      const pages = scanWikiDir(state.path);
      rebuildIndex(name, pages);
      restored++;
      log.info("Restored wiki index", { name, pageCount: pages.length });
    } catch (err) {
      failed++;
      log.error("Failed to restore wiki index", { name, error: err instanceof Error ? err.message : String(err) });
      state.status = "error";
      state.error = err instanceof Error ? err.message : String(err);
    }
  }
  log.info("Wiki restore complete", { restored, failed, total: sources.size });

  // 启动时检测（F4）：stored === undefined（文件缺失）= 首次启用指纹 → 采纳当前配置
  // （现网向量即当前配置所建）；stored === null（文件损坏）视为指纹不一致 → 保守触发重建
  // （防旧配置向量混存）；其余按值比对。
  // （放在 loadState/restore 之后：sources 已就绪，forceRevectorizeAll 才能遍历到 wiki 源）
  const stored = readStoredFingerprint();
  if (currentFingerprint && stored === undefined) {
    writeStoredFingerprint(currentFingerprint);
  } else if (currentFingerprint && stored !== currentFingerprint) {
    log.warn("embedding 配置变更或指纹损坏 → 启动时强制重建向量索引（期间向量召回降级 FTS）", { stored, current: currentFingerprint });
    void forceRevectorizeAll();
  }

  function register(config: WikiSourceConfig): WikiSourceState {
    const existing = sources.get(config.name);
    if (existing) return existing;
    const state: WikiSourceState = { name: config.name, path: config.path, status: "scanning" };
    sources.set(config.name, state);
    try {
      const pages = scanWikiDir(config.path);
      rebuildIndex(config.name, pages);
      state.status = "ready"; state.pageCount = pages.length; state.lastSyncAt = new Date().toISOString();
    } catch (err) { state.status = "error"; state.error = String(err); }
    persist();
    return state;
  }

  function sync(name: string): WikiSourceState {
    const state = sources.get(name);
    if (!state) throw new Error(`Not found: ${name}`);
    state.status = "scanning";
    const t0 = Date.now();
    try {
      const pages = scanWikiDir(state.path);
      rebuildIndex(name, pages);
      state.status = "ready"; state.pageCount = pages.length; state.lastSyncAt = new Date().toISOString(); state.error = undefined;
      log.info("sync 完成（索引已重建）", { name, pageCount: pages.length, ms: Date.now() - t0 });
    } catch (err) {
      state.status = "error"; state.error = String(err);
      log.error("sync 失败", { name, path: state.path, error: String(err) });
    }
    persist();
    return state;
  }

  function init(config: WikiSourceConfig): WikiSourceState {
    initWikiProject(config.path);
    return register(config);
  }

  async function ingest(name: string, llmConfig: any, opts?: IngestExecOptions): Promise<any[]> {
    const state = sources.get(name);
    if (!state) throw new Error(`Not found: ${name}`);
    const projectPath = state.path;
    initIndexDb(projectPath, vecDim); // 确保 index.db 存在（register 通常已建，幂等）

    // 读上次 source 状态（增量判断基线）——须在抽取前读取。
    let oldStates = new Map<string, { sha256: string; status: SourceStatus }>();
    try {
      oldStates = readSourceStates(getReadDb(name, projectPath));
    } catch {
      /* 库刚建 / 无 source 行 → 全部视为新增 */
    }

    const outcome = await withSpan("wiki-ingest", async (span) => {
      span.setAttribute("wiki.name", name);
      return runIngestIncremental(
        projectPath,
        oldStates,
        llmConfig,
        opts?.onProgress,
        opts?.globalLlmLimit,
      );
    });

    // 重建索引 + 登记 source 状态 + 删已删源行：**同一写事务**（设计 003 §3.6 step 6，强一致）。
    state.status = "scanning";
    const t0 = Date.now();
    try {
      const pages = scanWikiDir(projectPath);
      withWriteDb(projectPath, (db) => {
        writeIndex(db, pages);
        for (const p of outcome.processed) recordSourceIngestResult(db, p);
        if (outcome.deletedSources.length > 0) deleteSources(db, outcome.deletedSources);
      });
      // 向量异步落库：embed 是 async 不能进同步事务，独立写连接逐条写（允许部分成功）。
      await writeVectors(projectPath, pages);
      evictWikiDb(name); // 丢弃可能持旧快照的读连接

      const attempted = outcome.processed.length;
      const failed = outcome.processed.filter((p) => !p.ok);
      if (attempted > 0 && failed.length === attempted) {
        const first = failed[0];
        throw new Error(
          `all source documents failed to ingest${first ? `; first failure: ${first.filename}: ${first.error ?? "unknown"}` : ""}`,
        );
      }

      state.status = "ready";
      state.pageCount = pages.length;
      state.lastSyncAt = new Date().toISOString();
      state.error = undefined;
      log.info("ingest 完成（增量抽取 + 索引/源状态同事务重建）", {
        name,
        pageCount: pages.length,
        extracted: outcome.processed.length,
        failed: failed.length,
        ms: Date.now() - t0,
      });
    } catch (err) {
      state.status = "error";
      state.error = String(err);
      log.error("ingest 失败", { name, path: projectPath, error: String(err) });
      persist();
      throw err;
    }
    persist();
    return outcome.results;
  }

  return {
    register, sync, init, ingest,
    get: (name) => sources.get(name),
    list: () => [...sources.values()],
    remove: (name) => {
      const state = sources.get(name);
      sources.delete(name);
      // 先关读连接（内部 checkpoint+close），目录 rmSync 由调用方（wiki-service/route）负责。
      evictWikiDb(name);
      if (state) { /* index.db 随目录删除一并清理 */ }
      persist();
    },
    search: (name, query, limit, options) => searchInternal(name, query, limit ?? DEFAULT_LIMIT, options ?? {}),
    embeddingClient,
    vectorStatus: (): VectorRebuildStatus => vectorStatus,
    forceRevectorizeAll,
    graph: (name) => {
      const state = sources.get(name);
      if (!state) return { nodes: [], edges: [], communities: [] };
      try {
        const db = getReadDb(name, state.path);
        return loadReadModel(db).pg.view;
      } catch {
        return { nodes: [], edges: [], communities: [] };
      }
    },
    readPage: (name, relPath) => {
      const state = sources.get(name);
      if (!state) return null;

      // 支持 raw/ 前缀：直接从项目根读取
      if (relPath.startsWith("raw/")) {
        const fullPath = join(state.path, relPath);
        if (!fullPath.startsWith(join(state.path, "raw"))) return null; // 防路径穿越
        try { return readFileSync(fullPath, "utf-8"); } catch {}
        if (!relPath.endsWith(".md")) {
          try { return readFileSync(fullPath + ".md", "utf-8"); } catch {}
        }
        return null;
      }

      // 支持多种格式：
      //   "wiki/concepts/l0-录入.md" → 完整 relPath
      //   "concepts/l0-录入.md"      → 去掉 wiki/ 前缀
      //   "concepts/l0-录入"         → id 格式（不带 .md）
      const cleanPath = relPath.replace(/^wiki\//, "");
      const base = join(state.path, "wiki");
      let fullPath = join(base, cleanPath);
      if (!fullPath.startsWith(base)) return null;
      // 先直接尝试，再补 .md
      try { return readFileSync(fullPath, "utf-8"); } catch {}
      if (!cleanPath.endsWith(".md")) {
        try { return readFileSync(fullPath + ".md", "utf-8"); } catch {}
      }
      return null;
    },
    getPages: (name) => {
      const state = sources.get(name);
      if (!state) return [];
      try { return scanWikiDir(state.path); } catch { return []; }
    },
  };
}
