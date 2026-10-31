/**
 * deploy/global-images/start-proxy.sh 生成的一键部署配置必须带 knowledge: 段。
 *
 * issue #119（6.3）：脚本只把 knowledge 列进 injection.injectors，没有 knowledge: 段，
 * 于是 shouldRegisterKnowledgeInjector 恒 false → KnowledgeToolsInjector 静默不注册，
 * <knowledge_tools> 永远不会出现在注入结果里（一键部署内测用户看不到知识库工具）。
 *
 * 这里不 grep 脚本（文本里出现 knowledge: 不算数），而是真跑 start-proxy.sh（stub docker，
 * 不起容器），再用 buildConfig 读回生成的 config.yaml，断言真实配置 + 注册判定。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildConfig } from "../config.js";
import { shouldRegisterKnowledgeInjector } from "../injection/index.js";
import { renderKnowledgeToolsBlock } from "../injection/injectors/knowledge-tools-injector.js";

// 每个用例要 spawn 一次 bash + start-proxy.sh（~1.4s）；全量并发跑时默认 5s 会超时
vi.setConfig({ testTimeout: 30_000 });

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const START_PROXY = path.join(REPO_ROOT, "deploy", "global-images", "start-proxy.sh");

const posix = (p: string) => p.replace(/\\/g, "/");

const hasBash = (() => {
  try {
    execFileSync("bash", ["-c", "exit 0"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** docker stub：不起真容器，只让脚本流走完。 */
const DOCKER_STUB = `#!/usr/bin/env bash
case "$1" in
  network) [[ "\${2:-}" == "inspect" ]] && exit 1; exit 0 ;;
  ps) exit 0 ;;
  inspect) case "$*" in *State.Health*) echo none ;; *) echo running ;; esac; exit 0 ;;
  run|pull|rm|logs|port) exit 0 ;;
esac
exit 0
`;

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

/** 真跑 start-proxy.sh，返回生成的 config.yaml 绝对路径 + 脚本输出。 */
function runStartProxy(env: Record<string, string>): { configFile: string; out: string; code: number } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-proxy-"));
  tmpDirs.push(dir);
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "docker"), DOCKER_STUB, { mode: 0o755 });
  fs.chmodSync(path.join(bin, "docker"), 0o755);
  fs.writeFileSync(
    path.join(dir, ".env"),
    [
      "PROXY_IMAGE=example/memory-proxy:test",
      "PROXY_PORT=18096",
      "PROXY_UPSTREAM_URL=http://upstream.invalid/v1",
      "PROXY_UPSTREAM_API_KEY=sk-upstream-test",
      "PROXY_UPSTREAM_MODEL=test-model",
      "",
    ].join("\n"),
  );
  const configDir = path.join(dir, "proxy-config");
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ENV_FILE: posix(path.join(dir, ".env")),
    PROXY_CONFIG_DIR: posix(configDir),
    PATH: process.platform === "win32" ? `${posix(bin)}:${process.env.PATH ?? ""}` : `${bin}:${process.env.PATH ?? ""}`,
    ...env,
  };
  let out = "";
  let code = 0;
  try {
    out = execFileSync("bash", [posix(START_PROXY)], {
      encoding: "utf8",
      cwd: REPO_ROOT,
      env: childEnv,
      stdio: "pipe",
    });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    code = err.status ?? 1;
    out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }
  return { configFile: path.join(configDir, "config.yaml"), out, code };
}

describe.skipIf(!hasBash)("start-proxy.sh 生成的配置带 knowledge 段（#119 6.3）", () => {
  it("一键部署（PROXY_FULL_STACK=1）后 knowledge 段生效，knowledge 注入器会注册", () => {
    const { configFile, out, code } = runStartProxy({
      PROXY_FULL_STACK: "1",
      MEMORY_CORE_GATEWAY_API_KEY: "sk-gateway-test-key",
    });
    expect(code, out).toBe(0);
    expect(fs.existsSync(configFile), `没有生成 ${configFile}`).toBe(true);

    // 文本层：knowledge: 段真的写进了 YAML（不是只出现在 injectors 列表里）
    const yamlText = fs.readFileSync(configFile, "utf8");
    expect(yamlText).toMatch(/^knowledge:/m);

    // 语义层：用真实读取链路读回，再走注册判定
    const config = buildConfig({ configFile });
    expect(config.knowledge.enabled).toBe(true);
    expect(config.knowledge.endpoint).toBe("http://memory-core:8420");
    expect(config.knowledge.serviceToken).toBe("sk-gateway-test-key");
    expect(config.knowledge.serviceId).toBe("default");
    expect(shouldRegisterKnowledgeInjector(config)).toBe(true);

    // 产物层：注册之后真的能渲出 <knowledge_tools>，且租户头用的是配置里的 serviceId
    // （只断言“会注册”不够——渲染链断了照样静默不注入）
    const block = renderKnowledgeToolsBlock(
      [
        {
          knowledge_id: "k-1",
          type: "wiki",
          service_url: `${config.knowledge.endpoint}/v3`,
          name: "团队 wiki",
          summary: "设计文档",
          team_id: "t-1",
          user_id: null,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
      ],
      config.knowledge.serviceId,
    );
    expect(block).not.toBeNull();
    expect(block!).toContain("<knowledge_tools>");
    expect(block!).toContain(`x-tdai-service-id: ${config.knowledge.serviceId}`);
    expect(block!).toContain("团队 wiki");
  });

  it("未开 tdai（PROXY_ENABLE_TDAI=0）时 knowledge 段存在但不注册（不影响既有部署）", () => {
    const { configFile, out, code } = runStartProxy({
      PROXY_FULL_STACK: "0",
      MEMORY_CORE_GATEWAY_API_KEY: "sk-gateway-test-key",
    });
    expect(code, out).toBe(0);
    expect(fs.readFileSync(configFile, "utf8")).toMatch(/^knowledge:/m);

    const config = buildConfig({ configFile });
    expect(config.knowledge.enabled).toBe(false);
    expect(shouldRegisterKnowledgeInjector(config)).toBe(false);
  });

  it("gateway key 留空时回退 local（与 memory-core 同源约定），serviceToken 仍非空", () => {
    const { configFile, out, code } = runStartProxy({
      PROXY_FULL_STACK: "1",
      MEMORY_CORE_GATEWAY_API_KEY: "",
    });
    expect(code, out).toBe(0);

    const config = buildConfig({ configFile });
    expect(config.knowledge.enabled).toBe(true);
    // start-proxy.sh:25 的 ${VAR:-local} 兜底：本地体验默认凭据，knowledge 段照常生效
    expect(config.knowledge.serviceToken).toBe("local");
    expect(shouldRegisterKnowledgeInjector(config)).toBe(true);
  });
});
