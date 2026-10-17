/**
 * #46 毒批拆分+批次上限（scene 抽取螺旋修复，用户拍板 A 方案，2026-10-17）。
 *
 * 生产取证（#46 issuecomment-6220264334）：scene 抽取失败集中在大批
 * （fail promptChars 中位 24.4K vs ok 15.6K = 1.56×），且游标只在全组成功时推进
 * （pipeline-factory.ts:925）→ 同批 5min 死循环、积压永不排空。本模块镜像 L1
 * 毒批自适应拆分先例（pipeline-factory.ts:603-669 extractGroupWithSplit）：
 * - 批次上限（batchMaxChars>0）：按 memoriesJson 估长贪心预分批，防巨批；
 * - 毒批拆分（poisonSplit=true）：批失败且批内 >1 条时对半递归重试，单条仍失败
 *   才上报败（交给上层既有 requeue/游标语义）。
 * 语义（同 L1 先例）：部分成功产出保留——scene 侧无 L1 dedup 兜底，重提取重复
 * 风险出现在「本轮未完整成功」窗口（部分成功后游标不进→下轮整组重提取 /
 * 端点中途宕机），为已知取舍；两半都尝试（不因首半失败跳过）；
 * 聚合 success=全部成功、计数求和、changedSceneFiles 拼接（工厂 :977 以 Set 去重）、
 * emptyExtraction/noOpIntegrated 全真才真。
 * config-first：batchMaxChars<=0 且 poisonSplit=false ⇒ 单调用原样透传（逐位现状）。
 */

/** scene-extractor 输入记忆的最小结构（scene-extractor.ts:259-267 消费面）。 */
export interface SceneMemoryInput {
  content: string;
  created_at: string;
  id?: string;
}

/** scene 抽取结果的最小结构（scene-extractor ExtractionResult 兼容面）。 */
export interface SceneExtractOutcome {
  success: boolean;
  memoriesProcessed: number;
  error?: string;
  emptyExtraction?: boolean;
  noOpIntegrated?: boolean;
  changedSceneFiles?: string[];
}

/**
 * 估算一批记忆的 memoriesJson 段字符数——与 scene-extractor.ts:259-267 构造
 * 逐位一致（JSON.stringify(..., null, 2)），保证阈值语义与真实 prompt 变量段对齐。
 */
export function estimateSceneMemoriesChars(memories: readonly SceneMemoryInput[]): number {
  return JSON.stringify(
    memories.map((m) => ({
      content: m.content,
      created_at: m.created_at,
      id: m.id ?? "",
    })),
    null,
    2,
  ).length;
}

/**
 * 按估长贪心分批：逐条累加（候选批复估，保证与阈值同口径）；单条超限独占一批
 * （不丢、不切单条）。maxChars 非有限值或 <=0 = 关（单批原样返回）。
 */
export function splitMemoriesByChars<T extends SceneMemoryInput>(
  memories: readonly T[],
  maxChars: number,
): T[][] {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return [[...memories]];
  const chunks: T[][] = [];
  let current: T[] = [];
  for (const m of memories) {
    const candidate = [...current, m];
    if (current.length === 0 || estimateSceneMemoriesChars(candidate) <= maxChars) {
      current = candidate;
    } else {
      chunks.push(current);
      current = [m];
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

interface ExtractWithSplitParams<T extends SceneMemoryInput, R extends SceneExtractOutcome> {
  extract: (memories: T[]) => Promise<R>;
  batch: readonly T[];
  poisonSplit: boolean;
  warnLog?: (message: string) => void;
  depth?: number;
}

/** 毒批对半递归（镜像 pipeline-factory.ts:603-669 extractGroupWithSplit 形状）。 */
async function extractWithPoisonSplit<T extends SceneMemoryInput, R extends SceneExtractOutcome>(
  params: ExtractWithSplitParams<T, R>,
): Promise<R> {
  const { extract, batch, poisonSplit, warnLog, depth = 0 } = params;
  const result = await extract([...batch]);
  if (result.success !== false || batch.length <= 1 || !poisonSplit) return result;
  warnLog?.(
    `[memory-tdai] [scene] extraction failed (${batch.length} memories, depth=${depth}) — splitting in half for retry (poison-batch guard, #46)`,
  );
  const mid = Math.floor(batch.length / 2);
  const first = await extractWithPoisonSplit<T, R>({
    extract,
    batch: batch.slice(0, mid),
    poisonSplit,
    warnLog,
    depth: depth + 1,
  });
  const second = await extractWithPoisonSplit<T, R>({
    extract,
    batch: batch.slice(mid),
    poisonSplit,
    warnLog,
    depth: depth + 1,
  });
  // 聚合语义镜像 L1（pipeline-factory.ts:661-668）：两半都尝试；计数求和；
  // changedSceneFiles 拼接；empty/noOp 全真才真。cast 安全：调用点 R=ExtractionResult，
  // 字段集与 SceneExtractOutcome 结构兼容。
  return {
    success: first.success !== false && second.success !== false,
    memoriesProcessed: first.memoriesProcessed + second.memoriesProcessed,
    error: first.error ?? second.error,
    emptyExtraction: first.emptyExtraction === true && second.emptyExtraction === true,
    noOpIntegrated: first.noOpIntegrated === true && second.noOpIntegrated === true,
    changedSceneFiles: [...(first.changedSceneFiles ?? []), ...(second.changedSceneFiles ?? [])],
  } as R;
}

/**
 * scene 抽取复合入口：chars 预分批 × 每批毒批对半递归。
 * 单批未拆分时原样透传 extract 结果对象（逐位现状，含额外字段与对象同一性）。
 */
export async function extractSceneBatches<
  T extends SceneMemoryInput,
  R extends SceneExtractOutcome,
>(params: {
  extract: (memories: T[]) => Promise<R>;
  memories: readonly T[];
  batchMaxChars?: number;
  poisonSplit?: boolean;
  warnLog?: (message: string) => void;
}): Promise<R> {
  const { extract, memories, batchMaxChars = 0, poisonSplit = false, warnLog } = params;
  const batches = splitMemoriesByChars(memories, batchMaxChars);
  // 空输入守卫：batchMaxChars>0 且 memories 为空时分批结果为空——仍走单调用现状。
  if (batches.length === 0) {
    return await extract([]);
  }
  // 关语义快捷路径：单批且毒批关 ⇒ 直接单调用（逐位现状，不经包装聚合）。
  if (batches.length <= 1 && !poisonSplit) {
    return await extract([...batches[0]!]);
  }
  const outcomes: R[] = [];
  for (const batch of batches) {
    outcomes.push(await extractWithPoisonSplit<T, R>({ extract, batch, poisonSplit, warnLog }));
  }
  if (outcomes.length === 1) return outcomes[0]!;
  // 跨批聚合（批次上限生效时）：镜像 L1 聚合面；失败批后其余批仍尝试（L1 续跑语义）。
  let firstError: string | undefined;
  const changed: string[] = [];
  let processed = 0;
  let allSuccess = true;
  let allEmpty = true;
  let allNoOp = true;
  for (const o of outcomes) {
    if (o.success === false) {
      allSuccess = false;
      firstError ??= o.error;
    }
    processed += o.memoriesProcessed;
    if (o.emptyExtraction !== true) allEmpty = false;
    if (o.noOpIntegrated !== true) allNoOp = false;
    changed.push(...(o.changedSceneFiles ?? []));
  }
  return {
    success: allSuccess,
    memoriesProcessed: processed,
    error: firstError,
    emptyExtraction: allEmpty,
    noOpIntegrated: allNoOp,
    changedSceneFiles: changed,
  } as R;
}
