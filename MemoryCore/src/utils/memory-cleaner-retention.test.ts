import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LocalMemoryCleaner } from "./memory-cleaner.js";

/**
 * LocalMemoryCleaner 的「按日分片」保留策略守卫。
 *
 * 背景（2026-11-01，DSH 特化 Wave 1）：该清理器原先只由已退役的 OpenClaw 宿主入口
 * （MemoryCore/index.ts）构造，删宿主后 `capture.l0l1RetentionDays` 会失去唯一消费者
 * ⇒ JSONL 永不回收。现由 gateway 接线，这里守它的核心契约：
 *   - 只删「分片名日期已整体过期」的文件（conversations/records 两个目录）；
 *   - 分片名不合法的文件一律跳过（不做启发式删除）；
 *   - 未来/当天的分片保留。
 */
describe("LocalMemoryCleaner (daily shard retention)", () => {
  let baseDir: string | null = null;

  afterEach(async () => {
    if (baseDir) await fs.rm(baseDir, { recursive: true, force: true });
    baseDir = null;
  });

  async function makeBase(): Promise<string> {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-cleaner-"));
    await fs.mkdir(path.join(baseDir, "conversations"), { recursive: true });
    await fs.mkdir(path.join(baseDir, "records"), { recursive: true });
    return baseDir;
  }

  function todayShardName(): string {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}.jsonl`;
  }

  it("deletes expired shard files in both conversations/ and records/", async () => {
    const dir = await makeBase();
    const oldConv = path.join(dir, "conversations", "2020-01-01.jsonl");
    const oldRec = path.join(dir, "records", "2020-01-02.json");
    await fs.writeFile(oldConv, '{"session":"old"}\n', "utf8");
    await fs.writeFile(oldRec, '{"session":"old"}\n', "utf8");

    const cleaner = new LocalMemoryCleaner({ baseDir: dir, retentionDays: 2, cleanTime: "03:00" });
    await cleaner.runOnce();
    cleaner.destroy();

    await expect(fs.stat(oldConv)).rejects.toBeTruthy();
    await expect(fs.stat(oldRec)).rejects.toBeTruthy();
  });

  it("keeps today's shard and never touches non-shard file names", async () => {
    const dir = await makeBase();
    const today = path.join(dir, "conversations", todayShardName());
    const notes = path.join(dir, "conversations", "notes.jsonl");
    await fs.writeFile(today, '{"session":"today"}\n', "utf8");
    await fs.writeFile(notes, '{"session":"manual"}\n', "utf8");

    const cleaner = new LocalMemoryCleaner({ baseDir: dir, retentionDays: 2, cleanTime: "03:00" });
    await cleaner.runOnce();
    cleaner.destroy();

    expect((await fs.stat(today)).isFile()).toBe(true);
    expect((await fs.stat(notes)).isFile()).toBe(true);
  });

  it("keeps everything when retentionDays is not positive", async () => {
    const dir = await makeBase();
    const oldConv = path.join(dir, "conversations", "2020-01-01.jsonl");
    await fs.writeFile(oldConv, '{"session":"old"}\n', "utf8");

    const cleaner = new LocalMemoryCleaner({ baseDir: dir, retentionDays: 0, cleanTime: "03:00" });
    await cleaner.runOnce();
    cleaner.destroy();

    expect((await fs.stat(oldConv)).isFile()).toBe(true);
  });
});
