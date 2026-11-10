/**
 * S4 判侧接线：把 LLMRunner 包成 worker 的 traitJudge（spec §3.1）。
 *
 * worker 早就留了接缝（worker.ts:174）却没人提供实现，生产上特质因此永不漂移。
 * 这里与 createSoulRewriter（worker.ts:415）同风格：调度器一行接线，
 * 解析失败=零票不抛——判别器说胡话不该把整轮人格维护带崩。
 */
import { parseTraitProtocolOutput, type TraitProtocolOutput } from "./trait-drift.js";
import { buildTraitJudgePrompt, TRAIT_JUDGE_SYSTEM_PROMPT } from "./trait-judge-prompt.js";
import type { SoulEpisode } from "./types.js";

export type TraitJudge = (episodes: SoulEpisode[]) => Promise<TraitProtocolOutput>;

/** 解析/模型的零票结果：解析器要求 invalid 计数，别把「说胡话」伪装成「没意见」。 */
function zeroVotes(invalid: number): TraitProtocolOutput {
  return { votes: [], labelProposals: [], invalid };
}

export function createTraitJudge(
  runner: { run(params: { prompt: string; systemPrompt?: string; taskId: string; timeoutMs?: number; maxTokens?: number }): Promise<string> },
  opts?: { taskId?: string; timeoutMs?: number; maxTokens?: number },
): TraitJudge {
  const taskId = opts?.taskId ?? "memory.soul-trait-judge";
  return async (episodes) => {
    const list = Array.isArray(episodes) ? episodes : [];
    if (list.length === 0) return zeroVotes(0);
    const call = () =>
      runner.run({
        prompt: buildTraitJudgePrompt(list),
        systemPrompt: TRAIT_JUDGE_SYSTEM_PROMPT,
        taskId,
        timeoutMs: opts?.timeoutMs ?? 60_000,
        // 给推理留够预算：2026-11-05 生产实拍 rewiter 用小预算时空响应、候选恒 0；
        // 判侧要输出「逐票 + 标签提案」，同样别让 reasoning 把 content 吃光。
        maxTokens: opts?.maxTokens ?? 32768,
      });
    let raw: string;
    try {
      raw = await call();
    } catch (err) {
      // 只对「推理把 token 吃光」这一类空响应重试一次；超时/鉴权等照旧上抛，
      // 不把真实故障藏进「零票」。
      const msg = err instanceof Error ? err.message : String(err);
      if (!/empty response|finishReason=length/i.test(msg)) throw err;
      raw = await call();
    }
    try {
      return parseTraitProtocolOutput(raw);
    } catch {
      // 解析器本身承诺不抛；这里再兜一层，保证 worker 那条 catch 只在真故障时亮。
      return zeroVotes(1);
    }
  };
}
