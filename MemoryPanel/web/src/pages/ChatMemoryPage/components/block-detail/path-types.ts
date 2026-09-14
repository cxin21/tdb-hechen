/** 关联链节点（/v3/atomic/path 出参，与内核 handleAtomicPath 内容增强同形）。 */
export interface PathNode {
  id: string;
  type: string;
  strength: number;
  hop: number;
  content?: string;
}
