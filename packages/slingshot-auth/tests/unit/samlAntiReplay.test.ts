import { describe, expect, test } from 'bun:test';
import { createMemorySamlRequestIdRepository } from '../../src/lib/samlRequestId';
import { consumeSamlRequestId, storeSamlRequestId } from '../../src/lib/samlRequestId';

describe('SAML anti-replay (request ID store)', () => {
  test('a stored request ID can be consumed exactly once', async () => {
    const repo = createMemorySamlRequestIdRepository();
    await storeSamlRequestId(repo, 'req-id-abc');

    const first = await consumeSamlRequestId(repo, 'req-id-abc');
    expect(first).toBe(true);
  });

  test('second consumption of the same request ID is rejected (replay blocked)', async () => {
    const repo = createMemorySamlRequestIdRepository();
    await storeSamlRequestId(repo, 'req-id-xyz');

    await consumeSamlRequestId(repo, 'req-id-xyz'); // first use
    const second = await consumeSamlRequestId(repo, 'req-id-xyz'); // replay attempt
    expect(second).toBe(false);
  });

  test('an unknown request ID returns false without side effects', async () => {
    const repo = createMemorySamlRequestIdRepository();
    const result = await consumeSamlRequestId(repo, 'never-stored-id');
    expect(result).toBe(false);
  });
});
