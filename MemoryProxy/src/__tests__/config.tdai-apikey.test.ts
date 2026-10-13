/**
 * I-2 配套：yaml `tdai.apiKey` 支持 `${VAR}` / `${VAR:-default}` 占位符在
 * 加载期由同名环境变量展开（与 systemUsers 共用 expandEnv）。
 *
 * 此前 yaml 头部注释宣称「密钥一律用 ${VAR} 占位，加载时由同名环境变量展开」，
 * 但 expandEnv 只接了 systemUsers —— tdai.apiKey 会把字面占位符当真值带进
 * 运行期（出站 `Bearer ${...}` → 401）。本单测锁定 expandEnv 语义：
 *   1. env 存在且非空 → 展开
 *   2. env 缺失、给了 `${VAR:-default}` → default
 *   3. env 缺失、无 default → ""（运行期由 resolveBearerToken 的 env 优先兜底）
 *   4. 字面 key（无占位符）→ 原样保留
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildConfig } from "../config.js";

const ENV_KEY = "TDAI_TEST_APIKEY_EXPAND";

const tmpDirs: string[] = [];

afterEach(() => {
  delete process.env[ENV_KEY];
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

function writeYaml(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "tdb-cfg-"));
  tmpDirs.push(dir);
  const file = join(dir, "proxy-config.yaml");
  writeFileSync(file, body, "utf-8");
  return file;
}

function yamlWithApiKey(apiKeyLine: string): string {
  return `tdai:
  enabled: true
  endpoint: "http://127.0.0.1:8420"
  apiKey: ${apiKeyLine}
`;
}

describe("tdai.apiKey ${VAR} 占位符加载期展开（I-2）", () => {
  it("env 已设置且非空 → 展开为 env 值", () => {
    process.env[ENV_KEY] = "expanded-key-123";
    const file = writeYaml(yamlWithApiKey(`"\${${ENV_KEY}}"`));
    const cfg = buildConfig({ configFile: file });
    expect(cfg.tdai.apiKey).toBe("expanded-key-123");
  });

  it("env 缺失、给了 ${VAR:-default} → default", () => {
    const file = writeYaml(yamlWithApiKey(`"\${${ENV_KEY}:-fallback-key}"`));
    const cfg = buildConfig({ configFile: file });
    expect(cfg.tdai.apiKey).toBe("fallback-key");
  });

  it("env 缺失、无 default → 空串（expandEnv 文档行为；运行期由 resolveBearerToken env 兜底）", () => {
    const file = writeYaml(yamlWithApiKey(`"\${${ENV_KEY}}"`));
    const cfg = buildConfig({ configFile: file });
    expect(cfg.tdai.apiKey).toBe("");
  });

  it("字面 key（无占位符）→ 原样保留", () => {
    const file = writeYaml(yamlWithApiKey(`"literal-key"`));
    const cfg = buildConfig({ configFile: file });
    expect(cfg.tdai.apiKey).toBe("literal-key");
  });
});
