/**
 * Instance registry × 已退役 `proxy_endpoint` 字段 —— DSH 特化 Wave 3 复核项。
 *
 * Wave 2A 从 zod schema / InstanceEntry / PublicInstance 里删掉了 `proxy_endpoint`
 * （客户端接 MemoryProxy 8096 的地址）。本文件钉住两件生产风险：
 *   ① 部署机上**已存在**的 metadata-instances.json 可能仍带该键 → load() 必须照常成功
 *      （zod 默认剥离未知键），绝不能因为一个退役键让 Panel 起不来；
 *   ② 下发面（listPublic / resolve）不能再出现该字段 —— 否则前端会拿到一个已死的地址。
 *
 * 另外直接读仓库里真实的两份配置（example 恒存在；gitignored 的真值文件存在时才校验）。
 */

import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InstanceRegistry } from '../src/panel/config/instance-registry.js';

const LEGACY_CONFIG = {
  _comment: 'Wave 2A 之前的形态：每条实例还带 proxy_endpoint（已退役）',
  instances: [
    {
      id: 'default',
      name: 'Local default instance',
      gateway_endpoint: 'http://127.0.0.1:8420',
      proxy_endpoint: 'http://127.0.0.1:8096',
      api_key: 'k-test-0001',
    },
  ],
};

function writeTempConfig(content: unknown): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'panel-instance-registry-'));
  const file = join(dir, 'metadata-instances.json');
  writeFileSync(file, JSON.stringify(content, null, 2), 'utf8');
  return { dir, file };
}

describe('metadata-instances.json 里的退役字段 proxy_endpoint', () => {
  it('旧配置仍带 proxy_endpoint → load 成功（未知键被剥离，不炸启动）', () => {
    const { dir, file } = writeTempConfig(LEGACY_CONFIG);
    try {
      const registry = InstanceRegistry.load(file);
      const entry = registry.resolve('default');
      expect(entry.gateway_endpoint).toBe('http://127.0.0.1:8420');
      expect(entry.api_key).toBe('k-test-0001');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('下发面 listPublic 不再含 proxy_endpoint（只剩 instance_id / name / gateway_endpoint）', () => {
    const { dir, file } = writeTempConfig(LEGACY_CONFIG);
    try {
      const publicList = InstanceRegistry.load(file).listPublic();
      expect(publicList).toHaveLength(1);
      expect(Object.keys(publicList[0]).sort()).toEqual(['gateway_endpoint', 'instance_id', 'name']);
      expect('proxy_endpoint' in publicList[0]).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('仓库里的 example 配置（committed）能被同一 schema 解析', () => {
    const example = join(process.cwd(), 'config', 'metadata-instances.example.json');
    expect(existsSync(example)).toBe(true);
    const registry = InstanceRegistry.load(example);
    expect(registry.listPublic().length).toBeGreaterThan(0);
  });

  it.skipIf(!existsSync(join(process.cwd(), 'config', 'metadata-instances.json')))(
    '部署机真值配置（gitignored）当前形态可解析：seed 里没有退役键也不会报错',
    () => {
      const real = join(process.cwd(), 'config', 'metadata-instances.json');
      const registry = InstanceRegistry.load(real);
      const publicList = registry.listPublic();
      expect(publicList.length).toBeGreaterThan(0);
      for (const entry of publicList) {
        expect(entry.gateway_endpoint.startsWith('http')).toBe(true);
        expect('proxy_endpoint' in entry).toBe(false);
      }
    },
  );
});
