import {
  DEFAULT_MAX_ENTRIES,
  HttpError,
  createEvictExpired,
  evictOldest,
} from '@lastshotlabs/slingshot-core';
import { decodeCursor, encodeCursor } from '@lastshotlabs/slingshot-core';
import { hashToken, timingSafeEqual } from '@lastshotlabs/slingshot-core';
import type {
  UserRecord as AdapterUserRecord,
  AuthAdapter,
  GroupRecord,
  IdentityProfile,
  RuntimePassword,
  UserQuery,
  WebAuthnCredential,
} from '@lastshotlabs/slingshot-core';
import type { AuthResolvedConfig } from '../config/authConfig';
import { normalizeEmail } from '../lib/normalizeEmail';
import type { OAuthCodePayload } from '../types/oauthCode';
import type { OAuthReauthConfirmation, OAuthReauthState } from '../types/oauthReauth';
import type { RefreshResult, SessionInfo, SessionMetadata } from '../types/session';

// ---------------------------------------------------------------------------
// In-memory stores — types
// ---------------------------------------------------------------------------

interface UserRecord {
  id: string;
  email: string | null;
  /** Primary login identifier — equals email when primaryField="email", username or phone otherwise. */
  identifier: string | null;
  passwordHash: string | null;
  providerIds: string[];
  roles: string[];
  emailVerified: boolean;
  mfaSecret: string | null;
  mfaEnabled: boolean;
  recoveryCodes: string[];
  mfaMethods: string[];
  webauthnCredentials: WebAuthnCredential[];
  displayName?: string;
  firstName?: string;
  lastName?: string;
  externalId?: string;
  suspended: boolean;
  suspendedAt?: Date;
  suspendedReason?: string;
  /** Previous bcrypt password hashes for reuse prevention. Oldest-first. */
  passwordHistory: string[];
  userMetadata?: Record<string, unknown>;
  appMetadata?: Record<string, unknown>;
}

interface MemorySession {
  sessionId: string;
  userId: string;
  token: string | null;
  createdAt: number;
  lastActiveAt: number;
  expiresAt: number;
  ipAddress?: string;
  userAgent?: string;
  refreshToken?: string | null;
  prevRefreshToken?: string | null;
  prevTokenExpiresAt?: number | null;
  fingerprint?: string | null;
  mfaVerifiedAt?: number | null;
}

// ---------------------------------------------------------------------------
// MemoryAuthStores — interface for the extra store methods exposed alongside AuthAdapter
// ---------------------------------------------------------------------------

/**
 * Synchronous, direct-access methods that bypass the `SessionRepository` interface.
 *
 * Exposed alongside the `AuthAdapter` by `createMemoryAuthAdapter` for use in tests
 * that need precise control over session state — for example, pre-seeding a session
 * without going through the async `createSession` path, or reading raw session records
 * to assert on fingerprint or MFA state.
 *
 * @remarks
 * These methods operate directly on the adapter's closure-owned Maps. They do **not**
 * apply any config-driven TTL or eviction logic — use them only in tests.
 */
export interface MemoryAuthStores {
  memoryAtomicCreateSession(
    userId: string,
    token: string,
    sessionId: string,
    maxSessions: number,
    metadata?: SessionMetadata,
  ): void;
  memoryCreateSession(
    userId: string,
    token: string,
    sessionId: string,
    metadata?: SessionMetadata,
  ): void;
  memoryGetSession(sessionId: string): string | null;
  memoryGetSessionRecord(sessionId: string): { token: string; lastActiveAt: number } | null;
  memoryDeleteSession(sessionId: string): void;
  memoryGetUserSessions(userId: string): SessionInfo[];
  memoryGetActiveSessionCount(userId: string): number;
  memoryEvictOldestSession(userId: string): void;
  memoryUpdateSessionLastActive(sessionId: string): void;
  memorySetSessionLastActive(sessionId: string, ts: number): void;
  memoryGetSessionFingerprint(sessionId: string): string | null;
  memorySetSessionFingerprint(sessionId: string, fingerprint: string): void;
  memoryGetMfaVerifiedAt(sessionId: string): number | null;
  memorySetMfaVerifiedAt(sessionId: string, ts: number): void;
  memorySetRefreshToken(sessionId: string, refreshToken: string): void;
  memoryGetSessionByRefreshToken(refreshToken: string): RefreshResult | null;
  memoryRotateRefreshToken(
    sessionId: string,
    newRefreshToken: string,
    newAccessToken: string,
  ): void;
  memoryStoreOAuthState(state: string, codeVerifier?: string, linkUserId?: string): void;
  memoryConsumeOAuthState(state: string): { codeVerifier?: string; linkUserId?: string } | null;
  memoryGetCache(key: string): string | null;
  memorySetCache(key: string, value: string, ttlSeconds?: number): void;
  memoryDelCache(key: string): void;
  memoryDelCachePattern(pattern: string): void;
  memoryCreateVerificationToken(
    token: string,
    userId: string,
    email: string,
    ttlSeconds: number,
  ): void;
  memoryGetVerificationToken(token: string): { userId: string; email: string } | null;
  memoryDeleteVerificationToken(token: string): void;
  memoryConsumeVerificationToken(token: string): { userId: string; email: string } | null;
  memoryCreateResetToken(token: string, userId: string, email: string, ttlSeconds: number): void;
  memoryConsumeResetToken(hash: string): { userId: string; email: string } | null;
  memoryStoreOAuthCode(hash: string, payload: OAuthCodePayload, ttlSeconds: number): void;
  memoryConsumeOAuthCode(hash: string): OAuthCodePayload | null;
  memoryCreateDeletionCancelToken(
    token: string,
    userId: string,
    jobId: string,
    ttlSeconds: number,
  ): void;
  memoryConsumeDeletionCancelToken(hash: string): { userId: string; jobId: string } | null;
  memoryCreateMagicLinkToken(token: string, userId: string, ttlSeconds: number): void;
  memoryConsumeMagicLinkToken(hash: string): string | null;
  memoryStoreOAuthReauth(hash: string, data: OAuthReauthState, ttlSeconds: number): void;
  memoryConsumeOAuthReauth(hash: string): OAuthReauthState | null;
  memoryStoreOAuthReauthConfirmation(
    hash: string,
    data: OAuthReauthConfirmation,
    ttlSeconds: number,
  ): void;
  memoryConsumeOAuthReauthConfirmation(hash: string): OAuthReauthConfirmation | null;
  memoryDeleteUserSessions(userId: string): void;
}

// ---------------------------------------------------------------------------
// Cursor helpers (shared with other adapters)
// ---------------------------------------------------------------------------

interface CursorPayload {
  createdAt: number;
  id: string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const DEFAULT_SESSION_TTL_MS = 60 * 60 * 24 * 7 * 1000; // 7 days
const OAUTH_STATE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Creates a fully in-memory `AuthAdapter` plus synchronous session accessor methods
 * (`MemoryAuthStores`) for test introspection.
 *
 * All state is closure-owned — each call returns an independent instance with its own
 * user, session, role, group, and M2M client stores. No module-level mutable state.
 *
 * Suitable for:
 * - Unit and integration tests (create a fresh instance per suite)
 * - Development with ephemeral data
 * - Benchmarks that need zero I/O overhead
 *
 * @param getConfig - Optional function returning the current `AuthResolvedConfig` for
 *   session TTL calculations. When omitted, `DEFAULT_AUTH_CONFIG` is used.
 * @param passwordRuntime - Optional password hashing runtime. When omitted, method calls
 *   that require hashing (e.g. `verifyPassword`) use a stub that compares strings directly.
 * @returns A combined `AuthAdapter & MemoryAuthStores` instance.
 *
 * @example
 * import { createMemoryAuthAdapter } from '@lastshotlabs/slingshot-auth/testing';
 *
 * const adapter = createMemoryAuthAdapter();
 * const user = await adapter.create('alice@example.com', 'hashed-password');
 * const found = await adapter.findByEmail('alice@example.com');
 * // found: { id: user.id, passwordHash: 'hashed-password' }
 */
export function createMemoryAuthAdapter(
  getConfig?: () => AuthResolvedConfig,
  passwordRuntime?: RuntimePassword,
): AuthAdapter & MemoryAuthStores {
  function getSessionTtlMs(): number {
    const abs = getConfig?.().sessionPolicy.absoluteTimeout;
    return abs ? abs * 1000 : DEFAULT_SESSION_TTL_MS;
  }
  // -------------------------------------------------------------------------
  // Instance state — all Maps live inside the closure
  // -------------------------------------------------------------------------

  const _users = new Map<string, UserRecord>();
  const _byEmail = new Map<string, string>();
  const _sessions = new Map<string, MemorySession>(); // sessionId → session
  const _userSessionIds = new Map<string, Set<string>>(); // userId → Set<sessionId>
  const _refreshTokenIndex = new Map<string, string>(); // refreshToken → sessionId
  const _oauthStates = new Map<
    string,
    { codeVerifier?: string; linkUserId?: string; expiresAt: number }
  >();
  const _cache = new Map<string, { value: string; expiresAt?: number }>();
  const _verificationTokens = new Map<
    string,
    { userId: string; email: string; expiresAt: number }
  >();
  const _resetTokens = new Map<string, { userId: string; email: string; expiresAt: number }>();
  const _cancelTokens = new Map<string, { userId: string; jobId: string; expiresAt: number }>();
  const _oauthCodes = new Map<
    string,
    { token: string; userId: string; email?: string; refreshToken?: string; expiresAt: number }
  >();
  const _oauthReauthStates = new Map<
    string,
    {
      userId: string;
      sessionId: string;
      provider: string;
      purpose: string;
      expiresAt: number;
      returnUrl?: string;
    }
  >();
  const _oauthReauthConfirmations = new Map<
    string,
    { userId: string; purpose: string; expiresAt: number }
  >();
  const evictExpired = createEvictExpired();
  const _tenantRoles = new Map<string, string[]>(); // "userId:tenantId" → roles
  const _groups = new Map<string, GroupRecord>(); // groupId → GroupRecord
  const _groupMemberships = new Map<
    string,
    Array<{
      // userId → memberships
      groupId: string;
      roles: string[];
      tenantId: string | null;
      createdAt: number;
    }>
  >();
  const _m2mClients = new Map<
    string,
    {
      id: string;
      clientId: string;
      clientSecretHash: string;
      name: string;
      scopes: string[];
      active: boolean;
    }
  >();
  const _magicLinkTokens = new Map<string, { userId: string; expiresAt: number }>();
  const _oauthProviderLinks = new Map<string, string>(); // provider:providerUserId → userId

  let _memoryWarned = false;

  function warnMemoryAdapter(): void {
    if (!_memoryWarned) {
      _memoryWarned = true;
      console.warn(
        '[slingshot] Memory adapter for auth has no eviction — for development/testing only',
      );
    }
  }

  // -------------------------------------------------------------------------
  // Session store methods (forward-declared so they can reference each other)
  // -------------------------------------------------------------------------

  const memoryDeleteSession = (sessionId: string): void => {
    const entry = _sessions.get(sessionId);
    if (!entry) return;
    // Clean up refresh token reverse-lookup keys
    if (entry.refreshToken) _refreshTokenIndex.delete(entry.refreshToken);
    if (entry.prevRefreshToken) _refreshTokenIndex.delete(entry.prevRefreshToken);
    if (getConfig?.().persistSessionMetadata) {
      entry.token = null;
      entry.refreshToken = null;
      entry.prevRefreshToken = null;
      entry.prevTokenExpiresAt = null;
    } else {
      _sessions.delete(sessionId);
      _userSessionIds.get(entry.userId)?.delete(sessionId);
    }
  };

  const memoryCreateSession = (
    userId: string,
    token: string,
    sessionId: string,
    metadata?: SessionMetadata,
  ): void => {
    const now = Date.now();
    const session: MemorySession = {
      sessionId,
      userId,
      token,
      createdAt: now,
      lastActiveAt: now,
      expiresAt: now + getSessionTtlMs(),
      ipAddress: metadata?.ipAddress,
      userAgent: metadata?.userAgent,
    };
    evictOldest(_sessions, DEFAULT_MAX_ENTRIES);
    _sessions.set(sessionId, session);
    if (!_userSessionIds.has(userId)) _userSessionIds.set(userId, new Set());
    const sessionSet = _userSessionIds.get(userId);
    if (sessionSet) sessionSet.add(sessionId);
  };

  // -------------------------------------------------------------------------
  // Return the combined AuthAdapter + MemoryAuthStores object
  // -------------------------------------------------------------------------

   
  return {
    // -----------------------------------------------------------------------
    // AuthAdapter methods
    // -----------------------------------------------------------------------

    async findByEmail(email) {
      warnMemoryAdapter();
      const id = _byEmail.get(normalizeEmail(email));
      if (!id) return null;
      const user = _users.get(id);
      if (!user || !user.passwordHash) return null;
      return { id: user.id, passwordHash: user.passwordHash };
    },

    async create(email, passwordHash) {
      const normalised = normalizeEmail(email);
      if (_byEmail.has(normalised)) throw new HttpError(409, 'Email already registered');
      const id = crypto.randomUUID();
      const user: UserRecord = {
        id,
        email: normalised,
        identifier: normalised,
        passwordHash,
        providerIds: [],
        roles: [],
        emailVerified: false,
        mfaSecret: null,
        mfaEnabled: false,
        recoveryCodes: [],
        mfaMethods: [],
        webauthnCredentials: [],
        suspended: false,
        passwordHistory: [],
      };
      evictOldest(_users, DEFAULT_MAX_ENTRIES);
      _users.set(id, user);
      _byEmail.set(normalised, id);
      return { id };
    },

    async verifyPassword(userId, password) {
      const user = _users.get(userId);
      if (!user?.passwordHash) return false;
      if (passwordRuntime) return passwordRuntime.verify(password, user.passwordHash);
      return Bun.password.verify(password, user.passwordHash);
    },

    async getIdentifier(userId) {
      const user = _users.get(userId);
      return user?.identifier ?? user?.email ?? '';
    },

    async setPassword(userId, passwordHash) {
      const user = _users.get(userId);
      if (!user) return;
      user.passwordHash = passwordHash;
    },

    async findOrCreateByProvider(provider: string, providerId: string, profile: IdentityProfile) {
      const key = `${provider}:${providerId}`;

      const existingOwner = _oauthProviderLinks.get(key);
      if (existingOwner) return { id: existingOwner, created: false };

      // Reject if email belongs to a credential account
      if (profile.email) {
        const existingId = _byEmail.get(normalizeEmail(profile.email));
        if (existingId)
          throw new HttpError(
            409,
            'An account with this email already exists. Sign in with your credentials, then link Google from your account settings.',
          );
      }

      const id = crypto.randomUUID();
      const email = profile.email ? normalizeEmail(profile.email) : null;
      const user: UserRecord = {
        id,
        email,
        identifier: email,
        passwordHash: null,
        providerIds: [key],
        roles: [],
        emailVerified: false,
        mfaSecret: null,
        mfaEnabled: false,
        recoveryCodes: [],
        mfaMethods: [],
        webauthnCredentials: [],
        suspended: false,
        passwordHistory: [],
      };
      evictOldest(_users, DEFAULT_MAX_ENTRIES);
      _users.set(id, user);
      if (email) _byEmail.set(email, id);
      _oauthProviderLinks.set(key, id);
      return { id, created: true };
    },

    async linkProvider(userId, provider, providerId) {
      const user = _users.get(userId);
      if (!user) throw new HttpError(404, 'User not found');
      const key = `${provider}:${providerId}`;
      const existingOwner = _oauthProviderLinks.get(key);
      if (existingOwner && existingOwner !== userId) {
        throw new HttpError(
          409,
          'This provider account is already linked to another user. Unlink it there before linking it here.',
        );
      }
      if (!user.providerIds.includes(key)) {
        user.providerIds.push(key);
      }
      _oauthProviderLinks.set(key, userId);
    },

    async getRoles(userId) {
      return _users.get(userId)?.roles ?? [];
    },

    async setRoles(userId, roles) {
      const user = _users.get(userId);
      if (!user) return;
      user.roles = [...roles];
    },

    async addRole(userId, role) {
      const user = _users.get(userId);
      if (!user) return;
      if (!user.roles.includes(role)) user.roles.push(role);
    },

    async removeRole(userId, role) {
      const user = _users.get(userId);
      if (!user) return;
      user.roles = user.roles.filter(r => r !== role);
    },

    async getUser(userId) {
      const user = _users.get(userId);
      if (!user) return null;
      return {
        email: user.email ?? undefined,
        providerIds: [...user.providerIds],
        emailVerified: user.emailVerified,
        displayName: user.displayName,
        firstName: user.firstName,
        lastName: user.lastName,
        externalId: user.externalId,
        suspended: user.suspended,
        suspendedReason: user.suspendedReason,
        userMetadata: user.userMetadata ? { ...user.userMetadata } : undefined,
        appMetadata: user.appMetadata ? { ...user.appMetadata } : undefined,
      };
    },

    async unlinkProvider(userId, provider) {
      const user = _users.get(userId);
      if (!user) throw new HttpError(404, 'User not found');
      for (const providerId of user.providerIds) {
        if (providerId.startsWith(`${provider}:`)) {
          _oauthProviderLinks.delete(providerId);
        }
      }
      user.providerIds = user.providerIds.filter(id => !id.startsWith(`${provider}:`));
    },

    async findByIdentifier(value) {
      const normalized = normalizeEmail(value);
      // First try _byEmail index (covers email primaryField)
      const idFromEmail = _byEmail.get(normalized);
      if (idFromEmail) {
        const user = _users.get(idFromEmail);
        if (user) return { id: user.id, passwordHash: user.passwordHash ?? '' };
      }
      // Fallback: linear scan for identifier field (non-email primaryField)
      for (const user of _users.values()) {
        if (user.identifier === normalized) {
          return { id: user.id, passwordHash: user.passwordHash ?? '' };
        }
      }
      return null;
    },

    async setEmailVerified(userId, verified) {
      const user = _users.get(userId);
      if (user) user.emailVerified = verified;
    },

    async getEmailVerified(userId) {
      return _users.get(userId)?.emailVerified ?? false;
    },

    async deleteUser(userId) {
      const user = _users.get(userId);
      if (user?.email) _byEmail.delete(user.email);
      if (user) {
        for (const providerId of user.providerIds) {
          _oauthProviderLinks.delete(providerId);
        }
      }
      _users.delete(userId);

      // Cascade: clean up sessions (mirrors deleteUserSessions logic)
      const sessionIds = _userSessionIds.get(userId);
      if (sessionIds) {
        for (const sessionId of sessionIds) {
          const session = _sessions.get(sessionId);
          if (session) {
            if (session.refreshToken) _refreshTokenIndex.delete(session.refreshToken);
            if (session.prevRefreshToken) _refreshTokenIndex.delete(session.prevRefreshToken);
            _sessions.delete(sessionId);
          }
        }
        _userSessionIds.delete(userId);
      }

      // Cascade: clean up tenant roles
      for (const key of _tenantRoles.keys()) {
        if (key.startsWith(`${userId}:`)) _tenantRoles.delete(key);
      }

      // Cascade: clean up group memberships
      _groupMemberships.delete(userId);
    },

    async hasPassword(userId) {
      return !!_users.get(userId)?.passwordHash;
    },

    async setMfaSecret(userId, secret) {
      const user = _users.get(userId);
      if (user) user.mfaSecret = secret;
    },

    async getMfaSecret(userId) {
      return _users.get(userId)?.mfaSecret ?? null;
    },

    async isMfaEnabled(userId) {
      return _users.get(userId)?.mfaEnabled ?? false;
    },

    async setMfaEnabled(userId, enabled) {
      const user = _users.get(userId);
      if (user) user.mfaEnabled = enabled;
    },

    async setRecoveryCodes(userId, codes) {
      const user = _users.get(userId);
      if (user) user.recoveryCodes = [...codes];
    },

    async getRecoveryCodes(userId) {
      return _users.get(userId)?.recoveryCodes ?? [];
    },

    async removeRecoveryCode(userId, code) {
      const user = _users.get(userId);
      if (user) user.recoveryCodes = user.recoveryCodes.filter(c => c !== code);
    },

    async consumeRecoveryCode(userId, hashedCode) {
      // Synchronous find-and-splice — safe in single-threaded Bun (no await between read and write).
      const user = _users.get(userId);
      if (!user) return false;

      const codes = user.recoveryCodes;
      const idx = codes.indexOf(hashedCode);
      if (idx === -1) return false;

      codes.splice(idx, 1);
      return true;
    },

    async getMfaMethods(userId) {
      const user = _users.get(userId);
      if (!user) return [];
      return [...user.mfaMethods];
    },

    async setMfaMethods(userId, methods) {
      const user = _users.get(userId);
      if (user) user.mfaMethods = [...methods];
    },

    async getWebAuthnCredentials(userId) {
      return [...(_users.get(userId)?.webauthnCredentials ?? [])];
    },

    async addWebAuthnCredential(userId, credential) {
      const user = _users.get(userId);
      if (user) user.webauthnCredentials.push({ ...credential });
    },

    async removeWebAuthnCredential(userId, credentialId) {
      const user = _users.get(userId);
      if (user)
        user.webauthnCredentials = user.webauthnCredentials.filter(
          c => c.credentialId !== credentialId,
        );
    },

    async updateWebAuthnCredentialSignCount(userId, credentialId, signCount) {
      const user = _users.get(userId);
      if (!user) return;
      const cred = user.webauthnCredentials.find(c => c.credentialId === credentialId);
      if (cred) cred.signCount = signCount;
    },

    async findUserByWebAuthnCredentialId(credentialId) {
      for (const user of _users.values()) {
        if (user.webauthnCredentials.some(c => c.credentialId === credentialId)) return user.id;
      }
      return null;
    },

    async getTenantRoles(userId, tenantId) {
      return _tenantRoles.get(`${userId}:${tenantId}`) ?? [];
    },

    async setTenantRoles(userId, tenantId, roles) {
      _tenantRoles.set(`${userId}:${tenantId}`, [...roles]);
    },

    async addTenantRole(userId, tenantId, role) {
      const key = `${userId}:${tenantId}`;
      const current = _tenantRoles.get(key) ?? [];
      if (!current.includes(role)) {
        _tenantRoles.set(key, [...current, role]);
      }
    },

    async removeTenantRole(userId, tenantId, role) {
      const key = `${userId}:${tenantId}`;
      const current = _tenantRoles.get(key);
      if (current) {
        _tenantRoles.set(
          key,
          current.filter(r => r !== role),
        );
      }
    },

    async setSuspended(userId: string, suspended: boolean, reason?: string) {
      const user = _users.get(userId);
      if (!user) return;
      user.suspended = suspended;
      if (suspended) {
        user.suspendedAt = new Date();
        user.suspendedReason = reason;
      } else {
        user.suspendedAt = undefined;
        user.suspendedReason = undefined;
      }
    },

    async getSuspended(userId: string) {
      const user = _users.get(userId);
      if (!user) return null;
      return { suspended: user.suspended, suspendedReason: user.suspendedReason };
    },

    async updateProfile(
      userId: string,
      fields: Partial<
        Pick<
          {
            displayName?: string;
            firstName?: string;
            lastName?: string;
            externalId?: string;
            userMetadata?: Record<string, unknown>;
          },
          'displayName' | 'firstName' | 'lastName' | 'externalId' | 'userMetadata'
        >
      >,
    ) {
      const user = _users.get(userId);
      if (!user) return;
      if ('displayName' in fields) user.displayName = fields.displayName;
      if ('firstName' in fields) user.firstName = fields.firstName;
      if ('lastName' in fields) user.lastName = fields.lastName;
      if ('externalId' in fields) user.externalId = fields.externalId;
      if ('userMetadata' in fields) user.userMetadata = fields.userMetadata;
    },

    async getUserMetadata(userId: string) {
      const user = _users.get(userId);
      if (!user) return {};
      return {
        userMetadata: user.userMetadata ? { ...user.userMetadata } : undefined,
        appMetadata: user.appMetadata ? { ...user.appMetadata } : undefined,
      };
    },

    async setUserMetadata(userId: string, data: Record<string, unknown>) {
      const user = _users.get(userId);
      if (user) user.userMetadata = { ...data };
    },

    async setAppMetadata(userId: string, data: Record<string, unknown>) {
      const user = _users.get(userId);
      if (user) user.appMetadata = { ...data };
    },

    async listUsers(query: UserQuery) {
      let users = [..._users.values()];
      if (query.email !== undefined) users = users.filter(u => u.email === query.email);
      if (query.externalId !== undefined)
        users = users.filter(u => u.externalId === query.externalId);
      if (query.suspended !== undefined) users = users.filter(u => u.suspended === query.suspended);

      const totalResults = users.length;
      const startIndex = query.startIndex ?? 0;
      const count = query.count ?? 100;
      const page = users.slice(startIndex, startIndex + count);

      return {
        users: page.map(u => ({
          id: u.id,
          email: u.email ?? undefined,
          displayName: u.displayName,
          firstName: u.firstName,
          lastName: u.lastName,
          externalId: u.externalId,
          suspended: u.suspended,
          suspendedAt: u.suspendedAt,
          suspendedReason: u.suspendedReason,
          emailVerified: u.emailVerified,
          providerIds: [...u.providerIds],
        })) as AdapterUserRecord[],
        totalResults,
      };
    },

    // -----------------------------------------------------------------------
    // Groups
    // -----------------------------------------------------------------------

    async createGroup(group) {
      // Enforce name uniqueness within scope (null = app-wide, string = tenant-scoped)
      for (const g of _groups.values()) {
        if (g.name === group.name && g.tenantId === group.tenantId) {
          throw new HttpError(409, 'A group with this name already exists in this scope');
        }
      }
      const id = crypto.randomUUID();
      const now = Date.now();
      evictOldest(_groups, DEFAULT_MAX_ENTRIES);
      _groups.set(id, { ...group, id, createdAt: now, updatedAt: now });
      return { id };
    },

    async deleteGroup(groupId) {
      _groups.delete(groupId);
      // Cascade: remove all memberships for this group
      for (const [userId, memberships] of _groupMemberships) {
        const filtered = memberships.filter(m => m.groupId !== groupId);
        if (filtered.length !== memberships.length) {
          _groupMemberships.set(userId, filtered);
        }
      }
    },

    async getGroup(groupId) {
      return _groups.get(groupId) ?? null;
    },

    async listGroups(tenantId, opts) {
      const limit = Math.min(opts?.limit ?? 50, 200);
      const all = [..._groups.values()]
        .filter(g => g.tenantId === tenantId)
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
      let filtered = all;
      if (opts?.cursor) {
        const c = decodeCursor<CursorPayload>(opts.cursor);
        if (c) {
          filtered = all.filter(
            g => g.createdAt > c.createdAt || (g.createdAt === c.createdAt && g.id > c.id),
          );
        }
      }
      const page = filtered.slice(0, limit);
      const nextCursor =
        filtered.length > limit
          ? encodeCursor({
              createdAt: page[page.length - 1].createdAt,
              id: page[page.length - 1].id,
            })
          : undefined;
      return { items: page, nextCursor, hasMore: !!nextCursor };
    },

    async updateGroup(groupId, updates) {
      const group = _groups.get(groupId);
      if (!group) return;
      const now = Date.now();
      _groups.set(groupId, {
        ...group,
        ...updates,
        id: group.id,
        tenantId: group.tenantId,
        createdAt: group.createdAt,
        updatedAt: now,
      });
    },

    async addGroupMember(groupId, userId, roles = []) {
      const group = _groups.get(groupId);
      if (!group) throw new HttpError(404, 'Group not found');
      const existing = _groupMemberships.get(userId) ?? [];
      if (existing.some(m => m.groupId === groupId)) {
        throw new HttpError(409, 'User is already a member of this group');
      }
      _groupMemberships.set(userId, [
        ...existing,
        {
          groupId,
          roles: [...roles],
          tenantId: group.tenantId,
          createdAt: Date.now(),
        },
      ]);
    },

    async updateGroupMembership(groupId, userId, roles) {
      const memberships = _groupMemberships.get(userId);
      if (!memberships) return;
      const idx = memberships.findIndex(m => m.groupId === groupId);
      if (idx === -1) return;
      memberships[idx] = { ...memberships[idx], roles: [...roles] };
    },

    async removeGroupMember(groupId, userId) {
      const memberships = _groupMemberships.get(userId);
      if (!memberships) return;
      _groupMemberships.set(
        userId,
        memberships.filter(m => m.groupId !== groupId),
      );
    },

    async getGroupMembers(groupId, opts) {
      const limit = Math.min(opts?.limit ?? 50, 200);
      const all: Array<{ userId: string; roles: string[]; createdAt: number }> = [];
      for (const [userId, memberships] of _groupMemberships) {
        const m = memberships.find(m => m.groupId === groupId);
        if (m) all.push({ userId, roles: [...m.roles], createdAt: m.createdAt });
      }
      all.sort((a, b) => a.createdAt - b.createdAt || a.userId.localeCompare(b.userId));
      let filtered = all;
      if (opts?.cursor) {
        const c = decodeCursor<CursorPayload>(opts.cursor);
        if (c) {
          filtered = all.filter(
            m => m.createdAt > c.createdAt || (m.createdAt === c.createdAt && m.userId > c.id),
          );
        }
      }
      const page = filtered.slice(0, limit);
      const nextCursor =
        filtered.length > limit
          ? encodeCursor({
              createdAt: page[page.length - 1].createdAt,
              id: page[page.length - 1].userId,
            })
          : undefined;
      return {
        items: page.map(({ userId, roles }) => ({ userId, roles })),
        nextCursor,
        hasMore: !!nextCursor,
      };
    },

    async getUserGroups(userId, tenantId) {
      const memberships = (_groupMemberships.get(userId) ?? []).filter(
        m => m.tenantId === tenantId,
      );
      const result: Array<{ group: GroupRecord; membershipRoles: string[] }> = [];
      for (const m of memberships) {
        const group = _groups.get(m.groupId);
        if (group) result.push({ group: { ...group }, membershipRoles: [...m.roles] });
      }
      return result;
    },

    async getEffectiveRoles(userId, tenantId) {
      const direct = tenantId
        ? (_tenantRoles.get(`${userId}:${tenantId}`) ?? [])
        : (_users.get(userId)?.roles ?? []);
      const memberships = (_groupMemberships.get(userId) ?? []).filter(
        m => m.tenantId === tenantId,
      );
      const groupRoles = memberships.flatMap(m => [
        ...(_groups.get(m.groupId)?.roles ?? []),
        ...m.roles,
      ]);
      return [...new Set([...direct, ...groupRoles])];
    },

    async getPasswordHistory(userId) {
      return [...(_users.get(userId)?.passwordHistory ?? [])];
    },

    async addPasswordToHistory(userId, hash, maxCount) {
      const user = _users.get(userId);
      if (!user) return;
      user.passwordHistory.push(hash);
      if (user.passwordHistory.length > maxCount) {
        user.passwordHistory = user.passwordHistory.slice(-maxCount);
      }
    },

    // -----------------------------------------------------------------------
    // M2M client credentials
    // -----------------------------------------------------------------------

    async getM2MClient(clientId: string) {
      for (const c of _m2mClients.values()) {
        if (c.clientId === clientId && c.active) return { ...c };
      }
      return null;
    },

    async createM2MClient(data) {
      for (const client of _m2mClients.values()) {
        if (client.clientId === data.clientId) {
          throw new Error(`Duplicate m2m clientId: ${data.clientId}`);
        }
      }
      const id = crypto.randomUUID();
      evictOldest(_m2mClients, DEFAULT_MAX_ENTRIES);
      _m2mClients.set(id, { id, ...data, active: true });
      return { id };
    },

    async deleteM2MClient(clientId: string) {
      for (const [key, c] of _m2mClients.entries()) {
        if (c.clientId === clientId) {
          _m2mClients.delete(key);
          return;
        }
      }
    },

    async listM2MClients() {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      return Array.from(_m2mClients.values()).map(({ clientSecretHash: _, ...rest }) => rest);
    },

    // -----------------------------------------------------------------------
    // Session store methods
    // -----------------------------------------------------------------------

    memoryAtomicCreateSession(
      userId: string,
      token: string,
      sessionId: string,
      maxSessions: number,
      metadata?: SessionMetadata,
    ): void {
      const now = Date.now();
      const ids = _userSessionIds.get(userId);
      if (ids) {
        // Count active sessions and find oldest in a single pass
        let activeCount = 0;
        let oldest: MemorySession | null = null;
        for (const sid of ids) {
          const s = _sessions.get(sid);
          if (s && s.token && s.expiresAt > now) {
            activeCount++;
            if (!oldest || s.createdAt < oldest.createdAt) oldest = s;
          }
        }
        // Evict oldest sessions until we have room for the new one
        while (activeCount >= maxSessions && oldest) {
          memoryDeleteSession(oldest.sessionId);
          activeCount--;
          // Find next oldest
          oldest = null;
          for (const sid of ids) {
            const s = _sessions.get(sid);
            if (s && s.token && s.expiresAt > now) {
              if (!oldest || s.createdAt < oldest.createdAt) oldest = s;
            }
          }
        }
      }
      // Create the new session
      memoryCreateSession(userId, token, sessionId, metadata);
    },

    memoryCreateSession,

    memoryGetSession(sessionId: string): string | null {
      const entry = _sessions.get(sessionId);
      if (!entry || !entry.token || entry.expiresAt <= Date.now()) return null;
      return entry.token;
    },

    memoryGetSessionRecord(sessionId: string): { token: string; lastActiveAt: number } | null {
      const entry = _sessions.get(sessionId);
      if (!entry || !entry.token || entry.expiresAt <= Date.now()) return null;
      return { token: entry.token, lastActiveAt: entry.lastActiveAt };
    },

    memoryDeleteSession,

    memoryGetUserSessions(userId: string): SessionInfo[] {
      const ids = _userSessionIds.get(userId);
      if (!ids) return [];
      const now = Date.now();
      const config = getConfig?.();
      const includeInactive = config?.includeInactiveSessions;
      const persist = config?.persistSessionMetadata;
      const results: SessionInfo[] = [];
      for (const sessionId of ids) {
        const s = _sessions.get(sessionId);
        if (!s) continue;
        const isActive = !!s.token && s.expiresAt > now;
        if (!isActive && !persist) continue;
        if (!isActive && !includeInactive) continue;
        results.push({
          sessionId: s.sessionId,
          createdAt: s.createdAt,
          lastActiveAt: s.lastActiveAt,
          expiresAt: s.expiresAt,
          ipAddress: s.ipAddress,
          userAgent: s.userAgent,
          isActive,
        });
      }
      return results;
    },

    memoryGetActiveSessionCount(userId: string): number {
      const ids = _userSessionIds.get(userId);
      if (!ids) return 0;
      const now = Date.now();
      let count = 0;
      for (const sessionId of ids) {
        const s = _sessions.get(sessionId);
        if (s && s.token && s.expiresAt > now) count++;
      }
      return count;
    },

    memoryEvictOldestSession(userId: string): void {
      const ids = _userSessionIds.get(userId);
      if (!ids) return;
      const now = Date.now();
      let oldest: MemorySession | null = null;
      for (const sessionId of ids) {
        const s = _sessions.get(sessionId);
        if (!s || !s.token || s.expiresAt <= now) continue;
        if (!oldest || s.createdAt < oldest.createdAt) oldest = s;
      }
      if (oldest) memoryDeleteSession(oldest.sessionId);
    },

    memoryUpdateSessionLastActive(sessionId: string): void {
      const entry = _sessions.get(sessionId);
      if (entry) entry.lastActiveAt = Date.now();
    },

    /** Test-only helper: set lastActiveAt to a specific timestamp for idle timeout testing. */
    memorySetSessionLastActive(sessionId: string, ts: number): void {
      const entry = _sessions.get(sessionId);
      if (entry) entry.lastActiveAt = ts;
    },

    memoryGetSessionFingerprint(sessionId: string): string | null {
      return _sessions.get(sessionId)?.fingerprint ?? null;
    },

    memorySetSessionFingerprint(sessionId: string, fingerprint: string): void {
      const entry = _sessions.get(sessionId);
      if (entry) entry.fingerprint = fingerprint;
    },

    memoryGetMfaVerifiedAt(sessionId: string): number | null {
      return _sessions.get(sessionId)?.mfaVerifiedAt ?? null;
    },

    memorySetMfaVerifiedAt(sessionId: string, ts: number): void {
      const entry = _sessions.get(sessionId);
      if (entry) entry.mfaVerifiedAt = ts;
    },

    memorySetRefreshToken(sessionId: string, refreshToken: string): void {
      const entry = _sessions.get(sessionId);
      if (!entry) return;
      const tokenHash = hashToken(refreshToken);
      entry.refreshToken = tokenHash;
      _refreshTokenIndex.set(tokenHash, sessionId);
    },

    memoryGetSessionByRefreshToken(refreshToken: string): RefreshResult | null {
      const tokenHash = hashToken(refreshToken);
      const sessionId = _refreshTokenIndex.get(tokenHash);
      if (!sessionId) return null;
      const entry = _sessions.get(sessionId);
      if (!entry) return null;

      // Current refresh token matches (compare hashes — timing-safe)
      if (entry.refreshToken && timingSafeEqual(entry.refreshToken, tokenHash)) {
        return {
          sessionId: entry.sessionId,
          userId: entry.userId,
          fromGrace: false,
        };
      }

      // Check grace window (prevRefreshToken is stored as hash too — timing-safe)
      if (
        entry.prevRefreshToken &&
        timingSafeEqual(entry.prevRefreshToken, tokenHash) &&
        entry.prevTokenExpiresAt &&
        entry.prevTokenExpiresAt > Date.now()
      ) {
        return {
          sessionId: entry.sessionId,
          userId: entry.userId,
          fromGrace: true,
        };
      }

      // Grace window expired — theft detected, invalidate session
      if (entry.prevRefreshToken && timingSafeEqual(entry.prevRefreshToken, tokenHash)) {
        memoryDeleteSession(sessionId);
        return null;
      }

      return null;
    },

    memoryRotateRefreshToken(
      sessionId: string,
      newRefreshToken: string,
      newAccessToken: string,
    ): void {
      const entry = _sessions.get(sessionId);
      if (!entry) return;
      const graceSeconds = getConfig?.().refreshToken?.rotationGraceSeconds ?? 10;
      const newHash = hashToken(newRefreshToken);

      // Move current hash to prev; store the new hash as current
      const oldHash = entry.refreshToken;
      entry.prevRefreshToken = oldHash;
      entry.prevTokenExpiresAt = Date.now() + graceSeconds * 1000;
      entry.refreshToken = newHash;
      entry.token = newAccessToken;

      // Update reverse-lookup index
      _refreshTokenIndex.set(newHash, sessionId);
      // Old hash stays in index during grace window — cleaned up on next lookup or session delete
    },

    memoryDeleteUserSessions(userId: string): void {
      const sessionIds = _userSessionIds.get(userId);
      if (!sessionIds) return;
      for (const sessionId of sessionIds) {
        const session = _sessions.get(sessionId);
        if (session) {
          if (session.refreshToken) _refreshTokenIndex.delete(session.refreshToken);
          if (session.prevRefreshToken) _refreshTokenIndex.delete(session.prevRefreshToken);
          _sessions.delete(sessionId);
        }
      }
      _userSessionIds.delete(userId);
    },

    // -----------------------------------------------------------------------
    // OAuth state helpers
    // -----------------------------------------------------------------------

    memoryStoreOAuthState(state: string, codeVerifier?: string, linkUserId?: string): void {
      evictExpired(_oauthStates);
      evictOldest(_oauthStates, DEFAULT_MAX_ENTRIES);
      _oauthStates.set(state, {
        codeVerifier,
        linkUserId,
        expiresAt: Date.now() + OAUTH_STATE_TTL_MS,
      });
    },

    memoryConsumeOAuthState(state: string): { codeVerifier?: string; linkUserId?: string } | null {
      const entry = _oauthStates.get(state);
      if (!entry || entry.expiresAt <= Date.now()) {
        _oauthStates.delete(state);
        return null;
      }
      _oauthStates.delete(state);
      return { codeVerifier: entry.codeVerifier, linkUserId: entry.linkUserId };
    },

    // -----------------------------------------------------------------------
    // Cache helpers
    // -----------------------------------------------------------------------

    memoryGetCache(key: string): string | null {
      const entry = _cache.get(key);
      if (!entry) return null;
      if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
        _cache.delete(key);
        return null;
      }
      return entry.value;
    },

    memorySetCache(key: string, value: string, ttlSeconds?: number): void {
      const expiresAt = ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined;
      evictExpired(_cache);
      evictOldest(_cache, DEFAULT_MAX_ENTRIES);
      _cache.set(key, { value, expiresAt });
    },

    memoryDelCache(key: string): void {
      _cache.delete(key);
    },

    memoryDelCachePattern(pattern: string): void {
      // Convert glob * to a regex
      const regex = new RegExp(
        '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
      );
      for (const key of _cache.keys()) {
        if (regex.test(key)) _cache.delete(key);
      }
    },

    // -----------------------------------------------------------------------
    // Email verification token helpers
    // -----------------------------------------------------------------------

    memoryCreateVerificationToken(
      token: string,
      userId: string,
      email: string,
      ttlSeconds: number,
    ): void {
      evictExpired(_verificationTokens);
      evictOldest(_verificationTokens, DEFAULT_MAX_ENTRIES);
      _verificationTokens.set(token, { userId, email, expiresAt: Date.now() + ttlSeconds * 1000 });
    },

    memoryGetVerificationToken(token: string): { userId: string; email: string } | null {
      const entry = _verificationTokens.get(token);
      if (!entry || entry.expiresAt <= Date.now()) {
        _verificationTokens.delete(token);
        return null;
      }
      return { userId: entry.userId, email: entry.email };
    },

    memoryDeleteVerificationToken(token: string): void {
      _verificationTokens.delete(token);
    },

    memoryConsumeVerificationToken(token: string): { userId: string; email: string } | null {
      const entry = _verificationTokens.get(token);
      if (!entry || entry.expiresAt <= Date.now()) {
        _verificationTokens.delete(token);
        return null;
      }
      _verificationTokens.delete(token);
      return { userId: entry.userId, email: entry.email };
    },

    // -----------------------------------------------------------------------
    // Password reset token helpers
    // -----------------------------------------------------------------------

    memoryCreateResetToken(token: string, userId: string, email: string, ttlSeconds: number): void {
      const now = Date.now();
      evictExpired(_resetTokens);
      evictOldest(_resetTokens, DEFAULT_MAX_ENTRIES);
      _resetTokens.set(token, { userId, email, expiresAt: now + ttlSeconds * 1000 });
    },

    memoryConsumeResetToken(hash: string): { userId: string; email: string } | null {
      const entry = _resetTokens.get(hash);
      if (!entry || entry.expiresAt <= Date.now()) {
        _resetTokens.delete(hash);
        return null;
      }
      _resetTokens.delete(hash);
      return { userId: entry.userId, email: entry.email };
    },

    // -----------------------------------------------------------------------
    // OAuth code helpers
    // -----------------------------------------------------------------------

    memoryStoreOAuthCode(hash: string, payload: OAuthCodePayload, ttlSeconds: number): void {
      evictExpired(_oauthCodes);
      evictOldest(_oauthCodes, DEFAULT_MAX_ENTRIES);
      _oauthCodes.set(hash, { ...payload, expiresAt: Date.now() + ttlSeconds * 1000 });
    },

    memoryConsumeOAuthCode(hash: string): OAuthCodePayload | null {
      const entry = _oauthCodes.get(hash);
      if (!entry || entry.expiresAt <= Date.now()) {
        _oauthCodes.delete(hash);
        return null;
      }
      _oauthCodes.delete(hash);
      return {
        token: entry.token,
        userId: entry.userId,
        email: entry.email,
        refreshToken: entry.refreshToken,
      };
    },

    // -----------------------------------------------------------------------
    // Account deletion cancel token helpers
    // -----------------------------------------------------------------------

    memoryCreateDeletionCancelToken(
      token: string,
      userId: string,
      jobId: string,
      ttlSeconds: number,
    ): void {
      const now = Date.now();
      evictExpired(_cancelTokens);
      evictOldest(_cancelTokens, DEFAULT_MAX_ENTRIES);
      _cancelTokens.set(token, { userId, jobId, expiresAt: now + ttlSeconds * 1000 });
    },

    memoryConsumeDeletionCancelToken(hash: string): { userId: string; jobId: string } | null {
      const entry = _cancelTokens.get(hash);
      if (!entry || entry.expiresAt <= Date.now()) {
        _cancelTokens.delete(hash);
        return null;
      }
      _cancelTokens.delete(hash);
      return { userId: entry.userId, jobId: entry.jobId };
    },

    // -----------------------------------------------------------------------
    // Magic link token helpers
    // -----------------------------------------------------------------------

    memoryCreateMagicLinkToken(token: string, userId: string, ttlSeconds: number): void {
      const now = Date.now();
      evictExpired(_magicLinkTokens);
      evictOldest(_magicLinkTokens, DEFAULT_MAX_ENTRIES);
      _magicLinkTokens.set(token, { userId, expiresAt: now + ttlSeconds * 1000 });
    },

    memoryConsumeMagicLinkToken(hash: string): string | null {
      const entry = _magicLinkTokens.get(hash);
      if (!entry || entry.expiresAt <= Date.now()) {
        _magicLinkTokens.delete(hash);
        return null;
      }
      _magicLinkTokens.delete(hash);
      return entry.userId;
    },

    // -----------------------------------------------------------------------
    // OAuth re-auth state helpers
    // -----------------------------------------------------------------------

    memoryStoreOAuthReauth(hash: string, data: OAuthReauthState, ttlSeconds: number): void {
      evictExpired(_oauthReauthStates);
      evictOldest(_oauthReauthStates, DEFAULT_MAX_ENTRIES);
      _oauthReauthStates.set(hash, { ...data, expiresAt: Date.now() + ttlSeconds * 1000 });
    },

    memoryConsumeOAuthReauth(hash: string): OAuthReauthState | null {
      const entry = _oauthReauthStates.get(hash);
      if (!entry || entry.expiresAt <= Date.now()) {
        _oauthReauthStates.delete(hash);
        return null;
      }
      _oauthReauthStates.delete(hash);
      return {
        userId: entry.userId,
        sessionId: entry.sessionId,
        provider: entry.provider,
        purpose: entry.purpose,
        expiresAt: entry.expiresAt,
        returnUrl: entry.returnUrl,
      };
    },

    memoryStoreOAuthReauthConfirmation(
      hash: string,
      data: OAuthReauthConfirmation,
      ttlSeconds: number,
    ): void {
      evictExpired(_oauthReauthConfirmations);
      evictOldest(_oauthReauthConfirmations, DEFAULT_MAX_ENTRIES);
      _oauthReauthConfirmations.set(hash, { ...data, expiresAt: Date.now() + ttlSeconds * 1000 });
    },

    memoryConsumeOAuthReauthConfirmation(hash: string): OAuthReauthConfirmation | null {
      const entry = _oauthReauthConfirmations.get(hash);
      if (!entry || entry.expiresAt <= Date.now()) {
        _oauthReauthConfirmations.delete(hash);
        return null;
      }
      _oauthReauthConfirmations.delete(hash);
      return { userId: entry.userId, purpose: entry.purpose };
    },
  };
   
}
