import { describe, expect, test } from 'bun:test';
import { createDefaultFingerprintBuilder } from '../../src/defaults/defaultFingerprint';

describe('createDefaultFingerprintBuilder', () => {
  test('returns an object with a buildFingerprint method', () => {
    const builder = createDefaultFingerprintBuilder();
    expect(typeof builder.buildFingerprint).toBe('function');
  });

  test('produces a 12-character hex string from request headers', async () => {
    const builder = createDefaultFingerprintBuilder();
    const req = new Request('http://localhost/', {
      headers: {
        'user-agent': 'Mozilla/5.0',
        'accept-language': 'en-US',
        'accept-encoding': 'gzip, deflate',
      },
    });
    const fp = await builder.buildFingerprint(req);
    expect(fp).toMatch(/^[0-9a-f]{12}$/);
  });

  test('same headers produce the same fingerprint', async () => {
    const builder = createDefaultFingerprintBuilder();
    const headers = {
      'user-agent': 'TestAgent/1.0',
      'accept-language': 'en-GB',
      'accept-encoding': 'br',
    };
    const req1 = new Request('http://localhost/', { headers });
    const req2 = new Request('http://localhost/', { headers });

    const fp1 = await builder.buildFingerprint(req1);
    const fp2 = await builder.buildFingerprint(req2);
    expect(fp1).toBe(fp2);
  });

  test('different headers produce different fingerprints', async () => {
    const builder = createDefaultFingerprintBuilder();
    const req1 = new Request('http://localhost/', {
      headers: { 'user-agent': 'AgentA' },
    });
    const req2 = new Request('http://localhost/', {
      headers: { 'user-agent': 'AgentB' },
    });

    const fp1 = await builder.buildFingerprint(req1);
    const fp2 = await builder.buildFingerprint(req2);
    expect(fp1).not.toBe(fp2);
  });

  test('missing headers default to empty string and still produce a fingerprint', async () => {
    const builder = createDefaultFingerprintBuilder();
    const req = new Request('http://localhost/');
    // No headers set at all — all three header reads return ''
    const fp = await builder.buildFingerprint(req);
    expect(fp).toMatch(/^[0-9a-f]{12}$/);
  });

  test('partially missing headers still produce a valid fingerprint', async () => {
    const builder = createDefaultFingerprintBuilder();
    const req = new Request('http://localhost/', {
      headers: { 'user-agent': 'SomeAgent' },
      // accept-language and accept-encoding absent
    });
    const fp = await builder.buildFingerprint(req);
    expect(fp).toMatch(/^[0-9a-f]{12}$/);
  });

  test('fingerprint uses only user-agent, accept-language, accept-encoding', async () => {
    const builder = createDefaultFingerprintBuilder();
    const base = {
      'user-agent': 'UA',
      'accept-language': 'en',
      'accept-encoding': 'gzip',
    };
    const req1 = new Request('http://localhost/a', { headers: base });
    const req2 = new Request('http://localhost/b', {
      headers: { ...base, 'x-custom': 'extra', authorization: 'Bearer token' },
    });

    const fp1 = await builder.buildFingerprint(req1);
    const fp2 = await builder.buildFingerprint(req2);
    // Extra headers should not affect the fingerprint
    expect(fp1).toBe(fp2);
  });

  test('two separate builder instances produce the same fingerprint for the same input', async () => {
    const builder1 = createDefaultFingerprintBuilder();
    const builder2 = createDefaultFingerprintBuilder();
    const headers = { 'user-agent': 'Test', 'accept-language': 'fr', 'accept-encoding': 'br' };
    const req1 = new Request('http://localhost/', { headers });
    const req2 = new Request('http://localhost/', { headers });

    const fp1 = await builder1.buildFingerprint(req1);
    const fp2 = await builder2.buildFingerprint(req2);
    expect(fp1).toBe(fp2);
  });
});
