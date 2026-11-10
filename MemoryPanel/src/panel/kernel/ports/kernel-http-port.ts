import type { MetaEnvelope } from '../envelope.js';
import type { RawMetaResponse } from '../transport-fetch.js';
import type { KernelCredentials } from '../types.js';

export interface KernelHttpPort {
  postEnvelope<T>(path: string, body: unknown, cred: KernelCredentials): Promise<MetaEnvelope<T>>;
  /** GET 只读端点（如 /v3/soul/card）；query 为空串的键不序列化。 */
  getEnvelope<T>(
    path: string,
    query: Record<string, string>,
    cred: KernelCredentials,
  ): Promise<MetaEnvelope<T>>;
  /**
   * GET 只读端点，**不解析信封**：上游回裸对象时（如 /v3/soul/trait-state）
   * 原样带回 status + body + text，由调用方按原码透出。
   */
  getRaw(
    path: string,
    query: Record<string, string>,
    cred: KernelCredentials,
  ): Promise<RawMetaResponse>;
}
