-- Applied automatically by createPostgresAdapter() via runMigrations().
-- This file documents the schema created by migration v1.
-- Do not apply this manually if using createPostgresAdapter() — it runs on first connection.

CREATE TABLE IF NOT EXISTS slingshot_users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  password_hash TEXT,
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  suspended BOOLEAN NOT NULL DEFAULT FALSE,
  suspended_reason TEXT,
  suspended_at TIMESTAMPTZ,
  display_name TEXT,
  first_name TEXT,
  last_name TEXT,
  external_id TEXT,
  user_metadata JSONB,
  app_metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS slingshot_oauth_accounts (
  user_id TEXT NOT NULL REFERENCES slingshot_users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (provider, provider_user_id)
);

CREATE TABLE IF NOT EXISTS slingshot_user_roles (
  user_id TEXT NOT NULL REFERENCES slingshot_users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  PRIMARY KEY (user_id, role)
);

CREATE TABLE IF NOT EXISTS slingshot_tenant_roles (
  user_id TEXT NOT NULL REFERENCES slingshot_users(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  role TEXT NOT NULL,
  PRIMARY KEY (user_id, tenant_id, role)
);
