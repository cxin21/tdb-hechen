/** 星图组件层（kit）。S1 已实现 15 个组件，接线在 S1b：
 * docs/specs/2026-11-11-panel-starmap-kit-and-cache.md A 节。 */
import './kit.css';

export { Stage } from './Stage';
export type { StageProps } from './Stage';

export { Surface } from './Surface';
export type { SurfaceProps } from './Surface';

export { Section } from './Section';
export type { SectionProps } from './Section';

export { Row } from './Row';
export type { RowProps } from './Row';

export { KvList } from './KvList';
export type { KvItem, KvListProps } from './KvList';

export { MetricRow } from './MetricRow';
export type { MetricItem } from './MetricRow';

export { Pager, pageWindow } from './Pager';
export type { PageSlot, PagerProps } from './Pager';

export { Seg } from './Seg';
export type { SegOption, SegProps } from './Seg';

export { Tag } from './Tag';
export type { TagProps } from './Tag';

export { Dialog } from './Dialog';
export type { DialogProps } from './Dialog';

export { Empty, Note, Skeleton } from './States';
export type { NoteProps } from './States';

export { Gate } from './Gate';
export type { GateProps } from './Gate';

export { Legend } from './Legend';
export type { LegendItem, LegendProps } from './Legend';

export { ScopeBar } from './ScopeBar';
export type { ScopeBarProps, ScopeOption } from './ScopeBar';

export { StarDetail } from './StarDetail';
export type { StarDetailProps, StarRelation } from './StarDetail';

export { dotClass } from './types';
export type { Tone } from './types';
