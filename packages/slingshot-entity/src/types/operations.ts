/**
 * Operation configuration types — re-exported from @lastshotlabs/slingshot-core.
 *
 * slingshot-core is the single source of truth for these types.
 * This file re-exports them for convenience within slingshot-entity.
 */
export type {
  ComputeSpec,
  ComputedField,
  DateTruncation,
  GroupByConfig,
  MergeStrategy,
  LookupOpConfig,
  ExistsOpConfig,
  TransitionOpConfig,
  FieldUpdateOpConfig,
  AggregateOpConfig,
  ComputedAggregateOpConfig,
  BatchOpConfig,
  UpsertOpConfig,
  SearchOpConfig,
  CollectionOpConfig,
  CollectionOperation,
  ConsumeOpConfig,
  DeriveOpConfig,
  DeriveSource,
  TransactionOpConfig,
  TransactionStep,
  PipeOpConfig,
  PipeStep,
  CustomOpConfig,
  ArrayPushOpConfig,
  ArrayPullOpConfig,
  ArraySetOpConfig,
  IncrementOpConfig,
  OperationConfig,
  ResolvedOperations,
} from '@lastshotlabs/slingshot-core';
