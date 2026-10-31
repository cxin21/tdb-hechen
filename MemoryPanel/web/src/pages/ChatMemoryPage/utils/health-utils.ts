/**
 * health-utils —— 记忆健康条纯函数（Task 3，DS-PANEL-UI-WIKI-SOURCE-001 §2.3）。
 *
 * 零 import：可被根 vitest（node 环境）直接单测；React 渲染留在 ChatMemoryPanel.tsx。
 * U-C1（DS-PANEL-UI-VISUAL-001 §2 S5）：视图补 coveragePct/degradedSince，新增 healthRingTone 档位。
 */

/** 网关 /health 响应的 memory 子对象（与 MemoryCore server.ts MemoryHealthInfo 对齐）。 */
export interface MemoryHealthInfo {
  /** coveredRows / max(metaRows, 1) —— <0.9 即部分向量死亡 */
  vectorCoverage: number;
  vecRows: number;
  metaRows: number;
  embedding: 'ok' | 'degraded';
  degradedSince: string | null;
  lastVecWriteAt: string | null;
  /**
   * #123：embedding provider 原值（"noop" / "local" / "openai" …；无 service → null）。
   * 老版本网关不返回该字段 ⇒ undefined（视图按"未知"处理，不臆断）。
   */
  embeddingProvider?: string | null;
  /**
   * #123：客户端 embedding 是否真可用。false（noop / 读不到 provider）时网关已把
   * embedding 降为 'degraded'，Panel 需要把它单独标成「未配置」而不是笼统的「降级」——
   * 否则运维看到"降级"会去查向量写失败，而真正原因是根本没配 embedder。
   */
  embeddingConfigured?: boolean;
}

/** 覆盖率进度环色调（U-C1，DS-PANEL-UI-VISUAL-001 §2 S5）：<70 红 / 70-90 黄 / >90 绿。 */
export type MemoryHealthRingTone = 'low' | 'mid' | 'high';

/** 覆盖率（0-100 整数）→ 进度环色调档位 */
export function healthRingTone(pct: number): MemoryHealthRingTone {
  if (pct > 90) return 'high';
  if (pct >= 70) return 'mid';
  return 'low';
}

/**
 * embedding 健康四态（#123）：
 * - ok：provider 存在且探针通过 → 绿
 * - degraded：provider 在但探针失败/写不进去 → 黄条「向量召回降级」
 * - unconfigured：embeddingConfigured === false（noop / 读不到 provider）→ 黄条「嵌入未配置」
 * - unknown：没拿到 memory 子对象
 */
export type MemoryEmbeddingState = 'ok' | 'degraded' | 'unconfigured' | 'unknown';

/** 健康条视图状态：组件层只负责渲染，不掺判定逻辑。 */
export interface MemoryHealthView {
  /** BFF 返回了 memory 子对象（false = 获取失败/缺数据，细条展示未知态） */
  hasData: boolean;
  /** embedding=degraded → 黄条「向量召回降级（FTS 兜底中）」 */
  degraded: boolean;
  /** 向量覆盖率文案，如 "81%" */
  coverageText: string;
  /** 向量覆盖率数值（0-100 整数，四舍五入，与 coverageText 同源）——进度环弧长输入（U-C1） */
  coveragePct: number;
  /** embedding 全绿（state === 'ok'）；未配置/降级/未知都为 false */
  embeddingOk: boolean;
  /** 四态：区分「未配置」与「降级」（#123 判绿靠 provider + configured，不只看 embedding） */
  embeddingState: MemoryEmbeddingState;
  /** 网关原值 embeddingConfigured；老网关/缺数据 → null */
  embeddingConfigured: boolean | null;
  /** 网关原值 embeddingProvider；缺数据 → null（noop 时展示 "noop" 便于排障） */
  embeddingProvider: string | null;
  /** 降级起始时间（ISO 字符串原样透出，缺数据为 null）——degraded 黄条悬浮详情（U-C1） */
  degradedSince: string | null;
}

/** 覆盖率 → 整数百分比文案（0.81 → "81%"；四舍五入到整数） */
export function formatVectorCoverage(v: number): string {
  return `${Math.round(v * 100)}%`;
}

/** memory 子对象 → 健康条视图（缺数据时 hasData=false，不造默认值） */
export function buildMemoryHealthView(memory?: Partial<MemoryHealthInfo> | null): MemoryHealthView {
  if (
    !memory ||
    typeof memory.vectorCoverage !== 'number' ||
    (memory.embedding !== 'ok' && memory.embedding !== 'degraded')
  ) {
    return {
      hasData: false,
      degraded: false,
      coverageText: '',
      coveragePct: 0,
      embeddingOk: false,
      embeddingState: 'unknown',
      embeddingConfigured: null,
      embeddingProvider: null,
      degradedSince: null,
    };
  }
  // #123：先看 configured（根因），再看 embedding 探针结果。网关对 configured=false
  // 也会把 embedding 置为 'degraded'，但两者对运维的含义不同，不能合并成一态。
  const configured =
    typeof memory.embeddingConfigured === 'boolean' ? memory.embeddingConfigured : null;
  const state: MemoryEmbeddingState =
    configured === false ? 'unconfigured' : memory.embedding === 'degraded' ? 'degraded' : 'ok';
  return {
    hasData: true,
    degraded: memory.embedding === 'degraded',
    coverageText: formatVectorCoverage(memory.vectorCoverage),
    coveragePct: Math.round(memory.vectorCoverage * 100),
    embeddingOk: state === 'ok',
    embeddingState: state,
    embeddingConfigured: configured,
    embeddingProvider: memory.embeddingProvider ?? null,
    degradedSince: memory.degradedSince ?? null,
  };
}
