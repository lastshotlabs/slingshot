/**
 * Create the BullMQ-backed event bus adapter and validate its runtime options.
 */
export { createBullMQAdapter, bullmqAdapterOptionsSchema } from './bullmqAdapter';
/**
 * Public BullMQ adapter event, health, and configuration types.
 */
export type {
  BullMQAdapterDropEvent,
  BullMQAdapterDropReason,
  BullMQAdapterHealth,
  BullMQAdapterOptions,
} from './bullmqAdapter';
