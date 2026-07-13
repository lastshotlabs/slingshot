/**
 * Capability descriptors: defaults, merging, and consistency checks.
 */
import { AiConfigError } from '../errors';
import type { ProviderCapabilities } from './types';

/**
 * The conservative baseline.
 *
 * Every field assumes the LEAST capable plausible backend. An adapter that
 * forgets to declare something therefore gets degraded-but-correct behavior
 * rather than silently-wrong behavior. That asymmetry is on purpose: the cost
 * of under-declaring is a JSON repair loop; the cost of over-declaring is a
 * card that never validates and a party that stops.
 */
export const CONSERVATIVE_CAPABILITIES: ProviderCapabilities = Object.freeze({
  structuredOutput: 'none',
  promptCaching: 'none',
  streaming: false,
  thinking: 'none',
  effort: false,
  usageAccounting: 'none',
  costAccounting: false,
  refusalSignal: false,
  toolUse: false,
  maxOutputTokens: 4096,
});

/** Merge an adapter's declared capabilities with any config-level overrides. */
export function resolveCapabilities(
  base: ProviderCapabilities,
  overrides?: Partial<ProviderCapabilities>,
): ProviderCapabilities {
  const merged: ProviderCapabilities = { ...base, ...(overrides ?? {}) };
  assertCapabilitiesConsistent(merged, 'resolved');
  return Object.freeze(merged);
}

/**
 * Reject internally-incoherent descriptors at construction time.
 *
 * The important one: `promptCaching: 'explicit'` without `promptCacheMinTokens`
 * is a trap, because the orchestrator would have no threshold below which to
 * refuse a breakpoint — and a below-minimum breakpoint is accepted by the API
 * and then silently does nothing.
 */
export function assertCapabilitiesConsistent(caps: ProviderCapabilities, who: string): void {
  if (caps.promptCaching === 'explicit' && !caps.promptCacheMinTokens) {
    throw new AiConfigError(
      `[${who}] capabilities declare promptCaching: 'explicit' but omit promptCacheMinTokens. ` +
        `An explicit cache breakpoint below the provider minimum is accepted by the API and then ` +
        `silently does nothing — the threshold is required so the orchestrator can refuse to emit one.`,
    );
  }
  if (caps.maxOutputTokens <= 0) {
    throw new AiConfigError(`[${who}] capabilities declare a non-positive maxOutputTokens.`);
  }
}
