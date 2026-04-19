import {
  type CredentialStuffingService,
  createCredentialStuffingService,
  createMemoryCredentialStuffingRepository,
} from '@auth/lib/credentialStuffing';
import { describe, expect, test } from 'bun:test';

let svc: CredentialStuffingService;

describe('credential stuffing — isStuffingBlocked', () => {
  test('not blocked below threshold', async () => {
    svc = createCredentialStuffingService(
      { maxAccountsPerIp: { count: 3, windowMs: 60000 } },
      createMemoryCredentialStuffingRepository(),
    );
    await svc.trackFailedLogin('1.2.3.4', 'user1@example.com');
    await svc.trackFailedLogin('1.2.3.4', 'user2@example.com');
    expect(await svc.isStuffingBlocked('1.2.3.4', 'user3@example.com')).toBe(false);
  });

  test('blocked when accounts-per-IP exceeds threshold', async () => {
    svc = createCredentialStuffingService(
      { maxAccountsPerIp: { count: 3, windowMs: 60000 } },
      createMemoryCredentialStuffingRepository(),
    );
    await svc.trackFailedLogin('1.2.3.4', 'user1@example.com');
    await svc.trackFailedLogin('1.2.3.4', 'user2@example.com');
    await svc.trackFailedLogin('1.2.3.4', 'user3@example.com');
    expect(await svc.isStuffingBlocked('1.2.3.4', 'user4@example.com')).toBe(true);
  });

  test('blocked when IPs-per-account exceeds threshold', async () => {
    svc = createCredentialStuffingService(
      { maxIpsPerAccount: { count: 3, windowMs: 60000 } },
      createMemoryCredentialStuffingRepository(),
    );
    await svc.trackFailedLogin('1.1.1.1', 'target@example.com');
    await svc.trackFailedLogin('2.2.2.2', 'target@example.com');
    await svc.trackFailedLogin('3.3.3.3', 'target@example.com');
    expect(await svc.isStuffingBlocked('4.4.4.4', 'target@example.com')).toBe(true);
  });

  test("repeated same IP+account doesn't inflate set size", async () => {
    svc = createCredentialStuffingService(
      { maxAccountsPerIp: { count: 3, windowMs: 60000 } },
      createMemoryCredentialStuffingRepository(),
    );
    await svc.trackFailedLogin('1.2.3.4', 'user1@example.com');
    await svc.trackFailedLogin('1.2.3.4', 'user1@example.com');
    await svc.trackFailedLogin('1.2.3.4', 'user1@example.com');
    // Still only 1 unique account, threshold is 3
    expect(await svc.isStuffingBlocked('1.2.3.4', 'user2@example.com')).toBe(false);
  });

  test('onDetected callback is called when blocked', async () => {
    const detected: any[] = [];
    svc = createCredentialStuffingService(
      {
        maxAccountsPerIp: { count: 2, windowMs: 60000 },
        onDetected: signal => {
          detected.push(signal);
        },
      },
      createMemoryCredentialStuffingRepository(),
    );
    await svc.trackFailedLogin('1.2.3.4', 'user1@example.com');
    await svc.trackFailedLogin('1.2.3.4', 'user2@example.com');
    await svc.isStuffingBlocked('1.2.3.4', 'user3@example.com');
    expect(detected.length).toBe(1);
    expect(detected[0].type).toBe('ip');
  });
});
