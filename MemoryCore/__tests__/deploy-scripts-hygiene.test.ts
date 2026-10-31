/**
 * deploy/ 脚本卫生（issue #119：三处部署脚本缺陷的回归闸门）。
 *
 * 6.1 `$VAR` 紧跟全角标点未加 brace：bash 3.2（macOS 自带）+ 多字节 locale 会把
 *     全角字节并进变量名 → `set -u` 报 unbound variable，或取值错位。
 * 6.2 AUTH_HEADER 被 word splitting：`${KEY:+-H "Authorization: Bearer $KEY"}` 整体
 *     未加引号时内层引号不生效，展开成 `-H`、`Authorization:`、`Bearer`、`<key>`
 *     四个 token；curl 会把后两个当 URL → 配了 MEMORY_CORE_GATEWAY_API_KEY 就必失败。
 *
 * 这里不 grep 文本（注释也能让 grep 变绿），而是用 stub docker + stub curl 真跑
 * `start-memory-core.sh`，把 curl 收到的 argv 记下来断言：Bearer 头必须是一个 argv。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEPLOY_DIR = path.join(REPO_ROOT, "deploy");
const START_MEMORY_CORE = path.join(DEPLOY_DIR, "global-images", "start-memory-core.sh");

const posix = (p: string) => p.replace(/\\/g, "/");

const hasBash = (() => {
  try {
    execFileSync("bash", ["-c", "exit 0"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

function listScripts(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listScripts(full));
    else if (entry.name.endsWith(".sh")) out.push(full);
  }
  return out.sort();
}

function writeExecutable(file: string, body: string): void {
  fs.writeFileSync(file, body, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
}

/** docker stub：网络不存在 → inspect 退 1；容器一律 running / 无 healthcheck。 */
const DOCKER_STUB = `#!/usr/bin/env bash
case "$1" in
  network) [[ "\${2:-}" == "inspect" ]] && exit 1; exit 0 ;;
  ps) exit 0 ;;
  inspect) case "$*" in *State.Health*) echo none ;; *) echo running ;; esac; exit 0 ;;
  run|pull|rm|logs|port) exit 0 ;;
esac
exit 0
`;

/** curl stub：把每次调用的 argv 落盘（一次调用一个 ---call--- 段），并回 200 / 写 -o 文件。 */
const CURL_STUB = `#!/usr/bin/env bash
{
  printf '%s\\n' '---call---'
  printf '%s\\n' "$@"
} >> "$CURL_ARGV_LOG"
out=""; fmt=""; prev=""
for a in "$@"; do
  case "$prev" in
    -o) out="$a" ;;
    -w) fmt="$a" ;;
  esac
  prev="$a"
done
if [[ -n "$out" && "$out" != "/dev/null" ]]; then
  printf '{"code":0,"message":"ok","data":{"user_key":"stub-key"}}' > "$out"
fi
if [[ "$fmt" == *http_code* ]]; then printf '200'; fi
exit 0
`;

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

interface RunResult {
  code: number;
  out: string;
  dir: string;
}

/** 真跑 start-memory-core.sh：stub docker 防真起容器，stub curl 记录 argv。 */
function runStartMemoryCore(key: string): RunResult {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-smc-"));
  tmpDirs.push(dir);
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  writeExecutable(path.join(bin, "docker"), DOCKER_STUB);
  writeExecutable(path.join(bin, "curl"), CURL_STUB);
  fs.writeFileSync(
    path.join(dir, ".env"),
    [
      "MEMORY_CORE_IMAGE=example/memory-core:test",
      "MEMORY_CORE_PORT=18420",
      "MEMORY_CORE_VOLUME=tdai-test-core-data",
      "",
    ].join("\n"),
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ENV_FILE: posix(path.join(dir, ".env")),
    CURL: posix(path.join(bin, "curl")),
    CURL_ARGV_LOG: posix(path.join(dir, "curl-argv.log")),
    MEMORY_CORE_CONFIG_DIR: posix(path.join(dir, "core-config")),
    MEMORY_CORE_ADMIN_KEY_FILE: posix(path.join(dir, "admin-key")),
    MEMORY_CORE_GATEWAY_API_KEY: key,
    PATH: process.platform === "win32" ? `${posix(bin)}:${process.env.PATH ?? ""}` : `${bin}:${process.env.PATH ?? ""}`,
  };
  try {
    const out = execFileSync("bash", [posix(START_MEMORY_CORE)], {
      encoding: "utf8",
      cwd: REPO_ROOT,
      env,
      stdio: "pipe",
    });
    return { code: 0, out, dir };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}`, dir };
  }
}

/** 把 curl argv 日志切成「每次调用一个 string[]」。 */
function parseCalls(logFile: string): string[][] {
  const text = fs.readFileSync(logFile, "utf8");
  const calls: string[][] = [];
  for (const block of text.split("---call---\n").slice(1)) {
    calls.push(block.split("\n").filter((l) => l.length > 0));
  }
  return calls;
}

describe.skipIf(!hasBash)("deploy 脚本卫生（#119）", () => {
  it("deploy/ 下所有 .sh 都过 bash -n", () => {
    const scripts = listScripts(DEPLOY_DIR);
    expect(scripts.length).toBeGreaterThan(5);
    const broken: string[] = [];
    for (const script of scripts) {
      try {
        execFileSync("bash", ["-n", posix(script)], { stdio: "pipe" });
      } catch (e) {
        const err = e as { stderr?: Buffer | string };
        broken.push(`${path.relative(REPO_ROOT, script)}: ${String(err.stderr ?? "")}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it("$VAR 后面紧跟非 ASCII 字符时必须加 brace（全角不会并入变量名）", () => {
    const offenders: string[] = [];
    for (const script of listScripts(DEPLOY_DIR)) {
      const lines = fs.readFileSync(script, "utf8").split(/\r?\n/);
      lines.forEach((line, i) => {
        const trimmed = line.trimStart();
        if (trimmed.startsWith("#")) return; // 注释不参与展开
        const re = /\$[A-Za-z_][A-Za-z0-9_]*(?=[^\x00-\x7F])/g;
        for (const m of line.matchAll(re)) {
          offenders.push(`${path.relative(REPO_ROOT, script)}:${i + 1} ${m[0]} → ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it("配了 MEMORY_CORE_GATEWAY_API_KEY 时，Bearer 头是一个完整 argv（不被分词）", () => {
    const { code, out, dir } = runStartMemoryCore("sk-mem-test-key");
    expect(code, out).toBe(0);
    // 两处 curl 都得真的带鉴权跑成功
    expect(out).toContain("admin user_key 校验通过");

    const calls = parseCalls(path.join(dir, "curl-argv.log"));
    const urls = [
      "http://localhost:18420/v3/meta/auth/verify",
      "http://localhost:18420/v3/internal/meta/user/init-admin",
    ];
    for (const url of urls) {
      const call = calls.find((argv) => argv.includes(url));
      expect(call, `没有对 ${url} 的调用`).toBeDefined();
      const argv = call!;
      // -H 后面必须紧跟整条头（含空格），否则就是被 word splitting 拆开了
      expect(argv.filter((a) => a.startsWith("Authorization"))).toEqual([
        "Authorization: Bearer sk-mem-test-key",
      ]);
      expect(argv).not.toContain("Bearer");
      expect(argv.slice(0, -1)).not.toContain("Authorization:");
    }
  });

  it("未配 MEMORY_CORE_GATEWAY_API_KEY 时不留空 argv，脚本照常跑通", () => {
    const { code, out, dir } = runStartMemoryCore("");
    expect(code, out).toBe(0);
    expect(out).toContain("admin user_key 校验通过");

    const calls = parseCalls(path.join(dir, "curl-argv.log"));
    // 按 URL 取调用，不锁 curl 总次数：脚本将来多一次探活不该让这条假红
    const urls = [
      "http://localhost:18420/v3/meta/auth/verify",
      "http://localhost:18420/v3/internal/meta/user/init-admin",
    ];
    for (const url of urls) {
      const argv = calls.find((call) => call.includes(url));
      expect(argv, `没有对 ${url} 的调用`).toBeDefined();
      // 没有 key 时不能留下空串 -H 参数，也不能有半截 Authorization
      expect(argv!.filter((a) => a.startsWith("Authorization"))).toEqual([]);
      expect(argv!.filter((a) => a === "")).toEqual([]);
    }
  });
});
