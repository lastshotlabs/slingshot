import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_DISPLAY_TOKEN_TTL_MS,
  authorizeDisplayToken,
  mintDisplayToken,
  verifyDisplayToken,
} from '../../src/lib/displayToken';
import { createGameRoomSubscribeGuard } from '../../src/lib/roomAccess';
import type { SessionRuntime } from '../../src/lib/sessionRuntime';

const SECRET = 'test-secret-test-secret-test-secret';
const SID = 'session-abc';

function live(overrides: Partial<{ id: string; status: string; displayEpoch: number }> = {}) {
  return { id: SID, status: 'playing', displayEpoch: 0, ...overrides };
}

describe('display token — crypto', () => {
  test('a freshly minted token verifies', () => {
    const { token } = mintDisplayToken({ sessionId: SID, epoch: 0, secret: SECRET });
    const v = verifyDisplayToken(token, { secret: SECRET });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.claims.sessionId).toBe(SID);
  });

  test('a token signed with a different secret is rejected', () => {
    const { token } = mintDisplayToken({ sessionId: SID, epoch: 0, secret: SECRET });
    const v = verifyDisplayToken(token, { secret: 'a-completely-different-secret-value' });
    expect(v).toEqual({ ok: false, reason: 'bad-signature' });
  });

  test('TAMPERING with the session id is rejected — a TV cannot retarget itself', () => {
    // The whole point: the payload is public, so the ONLY thing stopping a TV
    // from editing `sid` and watching a stranger's party is the signature.
    const { token } = mintDisplayToken({ sessionId: SID, epoch: 0, secret: SECRET });
    const [ver, body, sig] = token.split('.') as [string, string, string];
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    payload.sid = 'someone-elses-session';
    const forgedBody = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

    const v = verifyDisplayToken(`${ver}.${forgedBody}.${sig}`, { secret: SECRET });
    expect(v).toEqual({ ok: false, reason: 'bad-signature' });
  });

  test('an expired token is rejected', () => {
    const now = Date.now();
    const { token } = mintDisplayToken({
      sessionId: SID,
      epoch: 0,
      secret: SECRET,
      ttlMs: 1_000,
      now,
    });
    expect(verifyDisplayToken(token, { secret: SECRET, now: now + 500 }).ok).toBe(true);
    expect(verifyDisplayToken(token, { secret: SECRET, now: now + 1_001 })).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  test('garbage is rejected without throwing', () => {
    for (const junk of ['', 'x', 'a.b', 'a.b.c.d', 'd1.!!!.zzz']) {
      expect(verifyDisplayToken(junk, { secret: SECRET }).ok).toBe(false);
    }
  });

  test('secret ROTATION: a token minted under the old key still verifies', () => {
    // Rotating a signing secret must not black out every TV in the house
    // mid-party. Sign with the active key; accept any key in the list.
    const { token } = mintDisplayToken({ sessionId: SID, epoch: 0, secret: 'old-key-old-key-old' });
    const rotated = ['new-key-new-key-new', 'old-key-old-key-old'];
    expect(verifyDisplayToken(token, { secret: rotated }).ok).toBe(true);
  });

  test('the default TTL outlasts a party but not a photo of the TV forever', () => {
    expect(DEFAULT_DISPLAY_TOKEN_TTL_MS).toBeGreaterThan(6 * 60 * 60 * 1000);
    expect(DEFAULT_DISPLAY_TOKEN_TTL_MS).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });
});

describe('display token — authorization against the live session', () => {
  const claims = () => mintDisplayToken({ sessionId: SID, epoch: 0, secret: SECRET }).claims;

  test('authorizes against its own live session', () => {
    expect(authorizeDisplayToken(claims(), live()).ok).toBe(true);
  });

  test('CANNOT read another session', () => {
    expect(authorizeDisplayToken(claims(), live({ id: 'another-session' }))).toEqual({
      ok: false,
      reason: 'session-mismatch',
    });
  });

  test('a missing session fails closed', () => {
    expect(authorizeDisplayToken(claims(), null)).toEqual({
      ok: false,
      reason: 'session-mismatch',
    });
  });

  test('REVOKED: bumping the session epoch kills every outstanding token', () => {
    const c = claims(); // minted at epoch 0
    expect(authorizeDisplayToken(c, live({ displayEpoch: 1 }))).toEqual({
      ok: false,
      reason: 'revoked',
    });
  });

  test('the token dies when the game ends', () => {
    for (const status of ['completed', 'abandoned']) {
      expect(authorizeDisplayToken(claims(), live({ status }))).toEqual({
        ok: false,
        reason: 'session-over',
      });
    }
  });
});

// ── Room access ─────────────────────────────────────────────────────────────
//
// These also pin the fix to a PRE-EXISTING hole: the framework's default guard
// only protected `player:*` rooms, so any authenticated socket could subscribe to
// `sessions:<id>:host` — or to another session's rooms entirely.

function socket(data: Record<string, unknown>) {
  return { data };
}

function guardWith(players: Array<Record<string, unknown>>) {
  const runtimes = new Map<string, SessionRuntime>();
  return createGameRoomSubscribeGuard({
    activeRuntimes: runtimes,
    getPlayerAdapter: () => ({
      find: async (filter: Record<string, unknown>) =>
        players.filter(p => p.sessionId === filter.sessionId && p.userId === filter.userId),
      update: async () => ({}),
    }),
  });
}

describe('room access — the pre-existing host-room hole', () => {
  const guard = guardWith([
    { sessionId: SID, userId: 'player-1', isHost: false, team: 'red', role: null },
    { sessionId: SID, userId: 'host-1', isHost: true, team: null, role: null },
  ]);

  const asPlayer = socket({ actor: { id: 'player-1', kind: 'user' } });
  const asHost = socket({ actor: { id: 'host-1', kind: 'user' } });

  test('a PLAYER may NOT subscribe to the host room (this was open)', async () => {
    expect(await guard(asPlayer, `sessions:${SID}:host`)).toBe(false);
  });

  test('the host may', async () => {
    expect(await guard(asHost, `sessions:${SID}:host`)).toBe(true);
  });

  test('a member may NOT subscribe to ANOTHER session (this was open)', async () => {
    expect(await guard(asPlayer, `sessions:some-other-session:session`)).toBe(false);
  });

  test('a member may not read another player’s private room', async () => {
    expect(await guard(asPlayer, `sessions:${SID}:player:host-1`)).toBe(false);
    expect(await guard(asPlayer, `sessions:${SID}:player:player-1`)).toBe(true);
  });

  test('a member may not join a team they are not on', async () => {
    expect(await guard(asPlayer, `sessions:${SID}:team:blue`)).toBe(false);
    expect(await guard(asPlayer, `sessions:${SID}:team:red`)).toBe(true);
  });

  test('members get the public feed', async () => {
    expect(await guard(asPlayer, `sessions:${SID}:session`)).toBe(true);
    expect(await guard(asPlayer, `sessions:${SID}:spectators`)).toBe(true);
  });

  test('anonymous sockets get nothing', async () => {
    const anon = socket({ actor: { id: null, kind: 'anonymous' } });
    expect(await guard(anon, `sessions:${SID}:session`)).toBe(false);
    expect(await guard(anon, `sessions:${SID}:host`)).toBe(false);
  });
});

describe('room access — a display (TV) is read-only and boxed into one session', () => {
  const guard = guardWith([]);
  const tv = socket({ actor: { id: null, kind: 'display' }, displaySessionId: SID });

  test('gets the public feed for its own session', async () => {
    expect(await guard(tv, `sessions:${SID}:session`)).toBe(true);
    expect(await guard(tv, `sessions:${SID}:spectators`)).toBe(true);
  });

  test('is DENIED the host room, private rooms, teams and roles', async () => {
    expect(await guard(tv, `sessions:${SID}:host`)).toBe(false);
    expect(await guard(tv, `sessions:${SID}:player:player-1`)).toBe(false);
    expect(await guard(tv, `sessions:${SID}:team:red`)).toBe(false);
    expect(await guard(tv, `sessions:${SID}:role:judge`)).toBe(false);
  });

  test('CANNOT see any other session — even the public feed', async () => {
    expect(await guard(tv, `sessions:another-session:session`)).toBe(false);
    expect(await guard(tv, `sessions:another-session:spectators`)).toBe(false);
  });
});
