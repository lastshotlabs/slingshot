import { createRemoteJWKSet, jwtVerify } from 'jose';
import type {
  CryptoKey,
  JWK,
  JWTPayload,
  JWTVerifyGetKey,
  JWTVerifyOptions,
  KeyObject,
} from 'jose';

const APPLE_ISSUER = 'https://appleid.apple.com';
const appleJwks = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));

type AppleVerificationKey = CryptoKey | KeyObject | JWK | Uint8Array | JWTVerifyGetKey;

export interface AppleIdentityClaims extends JWTPayload {
  sub: string;
  nonce: string;
  email?: string;
  email_verified?: boolean | string;
}

/**
 * Verify a Sign in with Apple identity token before trusting identity claims.
 *
 * Arctic's `decodeIdToken()` only parses the JWT. Apple requires signature,
 * algorithm, issuer, audience, expiry, issued-at, subject, and nonce validation.
 */
export async function verifyAppleIdentityToken(
  idToken: string,
  clientId: string,
  expectedNonce: string,
  key: AppleVerificationKey = appleJwks,
): Promise<AppleIdentityClaims> {
  const options: JWTVerifyOptions = {
    algorithms: ['RS256'],
    issuer: APPLE_ISSUER,
    audience: clientId,
    clockTolerance: 60,
    requiredClaims: ['iss', 'aud', 'exp', 'iat', 'sub', 'nonce'],
  };
  const { payload } =
    typeof key === 'function'
      ? await jwtVerify(idToken, key as JWTVerifyGetKey, options)
      : await jwtVerify(idToken, key as CryptoKey | KeyObject | JWK | Uint8Array, options);

  if (
    typeof payload.sub !== 'string' ||
    payload.sub.length === 0 ||
    typeof payload.nonce !== 'string' ||
    payload.nonce !== expectedNonce
  ) {
    throw new Error('Invalid Apple identity token claims');
  }

  return payload as AppleIdentityClaims;
}
