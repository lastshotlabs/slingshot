/**
 * Universal schema-driven fake data generation for Slingshot.
 *
 * This module provides a Zod-schema-aware faker that works with any schema
 * in the system — entity create/update schemas, route payloads, event
 * payloads, webhook bodies, and anything else validated by Zod.
 *
 * @example
 * ```ts
 * import { generateFromSchema, generateMany, generateExample } from '@lastshotlabs/slingshot-core/faker';
 * ```
 *
 * @module
 */
export { generateFromSchema, generateMany, generateExample } from './generateFromSchema';
export type { GenerateOptions } from './generateFromSchema';
export { walkSchema } from './zodWalker';
export type { WalkOptions } from './zodWalker';
