/**
 * Knowledge Module Factory — assembles store / services / engines / workers / restart recovery.
 *
 * Outputs `KnowledgeModule` with all dependencies wired up for the Hono server.
 * Real code-graph worker: git clone/fetch + codegraph indexing.
 * Real wiki worker: LLM ingest via wiki engine.
 */

import { join } from "node:path";
import { mkdirSync, existsSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import pLimit from "p-limit";

import type { Db } from "./db/client.js";
import { SqliteKnowledgeStore, type IKnowledgeStore } from "./store/index.js";
import { WikiService, type WikiWorker } from "./store/index.js";
import { CodeGraphService, type CodeGraphWorker } from "./store/index.js";
import { BuildQueue } from "./store/index.js";
import {
  createLlmBindingStore,
  resolveLlmConfig,
  type ILlmBindingStore,
} from "./store/llm-binding-store.js";
import { createWikiSourceManager, type WikiSourceManager, filterAndCopyMatched } from "./engines/wiki/index.js";
import { getEmbeddingConfig } from "./engines/wiki/embedding-client.js";
import { indexProject, openIndex, syncIndex, getStats, closeIndex, type CodeGraphInstance } from "./engines/code/index.js";
import { SourceFetcherRegistry, type ISourceFetcher } from "./source-fetcher/index.js";
import { createLogger } from "./logger.js";
import type { LlmConfig, EmbeddingConfig } from "./config.js";
import { getGlobalLlmConcurrency } from "./config.js";
import { buildProgressFn } from "./callback.js";
import { AutoSyncScheduler, resolveAutoSyncConfig, type AutoSyncConfig } from "./store/auto-sync-scheduler.js";

const log = createLogger("knowledge-module");

/** 进程级全局 LLM 并发信号量（跨所有 wiki 的 extract + merge）。 */
export const globalLlmLimit = pLimit(getGlobalLlmConcurrency());

/**
 * Git-source wiki 前置阶段（可独立测试的编排）：把 git 仓库拉到 dir/raw/repo_src
 * （首次 fetch，已存在 .git 则增量 sync），再用 filterAndCopyMatched 把匹配文件复制进
 * dir/raw/sources（现有 ingest 读取处）。之后由调用方进入 wikiMgr.ingest()。
 *
 * 返回当前 git commit（fetcher 的 version，可能 null）。调用方可用它与上次成功同步
 * 记录的 commit 对比，判断上游是否有变化——commit 相同则跳过全量 ingest（build 短路）。
 */
export interface SyncGitWikisourceParams {
  fetcher: ISourceFetcher;
  sourceUrl: string;
  branch: string;
  /** wiki 业务目录（其下 raw/repo_src 与 raw/sources） */
  dir: string;
  pathInclude?: string | null;
  pathExclude?: string | null;
  setInternalStatus?: (s: string) => void;
}

/** 上次成功同步记录的 git commit 状态文件路径（磁盘状态标记，避免 DB 迁移）。 */
const LAST_COMMIT_FILE = join("raw", ".last_commit");

export async function syncGitWikisource(p: SyncGitWikisourceParams): Promise<string | null> {
  const { fetcher, sourceUrl, branch, dir, pathInclude, pathExclude, setInternalStatus } = p;
  const cloneDir = join(dir, "raw", "repo_src");
  let version: string | null = null;
  if (existsSync(join(cloneDir, ".git"))) {
    setInternalStatus?.("fetching");
    version = (await fetcher.sync(sourceUrl, branch, cloneDir)).version;
  } else {
    setInternalStatus?.("cloning");
    mkdirSync(cloneDir, { recursive: true });
    version = (await fetcher.fetch(sourceUrl, branch, cloneDir)).version;
  }
  setInternalStatus?.("filtering");
  filterAndCopyMatched(cloneDir, join(dir, "raw", "sources"), {
    include: pathInclude ?? null,
    exclude: pathExclude ?? null,
  });
  return version;
}

/** 读取上次成功同步记录的 git commit 指纹（commit+branch+include+exclude 复合）；无记录返回 null。 */
export function readLastCommit(dir: string): string | null {
  try {
    const text = readFileSync(join(dir, LAST_COMMIT_FILE), "utf-8").trim();
    return text || null;
  } catch {
    return null;
  }
}

/** 记录本次成功同步的 git commit 指纹。 */
export function writeLastCommit(dir: string, commit: string): void {
  try {
    mkdirSync(join(dir, "raw"), { recursive: true });
    writeFileSync(join(dir, LAST_COMMIT_FILE), commit, "utf-8");
  } catch {
    // 状态文件写失败不阻断同步（仅失去下次短路的依据，退化回每次全量）。
  }
}

/**
 * 构造 git-source wiki 的同步指纹：commit + 拉取配置（branch/include/exclude）复合。
 * 任何一项变化都会使指纹不同 → 短路失效 → 触发重建（避免改过滤配置后索引 stale）。
 */
export function buildSyncFingerprint(
  commit: string,
  branch?: string | null,
  pathInclude?: string | null,
  pathExclude?: string | null,
): string {
  return `${commit}|${branch ?? ""}|${pathInclude ?? ""}|${pathExclude ?? ""}`;
}

// ───────────────────────── Module Config ─────────────────────────

export interface KnowledgeModuleConfig {
  dataDir: string;
  db: Db;
  /** LLM configuration for wiki ingest. */
  llmConfig: LlmConfig;
  /** Wiki embedding 配置（知识库向量化）。缺省/null → 不启用向量（降级纯 FTS）。 */
  embeddingConfig?: EmbeddingConfig | null;
  /** TMC callback URL for status notifications (empty = no callback). */
  tmcCallbackUrl?: string;
  /** Optional: externally injected wiki worker (for testing). */
  wikiWorker?: WikiWorker;
  /** Optional: externally injected code worker (for testing). */
  codeWorker?: CodeGraphWorker;
}

export interface CodeGraphInstancePool {
  get(codeGraphId: string): CodeGraphInstance | undefined;
  set(codeGraphId: string, instance: CodeGraphInstance): void;
  delete(codeGraphId: string): void;
  loadIfMissing?(codeGraphId: string, dir: string): Promise<CodeGraphInstance | undefined>;
}

export interface KnowledgeModule {
  wikiService: WikiService;
  cgService: CodeGraphService;
  wikiMgr: WikiSourceManager;
  store: IKnowledgeStore;
  instancePool: CodeGraphInstancePool;
  /** Per-instance LLM routing binding (proxy/byo), keyed by service_id. */
  llmBindingStore: ILlmBindingStore;
  /** 定时自动同步调度器（需显式 start/stop）。 */
  autoSyncScheduler: AutoSyncScheduler;
  /** 定时自动同步的解析后配置（挂载 admin 路由时透出）。 */
  autoSyncConfig: AutoSyncConfig;
}

/**
 * Create Knowledge Module (assembly entry point).
 * - Initialize Store / Service / engines
 * - Mark interrupted tasks as failed
 * - Async restore synced instances
 */
export function createKnowledgeModule(config: KnowledgeModuleConfig): KnowledgeModule {
  const { dataDir, db, llmConfig } = config;

  // Store
  const store = new SqliteKnowledgeStore(db);

  // Per-instance LLM routing binding + resolver (proxy/byo → effective LlmConfig).
  // No binding → global LLM_MODE decides: 'custom' uses global LLM_* direct,
  // 'proxy' (default) blanks creds so ingest fails loudly (no silent fallback).
  const llmBindingStore = createLlmBindingStore(db);
  const resolveLlm = (serviceId: string): LlmConfig =>
    resolveLlmConfig(serviceId, llmBindingStore.get(serviceId), llmConfig);

  // Instance pool (code-graph) — lazy loading
  const _poolMap = new Map<string, CodeGraphInstance>();
  const instancePool: CodeGraphInstancePool = {
    get(id: string) { return _poolMap.get(id); },
    set(id: string, inst: CodeGraphInstance) { _poolMap.set(id, inst); },
    delete(id: string) { _poolMap.delete(id); },
    async loadIfMissing(id: string, dir: string) {
      if (_poolMap.has(id)) return _poolMap.get(id);
      try {
        const instance = await openIndex(dir);
        _poolMap.set(id, instance);
        log.info(`[code-graph] lazy-loaded instance ${id}`);
        return instance;
      } catch (err) {
        log.warn(`[code-graph] lazy-load failed ${id}: ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
      }
    },
  };

  // Wiki engine manager（装配 embedding：getEmbeddingConfig 消费服务 config 的 embedding 段，
  // 未配置/不可用 → null，manager 侧 vecDim=0 不建 wiki_vec，降级纯 FTS）
  const wikiMgr = createWikiSourceManager(
    join(dataDir, "_wiki_engines"),
    getEmbeddingConfig({ embedding: config.embeddingConfig }),
  );

  // Source fetcher registry (git/local/ftp routing + security validation)
  const fetcherRegistry = new SourceFetcherRegistry();

  // ── Real code-graph worker: fetch/sync via SourceFetcher + index ──
  const realCodeWorker: CodeGraphWorker = async (ctx) => {
    const { dir, repoUrl, branch, codeGraphId, setInternalStatus } = ctx;

    // Resolve protocol-specific fetcher (validates url: https-only + SSRF blocklist).
    const fetcher = fetcherRegistry.resolve(repoUrl);

    const isExistingRepo = existsSync(join(dir, ".git"));
    let didIncrementalSync = false;
    let version: string | null = null;

    if (isExistingRepo) {
      try {
        setInternalStatus("fetching");
        const res = await fetcher.sync(repoUrl, branch, dir);
        version = res.version;

        setInternalStatus("indexing");
        let instance = instancePool.get(codeGraphId);
        if (!instance) {
          instance = await openIndex(dir);
        }
        await syncIndex(instance);
        instancePool.set(codeGraphId, instance);
        didIncrementalSync = true;
      } catch (err) {
        log.warn(
          `[code-graph] incremental sync failed for ${codeGraphId}, falling back to fresh clone: ${err instanceof Error ? err.message : String(err)}`,
        );
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }

    if (!didIncrementalSync) {
      mkdirSync(dir, { recursive: true });
      setInternalStatus("cloning");
      const res = await fetcher.fetch(repoUrl, branch, dir);
      version = res.version;

      setInternalStatus("indexing");
      const instance = await indexProject(dir);
      instancePool.set(codeGraphId, instance);
    }

    // commit hash comes from the fetcher's FetchResult (unified after clone / sync)
    const commitHash = version ?? undefined;

    const instance = instancePool.get(codeGraphId);
    const rawStats = instance ? getStats(instance) : undefined;
    const stats = rawStats
      ? { files: rawStats.fileCount ?? rawStats.files ?? 0, nodes: rawStats.nodeCount ?? rawStats.nodes ?? 0, edges: rawStats.edgeCount ?? rawStats.edges ?? 0 }
      : undefined;
    return { commitHash, stats };
  };

  // ── Real wiki worker: ingest via wiki engine ──
  const realWikiWorker: WikiWorker = async (ctx) => {
    const { wikiId, serviceId, teamId, dir, setInternalStatus, ingestRunId } = ctx;

    // Git 前置阶段：source_type==='git' 时先拉取 + 按路径正则过滤到 raw/sources，再 ingest。
    // 拉取后拿当前 commit，与上次成功同步的 commit 对比——相同说明上游无变化，短路跳过全量 ingest。
    let currentCommit: string | null = null;
    if (ctx.source_type === "git" && ctx.source_url) {
      try {
        const fetcher = fetcherRegistry.resolve(ctx.source_url);
        currentCommit = await syncGitWikisource({
          fetcher,
          sourceUrl: ctx.source_url,
          branch: ctx.branch ?? "main",
          dir,
          pathInclude: ctx.path_include ?? null,
          pathExclude: ctx.path_exclude ?? null,
          setInternalStatus,
        });
      } catch (err) {
        setInternalStatus("failed");
        throw new Error(`wiki git fetch failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 无变化短路：git 源且指纹曾有记录且未变（commit+branch+include+exclude 复合）→
    // 上游无新提交且过滤配置未变，索引内容必然与上次一致，不重扫/不重建/不重嵌，
    // 直接复用现有索引并返回现有 pageCount。
    const branch = ctx.branch ?? "main";
    const lastFingerprint = readLastCommit(dir);
    const currentFingerprint =
      ctx.source_type === "git" &&
      ctx.source_url &&
      currentCommit
        ? buildSyncFingerprint(currentCommit, branch, ctx.path_include ?? null, ctx.path_exclude ?? null)
        : null;
    if (currentFingerprint && lastFingerprint && currentFingerprint === lastFingerprint) {
      log.info(`[wiki] ${wikiId} no change (fingerprint=${currentFingerprint}), skipping rebuild`);
      wikiMgr.init({ name: wikiId, path: dir });
      let pages: unknown[] = [];
      try { pages = wikiMgr.getPages(wikiId); } catch { /* 索引读取失败仍短路，pageCount 置空 */ }
      return { pageCount: pages.length, skipped: true };
    }

    setInternalStatus("ingesting");

    // Per-instance LLM routing (proxy/byo/global fallback), keyed by service_id.
    const effectiveLlm = resolveLlm(serviceId);
    // 进度只推 Panel（Panel 内存 store + wiki/get 聚合）；KS 不落进度态
    const onProgress = config.tmcCallbackUrl
      ? buildProgressFn(config.tmcCallbackUrl, wikiId, serviceId, teamId, ingestRunId)
      : undefined;
    wikiMgr.init({ name: wikiId, path: dir });
    await wikiMgr.ingest(
      wikiId,
      {
        protocol: effectiveLlm.protocol,
        provider: effectiveLlm.provider,
        apiKey: effectiveLlm.apiKey,
        model: effectiveLlm.model,
        customEndpoint: effectiveLlm.baseUrl,
        maxContextSize: effectiveLlm.maxTokens,
        timeoutMs: effectiveLlm.timeoutMs,
        stream: effectiveLlm.stream ?? false,
      },
      { onProgress, globalLlmLimit },
    );
    setInternalStatus("rebuilding-index");

    // 成功后记录本次指纹（commit+branch+include+exclude），供下次同步短路对比。
    // 非 git 源（手动上传）不记录、不短路。
    if (ctx.source_type === "git" && currentCommit) {
      writeLastCommit(
        dir,
        buildSyncFingerprint(currentCommit, branch, ctx.path_include ?? null, ctx.path_exclude ?? null),
      );
    }

    const pages = wikiMgr.getPages(wikiId);
    return { pageCount: pages.length };
  };

  // Services (shared BuildQueue for serial wiki + code tasks)
  const callbackConfig = config.tmcCallbackUrl
    ? { tmcCallbackUrl: config.tmcCallbackUrl, resolveLlm }
    : undefined;

  const sharedQueue = new BuildQueue();
  const wikiService = new WikiService({
    store,
    dataRoot: dataDir,
    worker: config.wikiWorker ?? realWikiWorker,
    queue: sharedQueue,
    logger: { info: log.info.bind(log), warn: log.warn.bind(log), error: log.error.bind(log) },
    callbackConfig,
  });
  const cgService = new CodeGraphService({
    store,
    dataRoot: dataDir,
    worker: config.codeWorker ?? realCodeWorker,
    queue: sharedQueue,
    logger: { info: log.info.bind(log), warn: log.warn.bind(log), error: log.error.bind(log) },
    callbackConfig,
    // 释放 code-graph 内存资源（008 delete 清理）：从 pool 移除并关闭索引句柄。幂等。
    releaseInstance: (codeGraphId: string) => {
      const inst = instancePool.get(codeGraphId);
      if (inst) closeIndex(inst);
      instancePool.delete(codeGraphId);
    },
  });

  // Restart recovery: mark interrupted tasks as failed
  const interrupted = store.markInterruptedAsFailed();
  if (interrupted > 0) {
    log.info(`marked ${interrupted} interrupted tasks as failed`);
  }

  // Background restore of synced instances (non-blocking)
  void (async () => {
    // Code-graph: lazy loading, just fix stats on startup
    try {
      const allSynced = store.listSyncedCodeGraphs();
      for (const row of allSynced) {
        const dir = join(dataDir, row.service_id, row.team_id, row.code_graph_id);
        try {
          const instance = await openIndex(dir);
          instancePool.set(row.code_graph_id, instance);
          const rawStats = getStats(instance);
          if (rawStats) {
            const statsJson = JSON.stringify({
              files: rawStats.fileCount ?? rawStats.files ?? 0,
              nodes: rawStats.nodeCount ?? rawStats.nodes ?? 0,
              edges: rawStats.edgeCount ?? rawStats.edges ?? 0,
            });
            store.updateCodeGraphStatus(row.service_id, row.code_graph_id, { stats_json: statsJson });
          }
          log.info(`[code-graph] restored ${row.code_graph_id}`);
        } catch (err) {
          log.warn(`[code-graph] failed to restore ${row.code_graph_id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      log.info(`[code-graph] ${allSynced.length} synced instances restored`);
    } catch (err) {
      log.warn(`[code-graph] restore scan failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Wiki: register to engine manager
    try {
      const allSyncedWikis = store.listSyncedWikis();
      for (const row of allSyncedWikis) {
        const dir = join(dataDir, row.service_id, row.team_id, row.wiki_id);
        try {
          wikiMgr.init({ name: row.wiki_id, path: dir });
          const pages = wikiMgr.getPages(row.wiki_id);
          if (pages.length > 0) {
            store.updateWikiStatus(row.service_id, row.wiki_id, { page_count: pages.length });
          }
          log.info(`[wiki] restored index ${row.wiki_id} (${pages.length} pages)`);
        } catch (err) {
          log.warn(`[wiki] failed to restore ${row.wiki_id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      log.warn(`[wiki] restore scan failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  })();

  // ── AutoSync Scheduler: 定时拉取 git 仓库并更新 codegraph 索引 + git 源 wiki ──
  const autoSyncConfig = resolveAutoSyncConfig();
  const autoSyncScheduler = new AutoSyncScheduler({
    store, cgService, wikiService, config: autoSyncConfig,
  });
  autoSyncScheduler.start();

  return { wikiService, cgService, wikiMgr, store, instancePool, llmBindingStore, autoSyncScheduler, autoSyncConfig };
}
