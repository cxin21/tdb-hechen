/**
 * F2 验证：core 写入口信任边界 — 配置解析 + 校验器 + handler 拒绝路径。
 * 用法: node --import tsx scripts/audit-fix-verify-f2.ts
 */
import { parseConfig } from "../src/config.js";
import { validateCoreWrite } from "../src/core/core-memory/guard.js";

let pass = 0, fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`); }
}

console.log("== F2.1 parseConfig coreMemory 解析 ==");
// parseConfig 接收的是 gateway yaml 的 memory 块内部（与 links/lifecycle 同层）
const yaml = {
  coreMemory: {
    writeEnabled: true,
    allowedSlots: ["identity", "core_value", "strict_rule"],
    maxContentLength: 2000,
  },
};
const cfg = parseConfig(yaml as never);
check("allowedSlots 解析", JSON.stringify(cfg.coreMemory.allowedSlots) === JSON.stringify(["identity", "core_value", "strict_rule"]));
check("maxContentLength=2000", cfg.coreMemory.maxContentLength === 2000);
check("writeEnabled=true", cfg.coreMemory.writeEnabled === true);

const cfgDefault = parseConfig({} as never);
check("缺省 allowedSlots 三槽", JSON.stringify(cfgDefault.coreMemory.allowedSlots) === JSON.stringify(["identity", "core_value", "strict_rule"]));
check("缺省 maxContentLength=2000", cfgDefault.coreMemory.maxContentLength === 2000);
check("缺省 writeEnabled=true", cfgDefault.coreMemory.writeEnabled === true);

const cfgCustom = parseConfig({ coreMemory: { allowedSlots: [], writeEnabled: false, maxContentLength: 100 } } as never);
check("空白名单解析", cfgCustom.coreMemory.allowedSlots.length === 0);
check("writeEnabled=false 解析", cfgCustom.coreMemory.writeEnabled === false);
check("maxContentLength=100 覆盖", cfgCustom.coreMemory.maxContentLength === 100);

console.log("== F2.2 validateCoreWrite 校验器 ==");
const good = validateCoreWrite({ slot: "identity", content: "我是 TDB 后端工程师", source: "" }, cfg.coreMemory);
check("合法写入 ok", good.ok === true && good.slot === "identity" && good.source === "api");

const badSlot = validateCoreWrite({ slot: "hacked", content: "x", source: "" }, cfg.coreMemory);
check("非白名单 slot 拒绝", badSlot.ok === false && (badSlot.reason ?? "").includes("not in allowed slots"));

const emptySlot = validateCoreWrite({ slot: "  ", content: "x", source: "" }, cfg.coreMemory);
check("空 slot 拒绝", emptySlot.ok === false && (emptySlot.reason ?? "").includes("slot required"));

const tooLong = validateCoreWrite({ slot: "identity", content: "x".repeat(2001), source: "" }, cfg.coreMemory);
check("超长 content 拒绝", tooLong.ok === false && (tooLong.reason ?? "").includes("exceeds max length"));

const emptyContent = validateCoreWrite({ slot: "identity", content: "  ", source: "" }, cfg.coreMemory);
check("空白 content 拒绝", emptyContent.ok === false && (emptyContent.reason ?? "").includes("content (string) required"));

const disabled = validateCoreWrite({ slot: "identity", content: "x", source: "" }, cfgCustom.coreMemory);
check("writeEnabled=false 拒绝", disabled.ok === false && (disabled.reason ?? "").includes("disabled by config"));

const noSlots = validateCoreWrite({ slot: "identity", content: "x", source: "" }, { ...cfgCustom.coreMemory, writeEnabled: true });
check("空白名单拒绝", noSlots.ok === false && (noSlots.reason ?? "").includes("allowedSlots is empty"));

const trimmed = validateCoreWrite({ slot: " strict_rule ", content: "  不删生产库  ", source: " agent " }, cfg.coreMemory);
check("slot/content/source 规范化", trimmed.ok === true && trimmed.slot === "strict_rule" && trimmed.content === "不删生产库" && trimmed.source === "agent");

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);