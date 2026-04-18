import { sql } from 'drizzle-orm';
import { boolean, integer, jsonb, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

export const users = pgTable('slingshot_users', {
  id: text('id').primaryKey(),
  email: text('email').unique(),
  passwordHash: text('password_hash'),
  emailVerified: boolean('email_verified').default(false).notNull(),
  suspended: boolean('suspended').default(false).notNull(),
  suspendedReason: text('suspended_reason'),
  suspendedAt: timestamp('suspended_at', { withTimezone: true }),
  displayName: text('display_name'),
  firstName: text('first_name'),
  lastName: text('last_name'),
  externalId: text('external_id'),
  userMetadata: jsonb('user_metadata').$type<Record<string, unknown>>(),
  appMetadata: jsonb('app_metadata').$type<Record<string, unknown>>(),
  // Tier 3 — MFA (added in migration v2)
  mfaSecret: text('mfa_secret'),
  mfaEnabled: boolean('mfa_enabled').default(false).notNull(),
  mfaMethods: text('mfa_methods')
    .array()
    .notNull()
    .default(sql`ARRAY[]::text[]`),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// Tier 3 — recovery codes are a separate table so consumeRecoveryCode can be
// a single atomic DELETE ... RETURNING rather than a read-modify-write cycle.
export const recoveryCodes = pgTable(
  'slingshot_recovery_codes',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
  },
  t => [primaryKey({ columns: [t.userId, t.codeHash] })],
);

// Tier 4 — WebAuthn credentials (added in migration v2)
export const webauthnCredentials = pgTable('slingshot_webauthn_credentials', {
  credentialId: text('credential_id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  publicKey: text('public_key').notNull(),
  signCount: integer('sign_count').default(0).notNull(),
  transports: text('transports').array(), // nullable — not all authenticators report transports
  name: text('name'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const oauthAccounts = pgTable(
  'slingshot_oauth_accounts',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    providerUserId: text('provider_user_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  t => [primaryKey({ columns: [t.provider, t.providerUserId] })],
);

export const userRoles = pgTable(
  'slingshot_user_roles',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
  },
  t => [primaryKey({ columns: [t.userId, t.role] })],
);

export const tenantRoles = pgTable(
  'slingshot_tenant_roles',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tenantId: text('tenant_id').notNull(),
    role: text('role').notNull(),
  },
  t => [primaryKey({ columns: [t.userId, t.tenantId, t.role] })],
);

// Tier 6 — Groups (added in migration v2)
export const groups = pgTable('slingshot_groups', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  displayName: text('display_name'),
  description: text('description'),
  roles: text('roles')
    .array()
    .notNull()
    .default(sql`ARRAY[]::text[]`),
  tenantId: text('tenant_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const groupMemberships = pgTable(
  'slingshot_group_memberships',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    groupId: text('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    roles: text('roles')
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    tenantId: text('tenant_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  t => [primaryKey({ columns: [t.userId, t.groupId] })],
);
