/**
 * #125-B7（epic #125 面板 B7）：环境变量空串/纯空白语义。
 *
 * 回归点：panel-config 的 `env()` 曾用 `process.env[key] ?? fallback`，
 * 把 `KNOWLEDGE_SERVICE_URL=` / `KNOWLEDGE_AUTH_TOKEN=` 这类"空行占位"当成
 * 有效值，静默把 baseUrl/token 变成空串（BFF 随后请求失败）；envInt 更糟：
 * 纯空白经 Number('  ') === 0 会把端口/超时变成 0。现在统一 trim + 空视为未设。
 *
 * 说明：MemoryPanel 目录下没有 .env（只有 .env.example），loadDotenv() 不会
 * 覆盖 process.env，所以这里直接改 process.env 再调 loadPanelConfig()。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { loadPanelConfig } from '../src/panel/config/panel-config.js';

const KEYS = [
  'KNOWLEDGE_SERVICE_URL',
  'KNOWLEDGE_AUTH_TOKEN',
  'KNOWLEDGE_TIMEOUT_MS',
  'KNOWLEDGE_LLM_BINDING_SYNC',
  'LLM_PROVIDER_PROXY_BASE_URL',
  'PORT',
  'HOST',
] as const;

const saved = new Map<string, string | undefined>();
for (const k of KEYS) saved.set(k, process.env[k]);

afterEach(() => {
  for (const k of KEYS) {
    const v = saved.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('loadPanelConfig 环境变量空值语义（#125-B7）', () => {
  it('字符串键：未设置 → fallback', () => {
    for (const k of KEYS) delete process.env[k];
    const cfg = loadPanelConfig();
    expect(cfg.knowledge.baseUrl).toBe('http://127.0.0.1:8421');
    expect(cfg.knowledge.authToken).toBe('');
    expect(cfg.server.host).toBe('0.0.0.0');
    expect(cfg.llmProvider.proxyBaseUrl).toBe('http://127.0.0.1:8096');
  });

  it('字符串键：空串 → fallback（不再静默变成空串）', () => {
    process.env.KNOWLEDGE_SERVICE_URL = '';
    process.env.KNOWLEDGE_AUTH_TOKEN = '';
    process.env.HOST = '';
    const cfg = loadPanelConfig();
    expect(cfg.knowledge.baseUrl).toBe('http://127.0.0.1:8421');
    expect(cfg.knowledge.authToken).toBe('');
    expect(cfg.server.host).toBe('0.0.0.0');
  });

  it('字符串键：纯空白 → fallback；两侧空白被裁剪', () => {
    process.env.KNOWLEDGE_SERVICE_URL = '   ';
    process.env.LLM_PROVIDER_PROXY_BASE_URL = '  http://proxy:9000  ';
    const cfg = loadPanelConfig();
    expect(cfg.knowledge.baseUrl).toBe('http://127.0.0.1:8421');
    expect(cfg.llmProvider.proxyBaseUrl).toBe('http://proxy:9000');
  });

  it('整数键：空串/纯空白 → fallback（不是 0）', () => {
    process.env.PORT = '';
    process.env.KNOWLEDGE_TIMEOUT_MS = '   ';
    const cfg = loadPanelConfig();
    expect(cfg.server.port).toBe(8123);
    expect(cfg.knowledge.timeoutMs).toBe(15_000);
  });

  it('整数键：合法值含空白仍被解析', () => {
    process.env.PORT = ' 8124 ';
    process.env.KNOWLEDGE_TIMEOUT_MS = '2500';
    const cfg = loadPanelConfig();
    expect(cfg.server.port).toBe(8124);
    expect(cfg.knowledge.timeoutMs).toBe(2500);
  });

  it('布尔键：纯空白 → fallback，显式 false 仍生效', () => {
    process.env.KNOWLEDGE_LLM_BINDING_SYNC = '   ';
    expect(loadPanelConfig().knowledgeLlmBinding.sync).toBe(true);

    process.env.KNOWLEDGE_LLM_BINDING_SYNC = 'false';
    expect(loadPanelConfig().knowledgeLlmBinding.sync).toBe(false);
  });
});
