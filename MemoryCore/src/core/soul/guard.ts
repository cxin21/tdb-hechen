/**
 * 生产护栏：跨进程锁、LLM 成本熔断、原文脱敏、条目级回滚。
 * 全部确定性。LLM 不参与「能不能跑 / 能不能回滚」的决定。
 */
import { mkdirSync, openSync, closeSync, unlinkSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export interface LockHandle {
  path: string;
  release: () => void;
}

/** 独占锁文件。第二个进程 EEXIST 就放弃，不排队、不覆盖。锁文件只写 pid+时间。 */
export function acquireProcessLock(path: string, now = new Date().toISOString()): LockHandle {
  mkdirSync(dirname(path), { recursive: true });
  let fd: number;
  try {
    fd = openSync(path, "wx");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw new Error(`soul lock held: ${path}`);
    throw err;
  }
  try {
    writeFileSync(fd, `${process.pid} ${now}\n`);
  } finally {
    closeSync(fd);
  }
  return {
    path,
    release: () => {
      try { unlinkSync(path); } catch { /* already released */ }
    },
  };
}

export interface CostBudget {
  maxCalls: number;
  used: number;
}

export function openCostBudget(maxCalls: number): CostBudget {
  return { maxCalls: Math.max(0, Math.floor(maxCalls)), used: 0 };
}

/** 超预算返回 false。调用方必须跳过 LLM，并在报告里写 skipped。 */
export function chargeCall(budget: CostBudget): boolean {
  if (budget.used >= budget.maxCalls) return false;
  budget.used += 1;
  return true;
}

const SECRET = [
  /sk-[A-Za-z0-9_\-]{8,}/gu,
  /Bearer\s+[A-Za-z0-9._\-]{8,}/giu,
  /(?:api[_-]?key|token|password|secret)\s*[:=]\s*\S+/giu,
];

/** 进 prompt / 账本之前脱敏。替换确定性，不靠模型。 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET) out = out.replace(re, "[REDACTED]");
  return out;
}

export interface RollbackItem {
  itemId: string;
  /** 账本 before_json。null = 这条是新建，回滚即删除。 */
  beforeJson: string | null;
}

/** 只动点名的 itemId。before 解析失败 → skipped，不猜测。 */
export function planItemRollback(
  current: Array<{ itemId: string }>,
  targets: RollbackItem[],
): { restore: unknown[]; remove: string[]; skipped: string[] } {
  const have = new Set(current.map((c) => c.itemId));
  const restore: unknown[] = [];
  const remove: string[] = [];
  const skipped: string[] = [];
  for (const t of targets) {
    if (t.beforeJson === null) {
      if (have.has(t.itemId)) remove.push(t.itemId);
      else skipped.push(t.itemId);
      continue;
    }
    if (!have.has(t.itemId)) {
      skipped.push(t.itemId);
      continue;
    }
    try {
      restore.push(JSON.parse(t.beforeJson));
    } catch {
      skipped.push(t.itemId);
    }
  }
  return { restore, remove, skipped };
}

export function readLockOwner(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}
