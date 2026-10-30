/**
 * #121 8.3 回归：Context Engine 槽位不可用时，**不得**硬禁全部 hook。
 *
 * 缺陷：`registerOffload()` 在
 *   - `plugins.slots.contextEngine` 不指向本插件（旧 index.ts:1229-1234），或
 *   - `api.registerContextEngine()` 返回 `{ ok: false }`（旧 :1263-1267）
 * 时置 `_contextEngineRejected = true` 并 `return`，而旧的 hook 包装器（:1005-1015）
 * 一旦看到该 flag 就直接 return ⇒ after_tool_call 采集、before_prompt_build 预处理、
 * llm_input 的 L3 压缩全链静默失效；同时因为提前 return，reclaim scheduler 也不启动。
 * 修复后该 flag 与包装器都已删除，`_trackedOn` 直接把 handler 交给 `api.on`。
 *
 * 契约（对齐上游：只 warn，不禁用）：
 *   1) hook 包装器不再因 CE 槽位问题短路——采集 / L3 通路照常执行；
 *   2) 只对「L1.5 判定 + MMD 注入不可用」warn，不再 error「ALL offload functions disabled」；
 *   3) reclaim scheduler 仍然启动（offloadRetentionDays >= 3）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerOffload } from "./index.js";

type HookHandler = (...args: any[]) => any;

interface FakeApi {
  logger: Record<string, (...args: any[]) => void>;
  config: Record<string, unknown>;
  hooks: Map<string, HookHandler[]>;
  registerContextEngineCalls: Array<{ id: string; arg: unknown }>;
  on: (name: string, handler: HookHandler) => void;
  registerContextEngine: (id: string, arg: unknown) => unknown;
}

interface Logs {
  debug: string[];
  info: string[];
  warn: string[];
  error: string[];
}

function makeApi(opts: {
  slot?: string;
  registerResult?: unknown;
  logs: Logs;
}): FakeApi {
  const hooks = new Map<string, HookHandler[]>();
  const registerContextEngineCalls: Array<{ id: string; arg: unknown }> = [];
  const api: FakeApi = {
    logger: {
      debug: (msg: unknown) => opts.logs.debug.push(String(msg)),
      info: (msg: unknown) => opts.logs.info.push(String(msg)),
      warn: (msg: unknown) => opts.logs.warn.push(String(msg)),
      error: (msg: unknown) => opts.logs.error.push(String(msg)),
    },
    config: { plugins: { slots: { contextEngine: opts.slot } } },
    hooks,
    registerContextEngineCalls,
    on: (name: string, handler: HookHandler) => {
      const arr = hooks.get(name) ?? [];
      arr.push(handler);
      hooks.set(name, arr);
    },
    registerContextEngine: (id: string, arg: unknown) => {
      registerContextEngineCalls.push({ id, arg });
      return opts.registerResult ?? { ok: true };
    },
  };
  return api;
}

function makeOffloadConfig(dataDir: string, retentionDays: number) {
  return {
    dataDir,
    mode: "backend",
    backendUrl: "http://127.0.0.1:1",
    offloadRetentionDays: retentionDays,
    logMaxSizeMb: 10,
    enabled: true,
  } as never;
}

/** 触发一次 after_tool_call：包装器被短路时这条 debug 不会出现。 */
async function fireAfterToolCall(api: FakeApi): Promise<void> {
  const handlers = api.hooks.get("after_tool_call") ?? [];
  expect(handlers.length).toBeGreaterThan(0);
  for (const h of handlers) await h({ toolName: "Read", toolCallId: "t-1" }, {});
}

/** 触发一次 llm_input（L3 压缩通路）：包装器被短路时这条 debug 不会出现。 */
async function fireLlmInput(api: FakeApi): Promise<void> {
  const handlers = api.hooks.get("llm_input") ?? [];
  expect(handlers.length).toBeGreaterThan(0);
  for (const h of handlers) await h({ messages: [] }, {});
}

const dataDirs: string[] = [];

function freshDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "offload-ce-slot-"));
  dataDirs.push(dir);
  return dir;
}

afterEach(() => {
  // 让 registerOffload 走一遍 retentionDays=0 的分支，清掉 24h reclaim timer
  const logs: Logs = { debug: [], info: [], warn: [], error: [] };
  try {
    registerOffload(makeApi({ slot: "legacy", logs }) as never, makeOffloadConfig(freshDataDir(), 0));
  } catch {
    /* best-effort cleanup */
  }
  while (dataDirs.length > 0) {
    const dir = dataDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function joined(list: string[]): string {
  return list.join("\n");
}

describe("CE 槽位不可用时 offload hook 仍工作（#121 8.3）", () => {
  it("slots.contextEngine 指向别的引擎：hook 照常执行、只 warn、scheduler 仍启动", async () => {
    const logs: Logs = { debug: [], info: [], warn: [], error: [] };
    const api = makeApi({ slot: "legacy", logs });

    registerOffload(api as never, makeOffloadConfig(freshDataDir(), 7));

    // 1) 未注册 CE（槽位不属于本插件），但不得因此调用 registerContextEngine
    expect(api.registerContextEngineCalls).toHaveLength(0);

    // 2) 采集与 L3 通路仍然真正执行（旧实现：_contextEngineRejected=true 时直接 return）
    await fireAfterToolCall(api);
    await fireLlmInput(api);
    expect(joined(logs.debug)).toContain(">>> after_tool_call START");
    expect(joined(logs.debug)).toContain(">>> llm_input START");

    // 3) 只 warn（MMD 注入 / L1.5 不可用），不再 error 硬禁
    expect(joined(logs.warn)).toContain("plugins.slots.contextEngine");
    expect(joined(logs.warn)).toMatch(/MMD/);
    expect(joined(logs.error)).not.toMatch(/ALL offload functions disabled/i);
    expect(joined(logs.error)).not.toMatch(/all hooks will be no-ops/i);
    expect(joined(logs.error)).not.toMatch(/Offload module DISABLED/i);

    // 4) reclaim scheduler 仍启动（旧实现提前 return，永远看不到这条）
    expect(joined(logs.debug)).toContain("Reclaim scheduler started");
  });

  it("registerContextEngine 返回 ok:false（槽位被占）：hook 照常执行、只 warn、scheduler 仍启动", async () => {
    const logs: Logs = { debug: [], info: [], warn: [], error: [] };
    const api = makeApi({
      slot: "memory-tencentdb",
      registerResult: { ok: false, existingOwner: "other-engine" },
      logs,
    });

    registerOffload(api as never, makeOffloadConfig(freshDataDir(), 7));

    expect(api.registerContextEngineCalls).toHaveLength(1);

    await fireAfterToolCall(api);
    await fireLlmInput(api);
    expect(joined(logs.debug)).toContain(">>> after_tool_call START");
    expect(joined(logs.debug)).toContain(">>> llm_input START");

    expect(joined(logs.warn) + joined(logs.error)).toMatch(/existingOwner|occupied/i);
    expect(joined(logs.error)).not.toMatch(/ALL offload functions disabled/i);
    expect(joined(logs.error)).not.toMatch(/all hooks will be no-ops/i);

    expect(joined(logs.debug)).toContain("Reclaim scheduler started");
  });

  it("槽位指向本插件：注册成功、hook 执行、scheduler 启动（对照，防回归）", async () => {
    const logs: Logs = { debug: [], info: [], warn: [], error: [] };
    const api = makeApi({ slot: "memory-tencentdb", registerResult: { ok: true }, logs });

    registerOffload(api as never, makeOffloadConfig(freshDataDir(), 7));

    expect(api.registerContextEngineCalls).toHaveLength(1);
    expect(api.registerContextEngineCalls[0]!.id).toBe("memory-tencentdb");

    await fireAfterToolCall(api);
    expect(joined(logs.debug)).toContain(">>> after_tool_call START");
    expect(joined(logs.debug)).toContain("Reclaim scheduler started");
    expect(joined(logs.warn)).not.toContain("plugins.slots.contextEngine");
  });
});
