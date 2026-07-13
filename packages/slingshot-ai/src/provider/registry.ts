/**
 * Provider registry.
 *
 * Shape copied deliberately from `slingshot-oauth/src/connections.ts`: a
 * built-in registry keyed by `kind` (which defaults to the config key), plus a
 * `createProvider` escape hatch, plus an "unknown kind" error that lists what
 * IS available. Same problem, same solved shape.
 */
import { AiConfigError } from '../errors';
import type { AiProviderConfig, ProviderFactory } from '../config';
import type { AiLogger, AiProvider } from './types';

/**
 * Built-in adapters, keyed by `kind`.
 *
 * Registered lazily by the adapter modules (F3) so that importing the package
 * never pulls in `@anthropic-ai/sdk` — it is an OPTIONAL peer, and an app that
 * only uses a local model must not be forced to install it.
 */
const BUILTIN_PROVIDERS = new Map<string, ProviderFactory>();

/** Register a built-in adapter. Called by the adapter modules at import time. */
export function registerBuiltinProvider(kind: string, factory: ProviderFactory): void {
  BUILTIN_PROVIDERS.set(kind, factory);
}

/** The kinds currently registered. Used in error messages and by tests. */
export function builtinProviderKinds(): readonly string[] {
  return [...BUILTIN_PROVIDERS.keys()].sort();
}

export interface BuildProviderDeps {
  readonly apiKey: string | null;
  readonly logger: AiLogger;
}

/**
 * Resolve one configured provider into a live `AiProvider`.
 *
 * Resolution order, most-specific first:
 *   1. `provider` — a ready-made instance (DI; how tests inject the fake).
 *   2. `createProvider` — a custom factory (the escape hatch).
 *   3. `kind` in the built-in registry (kind defaults to the config key, so
 *      `providers: { anthropic: {...} }` needs no explicit `kind`).
 */
export async function buildProvider(
  name: string,
  config: AiProviderConfig,
  deps: BuildProviderDeps,
): Promise<AiProvider> {
  if (config.provider) return config.provider;
  if (config.createProvider) return config.createProvider(name, config, deps);

  const kind = config.kind ?? name;
  const factory = BUILTIN_PROVIDERS.get(kind);
  if (!factory) {
    const known = builtinProviderKinds();
    const available = known.length > 0 ? known.join(', ') : '(none registered)';
    throw new AiConfigError(
      `Unknown provider kind '${kind}' for provider '${name}'. ` +
        `Built-in kinds: ${available}. ` +
        `Pass \`createProvider\` to supply a custom adapter, or \`provider\` to inject one directly.`,
    );
  }
  return factory(name, config, deps);
}
