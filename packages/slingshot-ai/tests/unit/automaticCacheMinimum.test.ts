/**
 * "Automatic" caching is not unconditional caching.
 *
 * `renderSystem` used to skip the minimum-length guard for `promptCaching:
 * 'automatic'`, on the reasoning — written in the code — that "the provider caches
 * on its own. Nothing to emit, nothing to degrade." Only the first half is true.
 * An automatic provider takes no breakpoint from us, so nothing can be REJECTED;
 * below its minimum it simply never caches, forever, silently.
 *
 * Measured on gpt-5.4-mini, identical prefix, `cached_tokens` on the second call:
 *
 *     1,217 -> 0        1,457 -> 1,280
 *     1,337 -> 0        2,417 -> 2,304
 *
 * OpenAI documents 1,024. The real cliff is above 1,337. hotseat's moderation
 * prefix (~1,213 tokens) sat under it and cached 0% of every call it ever made.
 *
 * There is no breakpoint to withhold, so the DEGRADATION is the entire mechanism —
 * it is the only thing standing between an app and a permanent, unannounced full
 * price. That makes this the load-bearing test for invariant #3 (nothing degrades
 * silently) on the whole automatic-caching family.
 */
import { describe, expect, test } from 'bun:test';
import { PromptCacheMonitor, renderSystem } from '../../src/lib/systemPrompt';
import { CONSERVATIVE_CAPABILITIES } from '../../src/provider/capabilities';
import type { AiLogger, ProviderCapabilities } from '../../src/provider/types';

const silent: AiLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/** OpenAI's shape: caches by itself, but only above a real floor. */
const AUTOMATIC: ProviderCapabilities = {
  ...CONSERVATIVE_CAPABILITIES,
  promptCaching: 'automatic',
  promptCacheMinTokens: 1536,
};

/** ~4 chars per token, per the package's own estimator. */
const prefixOf = (tokens: number) => 'x'.repeat(tokens * 4);

function render(tokens: number, capabilities = AUTOMATIC) {
  return renderSystem({
    system: { stable: [{ id: 'contract', text: prefixOf(tokens) }] },
    capabilities,
    promptCacheEnabled: true,
    monitor: new PromptCacheMonitor(silent, true, 3),
  });
}

describe('automatic caching still has a minimum', () => {
  test('a prefix below the floor degrades LOUDLY instead of silently never caching', () => {
    // ~1,213 tokens: hotseat's real moderation prompt.
    const { degradations } = render(1213);

    const cache = degradations.find(d => d.feature === 'promptCaching');
    expect(cache).toBeDefined();
    expect(cache?.applied).toBe('none');
    // The app must be able to ACT on this, so the message has to name the gap.
    expect(cache?.reason).toContain('1536');
  });

  test('a prefix above the floor degrades nothing', () => {
    const { degradations } = render(4955); // hotseat's card contract
    expect(degradations.filter(d => d.feature === 'promptCaching')).toHaveLength(0);
  });

  test('an automatic provider still emits NO breakpoint — it places its own', () => {
    // The degradation must not be "fixed" by emitting a breakpoint an automatic
    // provider never asked for. Both sides of the floor: no breakpoint, ever.
    expect(render(1213).breakpointEmitted).toBe(false);
    expect(render(4955).breakpointEmitted).toBe(false);
  });

  test('a provider that declares no minimum is not second-guessed', () => {
    // xAI caches from ~128 tokens and declares no floor. Inventing one for it
    // would emit a degradation that is simply false.
    const noFloor: ProviderCapabilities = { ...AUTOMATIC, promptCacheMinTokens: undefined };
    expect(render(200, noFloor).degradations).toHaveLength(0);
  });
});
