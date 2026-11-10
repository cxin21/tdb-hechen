/**
 * 维护 tick 的 P4 写者（spec §4.5/§4.6）：把 self-model.ts 的纯派生结果落库。
 *
 * 四类写入，全部幂等：
 *  - soul_self_model：整行 upsert（反例与证据在派生侧已与旧行并集，不会被窗口滚掉）
 *  - soul_calibration：按事件 id INSERT OR IGNORE，同 tick 重放不重复入账
 *  - soul_event_reflection：只在重复失败或已有修复成功时写，verified_at 由证据决定
 *
 * 失败只 warn 不阻断整轮 tick：自我认识晚一轮更新，比人格/卡写不进去轻得多。
 * 常量全部写死（不新增配置项/开关/环境变量）。
 */

import type { IMemoryStore } from "../store/types.js";
import type { CoreTenant } from "../store/types.js";
import type {
  SoulCalibrationRow,
  SoulEventReflectionInsert,
  SoulEventRow,
  SoulSelfModelInsert,
  SoulSelfModelRow,
} from "../store/soul-event-types.js";
import { deriveSelfModel, SELF_MODEL_EVENT_WINDOW } from "./self-model.js";

/** 只声明本写者用到的能力：缺哪个就整段跳过，不写半套。 */
export type SelfModelStorePort = Partial<
  Pick<
    IMemoryStore,
    | "listSoulEvents"
    | "listSoulSelfModel"
    | "upsertSoulSelfModel"
    | "commitSoulCalibration"
    | "listSoulCalibration"
    | "upsertSoulEventReflection"
  >
>;

export interface SelfModelMaintenanceResult {
  /** 本轮读了多少条事件。 */
  scanned: number;
  /** 写进 soul_self_model 的行数（错误模式 / 能力 / 校准认知）。 */
  written: number;
  patterns: number;
  capabilities: number;
  calibrationInsights: number;
  /** 本轮新入账的校准样本数。 */
  calibrationRows: number;
  /** 本轮写出的反思条数。 */
  reflections: number;
  /** 处于 probation / retired 的行数：可被推翻的认识才算认识。 */
  probation: number;
  retired: number;
}

function emptyResult(): SelfModelMaintenanceResult {
  return {
    scanned: 0,
    written: 0,
    patterns: 0,
    capabilities: 0,
    calibrationInsights: 0,
    calibrationRows: 0,
    reflections: 0,
    probation: 0,
    retired: 0,
  };
}

/**
 * 维护 tick 的入口：读窗口事件 + 旧自我模型 + 旧校准 → 派生 → 落库。
 *
 * 读事件只取工具类来源（tool/test/commit/rollback）与用户纠正所在的 chat 行，
 * 但过滤放在派生侧（deriveSelfModel）统一判定——这里取窗口，避免两处口径。
 */
export async function runSelfModelMaintenance(args: {
  store: SelfModelStorePort;
  tenant: CoreTenant;
  now?: string;
  logger?: { warn?: (msg: string) => void };
}): Promise<SelfModelMaintenanceResult> {
  const { store, tenant } = args;
  const now = args.now ?? new Date().toISOString();
  const warn = (msg: string): void => args.logger?.warn?.("[soul-self-model] " + msg);
  const result = emptyResult();

  const listEvents = store.listSoulEvents;
  const listModels = store.listSoulSelfModel;
  const upsertModel = store.upsertSoulSelfModel;
  const commitCalibration = store.commitSoulCalibration;
  const listCalibration = store.listSoulCalibration;
  if (
    typeof listEvents !== "function" ||
    typeof listModels !== "function" ||
    typeof upsertModel !== "function" ||
    typeof commitCalibration !== "function"
  ) {
    return result;
  }

  let events: SoulEventRow[] = [];
  try {
    events = (await Promise.resolve(listEvents.call(store, tenant, { limit: SELF_MODEL_EVENT_WINDOW, order: "desc" }))) ?? [];
  } catch (err) {
    warn("读事件失败，本轮跳过：" + (err instanceof Error ? err.message : String(err)));
    return result;
  }
  let previous: SoulSelfModelRow[] = [];
  try {
    previous = (await Promise.resolve(listModels.call(store, tenant, { limit: 400 }))) ?? [];
  } catch (err) {
    warn("读旧自我模型失败，按空处理：" + (err instanceof Error ? err.message : String(err)));
  }
  let calibrations: SoulCalibrationRow[] = [];
  if (typeof listCalibration === "function") {
    try {
      calibrations = (await Promise.resolve(listCalibration.call(store, tenant, { limit: 1000 }))) ?? [];
    } catch (err) {
      warn("读旧校准失败，按空处理：" + (err instanceof Error ? err.message : String(err)));
    }
  }

  const derived = deriveSelfModel({ events, previous, calibrations, now });
  result.scanned = derived.scanned;
  result.patterns = derived.patterns;
  result.capabilities = derived.capabilities;
  result.calibrationInsights = derived.calibrationInsights;
  result.probation = derived.probation;
  result.retired = derived.retired;

  // 先入账校准：下一 tick 的领域分立刻能算上这一轮，而不是永远慢一拍。
  if (derived.calibrationRows.length > 0) {
    try {
      const committed = await Promise.resolve(commitCalibration.call(store, tenant, derived.calibrationRows));
      result.calibrationRows = committed?.inserted ?? 0;
    } catch (err) {
      warn("校准入账失败：" + (err instanceof Error ? err.message : String(err)));
    }
  }

  for (const row of derived.selfModels as SoulSelfModelInsert[]) {
    try {
      const written = await Promise.resolve(upsertModel.call(store, tenant, row));
      if (written) result.written += 1;
    } catch (err) {
      warn(row.id + " 写入失败：" + (err instanceof Error ? err.message : String(err)));
    }
  }

  const upsertReflection = store.upsertSoulEventReflection;
  if (typeof upsertReflection === "function") {
    for (const reflection of derived.reflections as SoulEventReflectionInsert[]) {
      try {
        const res = await Promise.resolve(upsertReflection.call(store, tenant, reflection));
        if ((res?.upserted ?? 0) > 0) result.reflections += 1;
      } catch (err) {
        warn("反思 " + reflection.event_id + " 写入失败：" + (err instanceof Error ? err.message : String(err)));
      }
    }
  }

  return result;
}
