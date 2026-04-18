/**
 * Recursively freezes an object and all of its nested plain-object values.
 *
 * @param value - The root value to freeze. Primitives and `null` are returned unchanged.
 * @returns The same reference, now deeply frozen. No copy is made.
 *
 * @remarks
 * **Deep vs shallow**: `Object.freeze` is inherently shallow — it only prevents
 * top-level property mutations. `deepFreeze` recurses into all enumerable own values
 * that are non-null objects and not already frozen. This means nested config objects
 * (e.g., `config.sessionPolicy`, `config.mfa`) are also immutable after the call.
 *
 * Frozen objects throw `TypeError` on mutation attempts in strict mode (all TypeScript
 * modules) and silently ignore mutations in sloppy mode.
 *
 * Arrays and class instances embedded in the value tree are also frozen if encountered
 * during the traversal. Primitive values (string, number, boolean) are skipped.
 *
 * **Caution**: Do not deep-freeze config objects that hold mutable runtime references
 * (e.g., database adapters, permission adapters). Use `Object.freeze()` (shallow) for
 * those instead.
 *
 * @example
 * ```ts
 * import { deepFreeze } from '@lastshotlabs/slingshot-core';
 *
 * const config = deepFreeze({
 *   mountPath: '/chat',
 *   pageSize: 50,
 *   permissions: { createRoom: ['admin'] },
 * });
 *
 * // TypeScript modules run in strict mode — this throws TypeError:
 * config.permissions.createRoom = []; // Cannot assign to read-only property
 * ```
 */
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }

  return value;
}
