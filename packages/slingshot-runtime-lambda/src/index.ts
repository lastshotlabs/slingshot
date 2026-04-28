/**
 * Create an AWS Lambda runtime that wraps Slingshot handlers with trigger adapters.
 */
export { createLambdaRuntime } from './runtime';
/**
 * Public Lambda runtime types shared by direct AWS entrypoints.
 */
export type { LambdaRuntime, LambdaRuntimeOptions, LambdaTriggerKind } from './runtime';
/**
 * Build Lambda exports directly from the manifest `lambdas` section.
 */
export { createFunctionsFromManifest } from './manifest';
/**
 * Typed error raised when a manifest-driven handler cannot be resolved.
 */
export { HandlerResolutionError } from './errors';
