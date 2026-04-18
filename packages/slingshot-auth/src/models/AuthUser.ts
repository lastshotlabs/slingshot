import type { Connection, Document, Model, Mongoose } from 'mongoose';

/**
 * Mongoose document shape for the `AuthUser` collection.
 *
 * Represents a single user in the slingshot-auth MongoDB-backed auth adapter.
 * The schema enforces uniqueness on `email`, `identifier`, `externalId`, and
 * individual `providerIds` entries (all sparse so null values don't collide),
 * which preserves a one-to-one mapping between an external OAuth identity and
 * a local user.
 *
 * @remarks
 * This interface is internal to the Mongoose auth adapter.  It is not
 * exported from slingshot-auth's public API surface.  Consumer code interacts
 * with users through the `AuthAdapter` interface, not this model directly.
 */
interface IAuthUser {
  /** User's email address (lowercased, sparse unique index). */
  email?: string | null;
  /**
   * Primary login identifier — equals `email` when `primaryField="email"`,
   * or the username / phone number when another primary field is configured.
   * Lowercased, sparse unique index.
   */
  identifier?: string | null;
  /** bcrypt-hashed password.  `null` for OAuth-only accounts. */
  password?: string | null;
  /**
   * Compound provider keys for linked OAuth identities.
   * Format: `"<provider>:<providerUserId>"`, e.g. `"google:123456"`.
   * Indexed for fast lookups via `findOne({ providerIds: key })`.
   */
  providerIds?: string[];
  /** App-defined roles assigned to this user, e.g. `["admin", "editor"]`. */
  roles: string[];
  /** Whether the user's email address has been verified via the email-verification flow. */
  emailVerified: boolean;
  /**
   * TOTP secret for MFA.  Plain Base32 in development; encrypted with
   * `encryptField` (AES-GCM) in production when data encryption keys are set.
   * `null` when MFA has not been set up.
   */
  mfaSecret?: string | null;
  /**
   * Whether MFA is enabled.  `true` only after the user has confirmed their
   * TOTP secret via `verifySetup`.  A stored `mfaSecret` with `mfaEnabled=false`
   * means setup was initiated but not confirmed.
   */
  mfaEnabled?: boolean;
  /**
   * SHA-256 hashed one-time recovery codes.  Codes are consumed atomically
   * via `consumeRecoveryCode` and removed from the array on use.
   */
  recoveryCodes?: string[];
  /**
   * MFA methods currently enabled for this user.
   * Possible values: `"totp"`, `"emailOtp"`, `"webauthn"`.
   * Example: `["totp", "emailOtp"]`.
   */
  mfaMethods?: string[];
  /**
   * WebAuthn / FIDO2 credentials registered by the user (security keys,
   * Touch ID, Face ID, etc.).  Each entry is identified by `credentialId`
   * and carries the public key for verification.
   */
  webauthnCredentials?: Array<{
    /** Base64url-encoded credential ID assigned by the authenticator. */
    credentialId: string;
    /** Base64url-encoded COSE public key for assertion verification. */
    publicKey: string;
    /** Monotonically increasing signature counter for clone detection. */
    signCount: number;
    /** Authenticator transport hints (`"usb"`, `"ble"`, `"nfc"`, `"internal"`, `"hybrid"`). */
    transports?: string[];
    /** Optional human-readable label set by the user (e.g. `"YubiKey 5"`). */
    name?: string;
    /** When the credential was registered. */
    createdAt: Date;
  }>;
  /** User's display name (concatenated or set directly). */
  displayName?: string;
  /** User's given name. */
  firstName?: string;
  /** User's family name. */
  lastName?: string;
  /**
   * External system ID for mapping to records in a separate system.
   * Sparse unique index so multiple users can have `null` without conflicting.
   */
  externalId?: string;
  /** Whether the account is suspended.  Suspended users cannot log in. */
  suspended: boolean;
  /** When the account was suspended. */
  suspendedAt?: Date;
  /** Human-readable reason for suspension (admin-provided). */
  suspendedReason?: string;
  /**
   * Previous bcrypt password hashes stored for reuse prevention.
   * Oldest hashes first; the array is trimmed to `config.passwordPolicy.preventReuse` length.
   */
  passwordHistory?: string[];
  /**
   * Arbitrary user-visible metadata set by the application.
   * Not used internally — provided for app-specific profile data.
   */
  userMetadata?: Record<string, unknown>;
  /**
   * Arbitrary server-side metadata.  Not visible to the end user.
   * Suitable for flags, internal labels, and integration data.
   */
  appMetadata?: Record<string, unknown>;
}

type AuthUserDocument = IAuthUser & Document;

/**
 * Creates (or retrieves a cached) Mongoose `AuthUser` model on the given connection.
 *
 * Checks `conn.models['AuthUser']` before defining a new schema to avoid the
 * "Cannot overwrite model once compiled" error in environments where modules are
 * re-evaluated (e.g. hot reload, test runners that re-import modules between tests).
 * When absent, defines the schema and registers the model on the connection.
 *
 * @param conn - The Mongoose `Connection` to register the model on.  Use a
 *   per-app connection (not `mongoose.connection`) to avoid cross-app state
 *   pollution in multi-tenant setups.
 * @param mongooseInstance - The `Mongoose` class instance used for `Schema`
 *   and `model` construction.  Accepts a locally imported instance so callers
 *   control the mongoose version and avoid peer-dep version skew.
 * @returns The `AuthUser` Mongoose `Model<AuthUserDocument>` registered on `conn`.
 *
 * @remarks
 * Model caching is per-connection: two different `Connection` instances each get
 * their own independent model registration.  This is intentional — each `createApp()`
 * call in a multi-tenant setup receives its own Mongo connection and therefore its
 * own model reference with zero cross-app state pollution.
 *
 * The schema uses `{ timestamps: true }` so Mongoose automatically manages
 * `createdAt` and `updatedAt`. The `providerIds` array carries a sparse unique multikey
 * index so each external OAuth identity can belong to only one local user, while `email`
 * and `identifier` use sparse unique indexes so `null` values do not collide.
 *
 * @example
 * import mongoose from 'mongoose';
 *
 * const conn = await mongoose.createConnection(uri).asPromise();
 * const AuthUser = createAuthUserModel(conn, mongoose);
 * const user = await AuthUser.findOne({ email: 'alice@example.com' });
 */
export function createAuthUserModel(
  conn: Connection,
  mongooseInstance: Mongoose,
): Model<AuthUserDocument> {
  if ('AuthUser' in conn.models) return conn.models['AuthUser'] as Model<AuthUserDocument>;

  const { Schema } = mongooseInstance;
  const schema = new Schema<AuthUserDocument>(
    {
      email: { type: String, unique: true, sparse: true, lowercase: true },
      /** Primary login identifier — equals email when primaryField="email", username or phone otherwise. */
      identifier: { type: String, unique: true, sparse: true, lowercase: true },
      password: { type: String },
      /** Compound provider keys: ["google:123456", "apple:000111"] */
      providerIds: { type: [{ type: String }], default: undefined },
      /** App-defined roles assigned to this user: ["admin", "editor", ...] */
      roles: [{ type: String }],
      /** Whether the user's email address has been verified. */
      emailVerified: { type: Boolean, default: false },
      /** TOTP secret for MFA. */
      mfaSecret: { type: String, default: null },
      /** Whether MFA is enabled. */
      mfaEnabled: { type: Boolean, default: false },
      /** SHA-256 hashed recovery codes for MFA. */
      recoveryCodes: [{ type: String }],
      /** MFA methods enabled for this user. */
      mfaMethods: [{ type: String }],
      /** WebAuthn credentials (security keys / platform authenticators). */
      webauthnCredentials: [
        {
          credentialId: { type: String, required: true },
          publicKey: { type: String, required: true },
          signCount: { type: Number, required: true, default: 0 },
          transports: [{ type: String }],
          name: { type: String },
          createdAt: { type: Date, default: Date.now },
        },
      ],
      displayName: { type: String, default: null },
      firstName: { type: String, default: null },
      lastName: { type: String, default: null },
      externalId: { type: String, default: null, index: true, sparse: true },
      suspended: { type: Boolean, default: false },
      suspendedAt: { type: Date, default: null },
      suspendedReason: { type: String, default: null },
      /** Previous bcrypt password hashes for reuse prevention. */
      passwordHistory: [{ type: String }],
      userMetadata: { type: Schema.Types.Mixed, default: {} },
      appMetadata: { type: Schema.Types.Mixed, default: {} },
    },
    // autoIndex: false — indexes are created explicitly (tests via ensureNewIndexes,
    // production via the application startup path). Prevents autoIndex from hanging
    // on the first write when Mongoose triggers ensureIndexes() asynchronously.
    { timestamps: true, autoIndex: false },
  );

  schema.index({ providerIds: 1 }, { unique: true, sparse: true });
  return conn.model<AuthUserDocument>('AuthUser', schema);
}
