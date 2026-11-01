/**
 * llm-runner-guard: the single LLM seam of the memory core.
 *
 * 第一性原理：抽取 / 场景 / 人格这三条 LLM 调用链需要一个「跑一次 prompt 拿字符串」的端口，
 * 与宿主无关。历史上 core 有两条实现——宿主注入的 `LLMRunner`（standalone llm-runner，
 * 走 llm-resolver 的 baseUrl/model/鉴权）与 OpenClaw 的 `CleanContextRunner`
 * （runEmbeddedPiAgent，借用宿主 agent 上下文隔离）。
 *
 * DSH 特化后宿主只有一种（dsh-plugin → core 服务），OpenClaw 那条已删除，
 * 因此这里把「必须有 runner」变成显式不变式：缺了就立刻抛出可读错误，
 * 而不是静默退回一个已不存在的宿主实现。
 */

import type { LLMRunner } from "./types.js";

export function requireLlmRunner(runner: LLMRunner | undefined, where: string): LLMRunner {
  if (!runner) {
    throw new Error(
      `LLMRunner is required for ${where}: the host must inject the standalone LLM runner ` +
        `(the OpenClaw embedded-runner fallback was removed in the DSH-only build)`,
    );
  }
  return runner;
}
