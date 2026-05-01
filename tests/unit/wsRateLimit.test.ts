import { beforeEach, describe, expect, it } from 'bun:test';
import type { WsState } from '@lastshotlabs/slingshot-core';
import { checkRateLimit, cleanupRateLimitBucket } from '../../src/framework/ws/rateLimit';

function createWsState(): WsState {
  return {
    server: null,
    transport: null,
    instanceId: 'test-instance',
    presenceEnabled: false,
    roomRegistry: new Map(),
    heartbeatSockets: new Map(),
    heartbeatEndpointConfigs: new Map(),
    heartbeatTimer: null,
    socketUsers: new Map(),
    roomPresence: new Map(),
    socketRegistry: new Map(),
    rateLimitState: new Map(),
    sessionRegistry: new Map(),
    lastEventIds: new Map(),
  };
}

describe('wsRateLimit — checkRateLimit', () => {
  let state: WsState;

  beforeEach(() => {
    state = createWsState();
  });

  it('first message returns allow', () => {
    const result = checkRateLimit(state, '/ws', 's1', {
      windowMs: 1000,
      maxMessages: 5,
    });
    expect(result).toBe('allow');
  });

  it('up to maxMessages — all return allow', () => {
    const config = { windowMs: 1000, maxMessages: 3 };
    expect(checkRateLimit(state, '/ws', 's1', config)).toBe('allow');
    expect(checkRateLimit(state, '/ws', 's1', config)).toBe('allow');
    expect(checkRateLimit(state, '/ws', 's1', config)).toBe('allow');
  });

  it('maxMessages + 1 returns drop (default)', () => {
    const config = { windowMs: 1000, maxMessages: 2 };
    checkRateLimit(state, '/ws', 's1', config); // 1
    checkRateLimit(state, '/ws', 's1', config); // 2
    const result = checkRateLimit(state, '/ws', 's1', config); // 3 = over limit
    expect(result).toBe('drop');
  });

  it('onExceeded: close — returns close', () => {
    const config = { windowMs: 1000, maxMessages: 1, onExceeded: 'close' as const };
    checkRateLimit(state, '/ws', 's1', config); // 1
    const result = checkRateLimit(state, '/ws', 's1', config); // 2 = over limit
    expect(result).toBe('close');
  });

  it('window expiry — after windowMs, count resets', () => {
    const config = { windowMs: 100, maxMessages: 1 };
    checkRateLimit(state, '/ws', 's1', config); // 1

    // Manually expire the window
    const bucket = state.rateLimitState.get('/ws')!.get('s1')!;
    bucket.windowStart = Date.now() - 200; // expired

    const result = checkRateLimit(state, '/ws', 's1', config);
    expect(result).toBe('allow'); // new window
  });

  it('per-endpoint isolation — endpoint A over limit, endpoint B still allow', () => {
    const config = { windowMs: 1000, maxMessages: 1 };
    checkRateLimit(state, '/a', 's1', config);
    checkRateLimit(state, '/a', 's1', config); // over limit on /a

    const result = checkRateLimit(state, '/b', 's1', config);
    expect(result).toBe('allow'); // /b unaffected
  });

  it('cleanupRateLimitBucket — bucket removed, subsequent call starts fresh', () => {
    const config = { windowMs: 1000, maxMessages: 1 };
    checkRateLimit(state, '/ws', 's1', config); // 1
    expect(checkRateLimit(state, '/ws', 's1', config)).toBe('drop'); // over

    cleanupRateLimitBucket(state, '/ws', 's1');

    // After cleanup, starts fresh
    expect(checkRateLimit(state, '/ws', 's1', config)).toBe('allow');
  });

  it('zero windowMs — always allows (guard clause)', () => {
    const config = { windowMs: 0, maxMessages: 5 };
    for (let i = 0; i < 20; i++) {
      expect(checkRateLimit(state, '/ws', 's1', config)).toBe('allow');
    }
  });

  it('negative windowMs — always allows (guard clause)', () => {
    const config = { windowMs: -100, maxMessages: 5 };
    for (let i = 0; i < 20; i++) {
      expect(checkRateLimit(state, '/ws', 's1', config)).toBe('allow');
    }
  });

  it('zero maxMessages — always allows (guard clause)', () => {
    const config = { windowMs: 1000, maxMessages: 0 };
    for (let i = 0; i < 20; i++) {
      expect(checkRateLimit(state, '/ws', 's1', config)).toBe('allow');
    }
  });

  it('cleanupRateLimitBucket on non-existent bucket — no error', () => {
    expect(() => cleanupRateLimitBucket(state, '/ws', 'nonexistent')).not.toThrow();
  });
});
