import type { DbConfig } from '../../../src/app';

export const DEFAULT_TEST_POSTGRES_URL =
  'postgresql://postgres:postgres@localhost:5433/slingshot_test';

const POSTGRES_E2E_TABLES = [
  'auth_oauth_reauth_confirmations',
  'auth_oauth_reauth_states',
  'auth_oauth_codes',
  'auth_oauth_state',
  'auth_reset_tokens',
  'auth_verification_tokens',
  'auth_magic_links',
  'auth_deletion_cancel_tokens',
  'auth_mfa_challenges',
  'auth_saml_request_ids',
  'auth_rate_limits',
  'auth_credential_stuffing',
  'auth_locked_accounts',
  'auth_lockout_attempts',
  'auth_sessions',
  'cache_entries',
  'ws_messages',
  'slingshot_upload_registry',
  'slingshot_idempotency',
  'slingshot_cron_registry',
  'slingshot_audit_logs',
  'slingshot_group_memberships',
  'slingshot_groups',
  'slingshot_webauthn_credentials',
  'slingshot_recovery_codes',
  'slingshot_tenant_roles',
  'slingshot_user_roles',
  'slingshot_oauth_accounts',
  'slingshot_users',
] as const;

export function resolveTestPostgresUrl(): string {
  return process.env.TEST_POSTGRES_URL ?? DEFAULT_TEST_POSTGRES_URL;
}

export function dbConfigUsesPostgres(db: DbConfig): boolean {
  return [db.sessions, db.oauthState, db.cache, db.auth].includes('postgres');
}

export async function resetPostgresE2eState(connectionString: string): Promise<void> {
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString });

  try {
    for (const table of POSTGRES_E2E_TABLES) {
      try {
        await pool.query(`TRUNCATE TABLE ${table} RESTART IDENTITY CASCADE`);
      } catch (error) {
        const code =
          typeof error === 'object' && error !== null && 'code' in error
            ? String((error as { code?: unknown }).code ?? '')
            : '';
        if (code !== '42P01') {
          throw error;
        }
      }
    }
  } finally {
    await pool.end();
  }
}
