import { describe, it, expect } from "vitest";
import { parseBatchResult } from "./l1-dedup.js";
import type { CoreValueCandidate } from "../prompts/l1-dedup.js";
import type { Logger } from "../types.js";

/**
 * R2 调用链契约测试（2026-10-06 审计轮）：
 *  - P0-1 假 merge 阻断：merge/update 缺 merged_content → 强制降级 store（不归档旧记忆）
 *  - P0-1 merged_type 非法/缺失 → 回填该记忆自身 type（merge/update）
 *  - P0-2 merged_priority clamp [0,100] 整数 / 非有限数丢弃；subject ≤12 字截断
 *  - P1-3 target_ids ⊆ 候选池过滤（幻觉 id 丢弃，缺省不传保持兼容）
 *  - P1-5 merged_timestamps ISO 过滤 / 去重 / 排序，全非法 → undefined
 *  - P1-1 截断抢救：输出被砍尾时抢救已闭合决策，缺的补 store
 *  - P1-4 硬化统计汇总 warn（Parse hardening stats）
 *  - 既有回归：fence 剥离 / 非法 action→store / coreRefs 幻觉过滤 / 缺决策补 store
 */

const mem = (record_id: string, type: "episodic" | "persona" | "instruction" = "episodic") => ({
  record_id,
  content: `新记忆-${record_id}`,
  type,
  priority: 70,
  source_message_ids: [] as string[],
  metadata: {},
  scene_name: "测试情境",
});

const values: CoreValueCandidate[] = [{ id: "v1", label: "文档" }];

const collectLogger = () => {
  const warns: string[] = [];
  const debugs: string[] = [];
  const logger = {
    warn: (m: string) => warns.push(m),
    debug: (m: string) => debugs.push(m),
    info: () => {},
    error: () => {},
  } as unknown as Logger;
  return { warns, debugs, logger };
};

describe("P0-1 假 merge 阻断", () => {
  it("merge 缺 merged_content → 强制降级 store 且清空 target/merged_*（旧记忆不归档）", () => {
    const raw = `[{"record_id":"n1","action":"merge","target_ids":["c1"],"merged_type":"episodic","merged_priority":80}]`;
    const d = parseBatchResult(raw, [mem("n1")]);
    expect(d[0].action).toBe("store");
    expect(d[0].target_ids).toEqual([]);
    expect(d[0].merged_content).toBeUndefined();
    expect(d[0].merged_type).toBeUndefined();
    expect(d[0].merged_priority).toBeUndefined();
  });

  it("update 缺 merged_content → 强制降级 store", () => {
    const raw = `[{"record_id":"n1","action":"update","target_ids":["c1"]}]`;
    const d = parseBatchResult(raw, [mem("n1")]);
    expect(d[0].action).toBe("store");
    expect(d[0].target_ids).toEqual([]);
  });

  it("merge 带 merged_content → 保留 merge 与 target", () => {
    const raw = `[{"record_id":"n1","action":"merge","target_ids":["c1"],"merged_content":"合并后内容","merged_type":"episodic","merged_priority":80,"merged_timestamps":["2026-01-01T00:00:00.000Z"]}]`;
    const d = parseBatchResult(raw, [mem("n1")]);
    expect(d[0].action).toBe("merge");
    expect(d[0].target_ids).toEqual(["c1"]);
    expect(d[0].merged_content).toBe("合并后内容");
  });

  it("conflict / skip 本就不带 merged_content → 不降级", () => {
    const raw = `[{"record_id":"n1","action":"conflict","target_ids":["c1"]},{"record_id":"n2","action":"skip"}]`;
    const d = parseBatchResult(raw, [mem("n1"), mem("n2")]);
    expect(d.find((x) => x.record_id === "n1")?.action).toBe("conflict");
    expect(d.find((x) => x.record_id === "n2")?.action).toBe("skip");
  });

  it("merge 缺 merged_content 降级时打 per-item warn", () => {
    const { warns, logger } = collectLogger();
    const raw = `[{"record_id":"n1","action":"merge","target_ids":["c1"]}]`;
    parseBatchResult(raw, [mem("n1")], logger);
    expect(warns.some((w) => w.includes("downgraded to store"))).toBe(true);
  });
});

describe("P0-1 merged_type 回填", () => {
  it("merge 时 merged_type 非法 → 回填该记忆自身 type", () => {
    const raw = `[{"record_id":"n1","action":"merge","target_ids":["c1"],"merged_content":"合并内容","merged_type":"banana"}]`;
    const d = parseBatchResult(raw, [mem("n1", "persona")]);
    expect(d[0].action).toBe("merge");
    expect(d[0].merged_type).toBe("persona");
  });

  it("merge 时 merged_type 缺失 → 回填自身 type", () => {
    const raw = `[{"record_id":"n1","action":"merge","target_ids":["c1"],"merged_content":"合并内容"}]`;
    const d = parseBatchResult(raw, [mem("n1", "instruction")]);
    expect(d[0].merged_type).toBe("instruction");
  });

  it("merged_type 合法 → 原样保留", () => {
    const raw = `[{"record_id":"n1","action":"merge","target_ids":["c1"],"merged_content":"合并内容","merged_type":"work_method"}]`;
    const d = parseBatchResult(raw, [mem("n1")]);
    expect(d[0].merged_type).toBe("work_method");
  });
});

describe("P0-2 priority 与 subject 钳制", () => {
  it("merged_priority 越界 clamp 到 [0,100]，小数取整", () => {
    const raw = `[{"record_id":"n1","action":"merge","merged_content":"甲","merged_priority":150},{"record_id":"n2","action":"merge","merged_content":"乙","merged_priority":-5},{"record_id":"n3","action":"merge","merged_content":"丙","merged_priority":85.6}]`;
    const d = parseBatchResult(raw, [mem("n1"), mem("n2"), mem("n3")]);
    expect(d.find((x) => x.record_id === "n1")?.merged_priority).toBe(100);
    expect(d.find((x) => x.record_id === "n2")?.merged_priority).toBe(0);
    expect(d.find((x) => x.record_id === "n3")?.merged_priority).toBe(86);
  });

  it("merged_priority 非数字 → undefined（writer 兜底）；非有限数 → undefined", () => {
    const raw = `[{"record_id":"n1","action":"merge","merged_content":"甲","merged_priority":"85"},{"record_id":"n2","action":"merge","merged_content":"乙","merged_priority":1e999}]`;
    const d = parseBatchResult(raw, [mem("n1"), mem("n2")]);
    expect(d.find((x) => x.record_id === "n1")?.merged_priority).toBeUndefined();
    expect(d.find((x) => x.record_id === "n2")?.merged_priority).toBeUndefined();
  });

  it("subject 超 12 字截断；12 字内原样；空串 → undefined", () => {
    const raw = `[{"record_id":"n1","action":"store","subject":"一二三四五六七八九十一二三"},{"record_id":"n2","action":"store","subject":"一二三四五六七八九十"},{"record_id":"n3","action":"store","subject":"  "}]`;
    const d = parseBatchResult(raw, [mem("n1"), mem("n2"), mem("n3")]);
    expect(d.find((x) => x.record_id === "n1")?.subject).toBe("一二三四五六七八九十一二");
    expect(d.find((x) => x.record_id === "n2")?.subject).toBe("一二三四五六七八九十");
    expect(d.find((x) => x.record_id === "n3")?.subject).toBeUndefined();
  });
});

describe("P1-3 target_ids 池过滤", () => {
  it("传池：幻觉 id 被丢弃，池内 id 保留", () => {
    const raw = `[{"record_id":"n1","action":"conflict","target_ids":["c1","GHOST-ID"]}]`;
    const d = parseBatchResult(raw, [mem("n1")], undefined, [], new Set(["c1", "c2"]));
    expect(d[0].target_ids).toEqual(["c1"]);
    expect(d[0].action).toBe("conflict");
  });

  it("传池：全幻觉 target → 空数组但 action 保留（宁重复不丢失）", () => {
    const raw = `[{"record_id":"n1","action":"merge","merged_content":"合","target_ids":["GHOST"]}]`;
    const d = parseBatchResult(raw, [mem("n1")], undefined, [], new Set(["c1"]));
    expect(d[0].action).toBe("merge");
    expect(d[0].target_ids).toEqual([]);
  });

  it("不传池（既有调用兼容）：target 原样保留", () => {
    const raw = `[{"record_id":"n1","action":"conflict","target_ids":["c1","GHOST-ID"]}]`;
    const d = parseBatchResult(raw, [mem("n1")]);
    expect(d[0].target_ids).toEqual(["c1", "GHOST-ID"]);
  });
});

describe("P1-5 merged_timestamps 规范化", () => {
  it("过滤非 ISO、去重、升序排序", () => {
    const raw = `[{"record_id":"n1","action":"merge","merged_content":"合","merged_timestamps":["2026-01-02T00:00:00.000Z","2026-01-01T00:00:00.000Z","2026-01-01T00:00:00.000Z","not-a-date",""]}]`;
    const d = parseBatchResult(raw, [mem("n1")]);
    expect(d[0].merged_timestamps).toEqual(["2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z"]);
  });

  it("全部非法 → undefined（writer 兜底 [now]）", () => {
    const raw = `[{"record_id":"n1","action":"merge","merged_content":"合","merged_timestamps":["nope","also-nope"]}]`;
    const d = parseBatchResult(raw, [mem("n1")]);
    expect(d[0].merged_timestamps).toBeUndefined();
  });
});

describe("P1-1 截断抢救", () => {
  it("输出在第二条决策中被砍尾 → 抢救第一条完整决策，缺的补 store", () => {
    const first = `{"record_id":"n1","action":"merge","target_ids":["c1"],"merged_content":"完整合并内容","merged_type":"episodic","merged_priority":80,"merged_timestamps":["2026-01-01T00:00:00.000Z"],"subject":"主题词","coreRefs":[]}`;
    const truncated = `[${first},{"record_id":"n2","action":"st`;
    const d = parseBatchResult(truncated, [mem("n1"), mem("n2")]);
    expect(d.find((x) => x.record_id === "n1")?.action).toBe("merge");
    expect(d.find((x) => x.record_id === "n1")?.merged_content).toBe("完整合并内容");
    expect(d.find((x) => x.record_id === "n2")?.action).toBe("store");
  });

  it("完全非 JSON 文本 → 全 store fallback", () => {
    const d = parseBatchResult("抱歉，我无法完成判定。", [mem("n1")]);
    expect(d.length).toBe(1);
    expect(d[0].action).toBe("store");
  });
});

describe("P1-4 硬化统计汇总", () => {
  it("发生降级/钳制/过滤时打 Parse hardening stats 汇总 warn", () => {
    const { warns, logger } = collectLogger();
    const raw = `[{"record_id":"n1","action":"merge","target_ids":["c1"]},{"record_id":"n2","action":"delete"}]`;
    parseBatchResult(raw, [mem("n1"), mem("n2")], logger, [], new Set(["c1"]));
    expect(warns.some((w) => w.includes("Parse hardening stats"))).toBe(true);
  });

  it("零违规的干净解析不打汇总", () => {
    const { warns, logger } = collectLogger();
    const raw = `[{"record_id":"n1","action":"store","subject":"主题","coreRefs":[]}]`;
    parseBatchResult(raw, [mem("n1")], logger);
    expect(warns.some((w) => w.includes("Parse hardening stats"))).toBe(false);
  });
});

describe("既有行为回归", () => {
  it("code fence 剥离", () => {
    const raw = "```json\n[{\"record_id\":\"n1\",\"action\":\"store\"}]\n```";
    const d = parseBatchResult(raw, [mem("n1")]);
    expect(d[0].action).toBe("store");
  });

  it("非法 action → store（既有降级）", () => {
    const raw = `[{"record_id":"n1","action":"delete"}]`;
    const d = parseBatchResult(raw, [mem("n1")]);
    expect(d[0].action).toBe("store");
  });

  it("coreRefs 幻觉过滤：清单内保留、清单外丢弃、全幻觉 → undefined", () => {
    const raw = `[{"record_id":"n1","action":"store","coreRefs":["文档","编造锚"]},{"record_id":"n2","action":"store","coreRefs":["编造锚"]}]`;
    const d = parseBatchResult(raw, [mem("n1"), mem("n2")], undefined, values);
    expect(d[0].coreRefs).toEqual(["文档"]);
    expect(d[1].coreRefs).toBeUndefined();
  });

  it("缺决策的记录补 store", () => {
    const raw = `[{"record_id":"n1","action":"store"}]`;
    const d = parseBatchResult(raw, [mem("n1"), mem("n2")]);
    expect(d.find((x) => x.record_id === "n2")?.action).toBe("store");
  });
});
