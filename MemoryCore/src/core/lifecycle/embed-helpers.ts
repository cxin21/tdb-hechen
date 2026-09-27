/**
 * R1（09-27 源头嵌入）单一源 helper：生命周期产物写入前嵌入。
 * 失败回退 metadata-only（embed-backfill 补偿器 30min 兜底），不阻塞写链——
 * 产物元数据不因嵌入失败而丢（与 l1-writer 主链容错语义一致）。
 */
export interface LifecycleEmbedder {
  embed(t: string): Promise<Float32Array>;
}

export async function embedForLifecycle(
  embeddingService: LifecycleEmbedder | null | undefined,
  content: string,
  tag: string,
  log?: { warn?(msg: string): void },
): Promise<Float32Array | undefined> {
  if (!embeddingService || typeof embeddingService.embed !== "function") return undefined;
  try {
    return await embeddingService.embed(content);
  } catch (err) {
    log?.warn?.(
      `${tag} embed failed (metadata-only; embed-backfill will compensate): ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}
