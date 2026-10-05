# Domain docs — 布局结论与消费规则

## 布局结论：single-context

本仓库域文档布局为 **single-context**（2026-10-05 初始化时与用户确认）：一个仓库共用一份**根目录 `CONTEXT.md`**，架构决定（ADR）放 **`docs/adr/`**。不使用 multi-context——无根 `CONTEXT-MAP.md`，各子项目（MemoryCore / MemoryProxy / MemoryPanel / MemoryKnowledge / sdk）不建各自的 `CONTEXT.md`，词条一律回流根文件。

## 消费规则

- 动手改代码前先读根 `CONTEXT.md` 的相关词条；术语以词条为准
- 架构决定写成 ADR 落 `docs/adr/`，文件名 `NNNN-标题.md` 序号递增
- `CONTEXT.md` **本次初始化不预建**：按约定留到第一次真正写下词条时再建（2026-10-05 记录在案）；`CONTEXT-MAP.md` 同样不建
- 词条新增/修改遵循 `domain-modeling` 技能的流程
