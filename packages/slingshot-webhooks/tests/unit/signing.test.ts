import { describe, expect, it } from 'bun:test';
import { signPayload, verifySignature } from '../../src/lib/signing';

describe('signing', () => {
  const secret = 'test-secret-key';
  const body = '{"event":"test","data":{"id":"123"}}';

  it('produces header with t= and v1= fields', async () => {
    const header = await signPayload(secret, body);
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
  });

  it('verifies a valid signature', async () => {
    const header = await signPayload(secret, body);
    expect(await verifySignature(secret, body, header)).toBe(true);
  });

  it('rejects expired timestamp (600s ago)', async () => {
    const oldTs = Math.floor(Date.now() / 1000) - 600;
    const header = await signPayload(secret, body, oldTs);
    expect(await verifySignature(secret, body, header)).toBe(false);
  });

  it('accepts timestamp within tolerance (200s ago)', async () => {
    const recentTs = Math.floor(Date.now() / 1000) - 200;
    const header = await signPayload(secret, body, recentTs);
    expect(await verifySignature(secret, body, header)).toBe(true);
  });

  it('rejects wrong secret', async () => {
    const header = await signPayload(secret, body);
    expect(await verifySignature('wrong-secret', body, header)).toBe(false);
  });

  it('rejects malformed header (missing v1)', async () => {
    const ts = Math.floor(Date.now() / 1000);
    expect(await verifySignature(secret, body, `t=${ts}`)).toBe(false);
  });

  it('rejects malformed header (garbage)', async () => {
    expect(await verifySignature(secret, body, 'not-a-valid-header')).toBe(false);
  });

  it('rejects malformed header (odd-length hex) without throwing', async () => {
    const ts = Math.floor(Date.now() / 1000);
    await expect(verifySignature(secret, body, `t=${ts},v1=a`)).resolves.toBe(false);
  });
});
