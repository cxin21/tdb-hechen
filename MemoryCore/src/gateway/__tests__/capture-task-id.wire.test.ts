/**
 * task-8（x-tdai-task-id 采集链路）wire 测试。
 *
 * 断言四件事：
 *   1. 网关头解析：x-tdai-task-id 存在 → CompletedTurn.taskId；缺失/纯空白 → undefined；
 *   2. 真链落库：handleTurnCommitted(taskId) → l0_conversations.task_id 等于该值 → store 的
 *      L0 分组读出 m.taskId（pipeline-factory:576/:634 的同一入口）；
 *   3. 不带 taskId 时落库仍是空串/缺省（旧调用方逐位不变）；
 *   4. /recall 与 /search/memories 同头进 IsolationFilter.taskId（不带时 filter 不出现该键）。
 *
 * LLM 永不进单测：capture 链走真 VectorStore(dimensions=0)，pipeline 以 scheduler=undefined 短路。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { TdaiGateway } from "../server.js";
import { TdaiCore } from "../../core/tdai-core.js";
import { SessionFilter } from "../../utils/session-filter.js";
import { VectorStore } from "../../core/store/sqlite.js";

// ============================ helpers ============================

const logSink = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function makeReq(headers: Record<string, string>, body: unknown): any {
  const req: any = Readable.from([Buffer.from(JSON.stringify(body), "utf8")]);
  req.headers = { ...headers };
  req.method = "POST";
  req.url = "/capture";
  return req;
}

function makeRes(): any {
  const res: any = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: "",
    writeHead(status: number, headers: Record<string, string>) {
      res.statusCode = status;
      res.headers = headers ?? {};
      return res;
    },
    end(chunk?: unknown) {
      res.body = chunk === undefined ? "" : String(chunk);
      return res;
    },
  };
  return res;
}

/** 绕开 ctor（不读配置、不建目录），只注入 core/logger —— 与真实网关同一 prototype。 */
function makeGateway(core: unknown): any {
  const gw: any = Object.create(TdaiGateway.prototype);
  gw.core = core;
  gw.logger = logSink;
  return gw;
}

const CAPTURE_BODY = {
  user_content: "hello task scope",
  assistant_content: "noted",
  session_key: "sess-taskid-wire",
  session_id: "sess-taskid-wire",
};

// ============================ 1. 头解析 ============================

describe("网关 x-tdai-task-id 头解析", () => {
  it("带头 → handleTurnCommitted 收到 trim 后的 taskId；/recall 与 /search 进 filter", async () => {
    const calls: any[] = [];
    const core = {
      async handleTurnCommitted(turn: any) {
        calls.push({ kind: "capture", turn });
        return { l0RecordedCount: 2, schedulerNotified: false };
      },
      async handleBeforeRecall(query: string, sessionKey: string, isolation?: any) {
        calls.push({ kind: "recall", query, sessionKey, isolation });
        return { appendSystemContext: "", recalledL1Memories: [], recallStrategy: "none" };
      },
      async searchMemories(params: any) {
        calls.push({ kind: "search", params });
        return { text: "", total: 0, strategy: "none" };
      },
    };
    const gw = makeGateway(core);

    const headers = { "x-tdai-task-id": "  task-8  " };
    const capRes = makeRes();
    await gw.handleCapture(makeReq(headers, CAPTURE_BODY), capRes);
    expect(capRes.statusCode).toBe(200);

    const recRes = makeRes();
    await gw.handleRecall(makeReq(headers, { query: "q", session_key: "s1" }), recRes);
    const seaRes = makeRes();
    await gw.handleSearchMemories(makeReq(headers, { query: "q" }), seaRes);

    const capture = calls.find((c) => c.kind === "capture");
    expect(capture.turn.taskId).toBe("task-8");
    expect(capture.turn.teamId).toBeUndefined(); // 租户头未变
    const recall = calls.find((c) => c.kind === "recall");
    expect(recall.isolation?.taskId).toBe("task-8");
    const search = calls.find((c) => c.kind === "search");
    expect(search.params.isolationFilter?.taskId).toBe("task-8");
  });

  it("不带头 / 纯空白头 → taskId undefined，filter 不出现 taskId 键（旧行为逐位）", async () => {
    const calls: any[] = [];
    const core = {
      async handleTurnCommitted(turn: any) {
        calls.push({ kind: "capture", turn });
        return { l0RecordedCount: 0, schedulerNotified: false };
      },
      async handleBeforeRecall(query: string, sessionKey: string, isolation?: any) {
        calls.push({ kind: "recall", isolation });
        return { appendSystemContext: "", recalledL1Memories: [], recallStrategy: "none" };
      },
      async searchMemories(params: any) {
        calls.push({ kind: "search", params });
        return { text: "", total: 0, strategy: "none" };
      },
    };
    const gw = makeGateway(core);

    await gw.handleCapture(makeReq({}, CAPTURE_BODY), makeRes());
    await gw.handleCapture(makeReq({ "x-tdai-task-id": "   " }, CAPTURE_BODY), makeRes());
    await gw.handleRecall(makeReq({}, { query: "q", session_key: "s1" }), makeRes());
    await gw.handleSearchMemories(makeReq({}, { query: "q" }), makeRes());

    const captures = calls.filter((c) => c.kind === "capture");
    expect(captures.map((c) => c.turn.taskId)).toEqual([undefined, undefined]);
    expect(calls.find((c) => c.kind === "recall").isolation).toBeUndefined();
    const search = calls.find((c) => c.kind === "search");
    expect(search.params.isolationFilter).toBeUndefined();
  });
});

// ============================ 2. 真链落库 ============================

describe("capture 链 → l0_conversations.task_id", () => {
  let store: VectorStore | undefined;
  let tmpDir: string | undefined;

  afterEach(() => {
    try { store?.close(); } catch { /* already closed */ }
    store = undefined;
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  function makeCore(): TdaiCore {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-taskid-"));
    store = new VectorStore(path.join(tmpDir, "vectors.db"), 0, logSink as any);
    const initResult = store.init();
    expect(store.isDegraded()).toBe(false);
    expect(initResult).toBeTruthy();

    const hostAdapter = {
      hostType: "standalone",
      getRuntimeContext: () => ({ dataDir: tmpDir }),
      getLogger: () => logSink,
      // 永不调用：本测试只走 L0 落库与 store 分组，不触发任何 LLM 抽取。
      getLLMRunnerFactory: () => ({ run: async () => ({}) }) as any,
    };
    const core = new TdaiCore({
      hostAdapter: hostAdapter as any,
      // 只给 capture 链真正会读到的开关；pipeline 以 scheduler=undefined 短路。
      config: { extraction: { enabled: false } } as any,
      sessionFilter: new SessionFilter([]),
    });
    // 注入真 store，跳过 initialize() 的目录/调度器初始化（本测试不跑 pipeline）。
    Object.assign(core, { vectorStore: store, storeReady: Promise.resolve() });
    return core;
  }

  it("带 taskId 时 L0 行 task_id = 该值，store 分组也读出 m.taskId", async () => {
    const core = makeCore();
    const result = await core.handleTurnCommitted({
      userText: "hello task scope",
      assistantText: "noted",
      messages: [
        { role: "user", content: "hello task scope", timestamp: 1710000000000 },
        { role: "assistant", content: "noted", timestamp: 1710000000001 },
      ],
      sessionKey: "wire-task-scope-1",
      sessionId: "wire-task-scope-1",
      taskId: "task-8",
      // 冷启动游标：不设时 pluginStartTimestamp=now，会把历史时间戳的消息全部过滤掉。
      startedAt: 1,
    });
    expect(result.l0RecordedCount).toBe(2);

    const db = store!.getRawDb();
    const rows = db.prepare("SELECT task_id, message_text FROM l0_conversations WHERE session_key = ?").all("wire-task-scope-1") as any[];
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.task_id).toBe("task-8");

    // pipeline 同一入口：L0 分组必须把 taskId 带出（pipeline-factory:576/:634 的 m.taskId）。
    const groups = store!.queryL0GroupedBySessionId("wire-task-scope-1");
    expect(groups).toHaveLength(1);
    expect(groups[0].taskId).toBe("task-8");
  });

  it("不带 taskId 时 task_id 保持空串（旧调用方逐位不变）", async () => {
    const core = makeCore();
    const result = await core.handleTurnCommitted({
      userText: "no task scope",
      assistantText: "noted",
      messages: [
        { role: "user", content: "no task scope", timestamp: 1710000001000 },
        { role: "assistant", content: "noted", timestamp: 1710000001001 },
      ],
      sessionKey: "wire-task-scope-2",
      sessionId: "wire-task-scope-2",
      startedAt: 1,
    });
    expect(result.l0RecordedCount).toBe(2);

    const db = store!.getRawDb();
    const rows = db.prepare("SELECT task_id FROM l0_conversations WHERE session_key = ?").all("wire-task-scope-2") as any[];
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.task_id ?? "").toBe("");

    const groups = store!.queryL0GroupedBySessionId("wire-task-scope-2");
    expect(groups).toHaveLength(1);
    expect(groups[0].taskId).toBeUndefined();
  });
});
