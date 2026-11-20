/**
 * L2 轮次结果 → task 标记（R29）。
 *
 * 动机：R24 修了「有 extract 组失败的轮次不能当成功轮」，但把判断写在 gateway/server.ts 的
 * 执行器闭包里，那个文件没有任何测试 import（r28c-a3 反证：把 `if (result.hadFailure === true)`
 * 改成 `if (false)` 后 4 个文件 20 个用例依旧全绿）。抽成纯函数后，生产者这一半终于有可直接断言的地方，
 * 消费端（services/pipeline-worker.ts 的级联早退）保持原样。
 */
export interface L2OutcomeLike {
  /** 本轮没有新记录可处理；与「失败」互斥，两者都为真时按失败处理。 */
  skipped?: boolean;
  /** 至少一个 extract 组失败：不能写墙钟、不能入队 L3。 */
  hadFailure?: boolean;
}

/** 把 L2 结果写回 task；只置位不清理（task 对象每轮由调度器新建）。 */
export function markL2Outcome(task: Record<string, unknown>, result: L2OutcomeLike | null | undefined): void {
  if (!result) return;
  if (result.skipped) task._l2Skipped = true;
  if (result.hadFailure === true) task._l2HadFailure = true;
}
