# Memory Hub 管理员设置页（Wiki/Memory 设置 + embedding 重建）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 管理员在 Memory Hub UI 设置页配置 MemoryKnowledge / MemoryCore 的 LLM 与 embedding；服务自持 override 配置 + admin 接口；embedding 变更重启后自动重建向量索引。

**Architecture:** 四个阶段独立可交付——A: KS admin settings API + override 合并 + 指纹强制重建；B: Core 同款（复用其 `needsReindex` 机制，接上无人调用的 `reindexAll`）；C: Panel 后端透传（admin 门控）+ Web 设置页两个页签；D: MemoryProxy——成员 Provider 门禁豁免（方案 B，门禁迁转发缝）+ creditPricing 运行时管理（复刻 rate-limits 模式）+ Panel「Proxy 计费」页签。

**Tech Stack:** TypeScript ESM（`"type":"module"`，import 带 `.js` 后缀）、Hono（KS）、node:http 自研路由（Core）、React18 + tea-component + zustand（Panel web）、vitest。

**Spec:** `td-agemem/docs/superpowers/specs/2026-09-09-hub-admin-settings-design.md`

## Global Constraints

- 不新增任何 npm 依赖。
- 所有 import 使用 `.js` 后缀（ESM 编译产物兼容）。
- apiKey 永不明文回显：GET 只回 `{ hasApiKey, apiKeyMasked(尾4位) }`；PUT 传空串 = 保留原值。
- 启动合并优先级：`config-override.json` > env（KS）/ `TDAI_LLM_*` env 与 yaml（Core）。
- 保存成功响应恒含 `needsRestart: true`；embedding model/dimensions 变更时另含 `embeddingChanged: true`。
- 重建失败必须可见：`log.error/warn` + 状态置 `failed`，禁止静默降级。
- 测试框架 vitest；每任务先写失败测试再实现（TDD）。
- 提交信息用 conventional commits（feat/test/docs 前缀）。

---

# 阶段 A：MemoryKnowledge

### Task 1: KS config-override 模块 + 启动合并

**Files:**
- Create: `td-agemem/MemoryKnowledge/src/config-override.ts`
- Modify: `td-agemem/MemoryKnowledge/src/config.ts:196`（`loadConfig` 返回前合并）
- Test: `td-agemem/MemoryKnowledge/tests/config-override.test.ts`

**Interfaces:**
- Produces（Task 2 依赖）: `readSettingsOverride(dataDir): SettingsOverride | null`、`writeSettingsOverride(dataDir, o)`、`mergeOverride(base, override)`、`maskKey(key)`、`validateOverride(body)`、类型 `SettingsOverride`

- [ ] **Step 1: 写失败测试**

```ts
// tests/config-override.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readSettingsOverride, writeSettingsOverride, mergeOverride, maskKey, validateOverride,
} from "../src/config-override.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ks-ovr-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("config-override", () => {
  it("无文件时返回 null", () => {
    expect(readSettingsOverride(dir)).toBeNull();
  });
  it("write 后 read 幂等回读", () => {
    writeSettingsOverride(dir, { llm: { model: "m2" } });
    expect(readSettingsOverride(dir)?.llm?.model).toBe("m2");
  });
  it("mergeOverride：override 优先，未定义字段保留 base", () => {
    const merged = mergeOverride(
      { llm: { model: "m1", maxTokens: 100 }, embedding: { model: "e1", dimensions: 8 } },
      { llm: { model: "m2" }, embedding: { model: "e2" } },
    );
    expect(merged.llm).toEqual({ model: "m2", maxTokens: 100 });
    expect(merged.embedding).toEqual({ model: "e2", dimensions: 8 });
  });
  it("mergeOverride：override 为 null 时原样返回", () => {
    const base = { llm: { model: "m1" }, embedding: { model: "e1" } };
    expect(mergeOverride(base, null)).toEqual(base);
  });
  it("maskKey 只回尾 4 位与 hasApiKey", () => {
    expect(maskKey("sk-abcdef")).toEqual({ hasApiKey: true, apiKeyMasked: "****cdef" });
    expect(maskKey(undefined)).toEqual({ hasApiKey: false, apiKeyMasked: "" });
  });
  it("validateOverride 拒绝非法 URL 与非正整数", () => {
    const bad = validateOverride({ llm: { baseUrl: "ftp://x" }, embedding: { dimensions: 0 } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.length).toBe(2);
    const good = validateOverride({ llm: { baseUrl: "https://a.b", model: "m", maxTokens: 10, timeoutMs: 5 }, embedding: { model: "e", dimensions: 8, provider: "openai_compatible", baseUrl: "https://a.b", apiKey: "k" } });
    expect(good.ok).toBe(true);
  });
  it("validateOverride 忽略未提供的段", () => {
    expect(validateOverride({})).toEqual({ ok: true, value: {} });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd D:\TDB\td-agemem\MemoryKnowledge; pnpm vitest run tests/config-override.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `src/config-override.ts`**

```ts
/**
 * Admin settings override — {dataDir}/config-override.json 的读写/校验/合并。
 * 优先级：override > env（loadConfig 内合并）。仅覆盖 llm / embedding 两段。
 */
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

export interface LlmSettingsOverride {
  baseUrl?: string; apiKey?: string; model?: string; maxTokens?: number; timeoutMs?: number;
}
export interface EmbeddingSettingsOverride {
  provider?: string; baseUrl?: string; apiKey?: string; model?: string; dimensions?: number;
}
export interface SettingsOverride {
  llm?: LlmSettingsOverride;
  embedding?: EmbeddingSettingsOverride;
}

const OVERRIDE_FILE = "config-override.json";
const HTTP_URL_RE = /^https?:\/\/.+/i;

export function readSettingsOverride(dataDir: string): SettingsOverride | null {
  const p = join(dataDir, OVERRIDE_FILE);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as SettingsOverride;
  } catch {
    return null; // 损坏文件按无 override 处理，服务可正常启动
  }
}

/** 原子写：tmp + rename，避免半写文件被下次启动读到。 */
export function writeSettingsOverride(dataDir: string, o: SettingsOverride): void {
  const p = join(dataDir, OVERRIDE_FILE);
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(o, null, 2), "utf-8");
  renameSync(tmp, p);
}

function pickDefined<T extends object>(o: T | undefined): Partial<T> {
  if (!o) return {};
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** 纯合并：override 中 undefined 字段不覆盖 base。 */
export function mergeOverride<L extends object, E extends object>(
  base: { llm: L; embedding: E },
  override: SettingsOverride | null,
): { llm: L; embedding: E } {
  if (!override) return base;
  return {
    llm: { ...base.llm, ...pickDefined(override.llm) },
    embedding: { ...base.embedding, ...pickDefined(override.embedding) },
  };
}

export function maskKey(key: string | undefined): { hasApiKey: boolean; apiKeyMasked: string } {
  if (!key) return { hasApiKey: false, apiKeyMasked: "" };
  return { hasApiKey: true, apiKeyMasked: key.length <= 4 ? "****" : `****${key.slice(-4)}` };
}

export function validateOverride(body: unknown): { ok: true; value: SettingsOverride } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const out: SettingsOverride = {};
  const b = (body ?? {}) as Record<string, any>;
  if (b.llm) {
    const llm: LlmSettingsOverride = {};
    if (b.llm.baseUrl !== undefined) {
      if (typeof b.llm.baseUrl === "string" && HTTP_URL_RE.test(b.llm.baseUrl)) llm.baseUrl = b.llm.baseUrl;
      else errors.push("llm.baseUrl 必须是合法 http(s) URL");
    }
    if (b.llm.apiKey !== undefined) {
      if (typeof b.llm.apiKey === "string") llm.apiKey = b.llm.apiKey;
      else errors.push("llm.apiKey 必须是字符串");
    }
    if (b.llm.model !== undefined) {
      if (typeof b.llm.model === "string" && b.llm.model.trim()) llm.model = b.llm.model.trim();
      else errors.push("llm.model 必须是非空字符串");
    }
    for (const intField of ["maxTokens", "timeoutMs"] as const) {
      if (b.llm[intField] !== undefined) {
        const n = Number(b.llm[intField]);
        if (Number.isInteger(n) && n > 0) llm[intField] = n;
        else errors.push(`llm.${intField} 必须是正整数`);
      }
    }
    if (Object.keys(llm).length) out.llm = llm;
  }
  if (b.embedding) {
    const emb: EmbeddingSettingsOverride = {};
    for (const strField of ["provider", "baseUrl", "apiKey", "model"] as const) {
      if (b.embedding[strField] !== undefined) {
        if (typeof b.embedding[strField] === "string") emb[strField] = b.embedding[strField];
        else errors.push(`embedding.${strField} 必须是字符串`);
      }
    }
    if (emb.baseUrl !== undefined && !HTTP_URL_RE.test(emb.baseUrl)) errors.push("embedding.baseUrl 必须是合法 http(s) URL");
    if (emb.model !== undefined && !emb.model.trim()) errors.push("embedding.model 必须是非空字符串");
    if (b.embedding.dimensions !== undefined) {
      const n = Number(b.embedding.dimensions);
      if (Number.isInteger(n) && n > 0) emb.dimensions = n;
      else errors.push("embedding.dimensions 必须是正整数");
    }
    if (Object.keys(emb).length) out.embedding = emb;
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: out };
}
```

- [ ] **Step 4: `src/config.ts` 的 `loadConfig` 返回前合并 override**

`loadConfig` 结尾（原 `return {...};`）改为：

```ts
  const cfg: ServiceConfig = {
    port: envInt("PORT", 8421),
    // ……原 return 的全部字段原样保留……
  };
  // Admin settings override（{dataDir}/config-override.json）> env。见 spec §3.1。
  return { ...cfg, ...mergeOverride({ llm: cfg.llm, embedding: cfg.embedding }, readSettingsOverride(cfg.dataDir)) };
```

并在文件头部 import：`import { mergeOverride, readSettingsOverride } from "./config-override.js";`

- [ ] **Step 5: 跑测试与类型检查**

Run: `pnpm vitest run tests/config-override.test.ts` → PASS；`pnpm typecheck` → 0 error

- [ ] **Step 6: Commit**

```bash
git add td-agemem/MemoryKnowledge/src/config-override.ts td-agemem/MemoryKnowledge/src/config.ts td-agemem/MemoryKnowledge/tests/config-override.test.ts
git commit -m "feat(ks): admin settings override 存储与启动合并（spec §3.1）"
```

### Task 2: KS admin settings 路由（get/set/revectorize）

**Files:**
- Create: `td-agemem/MemoryKnowledge/src/routes/admin-settings.ts`
- Modify: `td-agemem/MemoryKnowledge/src/server.ts:89`（llm-binding 挂载之后追加）
- Test: `td-agemem/MemoryKnowledge/tests/admin-settings-routes.test.ts`

**Interfaces:**
- Consumes: Task 1 全部导出；Task 3 将提供的 `wikiMgr.vectorStatus()` / `wikiMgr.forceRevectorizeAll()`（本任务以可选 deps 注入，Task 3 完成后在 server.ts 补传）
- Produces: `POST /v3/admin/settings/get|set|revectorize`

- [ ] **Step 1: 写失败测试（Hono app.request 直测路由）**

```ts
// tests/admin-settings-routes.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdminSettingsRoutes } from "../src/routes/admin-settings.js";

function makeApp(dir: string) {
  const config = {
    llm: { mode: "custom", protocol: "openai", provider: "custom", apiKey: "sk-real-1234", model: "m1", baseUrl: "https://a.b", maxTokens: 100, timeoutMs: 200, stream: false },
    embedding: { provider: "openai_compatible", apiKey: "ek-9999", model: "e1", baseUrl: "https://e.b", dimensions: 8 },
  } as any;
  return createAdminSettingsRoutes({ config, dataDir: dir });
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ks-set-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("admin settings routes", () => {
  it("GET /get 返回掩码 key 与 env 来源", async () => {
    const app = makeApp(dir);
    const res = await app.request("/get", { method: "POST" });
    const json: any = await res.json();
    expect(json.code).toBe(0);
    expect(json.data.llm.apiKeyMasked).toBe("****1234");
    expect(json.data.llm.apiKey).toBeUndefined();
    expect(json.data.llm.source).toBe("env");
    expect(json.data.needsRestart).toBeUndefined();
  });
  it("SET 写 override、空 apiKey 保留原值、返回 needsRestart", async () => {
    const app = makeApp(dir);
    const res = await app.request("/set", { method: "POST", body: JSON.stringify({ llm: { model: "m2", apiKey: "" }, embedding: { model: "e1", dimensions: 8 } }), headers: { "content-type": "application/json" } });
    const json: any = await res.json();
    expect(json.code).toBe(0);
    expect(json.data.needsRestart).toBe(true);
    expect(json.data.embeddingChanged).toBe(false);
    const saved = JSON.parse(readFileSync(join(dir, "config-override.json"), "utf-8"));
    expect(saved.llm.model).toBe("m2");
    expect(saved.llm.apiKey).toBeUndefined(); // 空串 = 保留原值，不落盘
  });
  it("embedding model/dimensions 变更返回 embeddingChanged", async () => {
    const app = makeApp(dir);
    const res = await app.request("/set", { method: "POST", body: JSON.stringify({ embedding: { model: "e9", dimensions: 16 } }), headers: { "content-type": "application/json" } });
    const json: any = await res.json();
    expect(json.data.embeddingChanged).toBe(true);
  });
  it("非法输入 400", async () => {
    const app = makeApp(dir);
    const res = await app.request("/set", { method: "POST", body: JSON.stringify({ llm: { baseUrl: "ftp://x" } }), headers: { "content-type": "application/json" } });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/admin-settings-routes.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `src/routes/admin-settings.ts`**

```ts
/**
 * Admin settings routes — /v3/admin/settings/{get,set,revectorize}。
 * 内网信任模型（与 /v3/internal/llm-binding 一致）；管理员判定由 Panel 层完成。
 * 变更落 {dataDir}/config-override.json，重启后经 loadConfig 合并生效（spec §3.1）。
 */
import { Hono } from "hono";
import {
  readSettingsOverride, writeSettingsOverride, maskKey, validateOverride,
  type SettingsOverride,
} from "../config-override.js";
import { wrapOk, wrapError } from "../api-helpers.js";
import type { ServiceConfig } from "../config.js";

export interface AdminSettingsDeps {
  config: ServiceConfig;
  dataDir: string;
  /** Task 3 接线后注入；缺省时 rebuildStatus 恒为 idle、revectorize 返回 400。 */
  getVectorStatus?: () => unknown;
  forceRevectorize?: () => Promise<void>;
}

function deepMergeOverride(existing: SettingsOverride | null, incoming: SettingsOverride): SettingsOverride {
  return {
    llm: { ...(existing?.llm ?? {}), ...incoming.llm },
    embedding: { ...(existing?.embedding ?? {}), ...incoming.embedding },
  };
}

export function createAdminSettingsRoutes(deps: AdminSettingsDeps): Hono {
  const app = new Hono();
  const { config, dataDir } = deps;

  app.post("/get", (c) => {
    const override = readSettingsOverride(dataDir);
    const effectiveLlm = { ...config.llm, ...(override?.llm ?? {}) };
    const effectiveEmb = { ...config.embedding, ...(override?.embedding ?? {}) };
    return c.json(wrapOk({
      llm: { ...effectiveLlm, ...maskKey(effectiveLlm.apiKey), source: override?.llm ? "override" : "env" },
      embedding: { ...effectiveEmb, ...maskKey(effectiveEmb.apiKey), source: override?.embedding ? "override" : "env" },
      rebuildStatus: deps.getVectorStatus?.() ?? { status: "idle" },
    }));
  });

  app.post("/set", async (c) => {
    const body = await c.req.json<Record<string, any>>().catch(() => ({}) as Record<string, any>);
    // apiKey 空串 = 保留原值：剥掉后不落盘（maskKey 语义见 spec §3.1）
    if (body?.llm?.apiKey === "") delete body.llm.apiKey;
    if (body?.embedding?.apiKey === "") delete body.embedding.apiKey;
    const v = validateOverride(body);
    if (!v.ok) return c.json(wrapError(400, v.errors.join("; ")), 400);
    const existing = readSettingsOverride(dataDir);
    const merged = deepMergeOverride(existing, v.value);
    writeSettingsOverride(dataDir, merged);
    const nextEmb = merged.embedding ?? {};
    const embeddingChanged =
      (nextEmb.model !== undefined && nextEmb.model !== config.embedding.model) ||
      (nextEmb.dimensions !== undefined && nextEmb.dimensions !== config.embedding.dimensions);
    return c.json(wrapOk({ needsRestart: true, embeddingChanged }));
  });

  app.post("/revectorize", async (c) => {
    if (!deps.forceRevectorize) return c.json(wrapError(400, "embedding 未配置或未接线"), 400);
    await deps.forceRevectorize();
    return c.json(wrapOk({ started: true }));
  });

  return app;
}
```

- [ ] **Step 4: `src/server.ts` 挂载（`api.route("/internal/llm-binding", ...)` 之后，约 89 行）**

```ts
  // admin settings — Panel 透传（仅 Panel 层做 system_admin 门控，见 spec §4）
  api.route("/admin/settings", createAdminSettingsRoutes({
    config,
    dataDir: config.dataDir,
    getVectorStatus: () => knowledgeModule.wikiMgr.vectorStatus(),
    forceRevectorize: () => knowledgeModule.wikiMgr.forceRevectorizeAll(),
  }));
```

import 行：`import { createAdminSettingsRoutes } from "./routes/admin-settings.js";`
（`vectorStatus`/`forceRevectorizeAll` 由 Task 3 提供；本步骤先写上，若 Task 3 未完成则临时注释这两行并留 `// TODO(task3)`——两个任务同分支按序执行时无需注释。）

- [ ] **Step 5: 跑测试**

Run: `pnpm vitest run tests/admin-settings-routes.test.ts` → PASS；`pnpm typecheck` → 0 error

- [ ] **Step 6: Commit**

```bash
git add td-agemem/MemoryKnowledge/src/routes/admin-settings.ts td-agemem/MemoryKnowledge/src/server.ts td-agemem/MemoryKnowledge/tests/admin-settings-routes.test.ts
git commit -m "feat(ks): /v3/admin/settings get/set/revectorize 路由（spec §3.1）"
```

### Task 3: KS embedding 指纹 + force 全量重建 + 状态透出

**Files:**
- Modify: `td-agemem/MemoryKnowledge/src/engines/wiki/manager.ts`（factory 895-922、writeVectors 967-1022、返回对象）
- Modify: `td-agemem/MemoryKnowledge/src/engines/wiki/types.ts`（`WikiSourceManager` 接口，若接口在 types.ts；否则在 manager.ts 导出处）
- Test: `td-agemem/MemoryKnowledge/tests/wiki-vector-force.test.ts`

**Interfaces:**
- Consumes: 现有 `initIndexDb(path, vecDim)`（维度不匹配自动 DROP wiki_vec，index-db.ts:141-157）、`scanWikiDir`、`withWriteAsync`
- Produces: `wikiMgr.vectorStatus(): { status, reason?, startedAt?, finishedAt? }`、`wikiMgr.forceRevectorizeAll(): Promise<void>`；`writeVectors(path, pages, opts?)` 增加 `{ force?: boolean }`

- [ ] **Step 1: 写失败测试**

```ts
// tests/wiki-vector-force.test.ts
// 复用 tests/wiki-vector-write.test.ts 的引擎搭建方式（临时目录注册 wiki → 写入页面 → 等 build 完成）。
// 新增断言：force=true 时，content_sha 未变的页面也会重新 embed（embed 调用计数 > 0）。
import { describe, it, expect, vi } from "vitest";
// 沿用 wiki-vector-write.test.ts 的 mock embedding client 注入方式；核心断言：
describe("writeVectors force", () => {
  it("force=true 时跳过 content_sha 复用，全量重新 embed", async () => {
    // 搭建方式与 wiki-vector-write.test.ts 完全一致（临时 dir + register + ingest 一页），
    // 差异点：第二次调用 writeVectors(path, pages, { force: true }) 时
    const embedSpy = vi.fn(async () => new Float32Array(8).fill(0.1));
    // …复用现有测试的 buildWikiEngineForTest(embedSpy) 助手（该测试文件已导出/可复制）…
    await firstWrite();          // 第一次：normal，1 页 embed 1 次
    const callsAfterFirst = embedSpy.mock.calls.length;
    await secondWriteForce();    // 第二次：force，无内容变化
    expect(embedSpy.mock.calls.length).toBeGreaterThan(callsAfterFirst); // force 绕过 sha 复用
  });
});
```

实现说明（执行者读此段）：直接打开 `tests/wiki-vector-write.test.ts`，复制其引擎搭建助手与断言骨架；唯一新增行为是第三次参数 `{ force: true }`。若该文件未导出助手，就在本测试文件内复制搭建代码（~40 行，两文件不得互相 import 私有函数）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/wiki-vector-force.test.ts`
Expected: FAIL（writeVectors 无第三参数 / force 未生效）

- [ ] **Step 3: manager.ts 实现**

3a. `writeVectors`（967 行）签名与复用短路改为：

```ts
  async function writeVectors(projectPath: string, pages: WikiPage[], opts?: { force?: boolean }): Promise<void> {
```

```ts
          // 复用：内容未变 且 该页已有向量 → 跳过 embed（省调用）；force（embedding 变更重建）时绕过
          if (!opts?.force && existing.has(p.id) && existing.get(p.id) === sha) { reused++; continue; }
```

3b. factory 内（`const vecDim = ...` 之后、`mkdirSync` 之前）新增指纹检测与强制重建：

```ts
  // ── embedding 指纹（spec §6.2）：provider|model|dimensions 变更 → 启动时强制重建向量 ──
  const fingerprintFile = join(dataDir, "embedding-fingerprint.json");
  const currentFingerprint = embeddingConfig
    ? `${embeddingConfig.provider ?? ""}|${embeddingConfig.model ?? ""}|${embeddingConfig.dimensions ?? 0}`
    : null;

  export interface VectorRebuildStatus {  // 放在文件顶部 export 区，不放函数体内
    status: "idle" | "running" | "done" | "failed";
    reason?: string; startedAt?: string; finishedAt?: string;
  }
  let vectorStatus: VectorRebuildStatus = { status: "idle" };

  function readStoredFingerprint(): string | undefined {
    try {
      return (JSON.parse(readFileSync(fingerprintFile, "utf-8")) as { fingerprint?: string }).fingerprint;
    } catch { return undefined; }
  }
  function writeStoredFingerprint(fp: string): void {
    writeFileSync(fingerprintFile, JSON.stringify({ fingerprint: fp, updatedAt: new Date().toISOString() }), "utf-8");
  }

  async function forceRevectorizeAll(): Promise<void> {
    if (!embeddingClient?.isReady() || !currentFingerprint) return;
    vectorStatus = { status: "running", reason: "embedding fingerprint changed", startedAt: new Date().toISOString() };
    try {
      for (const state of sources.values()) {
        if (state.status !== "ready") continue;
        const pages = scanWikiDir(state.path);
        initIndexDb(state.path, vecDim); // 维度不匹配 → DROP wiki_vec 重建（index-db.ts 既有行为）
        await writeVectors(state.path, pages, { force: true }); // 绕过 content_sha 复用
      }
      // 指纹在全部完成后才写入：中途崩溃 → 文件仍旧值 → 下次重启重新检测并重跑（防半新半旧混存）
      writeStoredFingerprint(currentFingerprint);
      vectorStatus = { ...vectorStatus, status: "done", finishedAt: new Date().toISOString() };
      log.info("forceRevectorizeAll 完成", { finishedAt: vectorStatus.finishedAt });
    } catch (err) {
      vectorStatus = {
        status: "failed",
        reason: err instanceof Error ? err.message : String(err),
        startedAt: vectorStatus.startedAt,
        finishedAt: new Date().toISOString(),
      };
      log.error("forceRevectorizeAll 失败（状态已置 failed）", { error: vectorStatus.reason });
    }
  }

  // 启动时检测：stored 缺失 = 首次启用指纹 → 采纳当前配置（现网向量即当前配置所建）
  const stored = readStoredFingerprint();
  if (currentFingerprint && stored === undefined) {
    writeStoredFingerprint(currentFingerprint);
  } else if (currentFingerprint && stored !== undefined && stored !== currentFingerprint) {
    log.warn("embedding 配置变更 → 启动时强制重建向量索引（期间向量召回降级 FTS）", { stored, current: currentFingerprint });
    void forceRevectorizeAll();
  }
```

3c. factory 返回对象追加两个成员（与现有 `rebuildIndex` 等同级）：

```ts
    vectorStatus: (): VectorRebuildStatus => vectorStatus,
    forceRevectorizeAll,
```

3d. `WikiSourceManager` 接口（本文件导出的 interface，或 types.ts 中定义处）追加：

```ts
  vectorStatus(): VectorRebuildStatus;
  forceRevectorizeAll(): Promise<void>;
```

（`VectorRebuildStatus` 从 manager.ts 导出；接口若在 types.ts，则 import type。）

- [ ] **Step 4: 跑测试 + 回归**

Run: `pnpm vitest run tests/wiki-vector-force.test.ts tests/wiki-vector-write.test.ts tests/wiki-vector-incremental.test.ts` → 全 PASS；`pnpm typecheck` → 0 error

- [ ] **Step 5: Commit**

```bash
git add td-agemem/MemoryKnowledge/src/engines/wiki/manager.ts td-agemem/MemoryKnowledge/tests/wiki-vector-force.test.ts
git commit -m "feat(ks): embedding 指纹检测 + force 全量向量重建 + 状态透出（spec §6.2）"
```

---

# 阶段 B：MemoryCore

### Task 4: Core settings-override 模块 + gateway config 合并

**Files:**
- Create: `td-agemem/MemoryCore/src/gateway/settings-override.ts`
- Modify: `td-agemem/MemoryCore/src/gateway/config.ts:434-467`（llm 构建后、`shouldSpliceLlm`（487 行）前合并）
- Test: `td-agemem/MemoryCore/src/gateway/settings-override.test.ts`（vitest 默认含 `**/*.test.ts`，与 src 同目录）

**Interfaces:**
- Produces（Task 5 依赖）: `readSettingsOverride(baseDir)`、`writeSettingsOverride(baseDir, o)`、`maskKey(key)`、`validateOverride(body)`、`pickDefined(o)`、类型 `SettingsOverride`（含 llm 五字段 + embedding：provider/baseUrl/apiKey/model/dimensions/sendDimensions）

- [ ] **Step 1: 写失败测试**

```ts
// src/gateway/settings-override.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSettingsOverride, writeSettingsOverride, maskKey, validateOverride, pickDefined } from "./settings-override.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "core-ovr-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("settings-override (core)", () => {
  it("round-trip 读写", () => {
    expect(readSettingsOverride(dir)).toBeNull();
    writeSettingsOverride(dir, { llm: { baseUrl: "https://x", model: "m" }, embedding: { model: "e", dimensions: 8, sendDimensions: true } });
    const o = readSettingsOverride(dir)!;
    expect(o.llm?.model).toBe("m");
    expect(o.embedding?.sendDimensions).toBe(true);
  });
  it("pickDefined 只保留非 undefined", () => {
    expect(pickDefined({ a: undefined, b: 1 })).toEqual({ b: 1 });
  });
  it("maskKey 尾 4 位", () => {
    expect(maskKey("12345678")).toEqual({ hasApiKey: true, apiKeyMasked: "****5678" });
  });
  it("validateOverride 校验 URL/正整数/非空 model", () => {
    expect(validateOverride({ llm: { baseUrl: "nope" } }).ok).toBe(false);
    expect(validateOverride({ embedding: { dimensions: -1 } }).ok).toBe(false);
    expect(validateOverride({ llm: { baseUrl: "https://a.b", model: "m" }, embedding: { model: "e", dimensions: 4 } }).ok).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd D:\TDB\td-agemem\MemoryCore; pnpm vitest run src/gateway/settings-override.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `src/gateway/settings-override.ts`**

与 Task 1 的 `config-override.ts` 同构（此处不省略，逐字落地）：`LlmSettingsOverride` 五字段同 KS；`EmbeddingSettingsOverride` 多一个 `sendDimensions?: boolean`；`readSettingsOverride / writeSettingsOverride(原子 tmp+rename) / pickDefined / maskKey / validateOverride`（校验规则同 KS：URL 正则 `/^https?:\/\/.+/i`、model 非空、maxTokens/timeoutMs/dimensions 正整数、sendDimensions 必须 boolean、损坏文件返回 null）。文件头注释注明：**override 优先级高于 `TDAI_LLM_*` env 与 yaml**（管理员显式意图，spec §3.2）。

- [ ] **Step 4: `gateway/config.ts` 合并（`llm` 构建完成后、`shouldSpliceLlm` 判定（487 行）之前插入）**

```ts
  // ── Admin settings override（{baseDir}/config-override.json）> TDAI_LLM_* env > yaml（spec §3.2）──
  // 必须在 shouldSpliceLlm 之前合并，保证 splice 到 memory.llm 的已是 override 后的值。
  const settingsOverride = readSettingsOverride(baseDir);
  if (settingsOverride?.llm) Object.assign(llm, pickDefined(settingsOverride.llm));
  if (settingsOverride?.embedding) {
    memory.embedding = { ...memory.embedding, ...pickDefined(settingsOverride.embedding) } as typeof memory.embedding;
  }
```

import：`import { readSettingsOverride, pickDefined } from "./settings-override.js";`
（`baseDir` 在 436 行已解析。）

- [ ] **Step 5: 跑测试**

Run: `pnpm vitest run src/gateway/settings-override.test.ts` → PASS；`pnpm exec tsc --noEmit -p tsconfig.json`（若 Core 有 typecheck script 则用之）→ 0 error

- [ ] **Step 6: Commit**

```bash
git add td-agemem/MemoryCore/src/gateway/settings-override.ts td-agemem/MemoryCore/src/gateway/config.ts td-agemem/MemoryCore/src/gateway/settings-override.test.ts
git commit -m "feat(core): admin settings override 存储与 gateway 配置合并（spec §3.2）"
```

### Task 5: Core admin settings 路由（v3 + routeTable 接线）

**Files:**
- Create: `td-agemem/MemoryCore/src/gateway/admin-settings.ts`
- Modify: `td-agemem/MemoryCore/src/gateway/server.ts`（`extraRouteTable` 组装处，grep `makeSkillRouteTable` 定位）
- Test: `td-agemem/MemoryCore/src/gateway/admin-settings.test.ts`

**Interfaces:**
- Consumes: Task 4 全部导出；Task 6 将提供的 `getReindexState()`（本任务先以可注入 deps 声明）
- Produces: `makeAdminSettingsRouteTable(deps): Record<string, RouteHandler>`，路由 `/v3/admin/settings/get|set`；handler 签名对齐 `memory-prompt-handlers.ts:286`：`(body: unknown, auth: V2AuthContext, requestId: string, deps: unknown) => Promise<ApiResponseEnvelope>`

- [ ] **Step 1: 写失败测试**

```ts
// src/gateway/admin-settings.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync as _m } from "node:fs"; // eslint 占位可删
import { makeAdminSettingsRouteTable } from "./admin-settings.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "core-set-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const deps = () => ({
  baseDir: dir,
  getEffective: () => ({
    llm: { baseUrl: "https://a.b", apiKey: "sk-12345678", model: "m1", maxTokens: 10, timeoutMs: 20, provider: "openai" as const, proxy: { useMemorySystemUserKey: true }, stream: false },
    embedding: { provider: "openai_compatible", apiKey: "ek-87654321", model: "e1", baseUrl: "https://e.b", dimensions: 8, sendDimensions: true, enabled: true },
  }),
  getReindexState: () => ({ status: "idle" as const }),
});

describe("admin settings route table (core)", () => {
  it("get 返回掩码 key + reindexState", async () => {
    const table = makeAdminSettingsRouteTable(deps());
    const res = await table["/v3/admin/settings/get"]!({}, {} as any, "req-1", {});
    expect(res.code).toBe(0);
    const d = res.data as any;
    expect(d.llm.apiKeyMasked).toBe("****5678");
    expect(d.llm.apiKey).toBeUndefined();
    expect(d.reindexState).toEqual({ status: "idle" });
  });
  it("set 落盘 + 空 apiKey 保留 + needsRestart", async () => {
    const table = makeAdminSettingsRouteTable(deps());
    const res = await table["/v3/admin/settings/set"]!({ llm: { model: "m2", apiKey: "" }, embedding: { model: "e1", dimensions: 8 } }, {} as any, "req-2", {});
    expect((res.data as any).needsRestart).toBe(true);
    expect((res.data as any).embeddingChanged).toBe(false);
  });
  it("embedding 变更 embeddingChanged=true", async () => {
    const table = makeAdminSettingsRouteTable(deps());
    const res = await table["/v3/admin/settings/set"]!({ embedding: { model: "e9", dimensions: 16 } }, {} as any, "req-3", {});
    expect((res.data as any).embeddingChanged).toBe(true);
  });
  it("非法输入返回 code!=0", async () => {
    const table = makeAdminSettingsRouteTable(deps());
    const res = await table["/v3/admin/settings/set"]!({ llm: { baseUrl: "ftp://x" } }, {} as any, "req-4", {});
    expect(res.code).not.toBe(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/gateway/admin-settings.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `src/gateway/admin-settings.ts`**

先读 `memory-prompt-handlers.ts` 头部 30 行，照抄其 `ApiResponseEnvelope` 的成功/失败构造方式（同款字段名；下述代码里 `ok()/err()` 两个助手按其真实构造落地——若该文件用共享助手则直接 import 同一个）：

```ts
/**
 * /v3/admin/settings/{get,set} — Panel 透传的实例设置管理（spec §3.2）。
 * handler 签名对齐 memory-prompt-handlers.ts（v2-router routeTable 同款）。
 * 内网信任模型；管理员判定在 Panel 层（isCallerSystemAdmin）。
 */
import { readSettingsOverride, writeSettingsOverride, maskKey, validateOverride, type SettingsOverride } from "./settings-override.js";
import type { ReindexState } from "../utils/reindex-state.js"; // Task 6 提供；本任务先写 import，Task 6 落地该文件

export interface EffectiveSettings {
  llm: Record<string, unknown>;
  embedding: Record<string, unknown>;
}
export interface AdminSettingsDeps {
  baseDir: string;
  getEffective: () => EffectiveSettings;
  getReindexState: () => ReindexState;
}

type AdminHandler = (body: unknown, auth: unknown, requestId: string, deps: unknown) => Promise<{ code: number; message: string; data?: unknown }>;

function deepMerge(existing: SettingsOverride | null, incoming: SettingsOverride): SettingsOverride {
  return { llm: { ...(existing?.llm ?? {}), ...incoming.llm }, embedding: { ...(existing?.embedding ?? {}), ...incoming.embedding } };
}

export function makeAdminSettingsRouteTable(deps: AdminSettingsDeps): Record<string, AdminHandler> {
  return {
    "/v3/admin/settings/get": async () => {
      const override = readSettingsOverride(deps.baseDir);
      const eff = deps.getEffective();
      const llm = { ...eff.llm, ...(override?.llm ?? {}) };
      const embedding = { ...eff.embedding, ...(override?.embedding ?? {}) };
      return {
        code: 0, message: "ok",
        data: {
          llm: { ...llm, ...maskKey(llm.apiKey as string | undefined), source: override?.llm ? "override" : "yaml" },
          embedding: { ...embedding, ...maskKey(embedding.apiKey as string | undefined), source: override?.embedding ? "override" : "yaml" },
          reindexState: deps.getReindexState(),
        },
      };
    },
    "/v3/admin/settings/set": async (body) => {
      const b = JSON.parse(JSON.stringify(body ?? {})) as Record<string, any>;
      if (b?.llm?.apiKey === "") delete b.llm.apiKey;   // 空串 = 保留原值
      if (b?.embedding?.apiKey === "") delete b.embedding.apiKey;
      const v = validateOverride(b);
      if (!v.ok) return { code: 400, message: v.errors.join("; ") };
      const merged = deepMerge(readSettingsOverride(deps.baseDir), v.value);
      writeSettingsOverride(deps.baseDir, merged);
      const eff = deps.getEffective();
      const nextEmb = merged.embedding ?? {};
      const embeddingChanged =
        (nextEmb.model !== undefined && nextEmb.model !== eff.embedding.model) ||
        (nextEmb.dimensions !== undefined && nextEmb.dimensions !== eff.embedding.dimensions);
      return { code: 0, message: "ok", data: { needsRestart: true, embeddingChanged } };
    },
  };
}
```

- [ ] **Step 4: server.ts 接线**

grep `makeSkillRouteTable`（`D:\TDB\td-agemem\MemoryCore\src\gateway\server.ts`）定位 `extraRouteTable` 组装处，在同处展开：

```ts
      ...makeAdminSettingsRouteTable({
        baseDir,           // 与该作用域已有的 data/baseDir 变量对齐（config.data.baseDir 解析结果）
        getEffective: () => ({ llm: this.config.llm as unknown as Record<string, unknown>, embedding: this.config.memory.embedding as unknown as Record<string, unknown> }),
        getReindexState: () => getReindexState(),
      }),
```

import：`import { makeAdminSettingsRouteTable } from "./admin-settings.js"; import { getReindexState } from "../utils/reindex-state.js";`（reindex-state 由 Task 6 提供；两任务同分支按序执行。）

- [ ] **Step 5: 跑测试**

Run: `pnpm vitest run src/gateway/admin-settings.test.ts` → PASS；typecheck → 0 error

- [ ] **Step 6: Commit**

```bash
git add td-agemem/MemoryCore/src/gateway/admin-settings.ts td-agemem/MemoryCore/src/gateway/admin-settings.test.ts td-agemem/MemoryCore/src/gateway/server.ts
git commit -m "feat(core): /v3/admin/settings get/set 路由接入 v2-router（spec §3.2）"
```

### Task 6: Core reindexAll 接线 + reindexState（补断点）

**Files:**
- Create: `td-agemem/MemoryCore/src/utils/reindex-state.ts`
- Modify: `td-agemem/MemoryCore/src/utils/pipeline-factory.ts:317-318`（`needsReindex` 赋值后调度）
- Test: `td-agemem/MemoryCore/src/utils/reindex-state.test.ts`

**Interfaces:**
- Consumes: `IMemoryStore.reindexAll(embedFn: (text: string) => Promise<Float32Array>, onProgress?): Promise<{l1Count,l0Count}>`（types.ts:666）、`EmbeddingService.embed(text): Promise<Float32Array>`（store/embedding.ts:73）
- Produces: `getReindexState(): ReindexState`、`scheduleReindex(store, embedding, logger): void`（Task 5 的 server.ts 接线已 import）

- [ ] **Step 1: 写失败测试**

```ts
// src/utils/reindex-state.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { getReindexState, setReindexState, scheduleReindex, __resetReindexStateForTests } from "./reindex-state.js";

beforeEach(() => __resetReindexStateForTests());

describe("reindex-state", () => {
  it("初始 idle", () => expect(getReindexState().status).toBe("idle"));
  it("scheduleReindex 成功 → running → done 并写 counts", async () => {
    const store = { reindexAll: vi.fn(async () => ({ l1Count: 3, l0Count: 7 })) };
    const embedding = { embed: vi.fn(async () => new Float32Array(8)) };
    scheduleReindex(store as any, embedding as any, console);
    expect(getReindexState().status).toBe("running");
    await vi.waitFor(() => expect(getReindexState().status).toBe("done"));
    expect(getReindexState().l1Count).toBe(3);
    expect(getReindexState().l0Count).toBe(7);
  });
  it("失败 → failed + reason 可见", async () => {
    const store = { reindexAll: vi.fn(async () => { throw new Error("boom"); }) };
    scheduleReindex(store as any, { embed: vi.fn() } as any, console);
    await vi.waitFor(() => expect(getReindexState().status).toBe("failed"));
    expect(getReindexState().reason).toContain("boom");
  });
  it("running 期间重复调度被拒", async () => {
    const store = { reindexAll: vi.fn(() => new Promise<{ l1Count: number; l0Count: number }>(() => {})) }; // 永不 resolve
    scheduleReindex(store as any, { embed: vi.fn() } as any, console);
    scheduleReindex(store as any, { embed: vi.fn() } as any, console);
    expect(store.reindexAll).toHaveBeenCalledTimes(1);
    setReindexState({ status: "idle" });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/utils/reindex-state.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `src/utils/reindex-state.ts`**

```ts
/**
 * Reindex 状态机 — embedding 指纹漂移（needsReindex）后的后台全量重建调度（spec §6.2）。
 * 补齐既有断点：VectorStore.init() 返回 needsReindex=true 但 reindexAll() 此前无任何调用方。
 * 状态挂 globalThis：单进程语义即可；失败必须可见（failed + reason），禁止静默。
 */
import type { Logger } from "./pipeline-factory.js";

export interface ReindexState {
  status: "idle" | "running" | "done" | "failed";
  reason?: string;
  startedAt?: string;
  finishedAt?: string;
  l1Count?: number;
  l0Count?: number;
}

const g = globalThis as unknown as { __tdaiReindexState?: ReindexState };
export function getReindexState(): ReindexState {
  return g.__tdaiReindexState ?? { status: "idle" };
}
export function setReindexState(s: ReindexState): void {
  g.__tdaiReindexState = s;
}
export function __resetReindexStateForTests(): void {
  g.__tdaiReindexState = undefined;
}

interface ReindexableStore {
  reindexAll(
    embedFn: (text: string) => Promise<Float32Array>,
    onProgress?: (done: number, total: number, layer: "L1" | "L0") => void,
  ): Promise<{ l1Count: number; l0Count: number }>;
}
interface Embeddable {
  embed(text: string): Promise<Float32Array>;
}

export function scheduleReindex(store: ReindexableStore, embedding: Embeddable, logger: Logger): void {
  const cur = getReindexState();
  if (cur.status === "running") {
    logger.warn?.("[reindex] 已在运行中，忽略重复调度");
    return;
  }
  const startedAt = new Date().toISOString();
  setReindexState({ status: "running", startedAt });
  store
    .reindexAll((text) => embedding.embed(text), (done, total, layer) => {
      logger.debug?.(`[reindex] ${layer} ${done}/${total}`);
    })
    .then(({ l1Count, l0Count }) => {
      setReindexState({ status: "done", l1Count, l0Count, startedAt, finishedAt: new Date().toISOString() });
      logger.info(`[reindex] 全量重建完成 L1=${l1Count} L0=${l0Count}`);
    })
    .catch((err: unknown) => {
      setReindexState({
        status: "failed",
        reason: err instanceof Error ? err.message : String(err),
        startedAt,
        finishedAt: new Date().toISOString(),
      });
      logger.error?.(`[reindex] 全量重建失败: ${getReindexState().reason}`);
    });
}
```

- [ ] **Step 4: `pipeline-factory.ts` 接线（317-318 行之后）**

```ts
      needsReindex = initResult.needsReindex;
      reindexReason = initResult.reason;

      // spec §6.2：指纹漂移 → 后台全量重建（不阻塞启动；状态经 getReindexState 透出）
      if (needsReindex && vectorStore && embeddingService) {
        logger.warn?.(`${TAG} embedding 配置变更 → 后台全量重建向量索引 (${reindexReason ?? "unknown"})`);
        scheduleReindex(vectorStore as Parameters<typeof scheduleReindex>[0], embeddingService, logger);
      }
```

import：`import { scheduleReindex } from "./reindex-state.js";`
（若 `vectorStore` 静态类型不含 `reindexAll`，用 `as ReindexableStore` 断言并以注释说明——接口已声明于 store/types.ts:666，正常应直接满足。）

- [ ] **Step 5: 跑测试 + 回归**

Run: `pnpm vitest run src/utils/reindex-state.test.ts src/gateway/admin-settings.test.ts` → PASS

- [ ] **Step 6: Commit**

```bash
git add td-agemem/MemoryCore/src/utils/reindex-state.ts td-agemem/MemoryCore/src/utils/pipeline-factory.ts td-agemem/MemoryCore/src/utils/reindex-state.test.ts
git commit -m "feat(core): needsReindex → 后台 reindexAll 接线 + 状态机（spec §6.2）"
```

---

# 阶段 C：MemoryPanel

### Task 7: Panel 后端 settings 透传路由（admin 门控）

**Files:**
- Create: `td-agemem/MemoryPanel/src/panel/http/routes/settings.ts`
- Modify: `td-agemem/MemoryPanel/src/panel/http/app.ts:38` 附近（llm-providers 注册处同款方式挂载）
- Test: `td-agemem/MemoryPanel/tests/settings-routes.test.ts`（若 tests/ 不存在则建；vitest 已配置）

**Interfaces:**
- Consumes: `validatePanelMetaHeaders`（middleware/validate-panel-headers.js）、`buildCtx` / `isCallerSystemAdmin` / `respondControlError`（routes/knowledge/common.js + ../envelope.js）、`deps.config.knowledge.baseUrl/authToken`、`panelMeta.gatewayEndpoint/gatewayApiKey`
- Produces: `POST /api/v1/settings/knowledge/:action`、`POST /api/v1/settings/memory/:action`（action ∈ get|set|revectorize；revectorize 仅 knowledge）

- [ ] **Step 1: 写失败测试**

```ts
// tests/settings-routes.test.ts
import { describe, it, expect, vi } from "vitest";
// 构造最小 Hono app + deps stub，参照既有 panel 路由测试的组织方式；
// 核心断言：非 admin → 403；admin → fetch 被调到正确上游 URL 且注入 Authorization。
const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify({ code: 0, message: "ok", data: {} }), { status: 200 }));

describe("settings passthrough", () => {
  it("非 system_admin 返回 403，不触达上游", async () => {
    // deps.metaKernel.invoke('auth/verify') 返回 user_type='member'
    const res = await callSettings("knowledge", "get", { userType: "member" });
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("admin 透传到 KS /v3/admin/settings/get 并注入 Bearer", async () => {
    const res = await callSettings("knowledge", "get", { userType: "system_admin" });
    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls[0][0]).toContain("/v3/admin/settings/get");
    expect(fetchMock.mock.calls[0][1]?.headers?.Authorization).toContain("Bearer");
  });
});
```

实现说明：`callSettings` 助手在本测试文件内构造 Hono app（`new Hono()` + `registerSettingsRoutes(api, depsStub)` + `app.request(...)`，请求头带 `X-Tdai-Service-Id` / `X-Tdai-User-Key`），`depsStub` 用 `vi.fn` 模拟 `metaKernel.invoke`（auth/verify 按 `userType` 返回）与 `config.knowledge = { baseUrl: 'http://ks-test:1', authToken: 'tok' }`。若 `validatePanelMetaHeaders` 依赖 app middleware，测试里以同样顺序 `api.use(...)` 挂载（照抄 app.ts:30 附近的注册序列）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd D:\TDB\td-agemem\MemoryPanel; pnpm vitest run tests/settings-routes.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `src/panel/http/routes/settings.ts`**

```ts
/**
 * /api/v1/settings/{knowledge,memory}/:action — 管理员设置透传（spec §4）。
 * 门控：validatePanelMetaHeaders（app.ts 已挂）→ isCallerSystemAdmin（auth/verify user_type）。
 * knowledge → deps.config.knowledge.baseUrl + authToken；memory → panelMeta.gatewayEndpoint + gatewayApiKey。
 */
import type { Context } from 'hono';
import type { Hono } from 'hono';
import type { PanelDeps } from '../../panel-deps.js';
import { buildCtx, isCallerSystemAdmin } from './knowledge/common.js';
import { respondControlError } from '../envelope.js';

const VALID_ACTIONS = new Set(['get', 'set', 'revectorize']);

async function forwardJson(deps: PanelDeps, c: Context, url: string, headers: Record<string, string>): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), deps.config.metadataRemoteTimeoutMs);
  try {
    const body = c.req.method === 'POST' ? JSON.stringify(await c.req.json().catch(() => ({}))) : undefined;
    const resp = await fetch(url, { method: c.req.method, headers: { 'content-type': 'application/json', ...headers }, body, signal: ctrl.signal });
    const text = await resp.text();
    return new Response(text, { status: resp.status, headers: { 'content-type': 'application/json' } });
  } catch (err) {
    const isTimeout = (err as { name?: string })?.name === 'AbortError';
    return respondControlError(c, isTimeout ? 504 : 502, isTimeout ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_ERROR');
  } finally {
    clearTimeout(timer);
  }
}

export function registerSettingsRoutes(api: Hono, deps: PanelDeps): void {
  const handler = (target: 'knowledge' | 'memory') => async (c: Context) => {
    const action = c.req.param('action');
    if (!VALID_ACTIONS.has(action)) return respondControlError(c, 400, 'INVALID_ACTION');
    if (target === 'memory' && action === 'revectorize') return respondControlError(c, 400, 'NOT_SUPPORTED');
    const ctx = buildCtx(c);
    if (!(await isCallerSystemAdmin(deps, ctx))) return respondControlError(c, 403, 'FORBIDDEN');

    const body = action === 'get' ? {} : await c.req.json().catch(() => ({}));
    if (target === 'knowledge') {
      const base = deps.config.knowledge.baseUrl.replace(/\/+$/, '');
      const headers: Record<string, string> = {};
      if (deps.config.knowledge.authToken) headers.Authorization = `Bearer ${deps.config.knowledge.authToken}`;
      return forwardJson(deps, c, `${base}/v3/admin/settings/${action}`, headers);
    }
    const coreBase = (ctx.gatewayEndpoint ?? '').replace(/\/+$/, '');
    if (!coreBase) return respondControlError(c, 502, 'NO_INSTANCE_ENDPOINT');
    const headers: Record<string, string> = {};
    if (ctx.gatewayApiKey) headers.Authorization = `Bearer ${ctx.gatewayApiKey}`;
    return forwardJson(deps, c, `${coreBase}/v3/admin/settings/${action}`, headers);
  };

  api.post('/settings/knowledge/:action', handler('knowledge'));
  api.post('/settings/memory/:action', handler('memory'));
}
```

- [ ] **Step 4: app.ts 挂载（llm-providers 注册行之后）**

```ts
  // 管理员设置透传（Wiki/Memory 设置，spec §4）
  registerSettingsRoutes(api, deps);
```

import 同步加：`import { registerSettingsRoutes } from './routes/settings.js';`

- [ ] **Step 5: 跑测试**

Run: `pnpm vitest run tests/settings-routes.test.ts` → PASS；`pnpm exec tsc --noEmit` → 0 error

- [ ] **Step 6: Commit**

```bash
git add td-agemem/MemoryPanel/src/panel/http/routes/settings.ts td-agemem/MemoryPanel/src/panel/http/app.ts td-agemem/MemoryPanel/tests/settings-routes.test.ts
git commit -m "feat(panel): /api/v1/settings 透传 + system_admin 门控（spec §4）"
```

### Task 8: Panel Web 设置页（两页签 + admin 可见性 + 保存/重建提示）

**Files:**
- Create: `td-agemem/MemoryPanel/web/src/lib/api/settings.ts`
- Create: `td-agemem/MemoryPanel/web/src/pages/SettingsPage/index.tsx`
- Modify: `td-agemem/MemoryPanel/web/src/routes/index.tsx`（children 追加 settings 路由）
- Modify: 侧边导航注册处（grep 定位：`cd web/src; grep -rn "llm-provider" layouts/`，在 `llm-provider` 导航项旁追加 settings 项，仅 admin 渲染）

**Interfaces:**
- Consumes: Task 7 的 `/api/v1/settings/{knowledge,memory}/:action`、现有 `request()`（lib/api/base.ts）、`getPanelSession()`、`useCurrentRole()`（services/useCurrentRole.ts，`'admin'` 即可见）、sonner toast（项目已依赖）

- [ ] **Step 1: API client `web/src/lib/api/settings.ts`**

```ts
/**
 * api/settings.ts — 管理员设置（Wiki 设置 / Memory 设置，spec §4）。
 * 后端链路：本 client → Panel /api/v1/settings/{target}/:action → KS / Core 的 /v3/admin/settings/*。
 */
import { getPanelSession } from '../panelSession';
import { request, ApiError } from './base';

export type SettingsTarget = 'knowledge' | 'memory';
export type SettingsAction = 'get' | 'set' | 'revectorize';

export interface SettingsLlm {
  baseUrl: string; model: string; maxTokens?: number; timeoutMs?: number;
  hasApiKey: boolean; apiKeyMasked: string; source: 'env' | 'override' | 'yaml';
  [k: string]: unknown;
}
export interface SettingsEmbedding {
  provider?: string; baseUrl?: string; model: string; dimensions?: number; sendDimensions?: boolean;
  hasApiKey: boolean; apiKeyMasked: string; source: 'env' | 'override' | 'yaml';
  [k: string]: unknown;
}
export interface SettingsView {
  llm: SettingsLlm;
  embedding: SettingsEmbedding;
  rebuildStatus?: { status: 'idle' | 'running' | 'done' | 'failed'; reason?: string; startedAt?: string; finishedAt?: string };
  needsRestart?: boolean;
  embeddingChanged?: boolean;
}

interface Envelope<T> { code: number; message: string; data: T }

function authHeaders(): Record<string, string> {
  const session = getPanelSession();
  if (!session) throw new ApiError(401, 'Unauthorized', 'no active panel session');
  return { 'X-Tdai-Service-Id': session.instanceId, 'X-Tdai-User-Key': session.userKey };
}

async function call<T>(target: SettingsTarget, action: SettingsAction, body?: unknown): Promise<T> {
  const env = await request<Envelope<T>>(
    'POST',
    `/api/v1/settings/${target}/${action}`,
    { ...(authHeaders() as Record<string, unknown>), ...(body as Record<string, unknown> | undefined) },
  );
  if (env.code !== 0) throw new ApiError(500, env.message, `code=${env.code}`);
  return env.data;
}

export const settingsApi = {
  get: (target: SettingsTarget) => call<SettingsView>(target, 'get'),
  set: (target: SettingsTarget, body: Record<string, unknown>) => call<SettingsView & { needsRestart: boolean; embeddingChanged: boolean }>(target, 'set', body),
  revectorize: (target: SettingsTarget) => call<{ started: boolean }>(target, 'revectorize'),
};
```

注意：`request()` 的第 4 参是否为 headers 需对照 `base.ts` 真实签名——llm-providers.ts 已示范其用法；若 `request(method, path, body, headers)` 支持 headers，则把 auth 头走第 4 参而不是并入 body（照 llm-providers.ts 的 `authHeaders()` 用法逐字对齐）。body 载荷以服务端实际接收为准（服务端只读 JSON body；auth 走 header）。

- [ ] **Step 2: 页面组件 `web/src/pages/SettingsPage/index.tsx`**

```tsx
/**
 * SettingsPage — 管理员设置（spec §4）。两个页签：Wiki 设置(MemoryKnowledge) / Memory 设置(MemoryCore)。
 * 仅 system_admin 可见（useCurrentRole()==='admin'）；保存后提示重启；embedding 变更追加重建提示。
 */
import { useCallback, useEffect, useState } from 'react';
import { Tabs, Form, Input, Button, Tag, Toast } from 'tea-component';
import { toast } from 'sonner';
import { settingsApi, type SettingsTarget, type SettingsView } from '@/lib/api/settings';
import { useCurrentRole } from '@/services';

type Draft = { llmBaseUrl: string; llmApiKey: string; llmModel: string; llmMaxTokens: string; llmTimeoutMs: string;
               embBaseUrl: string; embApiKey: string; embModel: string; embDimensions: string };

function toDraft(v: SettingsView): Draft {
  return {
    llmBaseUrl: v.llm.baseUrl ?? '', llmApiKey: '', llmModel: v.llm.model ?? '',
    llmMaxTokens: v.llm.maxTokens != null ? String(v.llm.maxTokens) : '',
    llmTimeoutMs: v.llm.timeoutMs != null ? String(v.llm.timeoutMs) : '',
    embBaseUrl: v.embedding.baseUrl ?? '', embApiKey: '', embModel: v.embedding.model ?? '',
    embDimensions: v.embedding.dimensions != null ? String(v.embedding.dimensions) : '',
  };
}

function ServiceSettingsPanel({ target, label }: { target: SettingsTarget; label: string }) {
  const [view, setView] = useState<SettingsView | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const v = await settingsApi.get(target);
    setView(v); setDraft(toDraft(v));
  }, [target]);
  useEffect(() => { void load(); }, [load]);

  if (!view || !draft) return <div>加载中…</div>;
  const rs = view.rebuildStatus;

  const save = async () => {
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        llm: { baseUrl: draft.llmBaseUrl, model: draft.llmModel,
               ...(draft.llmApiKey ? { apiKey: draft.llmApiKey } : {}),
               ...(draft.llmMaxTokens ? { maxTokens: Number(draft.llmMaxTokens) } : {}),
               ...(draft.llmTimeoutMs ? { timeoutMs: Number(draft.llmTimeoutMs) } : {}) },
        embedding: { baseUrl: draft.embBaseUrl, model: draft.embModel,
               ...(draft.embApiKey ? { apiKey: draft.embApiKey } : {}),
               ...(draft.embDimensions ? { dimensions: Number(draft.embDimensions) } : {}) },
      };
      const res = await settingsApi.set(target, body);
      if (res.embeddingChanged) {
        toast.warning('已保存。重启服务后将自动重建向量索引；重建期间向量召回降级为纯 FTS，完成后自动恢复。');
      } else {
        toast.success('已保存，重启服务后生效');
      }
      await load();
    } catch (e) {
      toast.error(`保存失败：${e instanceof Error ? e.message : String(e)}`);
    } finally { setSaving(false); }
  };

  const num = (v: string) => !v || /^\d+$/.test(v);
  const valid = num(draft.llmMaxTokens) && num(draft.llmTimeoutMs) && num(draft.embDimensions)
    && /^https?:\/\/.+/.test(draft.llmBaseUrl) && /^https?:\/\/.+$/.test(draft.embBaseUrl)
    && draft.llmModel.trim() !== '' && draft.embModel.trim() !== '';

  return (
    <Form>
      <Form.Title>LLM（{label}）</Form.Title>
      <Form.Item label="Base URL"><Input value={draft.llmBaseUrl} onChange={v => setDraft({ ...draft, llmBaseUrl: v })} placeholder="https://…" /></Form.Item>
      <Form.Item label="API Key">
        <Input value={draft.llmApiKey} onChange={v => setDraft({ ...draft, llmApiKey: v })}
               placeholder={view.llm.hasApiKey ? `已配置（尾 4 位：${view.llm.apiKeyMasked.slice(-4)}），留空保留原值` : '未配置'} />
      </Form.Item>
      <Form.Item label="Model"><Input value={draft.llmModel} onChange={v => setDraft({ ...draft, llmModel: v })} /></Form.Item>
      <Form.Item label="Max Tokens"><Input value={draft.llmMaxTokens} onChange={v => setDraft({ ...draft, llmMaxTokens: v })} /></Form.Item>
      <Form.Item label="Timeout (ms)"><Input value={draft.llmTimeoutMs} onChange={v => setDraft({ ...draft, llmTimeoutMs: v })} /></Form.Item>

      <Form.Title>Embedding（{label}）</Form.Title>
      <Form.Item label="Base URL"><Input value={draft.embBaseUrl} onChange={v => setDraft({ ...draft, embBaseUrl: v })} /></Form.Item>
      <Form.Item label="API Key">
        <Input value={draft.embApiKey} onChange={v => setDraft({ ...draft, embApiKey: v })}
               placeholder={view.embedding.hasApiKey ? `已配置（尾 4 位：${view.embedding.apiKeyMasked.slice(-4)}），留空保留原值` : '未配置'} />
      </Form.Item>
      <Form.Item label="Model"><Input value={draft.embModel} onChange={v => setDraft({ ...draft, embModel: v })} /></Form.Item>
      <Form.Item label="Dimensions"><Input value={draft.embDimensions} onChange={v => setDraft({ ...draft, embDimensions: v })} /></Form.Item>

      <Form.Action>
        <Button type="primary" disabled={!valid || saving} onClick={save}>{saving ? '保存中…' : '保存'}</Button>
        {rs && rs.status !== 'idle' && (
          <Tag type={rs.status === 'failed' ? 'danger' : rs.status === 'running' ? 'warning' : 'success'}>
            向量重建：{rs.status}{rs.reason ? `（${rs.reason}）` : ''}
          </Tag>
        )}
        {target === 'knowledge' && rs && (rs.status === 'failed' || rs.status === 'done') && (
          <Button onClick={() => settingsApi.revectorize(target).then(() => toast.success('已触发重建')).catch(e => toast.error(String(e)))}>
            重建向量索引
          </Button>
        )}
      </Form.Action>
    </Form>
  );
}

export function SettingsPage() {
  const role = useCurrentRole();
  if (role !== 'admin') return <div style={{ padding: 24 }}>仅管理员可访问设置页</div>;
  return (
    <Tabs tabs={[{ id: 'knowledge', label: 'Wiki 设置' }, { id: 'memory', label: 'Memory 设置' }]}>
      <Tabs.Tab id="knowledge"><ServiceSettingsPanel target="knowledge" label="MemoryKnowledge" /></Tabs.Tab>
      <Tabs.Tab id="memory"><ServiceSettingsPanel target="memory" label="MemoryCore" /></Tabs.Tab>
    </Tabs>
  );
}
```

（tea-component 的 `Tabs/Tabs.Tab`、`Form.*` 用法执行时以项目内现有页面（如 `LlmProviderPanel`）的真实用法为准对齐——若组件 API 名不同（如 `TabPanel`），以现有页面写法替换，**行为契约不变**：两页签、表单校验、保存 toast、重建状态 Tag、admin 门控。）

- [ ] **Step 3: 注册路由与导航**

routes/index.tsx children 追加：
```tsx
{ path: 'settings', element: <SettingsPage /> },
```
import：`import { SettingsPage } from '@/pages/SettingsPage';`

导航项：`cd web/src; grep -rn "llm-provider" layouts/` 找到导航数组，在同级追加：
```tsx
{ path: '/settings', label: '设置', icon: <Settings size={16} /> },  // 以现有导航项结构为准
```
并在渲染处加 `role === 'admin'` 条件（该数组若已按角色过滤则复用其过滤机制）。

- [ ] **Step 4: 构建 + lint**

Run: `cd web; pnpm lint:check; pnpm build` → 0 error（web/dist 产物更新）

- [ ] **Step 5: Commit**

```bash
git add td-agemem/MemoryPanel/web/src/lib/api/settings.ts td-agemem/MemoryPanel/web/src/pages/SettingsPage td-agemem/MemoryPanel/web/src/routes/index.tsx
git commit -m "feat(panel-web): 管理员设置页（Wiki/Memory 设置 + 重建状态）（spec §4）"
```

### Task 9: Proxy 门禁搬到转发缝（成员 Provider 豁免，spec §8）

**Files:**
- Modify: `td-agemem/MemoryProxy/src/pricing.ts`（新增 `enforceModelGate`）
- Modify: `td-agemem/MemoryProxy/src/handler.ts:594-614`（移除入口门禁）、`handler.ts:1357`（转发缝加门禁）
- Modify: `td-agemem/MemoryProxy/src/anthropicHandler.ts:600-620`（同款两处）
- Test: `td-agemem/MemoryProxy/src/__tests__/pricing-gate.test.ts`（或既有 pricing 测试文件所在目录；以 vitest include 命中为准）

**Interfaces:**
- Consumes: `isModelInPricing`（pricing.ts:111）、`resolveMemberOverride` 的返回类型 `MemberUpstream | null`
- Produces: `enforceModelGate(config, memberUpstream, requestedModel): string | null`（null=放行；string=400 消息，文本保持原文 `Model '${requestedModel}' is not a registered display name in the credit pricing table`）

- [ ] **Step 1: 写失败测试**

```ts
// src/__tests__/pricing-gate.test.ts
import { describe, it, expect } from "vitest";
import { enforceModelGate } from "../pricing.js";

const pricing = {
  models: [
    { name: "ep-1", modelName: "ark-code-latest", input: 1, output: 2, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
  ],
} as any;

describe("enforceModelGate (spec §8)", () => {
  it("成员上游命中 → 无条件放行（即使 model 未登记）", () => {
    expect(enforceModelGate(pricing, { url: "https://x", apiKey: "k", model: "anything" }, "unknown-model")).toBeNull();
  });
  it("无成员上游 + 未登记 model → 返回 400 消息（原文）", () => {
    const msg = enforceModelGate(pricing, null, "nope");
    expect(msg).toBe("Model 'nope' is not a registered display name in the credit pricing table");
  });
  it("无成员上游 + 已登记 modelName → 放行", () => {
    expect(enforceModelGate(pricing, null, "ark-code-latest")).toBeNull();
  });
  it("价目表未配置 → 放行（向后兼容）", () => {
    expect(enforceModelGate(null, null, "anything")).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd D:\TDB\td-agemem\MemoryProxy; pnpm vitest run src/__tests__/pricing-gate.test.ts`
Expected: FAIL（函数不存在）

- [ ] **Step 3: `pricing.ts` 实现（追加到文件末尾）**

```ts
/**
 * 模型门禁（spec §8）：只在"自营计费链路"上执行。
 * memberUpstream 命中 → 豁免（成员自有上游不经 TokenHub 计费，CreditDelta 恒 0）；
 * 未命中 → isModelInPricing 原行为（价目表未配置时向后兼容放行）。
 * 返回 null=放行；string=400 错误消息（文本与迁移前逐字一致）。
 */
export function enforceModelGate(
  config: CreditPricingConfig | null | undefined,
  memberUpstream: { url: string; apiKey: string; model: string } | null,
  requested: string | null | undefined,
): string | null {
  if (memberUpstream) return null;
  return isModelInPricing(config, requested)
    ? null
    : `Model '${requested ?? ""}' is not a registered display name in the credit pricing table`;
}
```

- [ ] **Step 4: `handler.ts` 两处改造**

4a. 入口（594-614 行）：删除 `if (!isModelInPricing(...)) return c.json(...400...)` 整个块，**保留** `const requestedModel = typeof body.model === "string" ? body.model : "unknown";`（621 行 `resolveModelId` 与后续日志都依赖它），原注释块替换为：

```ts
  // ── requestedModel 记录（原始值，别名改写前）──
  // 门禁已迁移至成员解析之后的转发缝（spec §8）：memberUpstream 命中即豁免。
  const requestedModel = typeof body.model === "string" ? body.model : "unknown";
```

4b. 转发缝（1357 行 `if (memberUpstream) applyMemberModel(body, memberUpstream);` 之后、1359 行 `agentUpstreamEntry` 之前）插入：

```ts
  // ── Model gate（自入口迁入，spec §8）──
  const gateError = enforceModelGate(config.creditPricing, memberUpstream, requestedModel);
  if (gateError) {
    return c.json(
      { error: { message: gateError, type: "invalid_request_error", code: "model_not_found" } },
      400,
    );
  }
```

import：`enforceModelGate` 加入现有 `./pricing.js` import 列表。

- [ ] **Step 5: `anthropicHandler.ts` 同款两处**

入口 600-614 行同 4a（保留 `requestedModel`）；转发缝 1228 行 `applyMemberModel` 之后同 4b 插入（该文件响应构造与 handler.ts 同款 `{ error: {...} }` + 400）。执行时先读 596-624 与 1219-1240 行确认现场再改。

- [ ] **Step 6: 跑测试 + 回归**

Run: `pnpm vitest run src/__tests__/pricing-gate.test.ts src/member-llm/__tests__ src/routes/__tests__` → 全 PASS；typecheck → 0 error

- [ ] **Step 7: Commit**

```bash
git add td-agemem/MemoryProxy/src/pricing.ts td-agemem/MemoryProxy/src/handler.ts td-agemem/MemoryProxy/src/anthropicHandler.ts td-agemem/MemoryProxy/src/__tests__/pricing-gate.test.ts
git commit -m "feat(proxy): 模型门禁迁转发缝，成员自有上游豁免（spec §8）"
```

### Task 10: creditPricing 运行时管理（admin 路由 + 持久化 + 启动应用，spec §9）

**Files:**
- Create: `td-agemem/MemoryProxy/src/routes/credit-pricing.ts`
- Modify: `td-agemem/MemoryProxy/src/server.ts:145-148`（rate-limits 挂载处同款追加）
- Modify: `td-agemem/MemoryProxy/src/index.ts`（`initProxyStorage` 之后、`serve` 之前应用存储 override）
- Test: `td-agemem/MemoryProxy/src/__tests__/credit-pricing-routes.test.ts`

**Interfaces:**
- Consumes: `getProxyStorage(config.storage)`（`getJSON/setJSON/delJSON`，键风格先读 `member-llm/provider-repo.ts` 的 `keyOf` 约定并对齐）、`config.creditPricing: { models: CreditPricingEntry[] }`
- Produces: `GET/PUT/DELETE /v3/admin/credit-pricing`；`applyStoredCreditPricing(config): Promise<void>`

- [ ] **Step 1: 写失败测试**

```ts
// src/__tests__/credit-pricing-routes.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createCreditPricingHandlers, applyStoredCreditPricing, CREDIT_PRICING_STORAGE_KEY } from "../routes/credit-pricing.js";

const entry = { name: "ep-1", modelName: "m-1", input: 1, output: 2, cacheRead: 0.1, cacheWrite5m: 0.2, cacheWrite1h: 0.3 };
function makeConfig() {
  return { creditPricing: { models: [entry] }, storage: { enabled: true, backend: "memory" } } as any;
}

describe("credit-pricing admin (spec §9)", () => {
  it("GET 返回 yaml 底表 + source:yaml", async () => {
    const handlers = createCreditPricingHandlers(makeConfig());
    const res = await handlers.get({ req: { url: "http://x" }, json: async () => ({}) } as any);
    const body: any = await res.json();
    expect(body.data.source).toBe("yaml");
    expect(body.data.models).toHaveLength(1);
  });
  it("PUT 校验失败 400（modelName 重复 / 负价格 / 非法字段）", async () => {
    const handlers = createCreditPricingHandlers(makeConfig());
    for (const bad of [
      { models: [{ ...entry, modelName: "a" }, { ...entry, name: "ep-2", modelName: "a" }] },
      { models: [{ ...entry, input: -1 }] },
      { models: "nope" },
    ]) {
      const res = await handlers.put({ json: async () => bad } as any);
      expect(res.status).toBe(400);
    }
  });
  it("PUT 合法整表 → 热替换 config.creditPricing + 持久化", async () => {
    const config = makeConfig();
    const handlers = createCreditPricingHandlers(config);
    const next = { models: [{ ...entry, modelName: "m-2", name: "ep-9" }] };
    const res = await handlers.put({ json: async () => next } as any);
    expect(res.status).toBe(200);
    expect(config.creditPricing.models[0].modelName).toBe("m-2"); // 热生效
  });
  it("DELETE 恢复 yaml 底表", async () => {
    const config = makeConfig();
    const handlers = createCreditPricingHandlers(config);
    await handlers.put({ json: async () => ({ models: [{ ...entry, modelName: "m-2", name: "ep-9" }] }) } as any);
    const res = await handlers.delete({ json: async () => ({}) } as any);
    expect(res.status).toBe(200);
    expect(config.creditPricing.models[0].modelName).toBe("m-1");
  });
  it("applyStoredCreditPricing：有存储 override 时启动应用", async () => {
    const config = makeConfig();
    // 用 memory backend 写一次 override 再 apply（经 CREDIT_PRICING_STORAGE_KEY）
    const handlers = createCreditPricingHandlers(config);
    await handlers.put({ json: async () => ({ models: [{ ...entry, modelName: "stored", name: "ep-s" }] }) } as any);
    const config2 = makeConfig(); // 模拟重启后的新 config
    await applyStoredCreditPricing(config2);
    expect(config2.creditPricing.models[0].modelName).toBe("stored");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/__tests__/credit-pricing-routes.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `src/routes/credit-pricing.ts`**

结构逐字对齐 `routes/rate-limits.ts`（ok/error 助手、parseBody、GET/PUT/DELETE 形态）：

```ts
/**
 * /v3/admin/credit-pricing — 价目表运行时管理（spec §9，复刻 rate-limits 模式）。
 * yaml 为底，storage override 整表替换；PUT/DELETE 直接热替换共享 config.creditPricing
 * （handlers 每请求读该对象 → 下一请求生效）。内网信任模型，与 rate-limits 一致。
 */
import type { Context } from "hono";
import type { ProxyConfig, CreditPricingEntry } from "../types.js";
import { getProxyStorage } from "../storage/factory.js";

export const CREDIT_PRICING_STORAGE_KEY = "admin:credit-pricing"; // 键风格以 provider-repo.ts keyOf 为准对齐

const PRICE_FIELDS = ["input", "output", "cacheRead", "cacheWrite5m", "cacheWrite1h"] as const;

function storageOf(config: ProxyConfig) {
  return getProxyStorage(config.storage);
}

export async function applyStoredCreditPricing(config: ProxyConfig): Promise<void> {
  try {
    const stored = await storageOf(config).getJSON<CreditPricingEntry[]>(CREDIT_PRICING_STORAGE_KEY);
    if (stored?.length) config.creditPricing = { models: stored };
  } catch { /* 存储不可用 → 维持 yaml 底表 */ }
}

export function createCreditPricingHandlers(config: ProxyConfig) {
  const yamlModels: CreditPricingEntry[] = config.creditPricing?.models ?? [];
  return {
    get: (c: Context) => handleGet(c, config, yamlModels),
    put: (c: Context) => handlePut(c, config),
    delete: (c: Context) => handleDelete(c, config, yamlModels),
  };
}

async function handleGet(c: Context, config: ProxyConfig, yamlModels: CreditPricingEntry[]): Promise<Response> {
  const stored = await storageOf(config).getJSON<CreditPricingEntry[]>(CREDIT_PRICING_STORAGE_KEY).catch(() => null);
  const models = stored?.length ? stored : yamlModels;
  return ok(c, { source: stored?.length ? "override" : "yaml", models });
}

async function handlePut(c: Context, config: ProxyConfig): Promise<Response> {
  const parsed = await parseBody(c);
  if (parsed instanceof Response) return parsed;
  const v = validateModels(parsed?.models);
  if (typeof v === "string") return error(c, 400, v);
  await storageOf(config).setJSON(CREDIT_PRICING_STORAGE_KEY, v);
  config.creditPricing = { models: v }; // 热生效（下一请求读取新引用）
  return ok(c, { source: "override", models: v });
}

async function handleDelete(c: Context, config: ProxyConfig, yamlModels: CreditPricingEntry[]): Promise<Response> {
  await storageOf(config).delJSON(CREDIT_PRICING_STORAGE_KEY).catch(() => undefined);
  config.creditPricing = { models: yamlModels };
  return ok(c, { source: "yaml", models: yamlModels, deleted: true });
}

/** 校验整表；合法返回 entries，非法返回错误消息。 */
function validateModels(raw: unknown): CreditPricingEntry[] | string {
  if (!Array.isArray(raw) || raw.length === 0) return "models 必须是非空数组";
  const seen = new Set<string>();
  for (const e of raw) {
    const entry = e as Record<string, unknown>;
    if (typeof entry.name !== "string" || !entry.name.trim()) return "每条 name 必须是非空字符串";
    if (typeof entry.modelName !== "string" || !entry.modelName.trim()) return "每条 modelName 必须是非空字符串";
    const key = entry.modelName.toLowerCase();
    if (seen.has(key)) return `modelName 重复: ${entry.modelName}`;
    seen.add(key);
    for (const f of PRICE_FIELDS) {
      const n = entry[f];
      if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return `${entry.modelName}.${f} 必须是 >=0 的数值`;
    }
  }
  return raw as CreditPricingEntry[];
}

async function parseBody(c: Context): Promise<Record<string, unknown> | Response> {
  try { return await c.req.json<Record<string, unknown>>(); }
  catch { return error(c, 400, "invalid JSON body"); }
}

function ok(c: Context, data: Record<string, unknown>): Response {
  return c.json({ code: 0, message: "ok", data });
}
function error(c: Context, status: 400 | 503, message: string): Response {
  return c.json({ code: status, message }, status);
}
```

（若 `ProxyStorage` 无 `delJSON`，用 `setJSON(key, null)` 或既有删除方法替代——以 storage/proxy-storage.ts 真实接口为准。）

- [ ] **Step 4: server.ts 挂载（145-148 行旁）+ index.ts 启动应用**

server.ts：
```ts
  const creditPricingHandlers = createCreditPricingHandlers(config);
  app.get("/v3/admin/credit-pricing", creditPricingHandlers.get);
  app.put("/v3/admin/credit-pricing", creditPricingHandlers.put);
  app.delete("/v3/admin/credit-pricing", creditPricingHandlers.delete);
```

index.ts（`initProxyStorage` await 完成后、`serve` 之前）：
```ts
  await applyStoredCreditPricing(config); // spec §9：重启后恢复管理端价目表 override
```

- [ ] **Step 5: 跑测试**

Run: `pnpm vitest run src/__tests__/credit-pricing-routes.test.ts src/__tests__/pricing-gate.test.ts` → PASS；typecheck → 0 error

- [ ] **Step 6: Commit**

```bash
git add td-agemem/MemoryProxy/src/routes/credit-pricing.ts td-agemem/MemoryProxy/src/server.ts td-agemem/MemoryProxy/src/index.ts td-agemem/MemoryProxy/src/__tests__/credit-pricing-routes.test.ts
git commit -m "feat(proxy): /v3/admin/credit-pricing 运行时管理 + 启动应用 override（spec §9）"
```

### Task 11: Panel「Proxy 计费」透传 + UI 第三页签

**Files:**
- Modify: `td-agemem/MemoryPanel/src/panel/http/routes/settings.ts`（Task 7 产物，追加 proxy-pricing 路由）
- Modify: `td-agemem/MemoryPanel/web/src/lib/api/settings.ts`（追加 pricingApi）
- Modify: `td-agemem/MemoryPanel/web/src/pages/SettingsPage/index.tsx`（第三页签）
- Test: `td-agemem/MemoryPanel/tests/settings-routes.test.ts`（追加用例）

**Interfaces:**
- Consumes: Task 7 的 `isCallerSystemAdmin` 门控与 forwardJson 模式、`deps.config.llmProvider.proxyBaseUrl`（llm-providers 透传已用的同一配置，panel-config.ts:36）、Task 10 的 `/v3/admin/credit-pricing`
- Produces: `POST /api/v1/settings/proxy-pricing/:action`（action ∈ get|set）

- [ ] **Step 1: 追加失败测试（同文件风格）**

```ts
// tests/settings-routes.test.ts 追加
it("非 admin 不可访问 proxy-pricing", async () => {
  const res = await callSettings("proxy-pricing", "get", { userType: "member" });
  expect(res.status).toBe(403);
});
it("admin 透传 GET → proxy /v3/admin/credit-pricing", async () => {
  const res = await callSettings("proxy-pricing", "get", { userType: "system_admin" });
  expect(res.status).toBe(200);
  expect(fetchMock.mock.calls.at(-1)![0]).toContain("/v3/admin/credit-pricing");
});
it("action 限定 get|set，其余 400", async () => {
  const res = await callSettings("proxy-pricing", "delete", { userType: "system_admin" });
  expect(res.status).toBe(400);
});
```

（`callSettings` 助手扩展 target 分支：`proxy-pricing` 的上游 URL 为 `${depsStub.config.llmProvider.proxyBaseUrl}/v3/admin/credit-pricing`，`set` 时 body 透传。）

- [ ] **Step 2: 跑测试确认失败** → `pnpm vitest run tests/settings-routes.test.ts`，新增用例 FAIL

- [ ] **Step 3: `settings.ts` 追加路由（Task 7 文件内）**

```ts
  // ── Proxy 计费价目表（spec §9.3）：get|set 透传 MemoryProxy /v3/admin/credit-pricing ──
  api.post('/settings/proxy-pricing/:action', async (c: Context) => {
    const action = c.req.param('action');
    if (action !== 'get' && action !== 'set') return respondControlError(c, 400, 'INVALID_ACTION');
    const ctx = buildCtx(c);
    if (!(await isCallerSystemAdmin(deps, ctx))) return respondControlError(c, 403, 'FORBIDDEN');
    const base = deps.config.llmProvider.proxyBaseUrl.replace(/\/+$/, '');
    return forwardJson(deps, c, `${base}/v3/admin/credit-pricing`, {});
  });
```

（GET 无 body：forwardJson 已兼容 `c.req.json()` 失败回 `{}`；PUT body 原样透传。）

- [ ] **Step 4: `web/src/lib/api/settings.ts` 追加**

```ts
export interface PricingEntry {
  name: string; modelName: string;
  input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number;
}
export interface PricingView { source: 'yaml' | 'override'; models: PricingEntry[] }

export const pricingApi = {
  get: () => call<PricingView>('knowledge', 'get' as SettingsAction), // 占位勿用；真实实现如下
};
// 真实实现（proxy-pricing 走专用 action，不复用 call()）：
export const proxyPricingApi = {
  get: async (): Promise<PricingView> => {
    const session = getPanelSession();
    if (!session) throw new ApiError(401, 'Unauthorized', 'no active panel session');
    const env = await request<Envelope<PricingView>>('POST', '/api/v1/settings/proxy-pricing/get', { ...authHeaders() });
    if (env.code !== 0) throw new ApiError(500, env.message, `code=${env.code}`);
    return env.data;
  },
  set: async (models: PricingEntry[]): Promise<PricingView> => {
    const session = getPanelSession();
    if (!session) throw new ApiError(401, 'Unauthorized', 'no active panel session');
    const env = await request<Envelope<PricingView>>('POST', '/api/v1/settings/proxy-pricing/set', { ...authHeaders(), models });
    if (env.code !== 0) throw new ApiError(500, env.message, `code=${env.code}`);
    return env.data;
  },
};
```

（落地时删除占位 `pricingApi`，只保留 `proxyPricingApi`；`request()` 的 auth 头传参方式以 llm-providers.ts 的 `authHeaders()` 实际用法对齐——若 `request` 有第 4 参 headers 则走参数而非并 body。）

- [ ] **Step 5: SettingsPage 第三页签**

`SettingsPage/index.tsx`：

```tsx
function ProxyPricingPanel() {
  const [view, setView] = useState<PricingView | null>(null);
  const [rows, setRows] = useState<PricingEntry[]>([]);
  const [saving, setSaving] = useState(false);
  useEffect(() => { void proxyPricingApi.get().then(v => { setView(v); setRows(v.models); }); }, []);
  const setRow = (i: number, patch: Partial<PricingEntry>) =>
    setRows(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const save = async () => {
    setSaving(true);
    try { await proxyPricingApi.set(rows); toast.success('已保存，下一请求生效'); }
    catch (e) { toast.error(`保存失败：${e instanceof Error ? e.message : String(e)}`); }
    finally { setSaving(false); }
  };
  if (!view) return <div>加载中…</div>;
  return (
    <Form>
      <Form.Title>计费价目表（source: {view.source}）</Form.Title>
      {rows.map((r, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr repeat(5, 80px) auto', gap: 8 }}>
          <Input value={r.name} onChange={v => setRow(i, { name: v })} placeholder="model_id" />
          <Input value={r.modelName} onChange={v => setRow(i, { modelName: v })} placeholder="展示名" />
          {(['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h'] as const).map(f => (
            <Input key={f} value={String(r[f])} onChange={v => setRow(i, { [f]: Number(v) } as Partial<PricingEntry>)} />
          ))}
          <Button onClick={() => setRows(rows.filter((_, idx) => idx !== i))}>删除</Button>
        </div>
      ))}
      <Form.Action>
        <Button onClick={() => setRows([...rows, { name: '', modelName: '', input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }])}>新增行</Button>
        <Button type="primary" disabled={saving} onClick={save}>{saving ? '保存中…' : '保存'}</Button>
      </Form.Action>
    </Form>
  );
}
```

Tabs 注册处追加：
```tsx
<Tabs.Tab id="pricing"><ProxyPricingPanel /></Tabs.Tab>
```
tabs 数组追加 `{ id: 'pricing', label: 'Proxy 计费' }`。

- [ ] **Step 6: 构建 + 测试**

Run: `pnpm vitest run tests/settings-routes.test.ts` → PASS；`cd web; pnpm lint:check; pnpm build` → 0 error

- [ ] **Step 7: Commit**

```bash
git add td-agemem/MemoryPanel/src/panel/http/routes/settings.ts td-agemem/MemoryPanel/tests/settings-routes.test.ts td-agemem/MemoryPanel/web/src/lib/api/settings.ts td-agemem/MemoryPanel/web/src/pages/SettingsPage/index.tsx
git commit -m "feat(panel): Proxy 计费价目表管理页签（spec §9.3）"
```

### Task 12: 全链路手动 E2E + 文档收尾

**Files:**
- Modify: `td-agemem/docs/superpowers/specs/2026-09-09-hub-admin-settings-design.md`（状态行改「已实施」）

- [ ] **Step 1: 全量回归**

```powershell
cd D:\TDB\td-agemem\MemoryKnowledge; pnpm test; pnpm typecheck
cd D:\TDB\td-agemem\MemoryCore;      pnpm test
cd D:\TDB\td-agemem\MemoryPanel;     pnpm test; cd web; pnpm build
```
Expected: 全 PASS

- [ ] **Step 2: 手动 E2E（重启服务逐项验证，记入提交说明）**

1. 重启 KS（`svc-knowledge.cmd`）→ `curl POST http://127.0.0.1:8421/v3/admin/settings/get` 返回掩码配置与 `rebuildStatus`。
2. `POST /set` 改 KS LLM model → 响应 `needsRestart:true` → 重启 KS → `/get` 回读 `source:"override"` 且新值生效；跑一次 wiki ingest 日志确认走新 model。
3. KS 改 embedding model → 重启 → knowledge.log 出现「embedding 配置变更 → 启动时强制重建向量索引」→ `/get` 的 rebuildStatus 走 running→done。
4. 重启 Core → 改 Core LLM baseUrl/model → 重启 → `/get`（经 Panel 或直连 8420）回读 override 生效；触发一次记忆提取确认走新端点。
5. Panel web：非 admin 账号看不到「设置」导航 / 直访页显示无权限；admin 账号两页签可读写、保存 toast 正常。
6. 事故演练：`config-override.json` 手工写坏 JSON → 重启 KS → 服务正常启动（override 视为不存在）且 `/get` 的 source 回落 env。
7. **门禁豁免（spec §8）**：给测试用户配 member Provider（url 指向任意可达端点，model 填价目表外名字）→ 以该用户身份发请求（model 任意值）→ 请求转发到成员端点而非 400；清掉成员配置后同请求 → 400（门禁保留）。
8. **价目表热管理（spec §9）**：UI「Proxy 计费」页签新增一条模型 → 立即用该 modelName 发请求 → 放行且计费可匹配；DELETE 接口恢复 yaml 底表 → 新 modelName 请求 400。全程 proxy 无需重启。

- [ ] **Step 3: Spec 状态更新 + Commit**

```bash
git add td-agemem/docs/superpowers/specs/2026-09-09-hub-admin-settings-design.md
git commit -m "docs(spec): hub-admin-settings 实施完成登记"
```

---

## Self-Review 记录

1. **Spec 覆盖**：§1 架构 → Task 2/5/7；§2 字段 → Task 1/4；§3 服务改动 → Task 1-6；§4 Panel → Task 7/8；§5 测试 → 各任务 + Task 12；§6.2 重建 → Task 3/6；§6.3 防静默 → Task 3（状态 failed）+ Task 6（failed+reason）；§8 门禁豁免 → Task 9；§9 价目表管理 → Task 10/11；§7/§8.3/§9.4 non-goals 未引入。无缺口。
2. **占位符扫描**：Task 3 Step 1 与 Task 7 Step 1 的测试代码引用了既有测试的搭建方式并给出落地指引（复制现文件骨架），属"复用仓库内真实存在文件"而非 TBD；Task 8 对 tea-component API 差异、Task 10 对 ProxyStorage 删除接口差异、Task 11 对 request() headers 传参差异均给出"以仓库内真实文件为准对齐 + 行为契约不变"的兜底。其余步骤均含实际代码。
3. **类型一致性**：`SettingsOverride/maskKey/validateOverride` 在 KS(Task1) 与 Core(Task4) 各自定义、各自消费，无跨服务引用；`ReindexState` 由 Task 6 定义、Task 5 import——B 阶段执行顺序 4→6→5（Task 5 import Task 6 的 reindex-state，顺序弹性已在任务内标注）；`enforceModelGate`（Task 9）被 handler.ts/anthropicHandler.ts 消费，消息文本与迁移前逐字一致；`CREDIT_PRICING_STORAGE_KEY/applyStoredCreditPricing`（Task 10）被 index.ts 与测试消费，命名一致。
