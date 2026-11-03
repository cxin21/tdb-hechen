/**
 * B1（P6）属性键归组：deriveAttributeKey 纯函数合同。
 *
 * 目标（docs/research/2026-11-02-memory-layering-extraction-optimization.md §6.B1）：
 * L3 分组键从 metadata.subject 整串相等换成 (entity, attribute) 归一，否则反思结论
 * 862 条共用一个 subject，巩固层只剩一张大卡。
 */
import { describe, expect, it } from "vitest";
import { deriveAttributeKey, CONSOLIDATION_ATTRIBUTE_NAMES, ATTRIBUTE_KEY_SEPARATOR } from "../attribute-key.js";
import type { MemoryRecord } from "../../../record/l1-writer.js";

function mk(over: { id?: string; content?: string; metadata?: Record<string, unknown> }): MemoryRecord {
  return {
    id: over.id ?? "r1",
    content: over.content ?? "",
    type: "work_fact",
    priority: 60,
    scene_name: "s",
    source_message_ids: [],
    metadata: (over.metadata ?? {}) as MemoryRecord["metadata"],
    timestamps: [],
    createdAt: "",
    updatedAt: "",
    version: 1,
    sessionKey: "k",
    sessionId: "s",
  } as unknown as MemoryRecord;
}

describe("deriveAttributeKey（entity, attribute 归一键）", () => {
  it("metadata.work_object 优先作为 entity，谓词归一为 attribute", () => {
    const k = deriveAttributeKey(mk({ content: "我负责 L3 巩固归组", metadata: { work_object: "td-agemem" } }));
    expect(k).not.toBeNull();
    expect(k!.entity).toBe("td-agemem");
    expect(k!.attribute).toBe("module_ownership");
    expect(k!.key).toBe("td-agemem" + ATTRIBUTE_KEY_SEPARATOR + "module_ownership");
  });

  it("无 work_object 时 coreRefs 兜底", () => {
    const k = deriveAttributeKey(mk({ content: "决定先做前端再谈分摊算法", metadata: { coreRefs: ["记忆系统"] } }));
    expect(k).not.toBeNull();
    expect(k!.entity).toBe("记忆系统");
    expect(k!.attribute).toBe("decision");
  });

  it("coreRefs 缺失时 personRefs 兜底", () => {
    const k = deriveAttributeKey(mk({ content: "何晨偏好先灰度后全量", metadata: { personRefs: ["何晨"] } }));
    expect(k).not.toBeNull();
    expect(k!.entity).toBe("何晨");
    expect(k!.attribute).toBe("preference");
  });

  it("无元数据实体时用文本主语（复用 subjectOf 口径）", () => {
    const k = deriveAttributeKey(mk({ content: "知识库召回：使用 bge 向量" }));
    expect(k).not.toBeNull();
    expect(k!.entity).toBe("知识库召回");
    expect(k!.attribute).toBe("tooling");
  });

  it("复用事实属性封闭词表：metadata.attribute 命中时优先于谓词正则", () => {
    const k = deriveAttributeKey(
      mk({ content: "我负责 L3 巩固归组", metadata: { work_object: "td-agemem", attribute: "preference" } }),
    );
    expect(k).not.toBeNull();
    expect(k!.attribute).toBe("preference");
  });

  it("属性无法归一 → null（交给 embedding 兜底）", () => {
    expect(deriveAttributeKey(mk({ content: "今天天气不错" }))).toBeNull();
  });

  it("空输入 / 空 content 且无元数据 → null，不抛错", () => {
    expect(deriveAttributeKey(mk({ content: "" }))).toBeNull();
    expect(deriveAttributeKey({} as unknown as MemoryRecord)).toBeNull();
  });

  it("非法元数据值不崩：work_object 非字符串、coreRefs 非数组 → 回落文本主语", () => {
    const k = deriveAttributeKey(
      mk({ content: "我负责 L3 巩固归组", metadata: { work_object: 42, coreRefs: "not-an-array" } }),
    );
    expect(k).not.toBeNull();
    expect(k!.entity).toBe(k!.entity.trim());
    expect(k!.attribute).toBe("module_ownership");
  });

  it("同 entity 同 attribute 不同表述 → 同 key", () => {
    const a = deriveAttributeKey(
      mk({ content: "决定先做前端再谈分摊算法", metadata: { work_object: "tjbh-frontend" } }),
    );
    const b = deriveAttributeKey(mk({ content: "拍板：先做前端", metadata: { work_object: "TJbh-Frontend " } }));
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.key).toBe(b!.key);
  });

  it("entity 归一：大小写/空白/尾标点不产生新键", () => {
    const a = deriveAttributeKey(mk({ content: "使用 playwright 取证", metadata: { work_object: "  Playwright " } }));
    const b = deriveAttributeKey(mk({ content: "使用 playwright 取证", metadata: { work_object: "playwright。" } }));
    expect(a!.key).toBe(b!.key);
  });

  it("有限词表：覆盖任务要求的五类属性", () => {
    for (const name of ["module_ownership", "tooling", "decision", "preference", "root_cause"]) {
      expect(CONSOLIDATION_ATTRIBUTE_NAMES).toContain(name);
    }
    expect(CONSOLIDATION_ATTRIBUTE_NAMES.length).toBeLessThanOrEqual(24);
  });
});
