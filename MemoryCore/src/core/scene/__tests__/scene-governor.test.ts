// ═══════════════ DS-SCENE-GOV-001 Task GOV-3 · SceneGovernor 五路径集成测试 ═══════════════
// ① enabled=false 全 no-op（文件字节不变）
// ② 不超限 no-op（skipped + runner 零调用）
// ③ 超限 + fake runner 合格产出 → 蒸馏写回（META created 保留 + 写回前 backup）
// ④ fake runner 抛错 → 原块保留 + errors 登记 + loud warn
// ⑤ 产出仍超限 → hardCapFallback 写回且零 U+FFFD
// storage(COS) 模式用 in-memory fake backend 覆盖 ③⑤。
import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SceneGovernor } from "../scene-governor.js";
import type { SceneGovernorRunner, GovernReport } from "../scene-governor.js";
import { StorageAdapter } from "../../storage/adapter.js";
import type { IStorageBackend } from "../../storage/types.js";
import { formatMeta } from "../scene-format.js";
import type { SceneBlockMeta } from "../scene-format.js";
import type { SceneGovernanceConfig } from "../../../config.js";
import type { Logger } from "../../types.js";

// ── fixtures ──

const META: SceneBlockMeta = {
  created: "2026-09-01T00:00:00Z",
  updated: "2026-09-02T00:00:00Z",
  summary: "原始摘要",
  heat: 7,
};

const block = (body: string) => `${formatMeta(META)}\n\n${body}`;

/** formatMeta 头自身的码点数（validateDistilled 按「含 META 总长」口径验收）。 */
const META_CHARS = Array.from(formatMeta(META)).length;

/** 治理配置：maxBlockChars=140（META 头 ≈125 码点，正文预算留 15）；hardCapChars=160。 */
function govCfg(over: Partial<SceneGovernanceConfig> = {}): SceneGovernanceConfig {
  return { enabled: true, maxBlockChars: 140, distillTimeoutMs: 1000, hardCapChars: 160, ...over };
}

function makeLogger(): Logger & { warns: string[] } {
  const warns: string[] = [];
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn((m: string) => warns.push(m)),
    error: vi.fn(),
    warns,
  };
}

function fakeRunner(reply: (p: { systemPrompt: string; prompt: string; timeoutMs?: number }) => string) {
  return { run: vi.fn(async (p: { systemPrompt: string; prompt: string; timeoutMs?: number }) => reply(p)) };
}

async function makeLocalFixture(files: Record<string, string>): Promise<{ dataDir: string; cleanup: () => Promise<void> }> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "scene-governor-test-"));
  const blocksDir = path.join(dataDir, "scene_blocks");
  await mkdir(blocksDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(blocksDir, name), content, "utf-8");
  }
  return { dataDir, cleanup: () => rm(dataDir, { recursive: true, force: true }) };
}

/** in-memory IStorageBackend（仅覆盖 SceneGovernor 用到的读写/列举/复制路径）。 */
class MemBackend implements IStorageBackend {
  readonly type = "local" as const;
  readonly store = new Map<string, Buffer>();

  async putObject(key: string, content: string | Buffer): Promise<void> {
    this.store.set(key, Buffer.isBuffer(content) ? content : Buffer.from(content, "utf-8"));
  }
  async appendObject(key: string, content: string | Buffer): Promise<void> {
    const prev = this.store.get(key) ?? Buffer.alloc(0);
    this.store.set(key, Buffer.concat([prev, Buffer.isBuffer(content) ? content : Buffer.from(content, "utf-8")]));
  }
  async getObject(key: string) {
    const content = this.store.get(key);
    return content ? { key, content, size: content.length, lastModified: new Date() } : null;
  }
  async exists(key: string): Promise<boolean> {
    return this.store.has(key);
  }
  async listObjects(prefix: string) {
    const entries = [...this.store.keys()]
      .filter((k) => k.startsWith(prefix))
      .map((k) => ({ key: k, size: this.store.get(k)!.length, lastModified: new Date(), isDirectory: false }));
    return { entries, total: entries.length };
  }
  async deleteObject(key: string): Promise<void> {
    this.store.delete(key);
  }
  async deleteByPrefix(prefix: string): Promise<number> {
    let n = 0;
    for (const k of [...this.store.keys()]) {
      if (k.startsWith(prefix)) {
        this.store.delete(k);
        n++;
      }
    }
    return n;
  }
}

const OVERSIZED_BODY = "a".repeat(150); // > maxBlockChars(140) → 触发治理
const okDistilled = () => block("蒸馏正文十条"); // 含 META 总长 125+2+6 ≈ 133 ≤ 140 → validate 过

// ═══════════════ 路径测试 ═══════════════

describe("DS-SCENE-GOV-001 GOV-3 SceneGovernor.govern 五路径", () => {
  it("① enabled=false：全 no-op，文件字节不变，runner 零调用", async () => {
    const original = block(OVERSIZED_BODY);
    const { dataDir, cleanup } = await makeLocalFixture({ "big.md": original });
    const runner = fakeRunner(() => okDistilled());
    const logger = makeLogger();

    try {
      const report = await new SceneGovernor({ runner, logger }).govern({
        dataDir,
        config: govCfg({ enabled: false }),
      });
      expect(report).toEqual({ scanned: 0, distilled: [], hardCapped: [], skipped: [], errors: [] });
      expect(runner.run).not.toHaveBeenCalled();
      const after = await readFile(path.join(dataDir, "scene_blocks", "big.md"), "utf-8");
      expect(after).toBe(original); // 字节不变
    } finally {
      await cleanup();
    }
  });

  it("② enabled=true 但块不超限：skipped 登记，文件不变，runner 零调用", async () => {
    const original = block("短正文");
    const { dataDir, cleanup } = await makeLocalFixture({ "small.md": original });
    const runner = fakeRunner(() => okDistilled());
    const logger = makeLogger();

    try {
      const report = await new SceneGovernor({ runner, logger }).govern({ dataDir, config: govCfg() });
      expect(report.scanned).toBe(1);
      expect(report.skipped).toEqual(["small.md"]);
      expect(report.distilled).toEqual([]);
      expect(runner.run).not.toHaveBeenCalled();
      const after = await readFile(path.join(dataDir, "scene_blocks", "small.md"), "utf-8");
      expect(after).toBe(original);
    } finally {
      await cleanup();
    }
  });

  it("③ 超限 + fake runner 合格产出：蒸馏写回、META created 保留、写回前有 backup、timeoutMs 透传", async () => {
    const original = block(OVERSIZED_BODY);
    const { dataDir, cleanup } = await makeLocalFixture({ "big.md": original });
    const runner = fakeRunner(() => okDistilled());
    const logger = makeLogger();

    try {
      const report = await new SceneGovernor({ runner, logger }).govern({ dataDir, config: govCfg() });
      expect(report.distilled).toEqual(["big.md"]);
      expect(report.hardCapped).toEqual([]);
      expect(report.errors).toEqual([]);

      // 蒸馏调用形态：buildDistillPrompts 产出 + 超时透传
      expect(runner.run).toHaveBeenCalledTimes(1);
      const call = runner.run.mock.calls[0]![0]!;
      expect(call.systemPrompt).toContain("未闭合");
      expect(call.prompt).toContain(original);
      expect(call.timeoutMs).toBe(1000);

      // 写回内容 = runner 产出（META created 保留由 prompt 合规产出）
      const after = await readFile(path.join(dataDir, "scene_blocks", "big.md"), "utf-8");
      expect(after).toBe(okDistilled());
      expect(after).toContain("created: 2026-09-01T00:00:00Z");

      // 写回前 backup：.backup/scene_governance/ 下有一份与原块一致的快照
      const backupDir = path.join(dataDir, ".backup", "scene_governance");
      const backups = await readdir(backupDir);
      expect(backups.length).toBe(1);
      expect(await readFile(path.join(backupDir, backups[0]!), "utf-8")).toBe(original);
    } finally {
      await cleanup();
    }
  });

  it("④ fake runner 抛错：原块保留 + errors 登记 + loud warn（不静默）", async () => {
    const original = block(OVERSIZED_BODY);
    const { dataDir, cleanup } = await makeLocalFixture({ "big.md": original });
    const runner: SceneGovernorRunner = {
      run: vi.fn(async () => {
        throw new Error("boom: llm timeout");
      }),
    };
    const logger = makeLogger();

    try {
      const report = await new SceneGovernor({ runner, logger }).govern({ dataDir, config: govCfg() });
      expect(report.distilled).toEqual([]);
      expect(report.hardCapped).toEqual([]);
      expect(report.errors.length).toBe(1);
      expect(report.errors[0]).toContain("big.md");
      expect(report.errors[0]).toContain("boom");

      // 原块逐字节保留
      const after = await readFile(path.join(dataDir, "scene_blocks", "big.md"), "utf-8");
      expect(after).toBe(original);

      // loud：warn 在场且提及文件名
      expect(logger.warns.some((w) => w.includes("big.md") && w.includes("boom"))).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("⑤ 产出仍超限：hardCapFallback 写回（总长 ≤ hardCapChars、含 META、零 U+FFFD）", async () => {
    const original = block(OVERSIZED_BODY);
    const { dataDir, cleanup } = await makeLocalFixture({ "big.md": original });
    // runner 产出仍超限：META + 150 码点正文（含代理对边界 emoji，验证码点安全）
    const stillOver = block(`${"b".repeat(148)}👍`);
    const runner = fakeRunner(() => stillOver);
    const logger = makeLogger();

    try {
      const report = await new SceneGovernor({ runner, logger }).govern({ dataDir, config: govCfg() });
      expect(report.distilled).toEqual([]);
      expect(report.hardCapped).toEqual(["big.md"]);

      const after = await readFile(path.join(dataDir, "scene_blocks", "big.md"), "utf-8");
      expect(Array.from(after).length).toBeLessThanOrEqual(160);
      expect(after).toContain("-----META-START-----");
      expect(after).toContain("-----META-END-----");
      expect(after.includes("\uFFFD")).toBe(false); // 零坏字符
    } finally {
      await cleanup();
    }
  });
  it("⑥ N1：META 头 ≥ hardCapChars（bodyBudget≤0）→ 兜底降级：不写回、原块字节不变、errors 登记 + loud warn", async () => {
    const original = block(OVERSIZED_BODY); // META 头 ≈127 码点
    const { dataDir, cleanup } = await makeLocalFixture({ "big.md": original });
    // fake runner 返回空串 → fallbackInput = raw → hardCapFallback 会产出 META-only 文件
    const runner = fakeRunner(() => "");
    const logger = makeLogger();

    try {
      const report = await new SceneGovernor({ runner, logger }).govern({
        dataDir,
        // hardCapChars=100 < META 头 127(+2) → bodyBudget ≤ 0（现实触发体：21,660 字 summary 块）
        config: govCfg({ hardCapChars: 100 }),
      });
      // 不写回：hardCapped 不登记，原块逐字节保留（防 Phase 5 cleanup 变相清块）
      expect(report.hardCapped).toEqual([]);
      expect(report.distilled).toEqual([]);
      const after = await readFile(path.join(dataDir, "scene_blocks", "big.md"), "utf-8");
      expect(after).toBe(original);

      // errors 登记 + loud warn（不静默）
      expect(report.errors.some((e) => e.startsWith("big.md") && e.includes("META exceeds hardCap"))).toBe(true);
      expect(logger.warns.some((w) => w.includes("big.md") && w.includes("META exceeds hardCap"))).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("⑦ N2：产出合格长度但含 U+FFFD → validate 不过，走 hardCapFallback 而非 distilled 写回", async () => {
    const original = block(OVERSIZED_BODY);
    const { dataDir, cleanup } = await makeLocalFixture({ "big.md": original });
    // 含 META 总长 ≈133 ≤ maxBlockChars(140)，但正文夹 U+FFFD 坏字符
    const runner = fakeRunner(() => block("蒸馏\uFFFD正文"));
    const logger = makeLogger();

    try {
      const report = await new SceneGovernor({ runner, logger }).govern({ dataDir, config: govCfg() });
      expect(report.distilled).toEqual([]);
      expect(report.hardCapped).toEqual(["big.md"]);

      // hardCapFallback 码点安全：写回产物零 U+FFFD 且 ≤ hardCapChars
      const after = await readFile(path.join(dataDir, "scene_blocks", "big.md"), "utf-8");
      expect(after.includes("\uFFFD")).toBe(false);
      expect(Array.from(after).length).toBeLessThanOrEqual(160);
      expect(after).toContain("-----META-START-----");
    } finally {
      await cleanup();
    }
  });

  it("⑧ N3：同秒连续 backup 两个不同块 → 两份快照都在（备份名带源文件名，不互相覆盖）", async () => {
    const a = block("甲".repeat(150));
    const b = block("乙".repeat(150));
    const { dataDir, cleanup } = await makeLocalFixture({ "a.md": a, "b.md": b });
    const runner = fakeRunner(() => okDistilled());

    try {
      const report = await new SceneGovernor({ runner, logger: makeLogger() }).govern({ dataDir, config: govCfg() });
      expect([...report.distilled].sort()).toEqual(["a.md", "b.md"]);

      const backupDir = path.join(dataDir, ".backup", "scene_governance");
      const backups = await readdir(backupDir);
      expect(backups.length).toBe(2); // 同秒不覆盖
      // 且各自对应自己的源块快照
      const contents = new Set(
        await Promise.all(backups.map((n) => readFile(path.join(backupDir, n), "utf-8"))),
      );
      expect(contents.has(a)).toBe(true);
      expect(contents.has(b)).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("⑨ F-1：兜底 body 为空/全空白（头长 < hardCap−2）→ 降级：不写回、原块字节不变、errors 登记（body empty）+ loud warn", async () => {
    const original = block(OVERSIZED_BODY);
    const { dataDir, cleanup } = await makeLocalFixture({ "big.md": original });
    // fake runner 返回「合法 META 头 + 全空白正文」：头长 ≈127(+2) < hardCap(160) →
    // 旧代码会放过 N1 判定 → hardCapFallback 写回 META-only 文件 → 下轮 Phase 5
    // cleanup 判「无正文」静默删除（= 变相清块通道）。期望：降级不写回。
    const runner = fakeRunner(() => `${formatMeta(META)}\n\n   \n\t `);
    const logger = makeLogger();

    try {
      const report = await new SceneGovernor({ runner, logger }).govern({ dataDir, config: govCfg() });
      expect(report.hardCapped).toEqual([]);
      expect(report.distilled).toEqual([]);

      // 原块逐字节保留
      const after = await readFile(path.join(dataDir, "scene_blocks", "big.md"), "utf-8");
      expect(after).toBe(original);

      // errors 登记 + loud warn（原因注明 body empty）
      expect(report.errors.some((e) => e.startsWith("big.md") && e.includes("body empty"))).toBe(true);
      expect(logger.warns.some((w) => w.includes("big.md") && w.includes("body empty"))).toBe(true);
    } finally {
      await cleanup();
    }
  });
});

describe("DS-SCENE-GOV-001 GOV-3 SceneGovernor.govern storage(COS) 模式", () => {
  function makeStorageFixture(files: Record<string, string>) {
    const backend = new MemBackend();
    for (const [name, content] of Object.entries(files)) {
      backend.store.set(`scene_blocks/${name}`, Buffer.from(content, "utf-8"));
    }
    return { backend, storage: new StorageAdapter(backend) };
  }

  it("③storage 超限 + 合格产出：蒸馏写回 storage + backup 快照在场", async () => {
    const original = block(OVERSIZED_BODY);
    const { backend, storage } = makeStorageFixture({ "big.md": original });
    const runner = fakeRunner(() => okDistilled());
    const logger = makeLogger();

    const report = await new SceneGovernor({ runner, logger }).govern({ dataDir: "/unused", storage, config: govCfg() });
    expect(report.distilled).toEqual(["big.md"]);

    const after = await backend.store.get("scene_blocks/big.md");
    expect(after?.toString("utf-8")).toBe(okDistilled());

    // 写回前 backup 快照：.backup/scene_governance/ 下有原块内容
    const backupEntries = [...backend.store.keys()].filter((k) => k.startsWith(".backup/scene_governance/"));
    expect(backupEntries.length).toBe(1);
    expect(backend.store.get(backupEntries[0]!)?.toString("utf-8")).toBe(original);
  });

  it("⑤storage 产出仍超限：hardCapFallback 写回 storage、零 U+FFFD", async () => {
    const original = block(OVERSIZED_BODY);
    const { backend, storage } = makeStorageFixture({ "big.md": original });
    const stillOver = block(`${"b".repeat(148)}👍`);
    const runner = fakeRunner(() => stillOver);
    const logger = makeLogger();

    const report: GovernReport = await new SceneGovernor({ runner, logger }).govern({
      dataDir: "/unused",
      storage,
      config: govCfg(),
    });
    expect(report.hardCapped).toEqual(["big.md"]);

    const after = backend.store.get("scene_blocks/big.md")!.toString("utf-8");
    expect(Array.from(after).length).toBeLessThanOrEqual(160);
    expect(after.includes("\uFFFD")).toBe(false);
  });
});

// META_CHARS 参与口径自查：META 头 + 2 换行 + 6 码点正文必须 ≤ maxBlockChars，否则 fixture 自相矛盾
it("fixture 口径自查：okDistilled 含 META 总长 ≤ maxBlockChars", () => {
  expect(META_CHARS + 2 + Array.from("蒸馏正文十条").length).toBeLessThanOrEqual(140);
  expect(Array.from(OVERSIZED_BODY).length).toBeGreaterThan(140);
});
