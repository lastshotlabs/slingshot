import { describe, expect, test } from 'bun:test';
import type { SigningConfig } from '@lastshotlabs/slingshot-core';
import { createAuthResolvedConfig } from '../../src/config/authConfig';
import { signToken, validateJwtSecrets, verifyToken } from '../../src/lib/jwt';

const SECRET_A = 'test-signing-secret-32-chars-ok!';
const SECRET_B = 'new-secret-32-characters-long!!!';

const baseSigning: SigningConfig = { secret: SECRET_A };
const baseConfig = createAuthResolvedConfig({});

describe('jwt', () => {
  describe('sign and verify round-trip', () => {
    test('sign a token and verify it — payload matches', async () => {
      const token = await signToken({ sub: 'user-1' }, 300, baseConfig, baseSigning);
      const payload = await verifyToken(token, baseConfig, baseSigning);
      expect(payload.sub).toBe('user-1');
    });
  });

  describe('standard claims', () => {
    test('token contains jti claim', async () => {
      const token = await signToken({ sub: 'user-1' }, 300, baseConfig, baseSigning);
      const payload = await verifyToken(token, baseConfig, baseSigning);
      expect(payload.jti).toBeString();
      expect((payload.jti as string).length).toBeGreaterThan(0);
    });

    test('token contains nbf claim', async () => {
      const token = await signToken({ sub: 'user-1' }, 300, baseConfig, baseSigning);
      const payload = await verifyToken(token, baseConfig, baseSigning);
      expect(payload.nbf).toBeNumber();
    });

    test('token contains iat claim', async () => {
      const token = await signToken({ sub: 'user-1' }, 300, baseConfig, baseSigning);
      const payload = await verifyToken(token, baseConfig, baseSigning);
      expect(payload.iat).toBeNumber();
    });

    test('two tokens have different jti values', async () => {
      const tokenA = await signToken({ sub: 'user-1' }, 300, baseConfig, baseSigning);
      const tokenB = await signToken({ sub: 'user-1' }, 300, baseConfig, baseSigning);
      const payloadA = await verifyToken(tokenA, baseConfig, baseSigning);
      const payloadB = await verifyToken(tokenB, baseConfig, baseSigning);
      expect(payloadA.jti).not.toBe(payloadB.jti);
    });
  });

  describe('failure cases', () => {
    test('expired token fails verification', async () => {
      // Sign with 1 second expiry, then verify with 0 clock tolerance
      const config = createAuthResolvedConfig({ jwt: { clockTolerance: 0 } });
      const token = await signToken({ sub: 'user-1' }, 1, config, baseSigning);
      // Wait for the token to expire
      await new Promise(resolve => setTimeout(resolve, 1500));
      await expect(verifyToken(token, config, baseSigning)).rejects.toThrow();
    });

    test('tampered token fails verification', async () => {
      const token = await signToken({ sub: 'user-1' }, 300, baseConfig, baseSigning);
      // Flip a character in the payload section (second segment)
      const parts = token.split('.');
      const tampered =
        parts[0] +
        '.' +
        parts[1].slice(0, -1) +
        (parts[1].slice(-1) === 'A' ? 'B' : 'A') +
        '.' +
        parts[2];
      await expect(verifyToken(tampered, baseConfig, baseSigning)).rejects.toThrow();
    });

    test('wrong secret fails verification', async () => {
      const token = await signToken({ sub: 'user-1' }, 300, baseConfig, baseSigning);
      const wrongSigning: SigningConfig = { secret: SECRET_B };
      await expect(verifyToken(token, baseConfig, wrongSigning)).rejects.toThrow();
    });
  });

  describe('HMAC key rotation', () => {
    test('verify with rotated secrets succeeds against previous key', async () => {
      // Sign with SECRET_A
      const token = await signToken({ sub: 'user-1' }, 300, baseConfig, baseSigning);
      // Verify with SECRET_B as active + SECRET_A as rotated
      const rotatedSigning: SigningConfig = { secret: [SECRET_B, SECRET_A] };
      const payload = await verifyToken(token, baseConfig, rotatedSigning);
      expect(payload.sub).toBe('user-1');
    });
  });

  describe('clock tolerance', () => {
    test('generous clock tolerance allows near-expired token', async () => {
      // Sign with 1s expiry
      const strictConfig = createAuthResolvedConfig({ jwt: { clockTolerance: 0 } });
      const token = await signToken({ sub: 'user-1' }, 1, strictConfig, baseSigning);
      await new Promise(resolve => setTimeout(resolve, 1500));
      // Strict config rejects
      await expect(verifyToken(token, strictConfig, baseSigning)).rejects.toThrow();
      // Generous tolerance accepts
      const lenientConfig = createAuthResolvedConfig({ jwt: { clockTolerance: 30 } });
      const payload = await verifyToken(token, lenientConfig, baseSigning);
      expect(payload.sub).toBe('user-1');
    });
  });

  describe('validateJwtSecrets', () => {
    test('secret too short throws', () => {
      const shortSigning: SigningConfig = { secret: 'too-short' };
      expect(() => validateJwtSecrets(baseConfig, shortSigning)).toThrow(/too short/);
    });

    test('missing secret throws', () => {
      expect(() => validateJwtSecrets(baseConfig, null)).toThrow(/No JWT secret/);
    });

    test('valid secret does not throw', () => {
      expect(() => validateJwtSecrets(baseConfig, baseSigning)).not.toThrow();
    });
  });

  describe('issuer validation', () => {
    test('matching issuer succeeds', async () => {
      const config = createAuthResolvedConfig({ jwt: { issuer: 'test-issuer' } });
      const token = await signToken({ sub: 'user-1' }, 300, config, baseSigning);
      const payload = await verifyToken(token, config, baseSigning);
      expect(payload.iss).toBe('test-issuer');
    });

    test('mismatched issuer fails', async () => {
      const signConfig = createAuthResolvedConfig({ jwt: { issuer: 'issuer-a' } });
      const verifyConfig = createAuthResolvedConfig({ jwt: { issuer: 'issuer-b' } });
      const token = await signToken({ sub: 'user-1' }, 300, signConfig, baseSigning);
      await expect(verifyToken(token, verifyConfig, baseSigning)).rejects.toThrow();
    });
  });

  describe('audience validation', () => {
    test('matching audience succeeds', async () => {
      const config = createAuthResolvedConfig({ jwt: { audience: 'test-audience' } });
      const token = await signToken({ sub: 'user-1' }, 300, config, baseSigning);
      const payload = await verifyToken(token, config, baseSigning);
      expect(payload.aud).toBe('test-audience');
    });

    test('mismatched audience fails', async () => {
      const signConfig = createAuthResolvedConfig({ jwt: { audience: 'aud-a' } });
      const verifyConfig = createAuthResolvedConfig({ jwt: { audience: 'aud-b' } });
      const token = await signToken({ sub: 'user-1' }, 300, signConfig, baseSigning);
      await expect(verifyToken(token, verifyConfig, baseSigning)).rejects.toThrow();
    });
  });
});
