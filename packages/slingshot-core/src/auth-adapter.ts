// PaginatedResult — single source of truth in entityConfig
import type { PaginatedResult } from './entityConfig';

// Core AuthAdapter type contracts.
// These live in slingshot-core so adapter packages (e.g. slingshot-postgres) can depend
// on core alone instead of pulling in the full auth plugin.

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/**
 * Normalised identity profile sourced from an OAuth provider.
 *
 * Populated by `OAuthAdapter.findOrCreateByProvider()` when a user authenticates
 * via an external provider. All fields are optional — each provider exposes
 * different claim sets.
 */
export interface IdentityProfile {
  /** Email address claimed by the provider. May be absent if the user denied the email scope. */
  email?: string;
  /** Full display name as returned by the provider (e.g., `'Jane Smith'`). */
  name?: string;
  /** Given name / first name, when the provider returns it as a separate claim. */
  firstName?: string;
  /** Family name / last name, when the provider returns it as a separate claim. */
  lastName?: string;
  /** Provider's preferred display name claim (maps to `preferred_username` in OIDC). */
  displayName?: string;
  /**
   * URL of the user's avatar image as returned by the provider.
   *
   * @remarks
   * Provider-specific and not guaranteed to be stable — the URL may change between
   * logins (e.g., Gravatar URLs keyed to an email, or Google profile picture URLs
   * that contain a revision token). Do not store as a permanent asset reference;
   * treat it as a best-effort display hint only.
   */
  avatarUrl?: string;
  /**
   * The provider's own unique identifier for this user.
   *
   * @remarks
   * Provider-specific format: a numeric string for GitHub/Google (`'12345678'`),
   * a UUID for Auth0, etc. Together with the `provider` string passed to
   * `findOrCreateByProvider()`, this forms the stable linkage key between the
   * external identity and the local user record. Must be stored verbatim — do not
   * normalise or truncate.
   */
  externalId?: string;
}

/**
 * A registered WebAuthn credential (passkey) for a user.
 *
 * Created during the WebAuthn registration ceremony and verified on each
 * authentication attempt. The `signCount` is incremented on every use to
 * detect cloned authenticators.
 */
export interface WebAuthnCredential {
  /** Base64url-encoded credential ID as returned by the authenticator. */
  credentialId: string;
  /** Base64url-encoded COSE-encoded public key stored from the registration ceremony. */
  publicKey: string;
  /**
   * Signature counter for replay and cloning protection.
   *
   * @remarks
   * The authenticator increments this counter on every signing operation.
   * During authentication, the server must verify that the incoming `signCount`
   * is strictly greater than the stored value (or that both are 0 for authenticators
   * that do not implement a counter). If the check fails it indicates a possible
   * cloned authenticator and authentication should be rejected. After a successful
   * verification, persist the new counter value via
   * `WebAuthnAdapter.updateWebAuthnCredentialSignCount()`.
   *
   * Some authenticators (notably platform authenticators on certain OS versions)
   * always return 0 — implementations must tolerate this case and skip the
   * counter comparison when both stored and incoming values are 0.
   */
  signCount: number;
  /**
   * Transport hints declared by the authenticator during registration.
   *
   * @remarks
   * Valid values per the WebAuthn spec: `'usb'`, `'ble'`, `'nfc'`, `'internal'`,
   * `'hybrid'`, `'smart-card'`, `'cable'`. Used by the browser's
   * `PublicKeyCredentialRequestOptions` to optimise authenticator selection UI.
   * May be `undefined` if the authenticator did not declare transports.
   */
  transports?: string[];
  /** User-assigned human-readable name for this credential (e.g. `'YubiKey 5'`, `'Face ID'`). */
  name?: string;
  /** Unix epoch milliseconds when this credential was registered. */
  createdAt: number;
}

/**
 * A machine-to-machine (M2M) client record used for service-to-service authentication.
 *
 * M2M clients authenticate with a `clientId` + `clientSecret` and receive a short-lived
 * access token scoped to the declared `scopes`. Used by background workers, CI pipelines,
 * and internal services that cannot use user sessions.
 */
export interface M2MClientRecord {
  /** Internal surrogate ID (nanoid / UUID). */
  id: string;
  /** Public client identifier used in the `client_credentials` grant request. */
  clientId: string;
  /** Human-readable name for display in admin UIs. */
  name: string;
  /**
   * The permission scopes granted to this client.
   *
   * @remarks
   * Each scope is a plain string token — format is application-defined (e.g.,
   * `'read:users'`, `'write:uploads'`). Scopes are embedded in the issued access
   * token's claims and checked by route-level scope guards. An empty array means
   * the client can authenticate but has no API access. Scope strings are
   * case-sensitive and matched exactly.
   */
  scopes: string[];
  /** Whether this client is allowed to authenticate. Set to `false` to disable without deleting. */
  active: boolean;
}

/**
 * Filter options for listing users via `EnterpriseAdapter.listUsers()`.
 * All fields are optional and combined with AND semantics — only records matching
 * every provided filter are returned.
 */
export interface UserQuery {
  /** Exact-match filter on the user's email address (case-insensitive). */
  email?: string;
  /** Exact-match filter on the user's external provider ID. */
  externalId?: string;
  /** When `true`, return only suspended users; when `false`, return only active users. Omit to return all. */
  suspended?: boolean;
  /**
   * Zero-based offset into the result set for pagination (SCIM-style).
   *
   * @remarks
   * Analogous to SQL `OFFSET`. Combined with `count` to page through large result
   * sets: first page is `startIndex: 0, count: 50`; second page is
   * `startIndex: 50, count: 50`, and so on. Defaults to `0` when omitted.
   */
  startIndex?: number;
  /**
   * Maximum number of users to return (SCIM-style page size).
   *
   * @remarks
   * Analogous to SQL `LIMIT`. Defaults to `50` when omitted. Implementations may
   * cap this at a maximum (e.g., `200`) regardless of the requested value.
   */
  count?: number;
}

/**
 * A user record as read from the auth store.
 *
 * Returned by `CoreAuthAdapter.getUser()`. All fields except `id` and `suspended`
 * are optional because not all adapters populate every field.
 */
export interface UserRecord {
  /** Internal surrogate user ID. Always present. */
  id: string;
  /** Primary email address. May be absent for OAuth-only users who denied the email scope. */
  email?: string;
  /** Display name as stored in the auth adapter (not necessarily from an OAuth profile). */
  displayName?: string;
  /** Given / first name. */
  firstName?: string;
  /** Family / last name. */
  lastName?: string;
  /** External identifier set by an integrator (e.g., an ID from an upstream HR system). */
  externalId?: string;
  /** Whether the user is currently suspended. Always present — defaults to `false`. */
  suspended: boolean;
  /**
   * Timestamp when the user was most recently suspended.
   *
   * @remarks
   * Present only when `suspended` is `true` and the adapter records suspension
   * timestamps. `undefined` when the user has never been suspended or when the
   * adapter does not track this field.
   */
  suspendedAt?: Date;
  /**
   * Human-readable reason for the current suspension.
   *
   * @remarks
   * Free-form text set by an admin at suspension time. `undefined` when the user
   * is not suspended, or when no reason was provided.
   */
  suspendedReason?: string;
  /** Whether the user's email address has been verified. */
  emailVerified?: boolean;
  /**
   * List of OAuth provider slugs linked to this user (e.g., `['google', 'github']`).
   *
   * @remarks
   * Populated only when the adapter implements OAuth linkage. Each string is the
   * provider key used in `auth.oauth.providers` configuration. An empty array means
   * the user has no linked OAuth providers. `undefined` when the adapter does not
   * track provider linkage.
   */
  providerIds?: string[];
  /**
   * Arbitrary metadata set by the end user (or on behalf of the user).
   *
   * @remarks
   * Writable by the user themselves via profile-update APIs. Must not contain
   * security-sensitive data — this object may be exposed to the authenticated
   * user in session/profile responses. Keys and values are application-defined.
   */
  userMetadata?: Record<string, unknown>;
  /**
   * Arbitrary metadata set by the application or administrators.
   *
   * @remarks
   * NOT writable by the end user — only by admin APIs or server-side code.
   * Suitable for internal flags, feature toggles, or audit annotations that the
   * user should not be able to tamper with. Never expose this object in
   * client-facing responses without explicit intent.
   */
  appMetadata?: Record<string, unknown>;
}

/**
 * A user group record stored by `GroupsAdapter`.
 *
 * Groups aggregate users with shared baseline roles. A group is either app-wide
 * (`tenantId = null`) or scoped to a specific tenant. The `tenantId` is immutable
 * after creation — it cannot be moved between tenants.
 */
export interface GroupRecord {
  /** Internal surrogate group ID. */
  id: string;
  /**
   * Machine-readable slug, unique within scope (app-wide or per-tenant).
   *
   * @remarks
   * Must match `/^[a-z0-9_-]+$/`. Uniqueness is enforced within the group's scope:
   * two different tenants may each have a group named `'admins'` without conflict,
   * but a single tenant cannot have two groups with the same name.
   */
  name: string;
  /** Human-readable display name shown in admin UIs. */
  displayName?: string;
  /** Free-form description of the group's purpose. */
  description?: string;
  /**
   * Baseline roles granted to every member of this group.
   *
   * @remarks
   * An empty array (`[]`) is valid and means membership confers no roles by default;
   * per-member extra roles in `GroupMembershipRecord.roles` still apply. Role strings
   * are application-defined, case-sensitive, and matched exactly. No enforced maximum
   * count, but keep the list reasonably small (under 50 roles) for JWT size reasons.
   */
  roles: string[];
  /**
   * Tenant scope of the group.
   *
   * @remarks
   * `null` means the group is app-wide and its members are visible across all tenants.
   * A non-null string is the tenant ID this group belongs to. **Immutable after
   * creation** — the adapter must not allow `tenantId` to be changed via
   * `updateGroup()`. Moving a group between tenants would silently invalidate all
   * denormalised `tenantId` values in `GroupMembershipRecord`.
   */
  tenantId: string | null;
  /** Unix epoch milliseconds when the group was created. */
  createdAt: number;
  /** Unix epoch milliseconds when the group was last updated. */
  updatedAt: number;
}

/**
 * A record of a user's membership in a group.
 *
 * Membership carries optional per-member `roles` that extend the group's baseline roles.
 * `tenantId` is denormalised from the group at insert time for efficient per-tenant queries.
 */
export interface GroupMembershipRecord {
  /** The member's user ID. */
  userId: string;
  /** The group this membership belongs to. */
  groupId: string;
  /**
   * Per-member extra roles that supplement (not replace) the group's baseline roles.
   *
   * @remarks
   * These roles are merged with `GroupRecord.roles` by `GroupsAdapter.getEffectiveRoles()`
   * to produce the user's full role set for a given tenant scope. An empty array means
   * the user inherits only the group's baseline roles with no additions. Duplicates
   * between this list and the group's baseline roles are deduplicated by
   * `getEffectiveRoles()`.
   */
  roles: string[];
  /**
   * Tenant scope, denormalised from the group at membership-insert time.
   *
   * @remarks
   * Copied from `GroupRecord.tenantId` when the membership row is created.
   * This denormalisation is safe because `GroupRecord.tenantId` is immutable after
   * group creation. Stored here so tenant-scoped membership queries can be answered
   * without joining to the groups table.
   */
  tenantId: string | null;
  /** Unix epoch milliseconds when the membership was created. */
  createdAt: number;
}

/**
 * Options for restricting an operation to a specific tenant.
 * Passed to `GroupsAdapter` methods that need to scope results by tenant.
 */
export interface TenantScopedOpts {
  tenantId?: string;
}

/**
 * Pagination options for auth adapter list operations.
 */
export interface PaginationOptions {
  /** Default: 50, max: 200 */
  limit?: number;
  /** Opaque pagination cursor from a previous response */
  cursor?: string;
}

export type { PaginatedResult } from './entityConfig';

// ---------------------------------------------------------------------------
// Tier 1 — Core (always required)
// ---------------------------------------------------------------------------

/**
 * The core authentication adapter — required for every Slingshot auth deployment.
 *
 * Provides the minimal set of operations needed to authenticate users with
 * email/password credentials. All other tiers (`OAuthAdapter`, `MfaAdapter`, etc.)
 * are optional and layer on top of this interface.
 *
 * @remarks
 * Implementations live in adapter packages (e.g., `@lastshotlabs/slingshot-postgres`).
 * The full composite `AuthAdapter` type is the union of all tiers.
 *
 * @example
 * ```ts
 * import type { CoreAuthAdapter } from '@lastshotlabs/slingshot-core';
 *
 * export class MemoryAuthAdapter implements CoreAuthAdapter {
 *   async findByEmail(email) { return users.get(email) ?? null; }
 *   async create(email, hash) { const id = nanoid(); users.set(email, { id, passwordHash: hash }); return { id }; }
 *   // ...
 * }
 * ```
 */
export interface CoreAuthAdapter {
  /**
   * Look up a user by email address.
   *
   * @param email - The email address to search for (case-insensitive lookup recommended).
   * @returns The user's ID and hashed password, or `null` if no user with this email exists.
   * @remarks
   * Returns `null` for unknown emails rather than throwing. The returned `passwordHash`
   * is the stored bcrypt (or equivalent) hash and must never be logged or sent to clients.
   */
  findByEmail(email: string): Promise<{ id: string; passwordHash: string } | null>;
  /**
   * Create a new user record with the given email and pre-hashed password.
   *
   * @param email - The user's email address. Must be unique within the store.
   * @param passwordHash - A bcrypt (or equivalent) hash of the user's password.
   *   The plaintext password must never be passed here — hashing is the caller's
   *   responsibility before invoking this method.
   * @returns An object containing the newly created user's ID.
   * @throws If a user with the given email already exists (adapter-specific error).
   */
  create(email: string, passwordHash: string): Promise<{ id: string }>;
  /**
   * Verify a user's plaintext password against their stored hash.
   *
   * @param userId - The user's ID.
   * @param password - The plaintext password supplied by the user.
   * @returns `true` if the password matches the stored hash, `false` otherwise.
   * @remarks
   * Implementations must perform a **constant-time** comparison (e.g., `bcrypt.compare`)
   * to prevent timing-based enumeration of valid passwords. Never compare hashes with
   * `===` or any non-constant-time function. Returns `false` (not throws) when the
   * user is not found or has no stored password.
   */
  verifyPassword(userId: string, password: string): Promise<boolean>;
  /**
   * Return the primary login identifier for a user (typically their email address).
   *
   * @param userId - The user's ID.
   * @returns The string identifier used to log in (e.g., email). Used by session
   *   serialisation to store a human-readable identity reference.
   * @throws If the user does not exist.
   */
  getIdentifier(userId: string): Promise<string>;
  /**
   * Retrieve a full user profile record.
   *
   * @param userId - The user's ID.
   * @returns A partial profile object, or `null` if no user with this ID exists.
   * @remarks
   * All returned fields are optional — adapters are not required to populate every
   * field. The auth plugin uses the presence of `suspended` to apply suspension
   * checks during identify middleware (when `auth.checkSuspensionOnIdentify` is set).
   */
  getUser?(userId: string): Promise<{
    email?: string;
    providerIds?: string[];
    emailVerified?: boolean;
    displayName?: string;
    firstName?: string;
    lastName?: string;
    externalId?: string;
    suspended?: boolean;
    suspendedReason?: string;
    userMetadata?: Record<string, unknown>;
    appMetadata?: Record<string, unknown>;
  } | null>;
  /**
   * Overwrite the stored password hash for a user.
   *
   * @param userId - The user's ID.
   * @param passwordHash - The new bcrypt (or equivalent) hash. The plaintext
   *   must be hashed by the caller before passing here.
   * @remarks
   * Called during password-reset and password-change flows. Implementations
   * that track password history should NOT call `addPasswordToHistory` here —
   * the auth plugin is responsible for that in `EnterpriseAdapter`.
   */
  setPassword?(userId: string, passwordHash: string): Promise<void>;
  /**
   * Permanently delete a user and all associated auth data.
   *
   * @param userId - The user's ID.
   * @remarks
   * Safe to call when the user does not exist (no-op). Cascade-delete all
   * related rows (OAuth links, MFA secrets, WebAuthn credentials, roles, group
   * memberships) within the same transaction where possible. The auth plugin
   * does not emit a separate cleanup call for each relation.
   */
  deleteUser?(userId: string): Promise<void>;
  /**
   * Set the email-verified flag for a user.
   *
   * @param userId - The user's ID.
   * @param verified - `true` to mark the email as verified, `false` to revoke.
   */
  setEmailVerified?(userId: string, verified: boolean): Promise<void>;
  /**
   * Return whether the user's email address has been verified.
   *
   * @param userId - The user's ID.
   * @returns `true` if verified, `false` if not.
   */
  getEmailVerified?(userId: string): Promise<boolean>;
  /**
   * Return whether the user has a stored password hash (i.e., is not OAuth-only).
   *
   * @param userId - The user's ID.
   * @returns `true` if a password hash is stored, `false` if the user only has
   *   OAuth provider links and no local password.
   */
  hasPassword?(userId: string): Promise<boolean>;
  /**
   * Look up a user by an arbitrary identifier (e.g., username, phone number).
   *
   * @param value - The identifier value to search for.
   * @returns The user's ID and password hash, or `null` if not found.
   * @remarks
   * Used when the application configures a non-email primary identifier. The
   * identifier type and uniqueness constraints are adapter-defined.
   */
  findByIdentifier?(value: string): Promise<{ id: string; passwordHash: string } | null>;
  /**
   * Update display-oriented profile fields for a user.
   *
   * @param userId - The user's ID.
   * @param fields - A partial set of profile fields to update. Only provided
   *   fields are written — omitted fields are left unchanged.
   */
  updateProfile?(
    userId: string,
    fields: { displayName?: string; firstName?: string; lastName?: string; externalId?: string },
  ): Promise<void>;
  /**
   * Retrieve the user's `userMetadata` and `appMetadata` blobs.
   *
   * @param userId - The user's ID.
   * @returns An object containing either or both metadata blobs. Missing blobs
   *   are returned as `undefined` rather than `null`.
   */
  getUserMetadata?(
    userId: string,
  ): Promise<{ userMetadata?: Record<string, unknown>; appMetadata?: Record<string, unknown> }>;
  /**
   * Replace the user-controlled metadata blob.
   *
   * @param userId - The user's ID.
   * @param data - The new `userMetadata` value. Replaces the existing blob entirely.
   */
  setUserMetadata?(userId: string, data: Record<string, unknown>): Promise<void>;
  /**
   * Replace the application-controlled metadata blob.
   *
   * @param userId - The user's ID.
   * @param data - The new `appMetadata` value. Replaces the existing blob entirely.
   * @remarks
   * Must not be writable by end users — only by server-side admin code.
   */
  setAppMetadata?(userId: string, data: Record<string, unknown>): Promise<void>;
  /**
   * Atomically find and remove a hashed MFA recovery code.
   *
   * @param userId - The user's ID.
   * @param hashedCode - The hashed form of the recovery code the user presented.
   * @returns `true` if the code existed and was consumed, `false` if not found.
   * @remarks
   * Required when MFA is configured. The find-and-delete must be atomic to prevent
   * the same code from being used twice under concurrent requests. The code is
   * passed in hashed form — implementations must NOT re-hash it; compare the stored
   * hashes directly.
   */
  consumeRecoveryCode(userId: string, hashedCode: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Tier 2 — OAuth (required when auth.oauth.providers is configured)
// ---------------------------------------------------------------------------

/**
 * OAuth adapter methods — required when `auth.oauth.providers` is configured.
 *
 * Handles the server-side storage of OAuth provider linkages. The auth plugin calls
 * these methods after successfully validating an OAuth callback from a provider.
 */
export interface OAuthAdapter {
  /**
   * Find an existing user by their OAuth provider linkage, or create a new user if none exists.
   *
   * @param provider - The provider slug (e.g., `'google'`, `'github'`). Must match a key in
   *   `auth.oauth.providers` configuration.
   * @param providerId - The provider's own unique ID for this user (from `IdentityProfile.externalId`
   *   or the provider's userinfo claim). Stored verbatim as the linkage key.
   * @param profile - Normalised identity profile from the provider's userinfo endpoint.
   *   Used to populate the new user record on first sign-in.
   * @returns The user's local ID and a `created` flag:
   *   - `created: true` — a **new** local user account was created and the provider was linked
   *     to it. This is the first time this provider identity has been seen.
   *   - `created: false` — an existing user with this provider link was found. No new account
   *     was created. The profile data is NOT used to update the existing user on subsequent logins
   *     unless the implementation explicitly handles profile refresh.
   * @remarks
   * The linkage key is `(provider, providerId)` — not email. Two providers with different
   * `providerId` values that happen to share an email are treated as separate identities
   * unless the implementation explicitly merges them. Implementations must atomically
   * check-and-create to prevent duplicate accounts under concurrent sign-ins.
   */
  findOrCreateByProvider(
    provider: string,
    providerId: string,
    profile: IdentityProfile,
  ): Promise<{ id: string; created: boolean }>;
  /**
   * Link an additional OAuth provider to an existing user account.
   *
   * @param userId - The existing local user ID to link the provider to.
   * @param provider - The provider slug (e.g., `'github'`).
   * @param providerId - The provider's unique ID for this user.
   * @remarks
   * Called by the OAuth link route when an authenticated user connects a new provider.
   * Throws (adapter-specific) if this `(provider, providerId)` pair is already linked
   * to a different user.
   */
  linkProvider(userId: string, provider: string, providerId: string): Promise<void>;
  /**
   * Remove the link between a user account and an OAuth provider.
   *
   * @param userId - The local user ID to unlink the provider from.
   * @param provider - The provider slug to remove.
   * @remarks
   * Called by the OAuth unlink route. Safe to call when the link does not exist
   * (no-op). The auth plugin guards against unlinking the user's last authentication
   * method before calling this — the adapter does not need to enforce that invariant.
   */
  unlinkProvider(userId: string, provider: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Tier 3 — MFA (required when auth.mfa is configured)
// ---------------------------------------------------------------------------

/**
 * MFA adapter methods — required when `auth.mfa` is configured.
 *
 * Manages TOTP secrets, MFA-enabled flags, and backup/recovery codes.
 * Called by the auth plugin during MFA setup and verification flows.
 */
export interface MfaAdapter {
  /**
   * Store or clear the TOTP shared secret for a user.
   *
   * @param userId - The user's ID.
   * @param secret - The base32-encoded TOTP secret, or `null` to clear it
   *   (e.g., when the user disables TOTP).
   */
  setMfaSecret(userId: string, secret: string | null): Promise<void>;
  /**
   * Retrieve the TOTP shared secret for a user.
   *
   * @param userId - The user's ID.
   * @returns The base32-encoded TOTP secret, or `null` if no secret is set.
   */
  getMfaSecret(userId: string): Promise<string | null>;
  /**
   * Return whether MFA is currently enabled for a user.
   *
   * @param userId - The user's ID.
   * @returns `true` if MFA has been activated (the user has completed MFA setup),
   *   `false` otherwise.
   */
  isMfaEnabled(userId: string): Promise<boolean>;
  /**
   * Set the MFA-enabled flag for a user.
   *
   * @param userId - The user's ID.
   * @param enabled - `true` to activate MFA enforcement, `false` to deactivate.
   */
  setMfaEnabled(userId: string, enabled: boolean): Promise<void>;
  /**
   * Replace all recovery codes for a user.
   *
   * @param userId - The user's ID.
   * @param codes - Array of hashed recovery codes to store. Replaces any
   *   existing codes entirely. Codes must be hashed by the caller before
   *   storing — never store plaintext recovery codes.
   */
  setRecoveryCodes(userId: string, codes: string[]): Promise<void>;
  /**
   * Retrieve all stored (hashed) recovery codes for a user.
   *
   * @param userId - The user's ID.
   * @returns Array of hashed recovery code strings. Returns an empty array when
   *   no codes are stored.
   */
  getRecoveryCodes(userId: string): Promise<string[]>;
  /**
   * Remove a single recovery code from the user's stored list.
   *
   * @param userId - The user's ID.
   * @param code - The hashed recovery code to remove.
   * @remarks
   * Safe to call when the code does not exist (no-op). Prefer
   * `CoreAuthAdapter.consumeRecoveryCode()` for atomic find-and-remove during
   * authentication — this method is for administrative removal only.
   */
  removeRecoveryCode(userId: string, code: string): Promise<void>;
  /**
   * Retrieve the list of active MFA methods for a user.
   *
   * @param userId - The user's ID.
   * @returns An array of method identifiers (e.g., `['totp', 'webauthn']`).
   *   Returns an empty array when no methods are registered.
   */
  getMfaMethods?(userId: string): Promise<string[]>;
  /**
   * Replace the list of active MFA methods for a user.
   *
   * @param userId - The user's ID.
   * @param methods - Array of method identifier strings to store. Replaces
   *   the existing list entirely.
   */
  setMfaMethods?(userId: string, methods: string[]): Promise<void>;
}

// ---------------------------------------------------------------------------
// Tier 4 — WebAuthn (required when auth.mfa.webauthn is configured)
// ---------------------------------------------------------------------------

/**
 * WebAuthn adapter methods — required when `auth.mfa.webauthn` is configured.
 *
 * Manages passkey credentials for users. Called during the WebAuthn registration
 * and authentication ceremonies. The `signCount` must be updated on every
 * successful authentication to guard against cloned authenticators.
 */
export interface WebAuthnAdapter {
  /**
   * Retrieve all registered WebAuthn credentials for a user.
   *
   * @param userId - The user's ID.
   * @returns Array of `WebAuthnCredential` records. Returns an empty array when
   *   the user has no registered passkeys.
   */
  getWebAuthnCredentials(userId: string): Promise<WebAuthnCredential[]>;
  /**
   * Persist a newly registered WebAuthn credential.
   *
   * @param userId - The user's ID.
   * @param credential - The full credential record from the registration ceremony,
   *   including the initial `signCount` (often 0 for new credentials).
   * @remarks
   * Called at the end of the WebAuthn registration ceremony after the server has
   * verified the attestation. Implementations should enforce uniqueness on
   * `credential.credentialId` and throw on duplicates.
   */
  addWebAuthnCredential(userId: string, credential: WebAuthnCredential): Promise<void>;
  /**
   * Remove a registered WebAuthn credential.
   *
   * @param userId - The user's ID.
   * @param credentialId - The base64url-encoded credential ID to remove.
   * @remarks
   * Safe to call when the credential does not exist (no-op). The auth plugin
   * guards against removing the user's last authentication method before calling
   * this — the adapter does not need to enforce that invariant.
   */
  removeWebAuthnCredential(userId: string, credentialId: string): Promise<void>;
  /**
   * Update the stored signature counter for a credential after a successful authentication.
   *
   * @param userId - The user's ID.
   * @param credentialId - The base64url-encoded credential ID.
   * @param signCount - The new counter value returned by the authenticator.
   * @remarks
   * Must be called after every successful WebAuthn authentication to advance the
   * replay-protection counter. The auth plugin has already validated that the new
   * `signCount` is greater than the stored value (or both are 0) before calling
   * this method. Out-of-order calls (e.g., from lost network requests) that attempt
   * to set a lower counter than the stored value should be rejected or silently
   * ignored — never decrement the stored counter.
   */
  updateWebAuthnCredentialSignCount(
    userId: string,
    credentialId: string,
    signCount: number,
  ): Promise<void>;
  /**
   * Look up the owner of a credential by its ID.
   *
   * @param credentialId - The base64url-encoded credential ID to search for.
   * @returns The user ID of the credential's owner, or `null` if no matching
   *   credential is found.
   * @remarks
   * Called during the WebAuthn authentication ceremony when the server needs to
   * identify the user before verifying the signature (i.e., when `allowCredentials`
   * is empty / discoverable credentials are used).
   */
  findUserByWebAuthnCredentialId(credentialId: string): Promise<string | null>;
}

// ---------------------------------------------------------------------------
// Tier 5 — Roles (required when auth.roles, auth.defaultRole, or tenancy is configured)
// ---------------------------------------------------------------------------

/**
 * Role management adapter methods — required when `auth.roles`, `auth.defaultRole`,
 * or tenancy is configured.
 *
 * Manages app-wide and tenant-scoped roles for users. Roles are stored as string arrays
 * and included in the JWT claims when tokens are issued.
 */
export interface RolesAdapter {
  /**
   * Retrieve the app-wide roles assigned to a user.
   *
   * @param userId - The user's ID.
   * @returns Array of role strings. Returns an empty array when the user has no
   *   app-wide roles. Role strings are application-defined, case-sensitive, and
   *   matched exactly.
   */
  getRoles(userId: string): Promise<string[]>;
  /**
   * Replace the app-wide roles for a user.
   *
   * @param userId - The user's ID.
   * @param roles - The complete set of roles to assign. Replaces any existing
   *   app-wide roles entirely. Pass an empty array to clear all roles.
   */
  setRoles(userId: string, roles: string[]): Promise<void>;
  /**
   * Add a single app-wide role to a user.
   *
   * @param userId - The user's ID.
   * @param role - The role string to add. Safe to call when the role is already
   *   assigned (no-op / idempotent).
   */
  addRole(userId: string, role: string): Promise<void>;
  /**
   * Remove a single app-wide role from a user.
   *
   * @param userId - The user's ID.
   * @param role - The role string to remove. Safe to call when the role is not
   *   assigned (no-op).
   */
  removeRole(userId: string, role: string): Promise<void>;
  /**
   * Retrieve the tenant-scoped roles assigned to a user within a specific tenant.
   *
   * @param userId - The user's ID.
   * @param tenantId - The tenant to scope the role lookup to.
   * @returns Array of role strings scoped to this tenant. Returns an empty array
   *   when the user has no roles in this tenant.
   */
  getTenantRoles?(userId: string, tenantId: string): Promise<string[]>;
  /**
   * Replace the tenant-scoped roles for a user within a specific tenant.
   *
   * @param userId - The user's ID.
   * @param tenantId - The tenant to scope the role assignment to.
   * @param roles - The complete set of tenant-scoped roles. Replaces existing
   *   tenant roles entirely. Pass an empty array to clear all tenant roles.
   */
  setTenantRoles?(userId: string, tenantId: string, roles: string[]): Promise<void>;
  /**
   * Add a single tenant-scoped role to a user.
   *
   * @param userId - The user's ID.
   * @param tenantId - The tenant to scope the role to.
   * @param role - The role string to add. Idempotent if already assigned.
   */
  addTenantRole?(userId: string, tenantId: string, role: string): Promise<void>;
  /**
   * Remove a single tenant-scoped role from a user.
   *
   * @param userId - The user's ID.
   * @param tenantId - The tenant to scope the role removal to.
   * @param role - The role string to remove. No-op if not assigned.
   */
  removeTenantRole?(userId: string, tenantId: string, role: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Tier 6 — Groups (required when groups is configured)
// ---------------------------------------------------------------------------

/**
 * Group management adapter methods — required when `auth.groups` is configured.
 *
 * Groups aggregate users with shared baseline roles. Members inherit the group's
 * roles plus any per-member extra roles. `getEffectiveRoles` returns the merged role set.
 */
export interface GroupsAdapter {
  /**
   * Create a new group.
   *
   * @param group - The group data excluding auto-generated fields (`id`, `createdAt`, `updatedAt`).
   * @returns An object containing the newly created group's ID.
   * @throws If a group with the same `name` already exists within the same `tenantId` scope
   *   (adapter-specific error).
   */
  createGroup(group: Omit<GroupRecord, 'id' | 'createdAt' | 'updatedAt'>): Promise<{ id: string }>;
  /**
   * Permanently delete a group and all its memberships.
   *
   * @param groupId - The group's ID.
   * @remarks
   * Safe to call when the group does not exist (no-op). Cascade-delete all
   * `GroupMembershipRecord` rows for this group in the same operation.
   */
  deleteGroup(groupId: string): Promise<void>;
  /**
   * Retrieve a single group by ID.
   *
   * @param groupId - The group's ID.
   * @returns The `GroupRecord`, or `null` if no group with this ID exists.
   */
  getGroup(groupId: string): Promise<GroupRecord | null>;
  /**
   * List all groups in a given tenant scope.
   *
   * @param tenantId - `null` to list app-wide groups; a tenant ID string to list
   *   groups scoped to that tenant.
   * @param opts - Optional pagination parameters (`limit` and `cursor`).
   * @returns A paginated result containing `GroupRecord` items and an optional
   *   `nextCursor` for the next page. Returns an empty `items` array when there
   *   are no groups in the requested scope.
   * @remarks
   * Pagination uses opaque cursors — callers must not interpret or construct cursor
   * values. Pass the `nextCursor` from a previous response as `opts.cursor` to
   * fetch the next page. `limit` defaults to 50 and is capped at 200.
   */
  listGroups(
    tenantId: string | null,
    opts?: PaginationOptions,
  ): Promise<PaginatedResult<GroupRecord>>;
  /**
   * Update mutable fields on a group.
   *
   * @param groupId - The group's ID.
   * @param updates - A partial object containing only the fields to change.
   *   Only `roles`, `name`, `displayName`, and `description` may be updated.
   *   `tenantId` is immutable and must not be accepted here.
   * @remarks
   * Performs a partial update — omitted fields are left unchanged. Updating
   * `roles` replaces the baseline roles array entirely with the new value.
   */
  updateGroup(
    groupId: string,
    updates: Partial<Pick<GroupRecord, 'roles' | 'name' | 'displayName' | 'description'>>,
  ): Promise<void>;
  /**
   * Add a user as a member of a group.
   *
   * @param groupId - The group's ID.
   * @param userId - The user's ID.
   * @param roles - Optional per-member extra roles in addition to the group's baseline roles.
   *   Defaults to an empty array when omitted.
   * @remarks
   * Idempotent if the user is already a member — callers may call this again to
   * update `roles` without first removing the membership, though `updateGroupMembership`
   * is preferred for that case.
   */
  addGroupMember(groupId: string, userId: string, roles?: string[]): Promise<void>;
  /**
   * Replace the per-member extra roles for an existing group membership.
   *
   * @param groupId - The group's ID.
   * @param userId - The user's ID.
   * @param roles - The new set of per-member extra roles. Replaces any existing
   *   per-member roles entirely.
   * @throws If the membership does not exist (adapter-specific error).
   */
  updateGroupMembership(groupId: string, userId: string, roles: string[]): Promise<void>;
  /**
   * Remove a user from a group.
   *
   * @param groupId - The group's ID.
   * @param userId - The user's ID.
   * @remarks
   * Safe to call when the membership does not exist (no-op).
   */
  removeGroupMember(groupId: string, userId: string): Promise<void>;
  /**
   * List all members of a group with their per-member roles.
   *
   * @param groupId - The group's ID.
   * @param opts - Optional pagination parameters (`limit` and `cursor`).
   * @returns A paginated result of `{ userId, roles }` objects, where `roles`
   *   contains only the per-member extra roles (not the group's baseline roles).
   * @remarks
   * Pagination uses opaque cursors. `limit` defaults to 50, capped at 200.
   */
  getGroupMembers(
    groupId: string,
    opts?: PaginationOptions,
  ): Promise<PaginatedResult<{ userId: string; roles: string[] }>>;
  /**
   * Retrieve all groups a user belongs to within a tenant scope.
   *
   * @param userId - The user's ID.
   * @param tenantId - `null` to fetch app-wide group memberships; a tenant ID
   *   string to fetch memberships in that tenant's groups only.
   * @returns An array of objects pairing the full `GroupRecord` with the
   *   `membershipRoles` array (the per-member extra roles for this user in
   *   each group). Returns an empty array when the user has no memberships
   *   in the requested scope.
   */
  getUserGroups(
    userId: string,
    tenantId: string | null,
  ): Promise<Array<{ group: GroupRecord; membershipRoles: string[] }>>;
  /**
   * Compute the merged effective role set for a user in a given tenant scope.
   *
   * @param userId - The user's ID.
   * @param tenantId - `null` for the app-wide scope; a tenant ID string for
   *   tenant-scoped effective roles.
   * @returns A deduplicated array of role strings representing the union of:
   *   (1) each group's baseline `roles` and (2) the user's per-membership `roles`
   *   across all groups the user belongs to in the given scope. Returns an empty
   *   array when the user has no group memberships in the scope.
   * @remarks
   * This is the authoritative role computation used when issuing tokens. The
   * result must be the same as manually unioning `group.roles` and
   * `membership.roles` for each entry returned by `getUserGroups()`. Duplicates
   * across groups must be deduplicated in the returned array.
   */
  getEffectiveRoles(userId: string, tenantId: string | null): Promise<string[]>;
}

// ---------------------------------------------------------------------------
// Tier 7 — Suspension (required unless auth.checkSuspensionOnIdentify is explicitly disabled, or when admin.api is configured)
// ---------------------------------------------------------------------------

/**
 * User suspension adapter methods — required unless `auth.checkSuspensionOnIdentify`
 * is explicitly disabled, or when `admin.api` is configured.
 *
 * Suspension prevents a user from authenticating without deleting their account.
 * The auth plugin checks suspension status during identify by default and on refresh
 * before minting fresh credentials.
 */
export interface SuspensionAdapter {
  /**
   * Set or clear the suspension state for a user.
   *
   * @param userId - The user's ID.
   * @param suspended - `true` to suspend the user, `false` to reinstate them.
   * @param reason - Optional human-readable reason for the suspension. Stored as
   *   `suspendedReason` on the user record. Ignored (or cleared) when `suspended`
   *   is `false`.
   * @remarks
   * Calling with `suspended: true` when the user is already suspended should update
   * the `reason` if provided, rather than throwing. Calling with `suspended: false`
   * when the user is already active is a no-op. The auth plugin records the
   * suspension timestamp (`suspendedAt`) separately via `CoreAuthAdapter.getUser()`.
   */
  setSuspended(userId: string, suspended: boolean, reason?: string): Promise<void>;
  /**
   * Retrieve the suspension state of a user.
   *
   * @param userId - The user's ID.
   * @returns An object with `suspended` and an optional `suspendedReason`, or `null`
   *   if no user with this ID exists. An active (non-suspended) user returns
   *   `{ suspended: false }` (not `null`).
   */
  getSuspended(userId: string): Promise<{ suspended: boolean; suspendedReason?: string } | null>;
}

// ---------------------------------------------------------------------------
// Tier 8 — Enterprise (required when auth.m2m, admin.api, or auth.passwordPolicy.preventReuse is configured)
// ---------------------------------------------------------------------------

/**
 * Enterprise adapter methods — required when M2M clients, the admin user-list API,
 * or password-reuse prevention is configured.
 *
 * All methods are individually optional and guarded by their respective config flags.
 * Implement only the methods needed for your configuration.
 */
export interface EnterpriseAdapter {
  /**
   * Look up an M2M client by its public `clientId`.
   *
   * @param clientId - The public client identifier from the `client_credentials` grant request.
   * @returns The client record including its `clientSecretHash`, or `null` if not found
   *   or the client is inactive. The caller must verify the plaintext secret against
   *   `clientSecretHash` using a constant-time comparison.
   * @remarks
   * Required when `auth.m2m` is configured. The `clientSecretHash` must never be
   * logged or included in API responses — it is only for internal verification.
   */
  getM2MClient?(clientId: string): Promise<(M2MClientRecord & { clientSecretHash: string }) | null>;
  /**
   * Create a new M2M client record.
   *
   * @param client - The client data including the pre-hashed `clientSecretHash`.
   *   The plaintext secret must be hashed by the caller before passing here.
   * @returns An object containing the newly created client's surrogate ID.
   * @remarks
   * Required when `auth.m2m` is configured. The `clientId` must be unique;
   * implementations should throw on duplicates.
   */
  createM2MClient?(client: {
    clientId: string;
    clientSecretHash: string;
    name: string;
    scopes: string[];
  }): Promise<{ id: string }>;
  /**
   * Delete an M2M client.
   *
   * @param clientId - The public `clientId` of the client to remove.
   * @remarks
   * Required when `auth.m2m` is configured. Safe to call when the client does
   * not exist (no-op). After deletion, any in-flight tokens issued to this client
   * remain valid until they expire — the auth plugin handles token revocation
   * separately if configured.
   */
  deleteM2MClient?(clientId: string): Promise<void>;
  /**
   * List all M2M clients (without secret hashes).
   *
   * @returns Array of `M2MClientRecord` objects. The `clientSecretHash` is
   *   intentionally excluded — use `getM2MClient()` when the hash is needed.
   *   Returns an empty array when no clients exist.
   * @remarks
   * Required when `auth.m2m` is configured and the admin API is enabled.
   */
  listM2MClients?(): Promise<M2MClientRecord[]>;
  /**
   * List users matching the given query filters.
   *
   * @param query - Filter and pagination options. All filter fields use AND semantics.
   *   `startIndex` and `count` provide SCIM-style offset pagination.
   * @returns An object with:
   *   - `users` — the page of `UserRecord` objects matching the filters.
   *   - `totalResults` — the total count of matching users across all pages,
   *     used by SCIM clients to compute page counts.
   * @remarks
   * Required when `admin.api` is configured. Implementations must respect the
   * `count` cap (max 200) and default `startIndex` to 0 when omitted.
   */
  listUsers?(query: UserQuery): Promise<{ users: UserRecord[]; totalResults: number }>;
  /**
   * Retrieve the stored password hash history for a user.
   *
   * @param userId - The user's ID.
   * @returns An ordered array of past bcrypt (or equivalent) hashes, most recent
   *   first. Returns an empty array when no history exists. Used by the password
   *   policy engine to prevent reuse of recent passwords.
   * @remarks
   * Required when `auth.passwordPolicy.preventReuse` is configured. The returned
   * hashes are used only for comparison via `bcrypt.compare` — they must never
   * be logged or sent to clients. The array length is bounded by the `maxCount`
   * passed to `addPasswordToHistory`.
   */
  getPasswordHistory?(userId: string): Promise<string[]>;
  /**
   * Add a new password hash to the user's history, trimming to `maxCount` entries.
   *
   * @param userId - The user's ID.
   * @param hash - The bcrypt (or equivalent) hash of the password that was just set.
   * @param maxCount - The maximum number of hashes to retain in history. After
   *   inserting the new hash, any entries beyond `maxCount` (oldest first) must
   *   be deleted. This keeps the history bounded.
   * @remarks
   * Required when `auth.passwordPolicy.preventReuse` is configured. Must be called
   * by the auth plugin after a successful password change (not by `setPassword`
   * directly). The caller consults `getPasswordHistory()` before calling this to
   * check for reuse — this method only appends; it does not validate uniqueness.
   */
  addPasswordToHistory?(userId: string, hash: string, maxCount: number): Promise<void>;
}

// ---------------------------------------------------------------------------
// Composite type
// ---------------------------------------------------------------------------

/**
 * The complete auth adapter type — the union of all tier interfaces.
 *
 * `CoreAuthAdapter` is always required. All other tiers are `Partial` because
 * a given deployment may not need OAuth, MFA, WebAuthn, roles, groups, suspension,
 * or enterprise features. The auth plugin validates that the required tier methods
 * are present based on the configured features at startup.
 *
 * @example
 * ```ts
 * import type { AuthAdapter } from '@lastshotlabs/slingshot-core';
 *
 * // A minimal adapter that only supports email/password:
 * const adapter: AuthAdapter = {
 *   findByEmail: async (email) => ...,
 *   create: async (email, hash) => ...,
 *   verifyPassword: async (userId, password) => ...,
 *   getIdentifier: async (userId) => ...,
 *   consumeRecoveryCode: async (userId, code) => false,
 * };
 * ```
 */
export type AuthAdapter = CoreAuthAdapter &
  Partial<OAuthAdapter> &
  Partial<MfaAdapter> &
  Partial<WebAuthnAdapter> &
  Partial<RolesAdapter> &
  Partial<GroupsAdapter> &
  Partial<SuspensionAdapter> &
  Partial<EnterpriseAdapter>;
