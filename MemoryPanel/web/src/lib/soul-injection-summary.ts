/**
 * 注入统计的「未归因桶」与「端到端证明」摘要（R29）。
 *
 * 背景（r28c-a4 / r28e-a4）：真实插件行大多没有身份，租户口径恒 0，能看的事实全在集群级
 * unattributed 里；而 proof 的 sectionCardHashCount 只有在宿主重启、插件写出 cardHash 之后
 * 才可能 > 0。面板此前一个都不渲染，等于把「看得见」的部分藏起来。
 * 这里只做纯映射：0 不出现（不拿 0 冒充「没发生」），缺键不补 0（旧 Core/BFF 没有该段）。
 */
export interface UnattributedLike {
  sectionRead?: number;
  noCard?: number;
  emptySegment?: number;
  noSession?: number;
  cardBound?: number;
  cardBoundEmpty?: number;
  cardBoundFailed?: number;
  cleared?: number;
  unconfiguredCleared?: number;
  other?: number;
}

export type UnattributedKey = keyof UnattributedLike;

const ORDER: UnattributedKey[] = [
  'sectionRead',
  'noCard',
  'noSession',
  'emptySegment',
  'cardBound',
  'cardBoundEmpty',
  'cardBoundFailed',
  'cleared',
  'unconfiguredCleared',
  'other',
];

export interface UnattributedRow {
  key: UnattributedKey;
  count: number;
}

/** 非零桶按固定顺序列出；全零/缺段返回空数组（调用方据此整段不渲染）。 */
export function unattributedRows(u: UnattributedLike | undefined | null): UnattributedRow[] {
  if (!u) return [];
  const out: UnattributedRow[] = [];
  for (const key of ORDER) {
    const n = Number(u[key] ?? 0);
    if (Number.isFinite(n) && n > 0) out.push({ key, count: n });
  }
  return out;
}

export interface ProofLike {
  sectionReadCount?: number;
  textHashMatched?: number;
  sessionsWithProof?: number;
  sectionCardHashCount?: number;
}

export interface ProofSummary {
  /** 段行里带整卡 hash 的行数（= 可参与对账的分母） */
  sectionCardHashCount: number;
  /** 对账命中的会话数 */
  matched: number;
  /** 段读行总数（含宿主未上报 cardHash 的那些） */
  sectionReadCount: number;
  /**
   * true = 分母为 0 而段读行 > 0：宿主还没重启到会写 cardHash 的版本，
   * 此时「0 命中」不是失败证据——面板要明说，而不是显示「匹配 0」。
   */
  hostPending: boolean;
}

export function proofSummary(p: ProofLike | undefined | null): ProofSummary | null {
  if (!p) return null;
  const sectionReadCount = Number(p.sectionReadCount ?? 0);
  const sectionCardHashCount = Number(p.sectionCardHashCount ?? 0);
  const matched = Number(p.sessionsWithProof ?? 0);
  if (!Number.isFinite(sectionReadCount) || !Number.isFinite(sectionCardHashCount) || !Number.isFinite(matched)) {
    return null;
  }
  if (sectionReadCount === 0 && sectionCardHashCount === 0 && matched === 0) return null;
  return {
    sectionReadCount,
    sectionCardHashCount,
    matched,
    hostPending: sectionCardHashCount === 0 && sectionReadCount > 0,
  };
}
