/**
 * MongoDB integration entrypoint.
 *
 * Re-exports all MongoDB-related helpers from the framework's internal `lib/mongo`
 * module, the auth adapter, the auth user model, and the Zod-to-Mongoose schema
 * converter. Import from this entrypoint rather than reaching into internal paths.
 *
 * **Connection management**
 * - {@link connectMongo} — connect both auth and app databases in one call.
 * - {@link connectAuthMongo} / {@link connectAppMongo} — connect each database
 *   individually when separate connection lifecycle is needed.
 * - {@link disconnectMongo} — gracefully close a connection.
 * - {@link getMongoFromApp} — retrieve the live connections from app context.
 * - {@link getMongooseModule} — lazily load the `mongoose` module (throws if not
 *   installed, prompting `bun add mongoose`).
 *
 * **Auth**
 * - {@link createMongoAuthAdapter} — Mongoose-backed auth adapter for the auth plugin.
 * - {@link createAuthUserModel} — Mongoose model factory for the `AuthUser` collection.
 *
 * **Schema utilities**
 * - {@link zodToMongoose} — Convert a Zod schema to a Mongoose `SchemaDefinition`.
 *
 * @example
 * ```ts
 * import { connectMongo, getMongoFromApp } from '@lastshotlabs/slingshot/mongo';
 *
 * const { authConn, appConn } = await connectMongo(authCreds, appCreds);
 * ```
 */

export {
  connectMongo,
  connectAuthMongo,
  connectAppMongo,
  disconnectMongo,
  getMongoFromApp,
  getMongooseModule,
} from '../lib/mongo';
export type { MongoConnections } from '../lib/mongo';
export { createMongoAuthAdapter } from '@auth/adapters/mongoAuth';
export { createAuthUserModel } from '@auth/models/AuthUser';
export { zodToMongoose } from '@framework/lib/zodToMongoose';
export type { ZodToMongooseConfig, ZodToMongooseRefConfig } from '@framework/lib/zodToMongoose';
