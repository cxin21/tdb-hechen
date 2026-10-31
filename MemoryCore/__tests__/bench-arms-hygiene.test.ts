/**
 * bench 档位脚本卫生（issue #159）。
 *
 * 历史 arms 脚本各自手抄旗标，积了三类坑（docs/optimization-results.md §15.7 是教训源）：
 *  1. 复跑历史基线时混进后来开的生产默认（factChannel / smallToBig / conclusionLayer / validity），
 *     数字不可比且无人察觉 —— 每档必须用 --expect-config 把"假设的生效配置"写死；
 *  2. 报告没落盘也算"跑完"，失败被吞成假绿 —— 每档必须 --report-name = tag 并断言报告存在；
 *  3. 路径写死 /c/Users/<个人>/AppData/Local/Temp，换机器即失效 —— 一律走 STORE_ROOT。
 *
 * 本测试是这三条口径的闸门：scripts/run-*.sh（除显式豁免）必须同时满足
 * ① bash -n 通过；② 出现 --expect-config；③ 出现 --report-name；④ 不出现个人家目录。
 * 票面点名的 10 个脚本还要真实走共享库（source lib/bench/arms.sh + 调 arms_run），
 * 并直接用假 runner 驱动 arms_run，验证"缺 --expect-config 不跑"与"报告缺失记失败"这两条行为，
 * 而不是只 grep 文本（注释也能让 grep 变绿）。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCRIPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts");
const LIB = path.join(SCRIPTS_DIR, "lib", "bench", "arms.sh");

// #159 票面只点 10 个脚本；这些是同源但票面范围外的新档/工具，留给后续票补口径。
const EXEMPT = new Set([
  "run-r141-ablate.sh",
  "run-r141-factorial.sh",
  "run-r146-arms.sh",
  "run-r146-currency.sh",
  "run-r146-currency2.sh",
  "run-rejudge-noise.sh",
]);

const TICKET_SCOPE = [
  "run-b1.sh",
  "run-b2a.sh",
  "run-b2b.sh",
  "run-mm-baselines.sh",
  "run-r135-off-arms.sh",
  "run-r135-rerankfix-arms.sh",
  "run-r136-arms.sh",
  "run-r137-allon.sh",
  "run-r137-factchannel.sh",
  "run-r2-fusion-arms.sh",
];

const scripts = fs
  .readdirSync(SCRIPTS_DIR)
  .filter((f) => f.startsWith("run-") && f.endsWith(".sh") && !EXEMPT.has(f))
  .sort();

const read = (f: string) => fs.readFileSync(path.join(SCRIPTS_DIR, f), "utf8");

const hasBash = (() => {
  try {
    execFileSync("bash", ["-c", "exit 0"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** 假 runner：记录收到的参数，按 --report-name 落一个空报告（FAKE_NO_REPORT=1 时不落）。 */
const FAKE_RUNNER = `#!/usr/bin/env bash
set -u
echo "$@" >> "$FAKE_ARGS_LOG"
tag=""; prev=""
for a in "$@"; do
  if [ "$prev" = "--report-name" ]; then tag="$a"; fi
  prev="$a"
done
if [ "\${FAKE_NO_REPORT:-0}" != "1" ] && [ -n "$tag" ]; then
  : > "$L/$tag.json"
fi
exit 0
`;

/** 在临时目录里 source 共享库跑一段脚本，返回 stdout+stderr 与退出码。 */
function runWithLib(body: string): { out: string; code: number; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-arms-"));
  const runner = path.join(dir, "fake-runner.sh");
  fs.writeFileSync(runner, FAKE_RUNNER);
  fs.chmodSync(runner, 0o755);
  const script = `
set -u
cd "${dir}"
export FAKE_ARGS_LOG="${dir}/args.log"
export STORE_ROOT="${dir}/stores"
. "${LIB}"
B="${runner}"
L="${dir}/reports"
arms_init
${body}
arms_finish
`;
  try {
    const out = execFileSync("bash", ["-c", script], { encoding: "utf8", stdio: "pipe" });
    return { out, code: 0, dir };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { out: `${err.stdout ?? ""}${err.stderr ?? ""}`, code: err.status ?? 1, dir };
  }
}

describe.skipIf(!hasBash)("bench 档位脚本卫生（#159）", () => {
  it("扫描范围覆盖票面点名的 10 个脚本", () => {
    expect(scripts).toEqual(expect.arrayContaining(TICKET_SCOPE));
  });

  it.each(scripts)("%s 语法通过（bash -n）", (f) => {
    // 语法错误直接抛（stderr 带行号）；不吞成 expect 失败，便于定位。
    execFileSync("bash", ["-n", path.join(SCRIPTS_DIR, f)], { stdio: "pipe" });
  });

  it.each(scripts)("%s 用 --expect-config 写死生效配置", (f) => {
    expect(read(f)).toMatch(/--expect-config/);
  });

  it.each(scripts)("%s 用 --report-name 把报告钉到 tag", (f) => {
    expect(read(f)).toMatch(/--report-name/);
  });

  it.each(scripts)("%s 不写死个人家目录", (f) => {
    const src = read(f);
    expect(src).not.toMatch(/\/c\/Users\//);
    expect(src).not.toMatch(/[A-Za-z]:[\\/]Users[\\/]/);
  });

  it("票面点名的脚本真实走共享库（source + arms_run），不是只写在注释里", () => {
    for (const f of TICKET_SCOPE) {
      const src = read(f);
      expect(src, `${f} 未 source 共享库`).toMatch(/\.\s+"\$SCRIPT_DIR\/lib\/bench\/arms\.sh"/);
      expect(src, `${f} 未调用 arms_run`).toMatch(/^\s*arms_run\s/m);
      expect(src, `${f} 未调用 arms_finish`).toMatch(/^\s*arms_finish\s*$/m);
    }
  });

  it("arms_run 缺 --expect-config 时不跑 runner，并记一次失败", () => {
    const { out, code, dir } = runWithLib('arms_run t-noexpect --candidate-k 15');
    expect(code).not.toBe(0);
    expect(out).toContain("缺 --expect-config");
    expect(out).toContain("共 1 处失败");
    // runner 一次都不该被调用（空 args.log 或不存在）
    const log = path.join(dir, "args.log");
    expect(fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim() : "").toBe("");
  });

  it("arms_run 把 --tag/--report-name 补成 tag，报告存在才算通过", () => {
    const { out, code, dir } = runWithLib('arms_run t-ok --expect-config recall.candidateK=15');
    expect(code).toBe(0);
    expect(out).toContain("OK t-ok");
    const args = fs.readFileSync(path.join(dir, "args.log"), "utf8");
    expect(args).toContain("--expect-config recall.candidateK=15");
    expect(args).toContain("--tag t-ok");
    expect(args).toContain("--report-name t-ok");
  });

  it("arms_run 在报告缺失时记失败（不把退出码 0 当跑完）", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-arms-"));
    const runner = path.join(dir, "fake-runner.sh");
    fs.writeFileSync(runner, FAKE_RUNNER);
    fs.chmodSync(runner, 0o755);
    const script = `
set -u
cd "${dir}"
export FAKE_ARGS_LOG="${dir}/args.log"
export FAKE_NO_REPORT=1
export STORE_ROOT="${dir}/stores"
. "${LIB}"
B="${runner}"
L="${dir}/reports"
arms_init
arms_run t-noreport --expect-config recall.candidateK=15
arms_finish
`;
    let code = 0;
    let out = "";
    try {
      out = execFileSync("bash", ["-c", script], { encoding: "utf8", stdio: "pipe" });
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; status?: number };
      out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
      code = err.status ?? 1;
    }
    expect(code).not.toBe(0);
    expect(out).toContain("报告缺失");
    expect(out).toContain("共 1 处失败");
  });

  it("arms_fresh 源库缺失时记一次失败并跳过后续档（不拿空库全量灌）", () => {
    const { out, code, dir } = runWithLib(
      'arms_fresh "$STORE_ROOT/does-not-exist" "$STORE_ROOT/dst"\narms_run t-skip --expect-config recall.candidateK=15',
    );
    expect(code).not.toBe(0);
    expect(out).toContain("缺少源库");
    expect(out).toContain("skip t-skip");
    expect(out).toContain("共 1 处失败");
    const log = path.join(dir, "args.log");
    expect(fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim() : "").toBe("");
  });
});
