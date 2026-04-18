import type { StoreType } from '@lastshotlabs/slingshot-core';

export type MongoMode = 'single' | 'separate' | false;

export interface DbDefaultsInput {
  sqlite?: string;
  postgres?: string;
  mongo?: MongoMode;
  sessions?: StoreType;
  oauthState?: StoreType;
  cache?: StoreType;
  auth?: StoreType;
}

/**
 * Resolve the effective Mongo connection mode when `db.mongo` is omitted.
 *
 * A bare legacy config still defaults to Mongo, but a config that selects a
 * durable non-Mongo backend or explicitly sets auth away from Mongo should not
 * silently require Mongo secrets.
 */
export function resolveMongoMode(db: DbDefaultsInput): MongoMode {
  if (db.mongo !== undefined) return db.mongo;

  if ([db.sessions, db.oauthState, db.cache, db.auth].includes('mongo')) return 'single';
  if (db.sqlite || db.postgres) return false;
  if (db.auth && db.auth !== 'mongo') return false;

  return 'single';
}
