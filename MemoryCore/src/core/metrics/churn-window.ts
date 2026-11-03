import type { DatabaseSync } from "node:sqlite";

export interface ChurnWindowReading {
  /** 同窗口内被归档的行数：COUNT(l1_archive WHERE archived_at >= windowFrom) */
  archived: number;
  /** 同窗口内创建的存活行数：COUNT(l1_records WHERE created_time >= windowFrom)。取不到窗口时为 null。 */
  live: number | null;
  /** 分子的窗口起点；null 表示没有可用窗口（无 --since 且无采样行）。 */
  windowFrom: string | null;
}

/**
 * 计算 churn 的分子/分母，保证两侧落在同一个窗口里。
 *
 * 旧实现用采样行数当分母（live=total），分子却按窗口从 l1_archive 计数，
 * 两侧不同期，ratio 无意义。这里把两侧都收敛到 windowFrom：
 * - 显式 --since 时 windowFrom = since；
 * - 否则 windowFrom = 采样最老行的 createdAt（采样是"最近 N 行"，窗口即采样边界）。
 *
 * 注意：live 是 SQL 全表 COUNT，不是采样长度；采样只用来确定窗口起点。
 */
export function readChurnWindow(
  db: DatabaseSync,
  rows: readonly { createdAt?: string | null }[],
  since?: string,
): ChurnWindowReading {
  const oldestSampled = rows.length > 0 ? (rows[rows.length - 1].createdAt ?? null) : null;
  const windowFrom = since ?? oldestSampled;
  if (!windowFrom) {
    return { archived: 0, live: null, windowFrom: null };
  }
  const count = (sql: string): number => {
    const row = db.prepare(sql).get(windowFrom) as { c?: number } | undefined;
    return Number(row?.c ?? 0);
  };
  return {
    archived: count("SELECT COUNT(*) AS c FROM l1_archive WHERE archived_at >= ?"),
    live: count("SELECT COUNT(*) AS c FROM l1_records WHERE created_time >= ?"),
    windowFrom,
  };
}
