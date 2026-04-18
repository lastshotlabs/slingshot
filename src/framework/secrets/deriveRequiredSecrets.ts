import type { DbConfig } from '../../config/types/db';
import { resolveMongoMode } from '../dbDefaults';

export interface DerivedSecretRequirements {
  /** Secret paths that must be present for the app to start. */
  required: string[];
  /** Secret paths that are used when present but not mandatory. */
  optional: string[];
}

/**
 * Derive the exact secret keys the framework will request at startup based on
 * the app's `DbConfig`.
 *
 * This is the single source of truth for secret requirements — used by startup
 * validation, `slingshot infra check`, and `slingshot secrets check`.
 *
 * **Always required:** `JWT_SECRET`, `SLINGSHOT_DATA_ENCRYPTION_KEY`.
 *
 * **Required vs optional distinction:**
 * - A key in `required` must be present in the secret provider at startup;
 *   missing values cause a hard startup failure with a descriptive error.
 * - A key in `optional` is consumed if present (e.g. `REDIS_USER`,
 *   `REDIS_PASSWORD`) but absence does not fail startup — these credentials
 *   are only sent when the corresponding service is configured to require them.
 *
 * **Redis** (`db.redis !== false`, which is the default):
 * - `required`: `REDIS_HOST`
 * - `optional`: `REDIS_USER`, `REDIS_PASSWORD`
 *
 * **MongoDB `'single'`** (default when `db.mongo` is omitted):
 * - `required`: `MONGO_USER`, `MONGO_PASSWORD`, `MONGO_HOST`, `MONGO_DB`
 *
 * **MongoDB `'separate'`** (separate app + auth databases):
 * - `required`: all `'single'` keys plus `MONGO_AUTH_USER`,
 *   `MONGO_AUTH_PASSWORD`, `MONGO_AUTH_HOST`, `MONGO_AUTH_DB`
 *
 * @param db - The application's `DbConfig` object.
 * @returns A `DerivedSecretRequirements` object with `required` and `optional`
 *   string arrays listing the secret keys the framework will look up.
 */
export function deriveRequiredSecrets(db: DbConfig): DerivedSecretRequirements {
  const required: string[] = ['JWT_SECRET', 'SLINGSHOT_DATA_ENCRYPTION_KEY'];
  const optional: string[] = [];

  // Redis — enabled by default
  if (db.redis !== false) {
    required.push('REDIS_HOST');
    optional.push('REDIS_USER', 'REDIS_PASSWORD');
  }

  // MongoDB — defaults to 'single' in the framework
  const mongo = resolveMongoMode(db);
  if (mongo === 'single') {
    required.push('MONGO_USER', 'MONGO_PASSWORD', 'MONGO_HOST', 'MONGO_DB');
  } else if (mongo === 'separate') {
    required.push('MONGO_USER', 'MONGO_PASSWORD', 'MONGO_HOST', 'MONGO_DB');
    required.push('MONGO_AUTH_USER', 'MONGO_AUTH_PASSWORD', 'MONGO_AUTH_HOST', 'MONGO_AUTH_DB');
  }

  return { required, optional };
}
