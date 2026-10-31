# 配置模板规格（CONFIG TEMPLATE SPEC）

> 本文件是 `config/templates/` 下五份服务配置模板的**唯一格式契约**。五份模板必须同形，
> 机器检查脚本 `scripts/check-config-templates.mjs` 按本文件断言。

## 1. 交付物

| 服务 | 端口 | 模板文件 | 机器清单 | 真源（唯一裁决） |
|---|---|---|---|---|
| MemoryCore | 8420 | `config/templates/memorycore.yaml` | `memorycore.keys.json` | `MemoryCore/src/config.ts` + `MemoryCore/tdai-gateway.yaml` |
| MemoryProxy | 8096 | `config/templates/memoryproxy.yaml` | `memoryproxy.keys.json` | `MemoryProxy/src/config.ts` + `etc/proxy-config.yaml` |
| MemoryKnowledge | 8421 | `config/templates/memoryknowledge.yaml` | `memoryknowledge.keys.json` | `MemoryKnowledge/src/config.ts` |
| MemoryPanel | 8123 | `config/templates/memorypanel.yaml` | `memorypanel.keys.json` | `MemoryPanel/src/panel/config*` + `MemoryPanel/config/*` |
| dsh-plugin | （宿主内） | `config/templates/dsh-plugin.yaml` | `dsh-plugin.keys.json` | `dsh-plugin/src/config.ts` + `src/config-schema.ts` |
| 本机环境变量 | — | `config/templates/env.ps1` | `env.keys.json` | `D:/TDB/etc/env.ps1` + 五包 `process.env` 读取点 |

## 2. 模板文件格式（逐字遵守）

```yaml
# ============================================================================
# <服务名> 配置模板 — <端口 / 进程形态>
# 真源：<源码文件清单>；本模板与之逐键对齐，由 scripts/check-config-templates.mjs 校验
# 用法：<一句话怎么用这份模板>
# 敏感值：一律 ${ENV_NAME} 占位，真实值只进 D:/TDB/etc/env.ps1
# ============================================================================

# ─── <段名> ─────────────────────────────  <- 与源码解析顺序一致
#                                        [config.ts:NNNN]
key: value   # <类型> default=<默认值> — <一句话说明作用与取值> [src:NNNN]
```

每条键**必须**同时具备四要素，缺一即不合格：

1. `<类型>`：`bool` / `int` / `float` / `str` / `enum(a|b|c)` / `list<T>` / `map<K,V>` / `ms` / `path`
2. `default=`：**源码里的缺省值**，不得写「生产现值」。四种合法写法：
   - 有字面量 → 写该字面量（字符串 `default=""` 表示缺省即空串）
   - 源码无缺省（可选键） → `default=unset`（等价写法 `required: true`，二者都不要写 `undefined`）
   - 源码写成表达式（`100 * 1024 * 1024`、`2 * 60_000`） → 写**折算后的值**，并在 keys.json 加 `defaultNote` 说明表达式原文
   - 缺省由 helper 兜底（`envBool('X')`、`?? DEFAULT`） → 写字面量结果并加 `defaultNote`
3. 一句话说明 作用 + 取值影响（不是复述键名）
4. `[src:行号]`：解析点行号，必须真实命中该键字符串。**若缺省值在别处（如 MemoryProxy 的 `DEFAULT_CONFIG` 块），source 应指向「既有键名又有字面量」的那一行**（读的人要能照着改），而不是合成优先级的那一行

## 3. 机器清单 `<service>.keys.json`

```json
{
  "service": "memorycore",
  "generatedAt": "2026-11-01T04:10:00+08:00",
  "sources": ["MemoryCore/src/config.ts", "MemoryCore/tdai-gateway.yaml"],
  "keys": [
    { "path": "memory.recall.maxResults", "type": "int", "default": 10,
      "env": "TDAI_RECALL_MAX_RESULTS", "source": "MemoryCore/src/config.ts:2610",
      "consumed": true }
  ],
  "ignored": [
    { "path": "memory.foo", "reason": "解析后无消费者（孤儿键），已登记 issue #NNN" }
  ]
}
```

- `path` 用点号从 yaml 根开始；数组用 `[]`（如 `memory.recall.channels[]`）
- `consumed`：该键在运行期是否真被读到。**false 也照样留在 `keys` 里**（模板保留它，让使用者看得见），
  另加 `"orphan": true` 与 `reason` 说明「谁解析了它、谁没消费它、登记在哪」
- `ignored`：源码有解析但**不进模板**的键，逐条给理由；「不知道」不是理由。
  典型三类：系统/容器环境变量（PATH/HOSTNAME）、历史失效别名（代码已不读）、仓内开发脚本自用变量
- **硬约束：`keys` 与 `ignored` 不相交**（一个键不能既在模板里又被忽略）
- `coverage` 四个字段：`sourceKeys`（源码解析键总数，**必须**）、`templatedKeys`（= keys.length）、`ignoredKeys`（= ignored.length）、`note`（一句话说明哪些键被算进/排除）。三者写成 `keys.length + ignored.length === sourceKeys` 才算自证

## 4. 覆盖率判据（谁都不能自证）

模板键集合 `M`，源码解析键集合 `S`：

- `S - M - ignored == ∅`：源码里每个被解析的键，要么在模板里，要么在 ignored 里带理由
- `M - S == ∅`：模板里不能有源码不认的键（拼错一个字母就是配置不生效）
- 每条键的 `[src:N]` 行必须包含该键名（脚本逐条 grep 断言）
- 每个键的 `default=` 必须与源码该行的缺省字面量一致（浮点/布尔/字符串归一后逐字相等）

## 5. 红线

- 不写真实密钥/token/URL 里的账号；只用 `${ENV}` 占位
- 不改源码；模板与代码冲突时**报告冲突**而不是改代码
- 不 commit（提交由 Lead 统一做）
