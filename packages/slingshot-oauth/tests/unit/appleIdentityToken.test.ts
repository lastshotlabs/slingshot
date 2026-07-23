import { beforeAll, describe, expect, test } from 'bun:test';
import { SignJWT, generateKeyPair } from 'jose';
import type { CryptoKey } from 'jose';
import { verifyAppleIdentityToken } from '../../src/lib/appleIdentityToken';

const clientId = 'com.example.web';
const nonce = 'server-generated-nonce';
let privateKey: CryptoKey;
let publicKey: CryptoKey;

beforeAll(async () => {
  const keys = await generateKeyPair('RS256');
  privateKey = keys.privateKey;
  publicKey = keys.publicKey;
});

async function appleToken(overrides: Record<string, unknown> = {}) {
  return new SignJWT({ nonce, email: 'user@example.com', ...overrides })
    .setProtectedHeader({ alg: 'RS256', kid: 'apple-test-key' })
    .setIssuer('https://appleid.apple.com')
    .setAudience(clientId)
    .setSubject('apple-user-123')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

describe('verifyAppleIdentityToken', () => {
  test('accepts a signed token with the expected issuer, audience, and nonce', async () => {
    const claims = await verifyAppleIdentityToken(await appleToken(), clientId, nonce, publicKey);

    expect(claims.sub).toBe('apple-user-123');
    expect(claims.email).toBe('user@example.com');
  });

  test('rejects a token issued for another Apple client', async () => {
    await expect(
      verifyAppleIdentityToken(await appleToken(), 'com.attacker.app', nonce, publicKey),
    ).rejects.toThrow();
  });

  test('rejects a replay with the wrong nonce', async () => {
    await expect(
      verifyAppleIdentityToken(await appleToken(), clientId, 'different-nonce', publicKey),
    ).rejects.toThrow('Invalid Apple identity token claims');
  });

  test('rejects a token signed by an untrusted key', async () => {
    const attacker = await generateKeyPair('RS256');
    const forged = await new SignJWT({ nonce })
      .setProtectedHeader({ alg: 'RS256', kid: 'attacker-key' })
      .setIssuer('https://appleid.apple.com')
      .setAudience(clientId)
      .setSubject('victim-apple-id')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(attacker.privateKey);

    await expect(verifyAppleIdentityToken(forged, clientId, nonce, publicKey)).rejects.toThrow();
  });
});
