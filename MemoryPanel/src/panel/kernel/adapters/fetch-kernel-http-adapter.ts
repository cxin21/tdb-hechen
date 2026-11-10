import type { Logger } from '../../infra/logger.js';
import {
  executeMetaFetch,
  executeMetaGet,
  executeMetaGetRaw,
  KernelFetchError,
  type MetaFetchConfig,
  type RawMetaResponse,
} from '../transport-fetch.js';
import type { MetaEnvelope } from '../envelope.js';
import type { KernelHttpPort } from '../ports/kernel-http-port.js';
import type { KernelCredentials } from '../types.js';

/** KernelFetchError → 信封（保留 401/403/503 等真实码，不统一折成 502）。 */
function envelopeFromKernelError<T>(
  err: KernelFetchError,
  cred: KernelCredentials,
): MetaEnvelope<T> {
  const message =
    err.code === 504 ? 'KERNEL_TIMEOUT' : err.code === 502 ? 'KERNEL_UNAVAILABLE' : err.message;
  return {
    code: err.code,
    message,
    request_id: cred.requestId ?? '',
    data: null,
  } as MetaEnvelope<T>;
}

function metaFetchConfig(cred: KernelCredentials, logger?: Logger): MetaFetchConfig {
  return {
    endpoint: cred.endpoint,
    apiKey: cred.apiKey,
    serviceId: cred.instanceId,
    userKey: cred.userKey,
    timeoutMs: cred.timeoutMs,
    requestId: cred.requestId,
    logger,
  };
}

export class FetchKernelHttpAdapter implements KernelHttpPort {
  constructor(private readonly logger?: Logger) {}

  async postEnvelope<T>(
    path: string,
    body: unknown,
    cred: KernelCredentials,
  ): Promise<MetaEnvelope<T>> {
    try {
      return await executeMetaFetch<MetaEnvelope<T>>(
        metaFetchConfig(cred, this.logger),
        path,
        body,
        'envelope',
      );
    } catch (err) {
      if (err instanceof KernelFetchError) return envelopeFromKernelError<T>(err, cred);
      throw err;
    }
  }

  async getEnvelope<T>(
    path: string,
    query: Record<string, string>,
    cred: KernelCredentials,
  ): Promise<MetaEnvelope<T>> {
    try {
      return await executeMetaGet<MetaEnvelope<T>>(
        metaFetchConfig(cred, this.logger),
        path,
        query,
        'envelope',
      );
    } catch (err) {
      if (err instanceof KernelFetchError) return envelopeFromKernelError<T>(err, cred);
      throw err;
    }
  }

  /**
   * 裸 GET：上游不套信封（/v3/soul/trait-state）。网络/超时仍抛 KernelFetchError(502/504)，
   * 由路由折成 UPSTREAM_ERROR/UPSTREAM_TIMEOUT；HTTP 错误码不在这里折叠。
   */
  async getRaw(
    path: string,
    query: Record<string, string>,
    cred: KernelCredentials,
  ): Promise<RawMetaResponse> {
    return executeMetaGetRaw(metaFetchConfig(cred, this.logger), path, query);
  }
}
