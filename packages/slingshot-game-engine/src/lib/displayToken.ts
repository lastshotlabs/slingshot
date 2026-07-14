/**
 * Display tokens — casting a game to a real screen.
 *
 * ## The problem
 *
 * Every game has a TV view: the big screen the room looks at. Until now none of
 * them could actually be *cast*. Open the TV route on a Chromecast, a smart-TV
 * browser, or any device that has never logged in, and every request 401s. It
 * only appeared to work because the host opened the TV as a tab in their own
 * already-authenticated browser, silently borrowing their session. In a music
 * game where the TV is the speaker, that meant no TV and therefore no sound.
 *
 * ## The threat model — say it out loud
 *
 * A display token lives in a URL, on a screen, in somebody's living room. Guests
 * can read it off the TV. It will be photographed. Assume it leaks.
 *
 * So a leaked display token must be a NON-EVENT. It grants exactly one thing:
 * read-only visibility of ONE game session, exactly as a spectator would see it.
 * It is not a login. It cannot be widened into one:
 *
 *   - The actor it produces has `kind: 'display'` and **`id: null`**. Slingshot's
 *     `userAuth` requires `kind === 'user'` AND a non-null `id`, so a display
 *     token can never satisfy `userAuth` — on ANY route, in ANY package, present
 *     or future. Read-only is therefore *structural*, not a check somebody has to
 *     remember to write. Every app route that guards on `getActorId(c)` already
 *     rejects it today, before those apps know display tokens exist.
 *   - It is bound to one `sessionId`. It is useless against any other session.
 *   - It carries no user identity, no roles, and no claims beyond its own session.
 *   - It expires, it dies when the session ends, and the host can revoke it.
 *
 * A display token is a key to a window, not a key to the house.
 *
 * ## Format
 *
 *   d1.<base64url(payload)>.<hmac-sha256-hex>
 *
 * `payload` = `{ sid, exp, ep, jti }` — session id, expiry (epoch ms), the
 * session's display *epoch* (see revocation), and a random id for logging.
 *
 * The payload is signed, not encrypted: none of it is secret. Signing is what
 * stops a TV from editing `sid` and watching someone else's party.
 *
 * ## Revocation, without a new table
 *
 * The session record carries a `displayEpoch` counter. A token embeds the epoch
 * it was minted under; verification requires an exact match. Revoking every
 * outstanding token for a session is therefore a single increment — no
 * revocation list, no storage that can drift out of sync with reality, and no
 * way for a stale token to survive a bump.
 */
import { hmacSign, timingSafeEqual } from '@lastshotlabs/slingshot-core';

/** Wire prefix. Bump if the payload shape ever changes — old tokens then fail closed. */
const TOKEN_VERSION = 'd1';

/** Default lifetime. Long enough to outlast a party, short enough that a photo of the TV rots. */
export const DEFAULT_DISPLAY_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

/** The claims carried inside a display token. Signed, not secret. */
export interface DisplayTokenClaims {
  /** The ONE session this token may observe. */
  readonly sessionId: string;
  /** Expiry, epoch ms. */
  readonly expiresAt: number;
  /** The session's display epoch at mint time. A mismatch means "revoked". */
  readonly epoch: number;
  /** Random id — for logging and support, never for authorization. */
  readonly tokenId: string;
}

/** Why a token was rejected. Returned rather than thrown so callers can log precisely. */
export type DisplayTokenFailure =
  | 'malformed'
  | 'bad-signature'
  | 'expired'
  | 'session-mismatch'
  | 'revoked'
  | 'session-over';

export type DisplayTokenVerification =
  | { readonly ok: true; readonly claims: DisplayTokenClaims }
  | { readonly ok: false; readonly reason: DisplayTokenFailure };

interface WirePayload {
  sid: string;
  exp: number;
  ep: number;
  jti: string;
}

function b64urlEncode(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

function b64urlDecode(input: string): string | null {
  try {
    return Buffer.from(input, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

/**
 * The signing keys, newest first.
 *
 * `signing.secret` may be a rotation array. We sign with the active (first) key
 * and accept any key in the list, so rotating a secret does not black out every
 * TV in the house mid-party.
 */
function keyList(secret: string | readonly string[]): string[] {
  return Array.isArray(secret) ? [...secret] : [secret as string];
}

/** Mint a display token for one session. Host-authorized — the caller enforces that. */
export function mintDisplayToken(input: {
  readonly sessionId: string;
  readonly epoch: number;
  readonly secret: string | readonly string[];
  readonly ttlMs?: number;
  readonly now?: number;
  readonly tokenId?: string;
}): { readonly token: string; readonly claims: DisplayTokenClaims } {
  const now = input.now ?? Date.now();
  const ttl = input.ttlMs ?? DEFAULT_DISPLAY_TOKEN_TTL_MS;
  const tokenId = input.tokenId ?? crypto.randomUUID();
  const expiresAt = now + ttl;

  const payload: WirePayload = {
    sid: input.sessionId,
    exp: expiresAt,
    ep: input.epoch,
    jti: tokenId,
  };

  const body = b64urlEncode(JSON.stringify(payload));
  const signingInput = `${TOKEN_VERSION}.${body}`;

  // Sign with the ACTIVE key (first in a rotation list); verification accepts any.
  const activeKey = keyList(input.secret).at(0);
  if (activeKey === undefined || activeKey.length === 0) {
    throw new Error('[slingshot-game-engine] mintDisplayToken: no signing secret configured.');
  }
  const sig = hmacSign(signingInput, activeKey);

  return {
    token: `${signingInput}.${sig}`,
    claims: { sessionId: input.sessionId, expiresAt, epoch: input.epoch, tokenId },
  };
}

/**
 * Verify a display token's SIGNATURE and EXPIRY only.
 *
 * Deliberately does not touch the database. Session existence, status and epoch
 * are authorization questions and are answered by {@link authorizeDisplayToken},
 * which has the session record. Splitting them keeps this half pure and lets the
 * WS path verify cheaply before doing any I/O.
 */
export function verifyDisplayToken(
  token: string,
  opts: { readonly secret: string | readonly string[]; readonly now?: number },
): DisplayTokenVerification {
  const now = opts.now ?? Date.now();

  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [version, body, sig] = parts as [string, string, string];
  if (version !== TOKEN_VERSION) return { ok: false, reason: 'malformed' };

  const signingInput = `${version}.${body}`;

  // Accept ANY key in the rotation list. `timingSafeEqual` throughout — a display
  // token is low-value, but a signature oracle is a signature oracle.
  let signatureOk = false;
  for (const key of keyList(opts.secret)) {
    if (timingSafeEqual(hmacSign(signingInput, key), sig)) {
      signatureOk = true;
      break;
    }
  }
  if (!signatureOk) return { ok: false, reason: 'bad-signature' };

  const json = b64urlDecode(body);
  if (json === null) return { ok: false, reason: 'malformed' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (!parsed || typeof parsed !== 'object') return { ok: false, reason: 'malformed' };
  const p = parsed as Partial<WirePayload>;
  if (
    typeof p.sid !== 'string' ||
    typeof p.exp !== 'number' ||
    typeof p.ep !== 'number' ||
    typeof p.jti !== 'string' ||
    p.sid.length === 0
  ) {
    return { ok: false, reason: 'malformed' };
  }

  if (now >= p.exp) return { ok: false, reason: 'expired' };

  return {
    ok: true,
    claims: { sessionId: p.sid, expiresAt: p.exp, epoch: p.ep, tokenId: p.jti },
  };
}

/** Session facts the authorization step needs. */
export interface DisplaySessionFacts {
  readonly id: string;
  readonly status: string;
  readonly displayEpoch: number;
}

/** A session that has ended shows nothing. The TV should fall back to a "game over" screen. */
const TERMINAL_STATUSES = new Set(['completed', 'abandoned']);

/**
 * Authorize verified claims against the live session record.
 *
 * Fails closed on every axis: wrong session, revoked epoch, or a session that is
 * already over.
 */
export function authorizeDisplayToken(
  claims: DisplayTokenClaims,
  session: DisplaySessionFacts | null,
): DisplayTokenVerification {
  if (!session || session.id !== claims.sessionId) {
    return { ok: false, reason: 'session-mismatch' };
  }
  if ((session.displayEpoch ?? 0) !== claims.epoch) {
    return { ok: false, reason: 'revoked' };
  }
  if (TERMINAL_STATUSES.has(session.status)) {
    return { ok: false, reason: 'session-over' };
  }
  return { ok: true, claims };
}

/** Read a display token off a request: `?display=` first, then `X-Display-Token`. */
export function readDisplayTokenFromRequest(input: {
  readonly query: (name: string) => string | undefined;
  readonly header: (name: string) => string | undefined;
}): string | null {
  const q = input.query('display');
  if (typeof q === 'string' && q.length > 0) return q;
  const h = input.header('x-display-token');
  if (typeof h === 'string' && h.length > 0) return h;
  return null;
}
