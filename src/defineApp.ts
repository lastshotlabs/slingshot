import type { CreateServerConfig } from './server';

/**
 * Canonical declarative app config shape.
 *
 * Alias of {@link CreateServerConfig} surfaced under a friendlier name. Users
 * author this in `app.config.ts` and the framework boots from the default
 * export.
 */
export type AppConfig<T extends object = object> = CreateServerConfig<T>;

/**
 * Declare a Slingshot application.
 *
 * Identity wrapper that provides typed inference for `app.config.ts` without
 * forcing users to annotate the config object themselves. The return value is
 * the config object, ready to be passed to `createServer()` by the framework
 * runner.
 *
 * @example
 * ```ts
 * // app.config.ts
 * import { defineApp } from '@lastshotlabs/slingshot';
 * import { createAuthPlugin } from '@lastshotlabs/slingshot-auth';
 *
 * export default defineApp({
 *   meta: { name: 'my-app', version: '1.0.0' },
 *   routesDir: import.meta.dir + '/routes',
 *   plugins: [createAuthPlugin({ ... })],
 * });
 * ```
 */
export function defineApp<T extends object = object>(config: AppConfig<T>): AppConfig<T> {
  return config;
}
