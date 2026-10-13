/**
 * /v3/admin/rerank-model/{status,download} — rerank 本地模型管理（P1 task-4）。
 * status：RerankModelDownloader 注册表快照（getRerankModelStatus 返回拷贝），
 *   供 Panel 轮询渲染下载进度（percent + files[].bytesReceived/totalBytes，
 *   计数器节流发布见 downloader.ts maybePublishFromCounter）。
 * download：fire-and-forget 触发 startRerankModelDownload（模块级单例去重，
 *   重复调用/下载中再点都安全），立即返回当前状态；进度由 Panel 轮询 status
 *   获取（spec §4.4：panel 无推送通道）。
 * 内网信任模型；管理员判定在 Panel 层（isCallerSystemAdmin，与 admin-settings
 * 同范式）。handler 签名对齐 admin-settings.ts（v2-router routeTable 同款）。
 */
import { successEnvelope } from "./v2-router.js";
import type { ApiResponseEnvelope, V2AuthContext } from "./v2-schemas.js";
import { getRerankModelStatus, startRerankModelDownload, type StartRerankModelDownloadOptions } from "../core/recall/rerank/downloader.js";
import { resolveLocalModelDir } from "../core/recall/rerank/factory.js";
import type { RecallRerankConfig } from "../config.js";

export interface RerankModelAdminDeps {
  /** 当前生效 rerank 配置（读 local.modelDir / dataDir 解析默认模型目录）。 */
  getRerankConfig: () => RecallRerankConfig;
  /** 数据目录 DI（缺省走 resolveLocalModelDir 内部规则：TDAI_DATA_DIR env → home）。 */
  dataDir?: string;
  /** 下载参数 DI（测试注入 modelFiles/fetchImpl/baseUrl 覆盖；modelDir 由上面两项解析）。 */
  downloadOptions?: Omit<StartRerankModelDownloadOptions, "modelDir">;
}

export type RerankModelAdminHandler = (
  body: unknown,
  auth: V2AuthContext,
  requestId: string,
  deps: unknown,
) => Promise<ApiResponseEnvelope>;

export function makeRerankModelAdminRouteTable(deps: RerankModelAdminDeps): Record<string, RerankModelAdminHandler> {
  return {
    "/v3/admin/rerank-model/status": async (_body, _auth, requestId): Promise<ApiResponseEnvelope> =>
      successEnvelope(getRerankModelStatus(), requestId),
    "/v3/admin/rerank-model/download": async (_body, _auth, requestId): Promise<ApiResponseEnvelope> => {
      const modelDir = resolveLocalModelDir(deps.getRerankConfig(), deps.dataDir);
      // fire-and-forget：download() 内部已捕获失败并落 registry（failed 态），
      // 这里不 await —— 立即返回当前快照，panel 轮询 /status 看进度。
      void startRerankModelDownload({ modelDir, ...deps.downloadOptions }).catch(() => undefined);
      return successEnvelope(getRerankModelStatus(), requestId);
    },
  };
}
