/**
 * The three prompt-cache detectors.
 *
 * Prompt caching fails SILENTLY in every direction, which is what makes it
 * dangerous: the API accepts a breakpoint below the minimum length and simply
 * doesn't cache; a one-byte change to the stable prefix invalidates everything
 * after it and still returns a perfectly good answer. You do not find out from
 * an error. You find out from the bill.
 *
 * Hence: detect, and say so out loud.
 */
import { describe, expect, test } from 'bun:test';
import { PromptCacheMonitor, renderSystem } from '../../src/lib/systemPrompt';
import { CONSERVATIVE_CAPABILITIES } from '../../src/provider/capabilities';
import type { AiLogger, ProviderCapabilities } from '../../src/provider/types';

const cachingCaps: ProviderCapabilities = {
  ...CONSERVATIVE_CAPABILITIES,
  promptCaching: 'explicit',
  promptCacheMinTokens: 1024,
};

function collectWarnings(): { logger: AiLogger; warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    logger: {
      debug: () => {},
      info: () => {},
      warn: (message: string) => {
        warnings.push(message);
      },
      error: () => {},
    },
  };
}

const longText = 'word '.repeat(2000); // ≈ 2500 tokens — comfortably over 1024.

describe('detector 1: the minimum cacheable prefix', () => {
  test('emits a breakpoint when the stable prefix is long enough', () => {
    const rendered = renderSystem({
      system: { stable: [{ id: 'rules', text: longText }] },
      capabilities: cachingCaps,
      promptCacheEnabled: true,
    });

    expect(rendered.breakpointEmitted).toBe(true);
    expect(rendered.blocks.some(block => block.cache)).toBe(true);
    expect(rendered.degradations).toEqual([]);
  });

  test('emits NO breakpoint below the minimum, and says why', () => {
    // The trap: the API would ACCEPT this breakpoint and then silently not cache.
    // A package that just forwards it looks correct and quietly saves nothing.
    const rendered = renderSystem({
      system: { stable: [{ id: 'rules', text: 'too short to cache' }] },
      capabilities: cachingCaps,
      promptCacheEnabled: true,
    });

    expect(rendered.breakpointEmitted).toBe(false);
    expect(rendered.blocks.every(block => !block.cache)).toBe(true);

    const degradation = rendered.degradations.find(d => d.feature === 'promptCaching');
    expect(degradation).toBeDefined();
    expect(degradation?.reason).toMatch(/1024/);
  });

  test('a bare string system prompt is treated as fully volatile', () => {
    const rendered = renderSystem({
      system: longText,
      capabilities: cachingCaps,
      promptCacheEnabled: true,
    });

    expect(rendered.breakpointEmitted).toBe(false);
    expect(rendered.blocks.every(block => !block.cache)).toBe(true);
  });

  test('volatile segments always render after the breakpoint', () => {
    const rendered = renderSystem({
      system: {
        stable: [{ id: 'rules', text: longText }],
        volatile: [{ id: 'roster', text: 'Players: ana, ben' }],
      },
      capabilities: cachingCaps,
      promptCacheEnabled: true,
    });

    const cachedIndex = rendered.blocks.findIndex(block => block.cache);
    const volatileIndex = rendered.blocks.findIndex(block => block.text.includes('Players'));

    // If the volatile block landed inside the cached prefix, the cache would be
    // invalidated on every single call — the exact bug this ordering prevents.
    expect(cachedIndex).toBeGreaterThanOrEqual(0);
    expect(volatileIndex).toBeGreaterThan(cachedIndex);
  });
});

describe('detector 2: stable-prefix drift', () => {
  test('warns, naming the segment, when a "stable" segment changes between calls', () => {
    const { logger, warnings } = collectWarnings();
    const monitor = new PromptCacheMonitor(logger, true, 3);

    const render = (rules: string) =>
      renderSystem({
        system: {
          stable: [
            { id: 'rules', text: rules },
            { id: 'persona', text: longText },
          ],
        },
        capabilities: cachingCaps,
        promptCacheEnabled: true,
        promptCacheKey: 'deck-gen',
        monitor,
      });

    render(longText);
    expect(warnings).toHaveLength(0);

    // One byte changes — e.g. someone interpolated a timestamp into the rules.
    render(`${longText}.`);

    expect(warnings).toHaveLength(1);
    // Naming the culprit is the whole point: "your cache broke" is useless.
    expect(warnings[0]).toContain('rules');
  });
});

describe('detector 3: breakpoints that never hit', () => {
  test('warns after N calls that emitted a breakpoint and read nothing back', () => {
    const { logger, warnings } = collectWarnings();
    const monitor = new PromptCacheMonitor(logger, true, 3);

    for (let call = 0; call < 3; call++) {
      monitor.recordCacheRead('deck-gen', 0, true);
    }

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/cache/i);
  });

  test('stays quiet once the cache is actually being read', () => {
    const { logger, warnings } = collectWarnings();
    const monitor = new PromptCacheMonitor(logger, true, 3);

    monitor.recordCacheRead('deck-gen', 0, true);
    monitor.recordCacheRead('deck-gen', 2400, true);
    monitor.recordCacheRead('deck-gen', 2400, true);
    monitor.recordCacheRead('deck-gen', 2400, true);

    expect(warnings).toHaveLength(0);
  });

  test('says nothing when no breakpoint was emitted — there is nothing to hit', () => {
    const { logger, warnings } = collectWarnings();
    const monitor = new PromptCacheMonitor(logger, true, 3);

    for (let call = 0; call < 5; call++) {
      monitor.recordCacheRead('deck-gen', 0, false);
    }

    expect(warnings).toHaveLength(0);
  });
});
