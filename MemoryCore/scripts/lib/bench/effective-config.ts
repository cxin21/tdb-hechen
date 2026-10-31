/**
 * 生效配置快照（审计 M6 / 根节点 A）。
 *
 * 病根：bench 报告只记 CLI 覆盖值（config.*），真正生效的基础配置来自
 * gitignored 的 tdai-gateway.yaml（+ 沙箱 yaml + config-override.json），
 * 于是「全开档」这类说法无法从报告自证，历史读数不可复现（r141 五臂即因此报废）。
 *
 * 修法：用 core 的 loadGatewayConfig()（= 生产同一套解析：env > override > yaml > 缺省）
 * 取最终生效值，并与「纯代码缺省」「仅配置文件」两层逐键比对，标出每个键的来源：
 *   default = 代码缺省；file = 配置文件（含 config-override.json）；cli = bench 沙箱/CLI 覆盖。
 * 本模块不重新解释 yaml 语义，只做快照与归因。
 */
import fs from "node:fs";
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { parseConfig } from "../../../src/config.ts";
import { excludeInvalidatedFor } from "../../../src/core/recall/validity-policy.ts";

export type ConfigSourceLayer = "default" | "file" | "cli";

export interface EffectiveBenchConfig {
  /** 最终生效值（扁平点号键）。 */
  values: Record<string, unknown>;
  /** 逐键来源。 */
  sources: Record<string, ConfigSourceLayer>;
  /** 纯代码缺省层的值（与 values 同键集）：用于把「实验值，非缺省」标注出来。 */
  defaults: Record<string, unknown>;
  /** values 的 sha256 前 8 位：报告名/对比表用它认「同一套生效配置」。 */
  fingerprint: string;
  meta: {
    sandboxYaml: string | null;
    srcYaml: string | null;
    /** 生效配置的解析入口（证明不是脚本自解析）。 */
    resolvedBy: "src/gateway/config.ts:loadGatewayConfig";
    error?: string;
  };
}

const pick = (v: unknown) => (v === undefined ? null : v);

/** 只取需要自证的键：召回读侧 + 写侧两条固化机制。 */
function snapshot(cfg: any): Record<string, unknown> {
  const r = cfg?.recall ?? {};
  const w = cfg?.write ?? {};
  const rr = r.rerank ?? {};
  const sb = r.smallToBig ?? {};
  const cl = r.conclusionLayer ?? {};
  const fc = r.factChannel ?? {};
  const ep = r.evidencePack ?? {};
  const fk = w.factKey ?? {};
  const ss = w.supersession ?? {};
  return {
    "recall.maxResults": pick(r.maxResults),
    "recall.candidateK": pick(r.candidateK),
    "recall.fusion.mode": pick(r.fusion?.mode),
    "recall.injectWrapper": pick(r.injectWrapper),
    "recall.validity.mode": pick(r.validity?.mode),
    // 软惩罚强度（缺省 0.5，src/config.ts:2219）。实验臂钉非缺省值时报告必须能自证，
    // 否则 vsp 与 vs 的 config.effective 完全相同、差值无从归因。
    "recall.validity.softPenalty": pick(r.validity?.softPenalty),
    "recall.excludeInvalidated": pick(r.excludeInvalidated),
    // 派生三态：mode=soft 会盖住 flag=true 的语义（#174），真正生效的是这个值。
    "recall.excludeInvalidated.effective": pick(
      excludeInvalidatedFor(r.validity?.mode, r.excludeInvalidated),
    ),
    "recall.smallToBig.enabled": sb.enabled === true,
    "recall.smallToBig.maxExtraLines": pick(sb.maxExtraLines),
    "recall.smallToBig.budget": pick(sb.budget),
    "recall.conclusionLayer.enabled": cl.enabled === true,
    "recall.conclusionLayer.maxConclusions": pick(cl.maxConclusions),
    "recall.rerank.enabled": rr.enabled === true,
    "recall.rerank.candidates": pick(rr.candidates),
    "recall.rerank.minScore": pick(rr.minScore),
    "recall.factChannel.enabled": fc.enabled === true,
    "recall.factChannel.weight": pick(fc.weight),
    // #169 证据包两键：与 store.mjs effectiveRecallSnapshot 对齐（M6 自证要能看出 ep0/1/2 的差异）。
    "recall.evidencePack.enabled": ep.enabled === true,
    "recall.evidencePack.adjacent": pick(ep.adjacent),
    "write.factKey.enabled": fk.enabled === true,
    "write.factKey.mode": pick(fk.mode),
    "write.factKey.maxFacts": pick(fk.maxFacts),
    "write.factKey.includeTriples": fk.includeTriples === true,
    "write.supersession.enabled": ss.enabled === true,
    "write.supersession.cardinalityGate": ss.cardinalityGate === true,
    "write.supersession.cardinalityDefault": pick(ss.cardinalityDefault),
  };
}

function yamlOf(file: string | null): Record<string, unknown> | null {
  if (!file) return null;
  try {
    const raw = parseYaml(fs.readFileSync(file, "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  } catch {
    return null;
  }
}

function memoryLayer(raw: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!raw) return null;
  const mem = raw.memory;
  // 与 src/gateway/config.ts:487 同序：memory 子树；兼容直接把 recall 写在根上的老 yaml。
  if (mem && typeof mem === "object") return mem as Record<string, unknown>;
  if (raw.recall || raw.write) return raw;
  return {};
}

function classify(
  value: unknown,
  fileValue: unknown,
  defaultValue: unknown,
): ConfigSourceLayer {
  if (JSON.stringify(value) !== JSON.stringify(fileValue)) return "cli";
  if (JSON.stringify(fileValue) !== JSON.stringify(defaultValue)) return "file";
  return "default";
}

function sha8(values: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(values)).digest("hex").slice(0, 8);
}

/**
 * 读取 bench 沙箱的最终生效配置。
 * @param opts.sandboxYaml prepareBenchYaml 写出的沙箱 yaml 路径
 * @param opts.srcYaml 生产 yaml 路径（用于区分「配置文件本来就这么配」与「bench 旗标改的」）
 * @param opts.dataDir 沙箱 dataDir（config-override.json 所在目录）
 */
export async function readEffectiveBenchConfig(opts: {
  sandboxYaml?: string | null;
  srcYaml?: string | null;
  dataDir?: string | null;
}): Promise<EffectiveBenchConfig> {
  const sandboxYaml = opts.sandboxYaml ?? null;
  const srcYaml = opts.srcYaml ?? null;
  const defaults = parseConfig({});
  const fileCfg = memoryLayer(yamlOf(srcYaml));
  const fileValues = snapshot(fileCfg ? parseConfig(fileCfg) : defaults);

  const prevCfg = process.env.TDAI_GATEWAY_CONFIG;
  const prevData = process.env.TDAI_DATA_DIR;
  let effectiveCfg: any = null;
  let error: string | undefined;
  try {
    if (!sandboxYaml) throw new Error("缺 sandboxYaml：无法用 loadGatewayConfig 解析生效值");
    process.env.TDAI_GATEWAY_CONFIG = sandboxYaml;
    if (opts.dataDir) process.env.TDAI_DATA_DIR = opts.dataDir;
    const { loadGatewayConfig } = await import("../../../src/gateway/config.ts");
    effectiveCfg = loadGatewayConfig().memory;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  } finally {
    if (prevCfg === undefined) delete process.env.TDAI_GATEWAY_CONFIG;
    else process.env.TDAI_GATEWAY_CONFIG = prevCfg;
    if (prevData === undefined) delete process.env.TDAI_DATA_DIR;
    else process.env.TDAI_DATA_DIR = prevData;
  }

  const effValues = snapshot(effectiveCfg ?? parseConfig({}));
  const defValues = snapshot(defaults);
  const sources: Record<string, ConfigSourceLayer> = {};
  for (const k of Object.keys(effValues)) {
    sources[k] = classify(effValues[k], fileValues[k], defValues[k]);
  }
  return {
    values: effValues,
    sources,
    defaults: defValues,
    fingerprint: sha8(effValues),
    meta: {
      sandboxYaml,
      srcYaml,
      resolvedBy: "src/gateway/config.ts:loadGatewayConfig",
      ...(error ? { error } : {}),
    },
  };
}

/** 控制台人读版：只列非 default 的键，避免刷屏。 */
export function formatEffectiveConfig(ec: EffectiveBenchConfig): string {
  const rows = Object.entries(ec.values)
    .map(([k, v]) => `${k}=${JSON.stringify(v)} [${ec.sources[k] ?? "?"}]`)
    .filter((s) => !s.endsWith("[default]"));
  return `${ec.fingerprint} ${rows.join(", ")}`;
}
