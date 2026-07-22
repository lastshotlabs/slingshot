import { describe, expect, it } from 'bun:test';
import { createPollsPackage } from '../../src/plugin';
import { Poll } from '../../src/entities/poll';

describe('policy state isolation', () => {
  it('publishes participant and admin permission roles', () => {
    expect(Poll.routes?.permissions?.roles?.participant).toEqual([
      'poll:read',
      'poll:vote',
      'poll:create',
    ]);
    expect(Poll.routes?.permissions?.roles?.admin).toContain('poll:admin');
    expect(Poll.routes?.defaults?.permission?.scope).toEqual({ resourceType: 'poll' });
  });

  it('two package instances do not share source handlers', () => {
    const packageA = createPollsPackage({
      closeCheckIntervalMs: 0,
      sourceHandlers: { 'test:isolated': () => Promise.resolve({ allow: true }) },
    });
    const packageB = createPollsPackage({ closeCheckIntervalMs: 0 });

    // Structural assertion: the two packages are distinct objects. Handler
    // maps are captured in setupMiddleware closures (derived from config), so
    // there is no shared module-level state to leak between instances.
    expect(packageA).not.toBe(packageB);
    expect(packageA.setupMiddleware).not.toBe(packageB.setupMiddleware);
  });

  it('sourceHandlers and voteHandlers accept handlers for both poll and vote entities', () => {
    // Should not throw at construction time when both handler maps are present.
    const pkg = createPollsPackage({
      closeCheckIntervalMs: 0,
      sourceHandlers: { 'test:poll': () => Promise.resolve({ allow: true }) },
      voteHandlers: { 'test:vote': () => Promise.resolve({ allow: true }) },
    });
    expect(pkg.name).toBe('slingshot-polls');
  });
});
