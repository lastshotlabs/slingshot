/**
 * Internal compatibility path for the canonical entity operation authoring API.
 *
 * The implementation lives in `builders/op.ts` and `defineOperations.ts`.
 * Keeping this source-local forwarding module avoids a second builder or
 * validator drifting from the package root API.
 */
export { op } from '../builders/op';
export { defineOperations } from '../defineOperations';
export type {
  AggregateOpConfig,
  ArrayPullOpConfig,
  ArrayPushOpConfig,
  ArraySetOpConfig,
  BatchOpConfig,
  CollectionOpConfig,
  ComputedAggregateOpConfig,
  ConsumeOpConfig,
  CustomOpConfig,
  DeriveOpConfig,
  ExistsOpConfig,
  FieldUpdateOpConfig,
  FilterExpression,
  FilterValue,
  IncrementOpConfig,
  LookupOpConfig,
  OperationConfig,
  PipeOpConfig,
  ResolvedOperations,
  SearchOpConfig,
  TransactionOpConfig,
  TransitionOpConfig,
  UpsertOpConfig,
} from '../types';
