import { describe, expect, test } from 'bun:test';
import { createPresignedUrl, verifyPresignedUrl } from '../../src/lib/signing';

const SECRET = 'a-valid-secret-key-that-is-long-enough-xx';
const BASE = 'https://api.example.com/uploads/presign';
const KEY = 'uploads/2024/photo.jpg';
const EXPIRY = 3600; // 1 hour from now

describe('presigned URL — extra param signing', () => {
  test('round-trip: createPresignedUrl + verifyPresignedUrl with extra params succeeds', () => {
    const url = createPresignedUrl(
      BASE,
      KEY,
      { method: 'GET', expiry: EXPIRY, extra: { bucket: 'my-bucket', region: 'us-east-1' } },
      SECRET,
    );
    const result = verifyPresignedUrl(url, 'GET', SECRET);
    expect(result).not.toBeNull();
    expect(result!.key).toBe(KEY);
    expect(result!.extra).toEqual({ bucket: 'my-bucket', region: 'us-east-1' });
  });

  test('round-trip: no extra params still works (regression)', () => {
    const url = createPresignedUrl(BASE, KEY, { method: 'GET', expiry: EXPIRY }, SECRET);
    const result = verifyPresignedUrl(url, 'GET', SECRET);
    expect(result).not.toBeNull();
    expect(result!.key).toBe(KEY);
    expect(result!.extra).toBeUndefined();
  });

  test('tampered param value → verification fails', () => {
    const url = createPresignedUrl(
      BASE,
      KEY,
      { method: 'GET', expiry: EXPIRY, extra: { bucket: 'my-bucket' } },
      SECRET,
    );
    // Modify the bucket param value in the URL
    const tampered = url.replace('bucket=my-bucket', 'bucket=evil-bucket');
    const result = verifyPresignedUrl(tampered, 'GET', SECRET);
    expect(result).toBeNull();
  });

  test('added extra param → verification fails', () => {
    const url = createPresignedUrl(
      BASE,
      KEY,
      { method: 'GET', expiry: EXPIRY, extra: { bucket: 'my-bucket' } },
      SECRET,
    );
    // Inject an additional param that was not signed
    const tampered = url + '&injected=evil';
    const result = verifyPresignedUrl(tampered, 'GET', SECRET);
    expect(result).toBeNull();
  });

  test('removed extra param → verification fails', () => {
    const url = createPresignedUrl(
      BASE,
      KEY,
      { method: 'GET', expiry: EXPIRY, extra: { bucket: 'my-bucket', region: 'us-east-1' } },
      SECRET,
    );
    // Remove one of the signed params from the URL
    const parsed = new URL(url);
    parsed.searchParams.delete('region');
    const tampered = parsed.toString();
    const result = verifyPresignedUrl(tampered, 'GET', SECRET);
    expect(result).toBeNull();
  });

  test('URL signed with extra params fails when verified against URL without them', () => {
    // Signed with params
    const url = createPresignedUrl(
      BASE,
      KEY,
      { method: 'GET', expiry: EXPIRY, extra: { bucket: 'my-bucket' } },
      SECRET,
    );
    // Strip all extra params, leaving only the reserved ones
    const parsed = new URL(url);
    parsed.searchParams.delete('bucket');
    const stripped = parsed.toString();
    const result = verifyPresignedUrl(stripped, 'GET', SECRET);
    expect(result).toBeNull();
  });

  test('param key name tampered → verification fails', () => {
    const url = createPresignedUrl(
      BASE,
      KEY,
      { method: 'GET', expiry: EXPIRY, extra: { bucket: 'my-bucket' } },
      SECRET,
    );
    // Rename "bucket" to "Bucket" (different key)
    const tampered = url.replace('bucket=my-bucket', 'Bucket=my-bucket');
    const result = verifyPresignedUrl(tampered, 'GET', SECRET);
    expect(result).toBeNull();
  });
});
