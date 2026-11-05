/**
 * 自维护人格层（soul persona）公共入口。
 *
 * 模块边界：
 *  - types     数据模型与缺省参数（安全侧缺省：enabled=false）
 *  - gates     确定性判据（事件句/阶段词/换项目/两难/证据独立性/原话/变更率/预算）
 *  - emotion   情绪（有对象、半衰期）与心境（无对象、相对基线）
 *  - drift     双轨漂移（语体可自复位，判断不可）
 *  - persona   条目生命周期（α 更新/合并/降级/冻结/复活/预算渲染）
 *  - consolidator 后台整合编排（读 core_memory → 判据 → 事务提交 + 账本）
 *  - replay    历史提案回放校准（0 人工的验收口径）
 */
export * from "./types.js";
export * from "./gates.js";
export * from "./emotion.js";
export * from "./drift.js";
export * from "./persona.js";
export * from "./consolidator.js";
export * from "./worker.js";
export * from "./replay.js";
