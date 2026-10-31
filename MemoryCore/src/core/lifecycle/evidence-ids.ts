/**
 * WP7（#155 写面）：L1 结论卡「证据指针」键名的单一源。
 *
 * 现状分裂（审计 §4 #155 + WP2 跨 scope 发现）：
 *   - consolidation 卡（consolidation/consolidation-worker.ts）写 metadata.evidence_ids；
 *   - reflection 卡（reflection.ts）写 metadata.evidence_record_ids；
 *   - evolution 卡（evolution-worker.ts）写 metadata.evidence_ids。
 * 消费方同样分裂：gateway/atomic-by-ids.ts:4 只读 evidence_ids，auto-recall.ts:4161/4201
 * 只读 evidence_record_ids。任一写面只写一个键，另一类读面就取不到证据——#155 的读面回退
 * 若只补一个键，另一类卡仍然拿不到（生产回捞率低的成因之一）。
 *
 * 第一性原理：证据指针的「键名契约」必须只有一处定义，写面与读面都从这里取。
 *   - 写面：withEvidenceIds() 双写——canonical (evidence_ids) + 兼容别名
 *     (evidence_record_ids)，两者内容相同（同源数组的两个副本）。
 *   - 读面：readEvidenceIds() 优先 canonical，回退别名（存量卡只有旧键时不丢证据）。
 * 别名不能删：auto-recall 侧仍在读旧键，删键=召回断崖。
 */

/** canonical 键：新读面优先读它。 */
export const EVIDENCE_IDS_KEY = "evidence_ids" as const;
/** 兼容别名键：auto-recall.ts:4161/4201 等存量读方在读，保留不删。 */
export const LEGACY_EVIDENCE_IDS_KEY = "evidence_record_ids" as const;

/** 证据 id 归一：去空/去重/转字符串，保留首次出现顺序。 */
export function normalizeEvidenceIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of value) {
    if (v === null || v === undefined) continue;
    const id = String(v).trim();
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * 读证据 id：两键合并去重、canonical 在前（= 读面 recall/evidence-ids.ts 的
 * evidenceIdsOfMetadata 同口径）。
 *
 * 为什么是合并而不是「canonical 非空就丢弃别名」：本函数同时服务两个场景——
 *   a) 读面回退（存量卡只有旧键 / 双写前的历史卡）；
 *   b) 写面累积（appendExisting 要拿「这张卡上已存在的全部证据」再去重合并）。
 * 两键在本模块写出来后内容恒等，合并与回退结果相同；而对双写前的历史卡/脏卡，
 * 合并只会多拿不会丢证据（丢证据的代价远大于多拿一条）。两侧语义必须一致，
 * 否则读面与写面各算一个证据集，就成了新的"两套真相"。
 */
export function readEvidenceIds(metadata: unknown): string[] {
  const md = (metadata ?? {}) as Record<string, unknown>;
  return normalizeEvidenceIds([
    ...normalizeEvidenceIds(md[EVIDENCE_IDS_KEY]),
    ...normalizeEvidenceIds(md[LEGACY_EVIDENCE_IDS_KEY]),
  ]);
}

/**
 * 写证据 id：双写 canonical + 兼容别名，其余 metadata 字段原样保留。
 *
 * @param opts.appendExisting 为 true 时先并入 metadata 里已有的证据（读面口径：canonical
 *   优先、回退别名）再去重——复蒸馏/合并场景要求「累积」而不是「整列覆盖」，必须与
 *   part_of 边这类幂等累积的证据口径保持一致。默认 false（以本次为准）。
 */
export function withEvidenceIds<M extends Record<string, unknown>>(
  metadata: M | null | undefined,
  ids: readonly unknown[],
  opts?: { appendExisting?: boolean },
): M & Record<string, string[]> {
  const base = (metadata ?? {}) as M;
  const prev = opts?.appendExisting ? readEvidenceIds(base) : [];
  const merged = normalizeEvidenceIds([...prev, ...ids]);
  // 两个键内容相同但数组各自独立（调用方改一个不会静默改另一个）。
  return { ...base, [EVIDENCE_IDS_KEY]: merged, [LEGACY_EVIDENCE_IDS_KEY]: [...merged] } as M & Record<string, string[]>;
}
