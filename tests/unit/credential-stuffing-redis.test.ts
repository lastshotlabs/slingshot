import {
  type CredentialStuffingService,
  createCredentialStuffingService,
  createMemoryCredentialStuffingRepository,
  createRedisCredentialStuffingRepository,
} from '@auth/lib/credentialStuffing';
import { describe, expect, mock, test } from 'bun:test';

// ---------------------------------------------------------------------------
// Memory store tests
// ---------------------------------------------------------------------------

describe('credential stuffing — memory store', () => {
  let svc: CredentialStuffingService;

  test('tracks distinct accounts per IP and blocks at threshold', async () => {
    const repo = createMemoryCredentialStuffingRepository();
    svc = createCredentialStuffingService(
      { maxAccountsPerIp: { count: 3, windowMs: 60_000 } },
      repo,
    );
    await svc.trackFailedLogin('10.0.0.1', 'a@x.com');
    await svc.trackFailedLogin('10.0.0.1', 'b@x.com');
    // 2 distinct accounts — not yet blocked
    expect(await svc.isStuffingBlocked('10.0.0.1', 'c@x.com')).toBe(false);
    await svc.trackFailedLogin('10.0.0.1', 'c@x.com');
    // 3 distinct accounts — blocked
    expect(await svc.isStuffingBlocked('10.0.0.1', 'd@x.com')).toBe(true);
  });

  test('tracks distinct IPs per account and blocks at threshold', async () => {
    const repo = createMemoryCredentialStuffingRepository();
    svc = createCredentialStuffingService(
      { maxIpsPerAccount: { count: 2, windowMs: 60_000 } },
      repo,
    );
    await svc.trackFailedLogin('1.1.1.1', 'victim@x.com');
    await svc.trackFailedLogin('2.2.2.2', 'victim@x.com');
    // 2 distinct IPs — now blocked
    expect(await svc.isStuffingBlocked('3.3.3.3', 'victim@x.com')).toBe(true);
  });

  test('repeated same IP+account is deduplicated', async () => {
    const repo = createMemoryCredentialStuffingRepository();
    svc = createCredentialStuffingService(
      { maxAccountsPerIp: { count: 3, windowMs: 60_000 } },
      repo,
    );
    await svc.trackFailedLogin('1.2.3.4', 'only@x.com');
    await svc.trackFailedLogin('1.2.3.4', 'only@x.com');
    await svc.trackFailedLogin('1.2.3.4', 'only@x.com');
    // only 1 unique account — not blocked (threshold is 3)
    expect(await svc.isStuffingBlocked('1.2.3.4', 'other@x.com')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Redis store path — verify Lua scripts are called with correct keys/args
// ---------------------------------------------------------------------------

describe('credential stuffing — redis store', () => {
  const makeRedis = (evalReturn: number = 0) => {
    const evalCalls: Array<{ script: string; numKeys: number; args: unknown[] }> = [];
    const evalFn = mock(async (script: string, numKeys: number, ...args: unknown[]) => {
      evalCalls.push({ script, numKeys, args });
      return evalReturn;
    });
    return { eval: evalFn, evalCalls };
  };

  function createRedisService(
    config: Parameters<typeof createCredentialStuffingService>[0],
    redis: ReturnType<typeof makeRedis>,
  ) {
    const repo = createRedisCredentialStuffingRepository(() => redis as any, 'test');
    return createCredentialStuffingService(config, repo);
  }

  test('trackFailedLogin calls eval with Lua script for both ip and account keys', async () => {
    const redis = makeRedis();
    const svc = createRedisService({ maxAccountsPerIp: { count: 5, windowMs: 60_000 } }, redis);

    await svc.trackFailedLogin('9.9.9.9', 'user@example.com');

    // Should call eval twice — once for ip key, once for account key
    expect(redis.eval).toHaveBeenCalledTimes(2);

    // Both calls should use 1 key (numKeys = 1)
    expect(redis.evalCalls.every(c => c.numKeys === 1)).toBe(true);

    // First arg of each call is the key — should include ip: and account: prefixes
    const keys = redis.evalCalls.map(c => c.args[0] as string);
    expect(keys.some(k => k.includes('ip:'))).toBe(true);
    expect(keys.some(k => k.includes('account:'))).toBe(true);

    // Each call should pass member, now, windowStart, windowMs as ARGV
    for (const call of redis.evalCalls) {
      // args = [key, member, now, windowStart, windowMs]
      expect(call.args.length).toBe(5);
    }
  });

  test('isStuffingBlocked calls eval with Lua script', async () => {
    const redis = makeRedis();
    const svc = createRedisService({ maxAccountsPerIp: { count: 5, windowMs: 60_000 } }, redis);

    await svc.isStuffingBlocked('9.9.9.9', 'user@example.com');

    // Should call eval for ip key and account key
    expect(redis.eval).toHaveBeenCalled();

    // Each isStuffingBlocked eval call should pass key and windowStart as args
    for (const call of redis.evalCalls) {
      // args = [key, windowStart]
      expect(call.args.length).toBe(2);
    }
  });

  test('isStuffingBlocked returns false when eval returns count below threshold', async () => {
    const redis = makeRedis(0);
    const svc = createRedisService({ maxAccountsPerIp: { count: 5, windowMs: 60_000 } }, redis);

    expect(await svc.isStuffingBlocked('1.1.1.1', 'u@x.com')).toBe(false);
  });

  test('isStuffingBlocked returns true when eval returns count at threshold', async () => {
    const redis = makeRedis(5);
    const svc = createRedisService({ maxAccountsPerIp: { count: 5, windowMs: 60_000 } }, redis);

    expect(await svc.isStuffingBlocked('1.1.1.1', 'u@x.com')).toBe(true);
  });

  test('keys are namespaced with credstuffing: prefix', async () => {
    const redis = makeRedis();
    const svc = createRedisService({ maxAccountsPerIp: { count: 5, windowMs: 60_000 } }, redis);

    await svc.trackFailedLogin('1.2.3.4', 'user@example.com');

    const keys = redis.evalCalls.map(c => c.args[0] as string);
    expect(keys.every(k => k.startsWith('credstuffing:'))).toBe(true);
  });
});
