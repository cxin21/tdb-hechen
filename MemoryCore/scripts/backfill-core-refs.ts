#!/usr/bin/env tsx
/**
 * 存量记忆 coreRef 回填（甲路线，task-backfill-brief）。
 *
 * 背景：结构感知召回红牌诊断——约 90% 存量记忆写于 C1 之前、无 metadata.coreRefs，
 * R5 价值反查 / R7 排序加成对存量无料可捞。本脚本批量回填：复用 C1 的
 * dedup prompt / parse 逻辑（P-A 单一实现，禁第二份手写），LLM 逐批判定
 * "该记忆明显触动了哪些价值锚"，防幻觉过滤后写回 metadata.coreRefs。
 *
 * 关键语义（全部与 C1 对齐）：
 *   - prompt 复用 formatBatchConflictPrompt + getConflictDetectionSystemPrompt
 *     （存量记忆作为"newMemory"、候选池为空；只消费输出中的 coreRefs 字段）。
 *   - parse 复用 parseBatchResult（code-fence 剥离 / sanitize / parseCoreRefs 幻觉
 *     过滤单源）——只接受候选清单内的 label（或 value_id 回显归一化）。
 *   - 价值锚候选按**记录自身三元组**走（normalizeCoreTenant 缺维度 → default 桶；
 *     PA 起严格无兜底——无锚 agent 候选为空，存量锚已由扇出迁移落到各 agent 桶）
 *     ——复用 loadValueCandidates。
 *   - 分批 30 条（LLM 上下文安全）。
 *   - LLM 失败/超时/解析坏 → 整批跳过 + loud 打印（R3：降级可见），批内零写入。
 *   - 损坏 metadata_json 行：跳过 + loud 计数，**字节不动**（updateL1Metadata 的
 *     catch→{} 宽容合并会丢弃原内容，回填宁缺毋滥不覆盖）。
 *   - 写回：updateL1Metadata(id, { coreRefs })——读-改-写合并，不覆盖其他键。
 *   - 幂等：候选筛选 = metadata.coreRefs 非空数组排除；空判不写键（C1 宁缺毋滥），
 *     二次运行只处理仍无 coreRefs 的记录。
 *
 * 模式：
 *   默认 dry-run（判定 + 解析 + 打印样本，零写库）；--write 才真实写库。
 *
 * 用法（在 MemoryCore 目录下）：
 *   node --import tsx scripts/backfill-core-refs.ts --db <vectors.db 路径> [--write]
 *        [--batch-size 30] [--mode chat|code] [--limit N]
 *   LLM 凭据走环境变量：TDAI_LLM_BASE_URL / TDAI_LLM_API_KEY / TDAI_LLM_MODEL
 *   （与 e2e-memory-prompt-vdb-cos.ts 同源惯例）。
 *
 * 验证：scripts/verify-backfill.ts（临时库 + mock LLM，不碰生产）。
 */
import { pathToFileURL } from "node:url";

import { VectorStore } from "../src/core/store/sqlite.js";
import {
  formatBatchConflictPrompt,
  getConflictDetectionSystemPrompt,
  type CandidateMatch,
} from "../src/core/prompts/l1-dedup.js";
import { parseBatchResult, loadValueCandidates } from "../src/core/record/l1-dedup.js";
import type { ExtractedMemory, MemoryType } from "../src/core/record/l1-writer.js";
import type { L1RecordRow } from "../src/core/store/types.js";
import type { LLMRunner, Logger, TraceContext } from "../src/types.js";
import { StandaloneLLMRunner } from "../src/adapters/standalone/llm-runner.js";

const TAG = "[memory-tdai][backfill-core-refs]";

/** 默认批大小（brief：每批 30 条，LLM 上下文安全）。 */
const DEFAULT_BATCH_SIZE = 30;
/** 单批 LLM 超时（与 C1 dedup 的 180s 同款）。 */
const LLM_TIMEOUT_MS = 180_000;
/** 全量扫描分页大小。 */
const SCAN_PAGE_SIZE = 500;

/** loud 统计（brief 验收：总数/批数/判定数/空判数/跳过批数）。 */
export interface BackfillStats {
  /** 扫描的 L1 行数。 */
  scanned: number;
  /** 无 coreRefs 的候选行数（损坏行不计入）。 */
  candidates: number;
  /** 损坏 metadata_json 跳过行数（字节不动）。 */
  skipCorrupt: number;
  /** 无价值锚租户跳过的记录数（不发 LLM）。 */
  noAnchorRecords: number;
  /** 实际送判的批数。 */
  batches: number;
  /** 判定出非空 coreRefs 的记录数（含 dry-run）。 */
  judged: number;
  /** LLM 判空（无命中）的记录数。 */
  emptyJudge: number;
  /** 真实写库成功数（dry-run 恒 0）。 */
  written: number;
  /** 写库失败数（updateL1Metadata 返回 false）。 */
  writeFailed: number;
  /** 整批跳过数（LLM 失败/超时/解析坏）。 */
  skipBatches: number;
  /** dry-run 样本（每批首条：记忆片段 → 判定结果）。 */
  samples: Array<{ recordId: string; snippet: string; refs: string[] }>;
}

export interface BackfillOptions {
  /** sqlite 库路径（生产为 D:/tdai-data/vectors.db——生产运行由队长执行）。 */
  dbPath: string;
  /** 注入既有 store（verify 用）；缺省按 dbPath 自建并负责关闭。 */
  store?: VectorStore;
  /** 真实写库；缺省 false = dry-run（零写库）。 */
  write?: boolean;
  /** 批大小，默认 30。 */
  batchSize?: number;
  /** prompt family，默认 chat。 */
  mode?: "chat" | "code";
  /** 候选上限（安全阀，缺省不限）。 */
  limit?: number;
  /** LLM runner（verify 注入 mock；CLI 从环境变量构建）。 */
  llmRunner?: LLMRunner;
  logger?: Logger;
}

/** metadata_json 宽松解析：损坏/非对象 → null（回填对损坏行跳过，不覆盖）。 */
function tryParseMetadata(raw: string | undefined | null): Record<string, unknown> | null {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 行 → ExtractedMemory & {record_id}（prompt/parse 消费的形状；只透传展示字段）。 */
function toExtractedMemory(row: L1RecordRow): ExtractedMemory & { record_id: string } {
  return {
    record_id: row.record_id,
    content: row.content ?? "",
    type: (row.type ?? "episodic") as MemoryType,
    priority: typeof row.priority === "number" ? row.priority : 50,
    scene_name: row.scene_name ?? "",
    source_message_ids: [],
    metadata: {},
  };
}

/**
 * 回填核心循环（可注入 store/llmRunner —— verify-backfill.ts 全链验证用同一入口）。
 * 步骤：全量分页扫描 → 过滤已标注/损坏 → 按记录自身三元组分租户 → 每租户取价值锚
 * 候选（复用 loadValueCandidates）→ 分批 30 → C1 prompt → LLM → C1 parse → 写回。
 */
export async function runBackfill(opts: BackfillOptions): Promise<BackfillStats> {
  const write = opts.write === true; // dry-run 默认
  const batchSize = Math.max(1, opts.batchSize ?? DEFAULT_BATCH_SIZE);
  const mode = opts.mode ?? "chat";
  const logger = opts.logger ?? (console as never);
  const ownStore = !opts.store;
  const store = opts.store ?? new VectorStore(opts.dbPath, 64, logger as never);
  const stats: BackfillStats = {
    scanned: 0, candidates: 0, skipCorrupt: 0, noAnchorRecords: 0,
    batches: 0, judged: 0, emptyJudge: 0, written: 0, writeFailed: 0, skipBatches: 0,
    samples: [],
  };

  try {
    await store.init();
    if (typeof store.isDegraded === "function" && store.isDegraded()) {
      throw new Error(`${TAG} store 初始化降级（sqlite 不可用），拒绝运行`);
    }

    // ── 1. 全量分页扫描：筛 metadata.coreRefs 缺失的记录 ──────────────
    let candidates: L1RecordRow[] = [];
    {
      let offset = 0;
      for (;;) {
        const page = store.queryL1Paginated({ limit: SCAN_PAGE_SIZE, offset });
        const rows = page.rows ?? [];
        stats.scanned += rows.length;
        for (const row of rows) {
          const meta = tryParseMetadata(row.metadata_json);
          if (meta === null) {
            // R-BF1：损坏 metadata 不覆盖——跳过 + loud（updateL1Metadata 的 catch→{}
            // 会丢弃原内容，回填宁可不动）。同一行每次运行都会重复计入（可见性优先）。
            stats.skipCorrupt += 1;
            logger.warn(`${TAG} 损坏 metadata_json，跳过（不覆盖）record_id=${row.record_id}`);
            continue;
          }
          const refs = meta.coreRefs;
          if (Array.isArray(refs) && refs.length > 0) continue; // 已标注 → 幂等排除
          candidates.push(row);
        }
        offset += rows.length;
        if (rows.length === 0 || offset >= page.total) break;
      }
      if (opts.limit !== undefined && candidates.length > opts.limit) candidates = candidates.slice(0, opts.limit);
      stats.candidates = candidates.length;
    }
    logger.info(
      `${TAG} 扫描 ${stats.scanned} 行：候选 ${stats.candidates}（无 coreRefs）/ 损坏跳过 ${stats.skipCorrupt} / 已标注排除 ${stats.scanned - stats.candidates - stats.skipCorrupt}`,
    );
    if (candidates.length === 0) {
      logger.info(`${TAG} 无候选，结束（幂等定点：全部已标注或损坏跳过）`);
      return stats;
    }

    // ── 2. 按记录自身三元组分租户（价值锚候选从该租户 listValues 取）──
    const groups = new Map<string, L1RecordRow[]>();
    for (const row of candidates) {
      const key = JSON.stringify([row.team_id ?? "", row.user_id ?? "", row.agent_id ?? ""]);
      const bucket = groups.get(key);
      if (bucket) bucket.push(row);
      else groups.set(key, [row]);
    }

    // ── 3. 每租户：价值锚候选（复用 loadValueCandidates；空 → 整租户跳过）──
    const llm = opts.llmRunner;
    for (const [tenantKey, rows] of groups) {
      const [teamId, userId, agentId] = JSON.parse(tenantKey) as [string, string, string];
      const tenantLabel = `${teamId || "default"}/${userId || "default"}/${agentId || "default"}`;

      // C1 同源复用：loadValueCandidates(traceContext) 内部 normalizeCoreTenant
      // （缺维度 → default 桶）+ listValues（PA 起严格无兜底，空桶 → 空候选）+ 过滤归一化。
      const valueCandidates = await loadValueCandidates(
        store,
        { teamId: teamId || undefined, userId: userId || undefined, agentId: agentId || undefined } as TraceContext,
        logger,
      );
      if (valueCandidates.length === 0) {
        stats.noAnchorRecords += rows.length;
        logger.warn(`${TAG} 租户 ${tenantLabel} 无价值锚候选——跳过 ${rows.length} 条（不发 LLM，宁缺毋滥）`);
        continue;
      }

      // ── 4. 分批判定（每批 batchSize 条）────────────────────────────
      for (let i = 0; i < rows.length; i += batchSize) {
        const batch = rows.slice(i, i + batchSize);
        stats.batches += 1;
        const batchNo = stats.batches;

        // C1 同源复用：存量记忆作为"newMemory"、候选池为空；LLM 输出只消费 coreRefs。
        const matches: CandidateMatch[] = batch.map((row) => ({
          newMemory: toExtractedMemory(row),
          candidates: [],
        }));
        const memories = matches.map((m) => m.newMemory);
        const prompt = formatBatchConflictPrompt(matches, valueCandidates);
        const systemPrompt = getConflictDetectionSystemPrompt(mode);

        if (!llm) {
          stats.skipBatches += 1;
          logger.warn(`${TAG} 批 ${batchNo}：无 LLM runner——整批跳过（配 TDAI_LLM_* 环境变量或注入 llmRunner）`);
          continue;
        }

        let result: string;
        try {
          result = await llm.run({
            prompt,
            systemPrompt,
            taskId: "l1-coreref-backfill",
            timeoutMs: LLM_TIMEOUT_MS,
          });
        } catch (err) {
          // R-BF4：LLM 失败/超时 → 整批跳过 + loud，批内零写入（R3 降级可见）。
          stats.skipBatches += 1;
          logger.warn(`${TAG} 批 ${batchNo} LLM 判定失败，整批跳过（${batch.length} 条，可重试）: ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }

        // C1 同源复用：parseBatchResult（code-fence 剥离 / sanitize / parseCoreRefs
        // 幻觉过滤单源）。解析坏 → 全 store 决策（coreRefs 全 undefined）= 整批空判。
        const decisions = parseBatchResult(result, memories, logger, valueCandidates);
        const refsById = new Map<string, string[] | undefined>();
        for (const d of decisions) refsById.set(d.record_id, d.coreRefs);

        // ── 5. 消费判定：dry-run 只统计/打样；--write 才 updateL1Metadata ──
        for (const row of batch) {
          const refs = refsById.get(row.record_id);
          if (refs && refs.length > 0) {
            stats.judged += 1;
            if (row === batch[0]) {
              // 每批首条样本（brief：记忆片段 → 判定结果）
              stats.samples.push({ recordId: row.record_id, snippet: (row.content ?? "").slice(0, 40), refs });
            }
            logger.info(`${TAG} 批 ${batchNo} ${row.record_id} → coreRefs=${JSON.stringify(refs)}`);
            if (write) {
              // R-BF2：读-改-写合并（sqlite updateL1Metadata），不覆盖其他键
              const ok = store.updateL1Metadata(row.record_id, { coreRefs: refs });
              if (ok) stats.written += 1;
              else {
                stats.writeFailed += 1;
                logger.warn(`${TAG} 批 ${batchNo} 写回失败 record_id=${row.record_id}（行不存在或库异常，loud）`);
              }
            }
          } else {
            // 空判（含解析坏整批 store）：不写键（C1 宁缺毋滥）；幂等运行会重判。
            stats.emptyJudge += 1;
          }
        }
        const judgedInBatch = batch.filter((r) => (refsById.get(r.record_id)?.length ?? 0) > 0).length;
        const first = batch[0];
        const firstRefs = refsById.get(first.record_id);
        logger.info(
          `${TAG} 批 ${batchNo} 完成：${batch.length} 条 / 判定 ${judgedInBatch} / 空判 ${batch.length - judgedInBatch}` +
          `${firstRefs?.length ? ` / 首条样本 ${first.record_id}「${(first.content ?? "").slice(0, 40)}」→ ${JSON.stringify(firstRefs)}` : ""}`,
        );
      }
    }

    // ── 6. loud 统计（brief 验收）────────────────────────────────────
    logger.info(
      `${TAG} 回填统计（${write ? "WRITE" : "DRY-RUN"}）：扫描=${stats.scanned} 候选=${stats.candidates} 批数=${stats.batches} ` +
      `判定=${stats.judged} 空判=${stats.emptyJudge} 写入=${stats.written} 写失败=${stats.writeFailed} ` +
      `跳过批=${stats.skipBatches} 损坏跳过=${stats.skipCorrupt} 无锚租户跳过=${stats.noAnchorRecords}`,
    );
    if (!write) {
      logger.info(`${TAG} dry-run：零写库。确认判定合理后加 --write 真实写库。`);
    }
    return stats;
  } finally {
    if (ownStore) {
      try { store.close(); } catch { /* Windows 句柄时序 */ }
    }
  }
}

// ── CLI（tsx 直跑；被 import 时不执行）────────────────────────────────

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--write") args.write = true;
    else if (a === "--db" || a === "--batch-size" || a === "--mode" || a === "--limit") {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${TAG} 参数 ${a} 缺值`);
      args[a.slice(2)] = v;
    } else if (a === "--help" || a === "-h") args.help = true;
  }
  return args;
}

function requiredEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${TAG} 缺少环境变量 ${name}（生产运行需 LLM 凭据）`);
  return v;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.db) {
    console.log(`用法：node --import tsx scripts/backfill-core-refs.ts --db <vectors.db> [--write] [--batch-size 30] [--mode chat|code] [--limit N]
  默认 dry-run（零写库）；--write 真实写库（幂等，可中断重跑）。
  LLM 凭据环境变量：TDAI_LLM_BASE_URL / TDAI_LLM_API_KEY / TDAI_LLM_MODEL`);
    if (!args.db) process.exitCode = 1;
    return;
  }
  const dbPath = String(args.db);
  const batchSize = args["batch-size"] !== undefined ? Number(args["batch-size"]) : undefined;
  const limit = args.limit !== undefined ? Number(args.limit) : undefined;
  const mode = args.mode === "code" ? "code" : "chat";
  const llmRunner: LLMRunner = new StandaloneLLMRunner({
    config: {
      baseUrl: requiredEnv("TDAI_LLM_BASE_URL"),
      apiKey: requiredEnv("TDAI_LLM_API_KEY"),
      model: requiredEnv("TDAI_LLM_MODEL"),
      maxTokens: 4096,
      timeoutMs: LLM_TIMEOUT_MS,
    },
    logger: console as never,
  });
  const stats = await runBackfill({ dbPath, write: args.write === true, batchSize, limit, mode, llmRunner, logger: console as never });
  if (stats.skipBatches > 0 || stats.writeFailed > 0) process.exitCode = 2; // loud：有跳过/失败，非全绿
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`${TAG} 未捕获异常: ${err instanceof Error ? err.stack : String(err)}`);
    process.exitCode = 1;
  });
}
