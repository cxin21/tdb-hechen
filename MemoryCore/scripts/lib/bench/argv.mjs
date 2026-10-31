/**
 * bench CLI 取参（issue #160 第4项）。
 *
 * 背景：取参与取值参数的规则曾散在 eval-memory-bench.mjs 里各写一份：
 *  - `strArg` 已修成「裸 flag 显式 exit 2」；
 *  - `num` 仍是 `Number(arg(...))`——`--k`（不带值）静默变 NaN/true 一路传到检索与报告里，
 *    跑完一整档才发现指标全是 NaN，白烧外呼。
 *
 * 契约（eval-memory-bench.mjs 的取参都走这里；bench-gates/bench-baseline 等兄弟脚本
 * 仍各自留着一份，迁移不在 #160 范围）：
 *  1. `arg`：--name 的原始值；缺席返回 dflt；裸 flag（后面紧跟 -- 或到底）返回 true；
 *  2. `flag`：argv 里有没有 --name；
 *  3. `strArg` / `num`：需要取值的参数，裸 flag 或数值非法一律**显式失败（exit 2）**，
 *     绝不静默退化成默认值/NaN；
 *  4. `exit`/`logError` 可注入：单测据此断言「调用了 exit(2)」，生产用 process.exit。
 */

/**
 * @param {string[]} argv process.argv.slice(2)
 * @param {{exit?:(code:number)=>void, logError?:(msg:string)=>void}} [opts]
 */
export function createArgReader(argv, { exit, logError } = {}) {
  const args = Array.isArray(argv) ? argv : [];
  const leave = typeof exit === "function" ? exit : (code) => process.exit(code);
  const reportError = typeof logError === "function" ? logError : (msg) => console.error(msg);

  function arg(name, dflt) {
    const i = args.indexOf("--" + name);
    if (i < 0) return dflt;
    const v = args[i + 1];
    return v === undefined || v.startsWith("--") ? true : v;
  }

  function flag(name) {
    return args.includes("--" + name);
  }

  function abort(name, message) {
    reportError(message);
    leave(2);
    // 生产里 process.exit 不会返回；这里兜住「注入了不终止的 exit」的测试与意外调用，
    // 保证调用方绝不能带着未取到的值继续往下跑。
    throw Object.assign(new Error("[bench] --" + name + " 取值失败"), { code: 2 });
  }

  /** 取值参数：裸 flag（后面紧跟 -- 或到底）必须显式失败，不能静默走默认路径。 */
  function strArg(name, dflt) {
    const v = arg(name, dflt);
    if (v === true) {
      abort(name, "[bench] --" + name + " 需要一个值（只给了裸 flag）；已中止，避免静默走默认路径白跑。");
    }
    return v;
  }

  /** 数值参数：裸 flag 或非数值都必须显式失败，不能静默变成 NaN 传下去。 */
  function num(name, dflt) {
    const v = arg(name, undefined);
    if (v === undefined) return dflt;
    if (v === true) {
      abort(name, "[bench] --" + name + " 需要一个数值（只给了裸 flag）；已中止，避免 NaN 静默传下去。");
    }
    const n = Number(v);
    if (!Number.isFinite(n)) {
      abort(name, "[bench] --" + name + " 需要数值，收到 " + JSON.stringify(v) + "；已中止，避免 NaN 静默传下去。");
    }
    return n;
  }

  return { arg, flag, strArg, num };
}
