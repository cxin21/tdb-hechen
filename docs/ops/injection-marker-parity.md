# 插件侧注入识别放宽（task-91）

真源 = `MemoryCore/src/gateway/injection-guard.ts:99-188`。插件旧实现（只看第一个非空行 `trim().startsWith(marker)`）
比 core 严，导致「缩进 / CRLF / 行首零宽」三种形态下**我们自己的块**被判成真实发言写回 L0（自我中毒）。

## 改动（path:line）
- `dsh-plugin/src/injection-markers.ts:57` `LEADING_NON_EMPTY_LINE_LIMIT = 3`（与 core 同名同值）
- `dsh-plugin/src/injection-markers.ts:60` `MIN_MATCHED_SEGMENT_RATIO = 0.3`
- `dsh-plugin/src/injection-markers.ts:71` `LEADING_INVISIBLE_CHARS_RE`（`\s` + NBSP/全角空格 + U+200B–200F/2060/FEFF）
- `dsh-plugin/src/injection-markers.ts:83` `normalizeInjectionLines`（`\r\n|\r` → `\n`，逐行剥行首不可见填充，保留空行位置）
- `dsh-plugin/src/injection-markers.ts:115` `detectInjectedBlock`（行首前缀匹配；命中须在前 3 个非空行内，或命中段非空白字符 ≥30%）
- `dsh-plugin/src/injection-markers.ts:136` `looksLikeInjectedBlock`（布尔视图）
- `dsh-plugin/src/writeback.ts:3` 改为 import 共享实现；`:225-232` 的本地旧函数删除，注释改为指向共享规则
- 终局裁决写死在 `:83` 注释：**只剥行首，标记内部不归一化**（`<soul\u200b-identity>` 不认），理由 = 拆开后已不是我们的块，认它会把「用户真在讨论该字符串」判成注入。

## 放宽前后判定对照（同一 payload）
| payload 形态 | 旧实现 | 新实现 | core |
|---|---|---|---|
| `前缀一句：\n   <soul-identity>\n…`（缩进） | false（逃逸） | **true** | true |
| `系统提示：\r\n\t<relevant-memories>…`（CRLF+tab） | false | **true** | true |
| `\u200b<relevant-memories>\n- 记忆`（ZWSP 行首） | false | **true** | true |
| 长正文第 8 非空行中段引用（占比 13%） | false | false（不误杀） | false |
| 句中「我看到【agemem 记忆提示】…」 | false | false | false |

## 测试
`dsh-plugin/test/injection-markers.test.ts`（新增，21 例）：常量/标记表/归一化与 core 逐项对拍、9 种放宽形态、
4 类负例、真实 `formatVolatileBlock` 渲染块必须被抓、整块缩进版必须被抓、20 例 fixture 两实现结论逐一相等
（直接 import core 模块对拍，不是抄字面量）、2 例 writeback 集成（缩进块 / ZWSP 块不落 L0，真问题保留）。

## 读数
- 本文件 21/21 绿；全仓 dsh-plugin **28 files / 500 tests 全绿**（我接手前 27/479 ⇒ +1 file / +21 tests）。
- `npx tsc -p tsconfig.json --noEmit` = 0 errors；`npm run build` rc=0。
- 一次全量跑曾出现 `index.test.ts` L0 4xx 用例失败（:685 区域，800ms 等待），单跑该文件与随后整跑均绿 ⇒ 判定为并行负载下的既有时序抖动，与本改动无关（该路径不带标记文本）。

## 未做 / 风险
- 未做「标记内部归一化」（Lead 已裁决不做），代价：宿主若把标记拆开重排，仍会漏判。
- 集成用例只覆盖无 source 的文本闸门路径；带 `source.kind==='user'` 的真实粘贴仍按 P1-a 保留（设计如此）。
- **跨包依赖边界**：该对拍测试把 MemoryCore 当同仓依赖（`dsh-plugin/test/injection-markers.test.ts:28-35` 是唯一 import 处）。
  若 dsh-plugin 将来单独发布、或在独立 CI 里只跑本包，这条会红，且**不是产品缺陷**。届时该由 dsh-plugin 侧接手：
  要么把该用例拆进「同仓专用」套件并按包边界跳过，要么提供带来源版本的 core 夹具副本——不许改成抄字面量
  （抄字面量只证明抄对，不证明等价）。
