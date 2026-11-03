/**
 * F6⑤ 指标脚本的配置读取（2026-11-02 task-7）。
 *
 * 背景：`scripts/memory-metrics.ts` 曾把 atomicMaxChars 硬编码成 300，与生产
 * config-override.json 的 `extraction.atomicMaxChars = 600` 不一致 —— 原子性率口径失真。
 * 这里提供唯一解析入口：CLI 值 > config-override > parseConfig 缺省，三者都过
 * `parseConfig` 的同一 clamp（120..2000），保证脚本与运行时口径逐位一致。
 *
 * 只读：调用方传 dataDir 时用 gateway 现成 loader（含损坏文件兜底），传 configPath
 * 时直读该 JSON。任何读取失败都回落缺省，绝不抛错（指标脚本不许因配置损坏而崩）。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseConfig } from "../../config.js";
import { readSettingsOverride, type SettingsOverride } from "../../gateway/settings-override.js";

export type AtomicMaxCharsSource = "cli" | "config-override" | "default";

export interface AtomicMaxCharsResolution {
  /** 生效值（已过 parseConfig 的 120..2000 clamp）。 */
  value: number;
  /** 取值来源：CLI 显式 > config-override > parseConfig 缺省。 */
  source: AtomicMaxCharsSource;
  /** parseConfig 的内建缺省（用于报告里自证"回落到了什么"）。 */
  parsedDefault: number;
}

/** parseConfig 的内建缺省（= 运行时无配置时的 atomicMaxChars）。 */
export function parsedDefaultAtomicMaxChars(): number {
  return parseConfig(undefined).extraction.atomicMaxChars;
}

/** 经 parseConfig 走同一 clamp。 */
function clampViaParse(raw: number): number {
  return parseConfig({ extraction: { atomicMaxChars: raw } }).extraction.atomicMaxChars;
}

/**
 * 读取 override 文件。configPath 显式给出时直读该路径；否则按 dataDir 走
 * gateway 的现成 loader（config-override.json 约定 + 损坏兜底）。
 */
export function readMetricsOverride(opts: { configPath?: string; dataDir?: string }): SettingsOverride | null {
  if (opts.configPath) {
    if (!existsSync(opts.configPath)) return null;
    try {
      return JSON.parse(readFileSync(opts.configPath, "utf-8")) as SettingsOverride;
    } catch {
      return null;
    }
  }
  if (opts.dataDir) return readSettingsOverride(opts.dataDir);
  return null;
}

export interface AtomicMaxCharsOptions {
  /** CLI 显式值（--atomic-max-chars）；缺省表示"跟随配置"。 */
  cli?: number;
  /** 指向 config-override.json 的显式路径。 */
  configPath?: string;
  /** 数据目录（其下 config-override.json）。 */
  dataDir?: string;
  /** 已解析好的 override（便于调用方复用一次 IO）。 */
  override?: SettingsOverride | null;
}

export function resolveAtomicMaxChars(opts: AtomicMaxCharsOptions): AtomicMaxCharsResolution {
  const parsedDefault = parsedDefaultAtomicMaxChars();
  if (typeof opts.cli === "number" && Number.isFinite(opts.cli)) {
    return { value: clampViaParse(opts.cli), source: "cli", parsedDefault };
  }
  const override =
    opts.override !== undefined
      ? opts.override
      : readMetricsOverride({ configPath: opts.configPath, dataDir: opts.dataDir });
  const fromConfig = override?.extraction?.atomicMaxChars;
  if (typeof fromConfig === "number" && Number.isFinite(fromConfig)) {
    return { value: clampViaParse(fromConfig), source: "config-override", parsedDefault };
  }
  return { value: parsedDefault, source: "default", parsedDefault };
}

/** configPath 的目录（CLI 只给文件路径时，日志里仍能报出所在目录）。 */
export function configDir(configPath: string | undefined): string | undefined {
  return configPath ? dirname(configPath) : undefined;
}
