/**
 * api/meta-instances.ts — 登录前选实例（GET /api/v1/meta/instances）。
 */
import { request, dedupeInFlight } from './base';

/**
 * 客户端可见的实例元信息。
 *   - `api_key`（真 secret）不下发。
 *   - `gateway_endpoint` 是后端 → 内核的转发地址，也是"客户端接入 baseUrl"
 *     （DSH 特化后唯一接入方是 DSH 插件，直连它）。
 *     不属于 secret；每个实例独立，前端不能硬编码。
 *   - 历史字段 `proxy_endpoint`（客户端接 MemoryProxy 8096）已随 DSH 特化退役。
 */
export interface MetadataInstance {
  instance_id: string;
  name: string;
  gateway_endpoint: string;
}

export const metaInstancesApi = {
  /** 登录前选实例；GET /api/v1/meta/instances，公开、无需鉴权、无分页 */
  list: () =>
    dedupeInFlight('meta/instances', () =>
      request<{ instances: MetadataInstance[] }>('GET', '/api/v1/meta/instances').then(
        (r) => r.instances,
      ),
    ),
};
