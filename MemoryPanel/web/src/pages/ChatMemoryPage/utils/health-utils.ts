/**
 * health-utils —— 记忆健康条纯函数（Task 3，DS-PANEL-UI-WIKI-SOURCE-001 §2.3）。
 *
 * 零 import：可被根 vitest（node 环境）直接单测；React 渲染留在 ChatMemoryPanel.tsx。
 * U-C1（DS-PANEL-UI-VISUAL-001 §2 S5）：视图补 coveragePct/degradedSince，新增 healthRingTone 档位。
 */

/** 网关 /health 响应的 memory 子对象（与 MemoryCore server.ts MemoryHealthInfo 对齐）。 */
export interface MemoryHealthInfo {
  /** vecRows / max(metaRows, 1) —— <0.9 即部分向量死亡 */
  vectorCoverage: number;
  vecRows: number;
  metaRows: number;
  embedding: 'ok' | 'degraded';
  degradedSince: string | null;
  lastVecWriteAt: string | null;
}

/** 覆盖率进度环色调（U-C1，DS-PANEL-UI-VISUAL-001 §2 S5）：<70 红 / 70-90 黄 / >90 绿。 */
export type MemoryHealthRingTone = 'low' | 'mid' | 'high';

/** 覆盖率（0-100 整数）→ 进度环色调档位 */
export function healthRingTone(pct: number): MemoryHealthRingTone {
  if (pct > 90) return 'high';
  if (pct >= 70) return 'mid';
  return 'low';
}

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
  embeddingOk: boolean;
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
      degradedSince: null,
    };
  }
  return {
    hasData: true,
    degraded: memory.embedding === 'degraded',
    coverageText: formatVectorCoverage(memory.vectorCoverage),
    coveragePct: Math.round(memory.vectorCoverage * 100),
    embeddingOk: memory.embedding === 'ok',
    degradedSince: memory.degradedSince ?? null,
  };
}
