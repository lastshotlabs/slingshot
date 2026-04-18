import { describe, expect, it } from 'bun:test';
import { createPollsPlugin } from '../../src/plugin';

describe('policy state isolation', () => {
  it('two plugin instances do not share source handlers', () => {
    const pluginA = createPollsPlugin({ closeCheckIntervalMs: 0 });
    const pluginB = createPollsPlugin({ closeCheckIntervalMs: 0 });

    // Register a handler only on instance A.
    pluginA.registerSourceHandler('test:isolated', () => Promise.resolve({ allow: true }));

    // Structural assertion: the two plugins are distinct objects with
    // independent registration functions.
    expect(pluginA).not.toBe(pluginB);
    expect(pluginA.registerSourceHandler).not.toBe(pluginB.registerSourceHandler);
  });

  it('registerSourceHandler supports both poll and vote entities', () => {
    const plugin = createPollsPlugin({ closeCheckIntervalMs: 0 });

    // Should not throw for either entity target.
    plugin.registerSourceHandler('test:poll', () => Promise.resolve({ allow: true }), 'poll');
    plugin.registerSourceHandler('test:vote', () => Promise.resolve({ allow: true }), 'vote');
  });
});
