/**
 * CodeGraph Bridge — 封装 @colbymchenry/codegraph 的核心 API。
 *
 * 将 CodeGraph 实例 + ToolHandler 包装为简洁的调用接口，
 * 上层 API 只需调 bridge 方法即可，不直接依赖 codegraph 内部结构。
 */

import { createRequire } from "node:module";
import { pathToFileURL } from "url";
import { createLogger } from "../../logger.js";

const log = createLogger("bridge");

let _codegraphModule: any = null;
let _toolsModule: any = null;

/**
 * 解析 ToolHandler 所在的 mcp/tools 模块路径。
 *
 * npm 主包的入口是 npm-sdk.js，它在运行时 require 平台包
 * （如 @colbymchenry/codegraph-linux-x64）的 lib/dist/index.js。
 * mcp/tools.js 在平台包的 lib/dist/mcp/ 下。必须从 npm 主包的路径解析：
 * pnpm 的 strict 隔离不会把主包的 optional dependency 暴露给 KS 根目录。
 */
export function resolveToolsPath(): string {
  const appRequire = createRequire(import.meta.url);
  const platform = `${process.platform}-${process.arch}`;
  const toolsSpecifier = `@colbymchenry/codegraph-${platform}/lib/dist/mcp/tools.js`;
  try {
    const codegraphEntry = appRequire.resolve("@colbymchenry/codegraph");
    const codegraphRequire = createRequire(codegraphEntry);
    return codegraphRequire.resolve(toolsSpecifier);
  } catch {
    throw new Error(
      `codegraph: platform package @colbymchenry/codegraph-${platform} not installed or missing mcp/tools.js. ` +
      `Run: pnpm add @colbymchenry/codegraph`,
    );
  }
}

async function loadModules() {
  if (_codegraphModule) {
    return extractExports();
  }

  const toolsPath = resolveToolsPath();
  log.info("Loading codegraph from npm package");
  _codegraphModule = await import("@colbymchenry/codegraph");
  _toolsModule = await import(pathToFileURL(toolsPath).href);
  log.info("Loaded codegraph from npm package", {
    indexKeys: Object.keys(_codegraphModule),
    toolsKeys: Object.keys(_toolsModule),
  });
  return extractExports();
}

/**
 * CJS 包在 ESM 下 `import()` 会被包成 `{ default: module.exports }`；
 * CJS 模式（tsx）下 `import()` 被转成 `require()`，返回的是展开对象。
 * 这里统一展开，两种模式都能正确取到导出。
 */
function unwrapCjs<T>(mod: T): T {
  const m = mod as unknown as { default?: unknown };
  return m && typeof m === "object" && m.default && typeof m.default === "object"
    ? (m.default as T)
    : mod;
}

function extractExports() {
  const cg = unwrapCjs(_codegraphModule);
  const tools = unwrapCjs(_toolsModule);
  return {
    CodeGraph: cg.CodeGraph,
    ToolHandler: tools.ToolHandler,
    isInitialized: cg.isInitialized,
    getCodeGraphDir: cg.getCodeGraphDir,
  };
}

export interface CodeGraphInstance {
  cg: any;
  handler: any;
  projectRoot: string;
}

export interface CodeGraphStructureNode {
  id: string;
  kind: string;
  name: string;
  qualifiedName: string;
  filePath: string;
  language: string;
  startLine: number;
  endLine: number;
  signature: string;
  isExported: boolean;
}

export interface CodeGraphStructureEdge {
  source: string;
  target: string;
  kind: string;
  line: number;
}

export interface ListGraphOptions {
  kinds?: string[];
  edgeKinds?: string[];
  limit?: number;
  offset?: number;
}

export interface ListGraphResult {
  nodes: CodeGraphStructureNode[];
  edges: CodeGraphStructureEdge[];
  total: number;
  truncated: boolean;
}

const DEFAULT_GRAPH_KINDS = ["file", "class", "function"];
const DEFAULT_GRAPH_EDGE_KINDS = ["calls", "imports", "contains"];

function asString(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asBool(value: unknown): boolean {
  return value === true;
}

function nodeIdOf(node: Record<string, unknown>, index: number): string {
  const id = node.id ?? node.nodeId ?? node.node_id;
  return id == null ? `n${index}` : String(id);
}

function mapStructureNode(node: unknown, index: number): CodeGraphStructureNode {
  const n = (node && typeof node === "object" ? node : {}) as Record<string, unknown>;
  return {
    id: nodeIdOf(n, index),
    kind: asString(n.kind ?? n.type),
    name: asString(n.name ?? n.label),
    qualifiedName: asString(n.qualifiedName ?? n.qualified_name ?? n.fqn),
    filePath: asString(n.filePath ?? n.file_path ?? n.file ?? n.path),
    language: asString(n.language ?? n.lang),
    startLine: asNumber(n.startLine ?? n.start_line ?? n.line),
    endLine: asNumber(n.endLine ?? n.end_line),
    signature: asString(n.signature),
    isExported: asBool(n.isExported ?? n.is_exported ?? n.exported),
  };
}

function collectNodesByKind(cg: any, kind: string): unknown[] {
  if (typeof cg?.iterateNodesByKind === "function") {
    const iter = cg.iterateNodesByKind(kind);
    if (iter && typeof iter[Symbol.iterator] === "function") return [...iter];
    if (Array.isArray(iter)) return iter;
  }
  if (typeof cg?.getNodesByKind === "function") {
    const rows = cg.getNodesByKind(kind);
    return Array.isArray(rows) ? rows : [];
  }
  return [];
}

/**
 * Read a paged structure graph. Never calls getAllNodes().
 * Nodes are collected per kind, then sliced [offset, offset+limit].
 * Edges come from getOutgoingEdgesFrom(pageIds, edgeKinds) and drop targets outside the page.
 */
export function listGraph(instance: CodeGraphInstance, opts: ListGraphOptions = {}): ListGraphResult {
  const kinds = opts.kinds && opts.kinds.length > 0 ? opts.kinds : DEFAULT_GRAPH_KINDS;
  const edgeKinds = opts.edgeKinds && opts.edgeKinds.length > 0 ? opts.edgeKinds : DEFAULT_GRAPH_EDGE_KINDS;
  const limit = opts.limit ?? 80;
  const offset = opts.offset ?? 0;
  const cg = instance.cg;

  const collected: unknown[] = [];
  for (const kind of kinds) {
    collected.push(...collectNodesByKind(cg, kind));
  }
  const total = collected.length;
  const pageRaw = collected.slice(offset, offset + limit);
  const nodes = pageRaw.map((node, i) => mapStructureNode(node, offset + i));
  const pageIds = nodes.map((n) => n.id);
  const idSet = new Set(pageIds);

  let rawEdges: unknown[] = [];
  if (pageIds.length > 0 && typeof cg?.getOutgoingEdgesFrom === "function") {
    const edges = cg.getOutgoingEdgesFrom(pageIds, edgeKinds);
    rawEdges = Array.isArray(edges) ? edges : [];
  }
  const edges: CodeGraphStructureEdge[] = [];
  for (const edge of rawEdges) {
    const e = (edge && typeof edge === "object" ? edge : {}) as Record<string, unknown>;
    const source = asString(e.source ?? e.from ?? e.sourceId ?? e.source_id);
    const target = asString(e.target ?? e.to ?? e.targetId ?? e.target_id);
    if (!idSet.has(source) || !idSet.has(target)) continue;
    edges.push({
      source,
      target,
      kind: asString(e.kind ?? e.type),
      line: asNumber(e.line ?? e.startLine ?? e.start_line),
    });
  }

  return {
    nodes,
    edges,
    total,
    truncated: offset + nodes.length < total,
  };
}

/**
 * 打开一个已存在的 codegraph 索引。
 */
export async function openIndex(projectPath: string): Promise<CodeGraphInstance> {
  log.info("openIndex", { projectPath });
  const { CodeGraph, ToolHandler } = await loadModules();
  const cg = await CodeGraph.open(projectPath);
  const stats = cg.getStats();
  log.info("openIndex complete", { projectPath, stats });
  const handler = new ToolHandler(cg);
  // 告诉 ToolHandler 项目根在哪，避免它拿进程 cwd 做 worktree 检测导致误报
  if (typeof handler.setDefaultProjectHint === "function") {
    handler.setDefaultProjectHint(projectPath);
  }
  return { cg, handler, projectRoot: projectPath };
}

/**
 * 对一个项目目录进行全量索引。
 */
export async function indexProject(projectPath: string): Promise<CodeGraphInstance> {
  log.info("indexProject start", { projectPath });
  const { CodeGraph, ToolHandler, isInitialized } = await loadModules();

  const initialized = isInitialized(projectPath);
  log.debug("isInitialized check", { projectPath, initialized });

  let cg: any;
  if (initialized) {
    // 已有索引，打开并重新全量索引
    log.info("Re-indexing existing project");
    cg = await CodeGraph.open(projectPath);
    await cg.indexAll();
  } else {
    // 首次初始化：创建目录结构 + DB + 全量索引
    log.info("First-time init + index");
    cg = await CodeGraph.init(projectPath, { index: true });
  }

  const stats = cg.getStats();
  log.info("indexProject complete", { projectPath, stats });

  const handler = new ToolHandler(cg);
  if (typeof handler.setDefaultProjectHint === "function") {
    handler.setDefaultProjectHint(projectPath);
  }
  log.debug("ToolHandler created", { availableTools: Object.keys(handler.tools || handler._tools || {}) });
  return { cg, handler, projectRoot: projectPath };
}

/**
 * 增量同步（只处理变化的文件）。
 */
export async function syncIndex(instance: CodeGraphInstance): Promise<{ changed: number }> {
  log.info("syncIndex start", { projectRoot: instance.projectRoot });
  const result = await instance.cg.sync();
  const changed = result?.filesChanged ?? 0;
  log.info("syncIndex complete", { changed });
  return { changed };
}

/**
 * 执行 codegraph MCP 工具（复用 ToolHandler 的格式化输出）。
 */
export async function executeTool(
  instance: CodeGraphInstance,
  toolName: string,
  params: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  log.info("executeTool", { toolName, params, projectRoot: instance.projectRoot });

  // 检查 handler 实例状态
  log.debug("handler state", {
    handlerType: typeof instance.handler,
    handlerKeys: Object.keys(instance.handler),
    hasExecute: typeof instance.handler.execute === "function",
  });

  const result = await instance.handler.execute(toolName, params);

  log.debug("executeTool raw result", {
    toolName,
    resultKeys: Object.keys(result || {}),
    contentLength: result?.content?.length,
    content0: result?.content?.[0],
    isError: result?.isError,
  });

  const text = result.content?.[0]?.text ?? "";
  const isError = result.isError ?? false;

  log.info("executeTool response", { toolName, isError, textLength: text.length, textPreview: text.slice(0, 200) });
  return { text, isError };
}

/**
 * 获取索引统计信息。
 */
export function getStats(instance: CodeGraphInstance) {
  const stats = instance.cg.getStats();
  log.debug("getStats", { stats });
  return stats;
}

/**
 * 关闭索引（释放 SQLite 连接）。
 */
export function closeIndex(instance: CodeGraphInstance): void {
  log.info("closeIndex", { projectRoot: instance.projectRoot });
  try {
    instance.cg.close?.();
  } catch {
    // best-effort
  }
}
