import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const instanceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  gateway_endpoint: z.string().url(),
  // DSH 特化（Wave 2A）：历史可选字段 `proxy_endpoint`（客户端接 MemoryProxy 8096 的 baseUrl）
  // 已退役 —— 唯一接入方是 DSH 插件，直连 `gateway_endpoint`(core)，没有需要单独展示的 proxy 地址。
  // 旧配置文件若仍带该键，zod 默认忽略未知键，不会启动失败。
  api_key: z.string().min(1),
});

const fileSchema = z.object({
  instances: z.array(instanceSchema).min(1),
});

export interface InstanceEntry {
  instance_id: string;
  name: string;
  gateway_endpoint: string;
  api_key: string;
}

export interface PublicInstance {
  instance_id: string;
  name: string;
  /**
   * Panel 后端 → Kernel 的转发地址（如 https://memory.ap-beijing.tencenttdai.com）。
   * 前端不能硬编码，每个实例的 endpoint 都不同（dev/staging/prod）。
   * `api_key` 是 secret，不下发。
   */
  gateway_endpoint: string;
}

export class InstanceRegistryError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'InstanceRegistryError';
  }
}

export class InstanceRegistry {
  private readonly byId: Map<string, InstanceEntry>;

  constructor(entries: InstanceEntry[]) {
    this.byId = new Map(entries.map((e) => [e.instance_id, e]));
  }

  static load(configPath: string): InstanceRegistry {
    const filePath = resolve(configPath);
    if (!existsSync(filePath)) {
      throw new InstanceRegistryError(
        500,
        `metadata instances config not found: ${filePath}\n` +
          `  hint: cp config/metadata-instances.example.json config/metadata-instances.json`,
      );
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    } catch {
      throw new InstanceRegistryError(500, `invalid metadata instances config: ${filePath}`);
    }
    const parsed = fileSchema.safeParse(raw);
    if (!parsed.success) {
      throw new InstanceRegistryError(500, `metadata instances config validation failed`);
    }
    // P2-T13 鉴权必填：网关翻转"server.apiKey 缺失即生成临时密钥"后（拍板③），
    // Panel 转发链路（metaKernel / kernelHttp → Bearer api_key）必须带同一把 key，
    // 否则一律 401。env `TDAI_GATEWAY_APIKEY` 优先于每实例 json `api_key`：
    //   - 设了 env → 一把 key 覆盖全部实例（部署侧最省事的接入方式）
    //   - 未设 → 沿用 json 里每实例 api_key（历史行为不变）
    const envGatewayKey = (process.env.TDAI_GATEWAY_APIKEY ?? '').trim();
    const entries = parsed.data.instances.map((row) => ({
      instance_id: row.id,
      name: row.name,
      gateway_endpoint: row.gateway_endpoint,
      api_key: envGatewayKey || row.api_key,
    }));
    return new InstanceRegistry(entries);
  }

  resolve(instanceId: string): InstanceEntry {
    const entry = this.byId.get(instanceId);
    if (!entry) {
      throw new InstanceRegistryError(400, 'INVALID_INSTANCE');
    }
    return entry;
  }

  listPublic(): PublicInstance[] {
    return [...this.byId.values()].map(({ instance_id, name, gateway_endpoint }) => ({
      instance_id,
      name,
      gateway_endpoint,
    }));
  }

  /** Full entries incl. credentials — internal startup/admin use only, never client-facing. */
  listAll(): InstanceEntry[] {
    return [...this.byId.values()];
  }
}
