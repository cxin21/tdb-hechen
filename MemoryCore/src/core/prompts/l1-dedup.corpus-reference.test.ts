/**
 * task-62 · dedup prompt 的 corpus / reference 物理分区（用户口径 m02362）
 *
 * 事实：dedup 候选召回**故意不带 sessionId**（l1-extractor.ts:538-542，L1 关联是
 * agent 维度语义），所以候选池是**跨会话**的 reference。要求：
 *   - corpus（待判断的新记忆）与 reference（统一候选记忆池）在 prompt 里两段分离，
 *     不得混成一段；
 *   - reference 每条带来源会话标注（source.session_id / source.agent_id）；
 *   - 明确「结论只基于 corpus，reference 仅用于判重/判冲突」；
 *   - 能统计/声明其中有多少条来自其它会话。
 */
import { describe, expect, it } from "vitest";
import { formatBatchConflictPrompt, type CandidateMatch } from "./l1-dedup.js";

const newMem = {
  record_id: "n1",
  content: "新记忆-CORPUSONLY-用户在本会话说要做会话隔离",
  type: "episodic" as const,
  priority: 70,
  source_message_ids: [] as string[],
  metadata: {},
  scene_name: "会话隔离情境",
};

const cand = (id: string, content: string, sessionId: string, agentId = "agent-x") => ({
  id,
  content,
  type: "episodic" as const,
  priority: 60,
  scene_name: "别处情境",
  source_message_ids: [] as string[],
  metadata: {},
  timestamps: ["2026-01-01T00:00:00.000Z"],
  createdAt: "",
  updatedAt: "",
  sessionKey: "sk",
  sessionId,
  agentId,
});

const matches: CandidateMatch[] = [{
  newMemory: newMem,
  candidates: [
    cand("c-other", "旧记忆-REFERENCEONLY-别的会话的旧事", "sess-B", "agent-b"),
    cand("c-same", "旧记忆-同会话旧事", "sess-A", "agent-a"),
  ],
}];

describe("task-62 · dedup prompt corpus/reference 分区", () => {
  const prompt = formatBatchConflictPrompt(matches, [], { sessionId: "sess-A", agentId: "agent-a" });

  it("两段物理分离：corpus 正文只出现在 corpus 段，reference 正文只出现在池段", () => {
    const poolIdx = prompt.indexOf("## 统一候选记忆池");
    const corpusIdx = prompt.indexOf("## 待判断的新记忆");
    expect(poolIdx).toBeGreaterThan(-1);
    expect(corpusIdx).toBeGreaterThan(-1);
    // 池段在前、corpus 段在后，且互不交叉：各自正文只在自己那一段
    expect(poolIdx).toBeLessThan(corpusIdx);
    const poolBlock = prompt.slice(poolIdx, corpusIdx);
    const corpusBlock = prompt.slice(corpusIdx);
    expect(poolBlock).toContain("REFERENCEONLY");
    expect(poolBlock).not.toContain("CORPUSONLY");
    expect(corpusBlock).toContain("CORPUSONLY");
    expect(corpusBlock).not.toContain("REFERENCEONLY");
  });

  it("reference 每条带来源会话标注（session_id / agent_id）", () => {
    expect(prompt).toContain('"session_id": "sess-B"');
    expect(prompt).toContain('"agent_id": "agent-b"');
    expect(prompt).toContain('"session_id": "sess-A"');
  });

  it("声明 corpus 的当前会话 + 跨会话条数", () => {
    expect(prompt).toContain("corpus");
    expect(prompt).toContain("session_id=sess-A");
    expect(prompt).toContain("其中 1 条来自其它会话");
  });

  it("语料/参考边界规则在场，且位于候选池之前（先声明后语料）", () => {
    expect(prompt).toContain("语料/参考边界（会话隔离）");
    expect(prompt).toContain("结论只能基于这些语料");
    expect(prompt.indexOf("语料/参考边界")).toBeLessThan(prompt.indexOf("## 统一候选记忆池"));
  });

  it("兼容缺省调用（无 corpus 参数）：不出现会话声明，仍是两段结构", () => {
    const legacy = formatBatchConflictPrompt(matches, []);
    expect(legacy).toContain("## 统一候选记忆池");
    expect(legacy).toContain("## 待判断的新记忆");
    expect(legacy).not.toContain("session_id=sess-A");
  });
});
