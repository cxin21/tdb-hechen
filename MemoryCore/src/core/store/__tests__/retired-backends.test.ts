/**
 * 守卫：已退场可选后端在**构造期**必须 fail-loud（docs/adr/0021）。
 *
 * 背景：DSH-only 构建只保留 sqlite（存储）/ local（状态）/ sqlite（元数据）/
 * noop|console（可观测性）。tcvdb / mongodb / redis / otlp 等后端已整组删除，
 * 配置里仍写这些值时**不许静默回落到 sqlite** —— 静默降级会让老部署「看起来
 * 还健康、实际读的是空库」，比启动即报错危险得多。
 *
 * 本文件逐条断言 4 个 factory 的抛错行为与报错内容（含迁移提示），并保留一条
 * 「sqlite 正常构造」的正向对照，确保守卫不是把正常路径也一起拦掉。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseConfig } from "../../../config.js";
import {
  assertStoreBackendSupported,
  createStoreBundle,
  RetiredStoreBackendError,
} from "../factory.js";
import {
  assertStateBackendSupported,
  createStateBackend,
  RetiredStateBackendError,
} from "../../state/index.js";
import {
  assertObservabilityBackendSupported,
  createObservabilityBackend,
  RetiredObservabilityBackendError,
} from "../../report/factory.js";
import {
  loadStoreConfig,
  MetadataStorePool,
  RetiredMetadataBackendError,
} from "../../../metadata/store/factory.js";

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "tdai-retired-backends-"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("1) 正向对照：sqlite 仍可正常构造", () => {
  it("parseConfig 缺省 → createStoreBundle 产出 sqlite 快照，且 store 可关闭", async () => {
    const cfg = parseConfig({});
    expect(cfg.storeBackend).toBe("sqlite");

    const bundle = createStoreBundle(cfg, { dataDir });
    expect(bundle.storeSnapshot.type).toBe("sqlite");
    expect(bundle.storeSnapshot.sqlitePath).toBe("vectors.db");
    await bundle.store.close();
  });
});

describe("2) storeBackend 非 sqlite → 抛 RetiredStoreBackendError（含 retired + sqlite 迁移提示）", () => {
  it("配置层：parseConfig({storeBackend:'tcvdb'}) 抛错", () => {
    expect(() => parseConfig({ storeBackend: "tcvdb" })).toThrow(/storeBackend "tcvdb" has been retired/);
    expect(() => parseConfig({ storeBackend: "tcvdb" })).toThrow(/Set storeBackend: "sqlite"/);
  });

  it("工厂层：assertStoreBackendSupported('tcvdb') 抛 RetiredStoreBackendError", () => {
    let caught: unknown;
    try {
      assertStoreBackendSupported("tcvdb");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RetiredStoreBackendError);
    expect((caught as Error).message).toContain("has been retired in the DSH-only build");
    expect((caught as Error).message).toContain('storeBackend: "sqlite"');
    expect((caught as RetiredStoreBackendError).backend).toBe("tcvdb");
  });

  it("工厂层：store 配置被伪造为 tcvdb 时 createStoreBundle 抛错（不静默回落 sqlite）", () => {
    const cfg = parseConfig({});
    const forged = { ...cfg, storeBackend: "tcvdb" } as unknown as typeof cfg;
    expect(() => createStoreBundle(forged, { dataDir })).toThrow(RetiredStoreBackendError);
  });
});

describe("3) state_backend 非 local → 抛 RetiredStateBackendError", () => {
  it("assertStateBackendSupported('redis') 抛错", () => {
    expect(() => assertStateBackendSupported("redis")).toThrow(RetiredStateBackendError);
    expect(() => assertStateBackendSupported("redis")).toThrow(/state_backend: "local"/);
  });

  it("createStateBackend({type:'redis'}) reject（异步构造期同样 fail-loud）", async () => {
    await expect(createStateBackend({ type: "redis" } as never)).rejects.toBeInstanceOf(
      RetiredStateBackendError,
    );
  });
});

describe("4) metadata 后端非 sqlite → 抛 RetiredMetadataBackendError", () => {
  it("环境变量仍设 TDAI_METADATA_MONGO_URI → loadStoreConfig 抛错", () => {
    expect(() => loadStoreConfig({ TDAI_METADATA_MONGO_URI: "mongodb://127.0.0.1:27017/x" })).toThrow(
      RetiredMetadataBackendError,
    );
    expect(() => loadStoreConfig({ TDAI_METADATA_MONGO_URI: "mongodb://127.0.0.1:27017/x" })).toThrow(
      /no silent fallback to sqlite/,
    );
  });

  it("MetadataStorePool 收到 backend:'mongodb' 时构造期抛错", () => {
    expect(
      () => new MetadataStorePool({ backend: "mongodb" as never, sqliteBaseDir: dataDir }),
    ).toThrow(RetiredMetadataBackendError);
  });
});

describe("5) observability.type 非 noop/console → 抛 RetiredObservabilityBackendError", () => {
  it("assertObservabilityBackendSupported('otlp') 抛错并给出 noop 迁移提示", () => {
    expect(() => assertObservabilityBackendSupported("otlp")).toThrow(RetiredObservabilityBackendError);
    expect(() => assertObservabilityBackendSupported("otlp")).toThrow(/observability\.type to "noop"/);
  });

  it("createObservabilityBackend({type:'otlp'}) reject", async () => {
    await expect(createObservabilityBackend({ type: "otlp" } as never)).rejects.toBeInstanceOf(
      RetiredObservabilityBackendError,
    );
  });
});
