/**
 * Tests whether a glob `pattern` matches an event key string.
 *
 * `*` in the pattern matches any sequence of characters (including `.` and `:`).
 * All other regex special characters in the pattern are escaped.
 *
 * @param pattern - A subscription pattern (e.g. `'auth:*'`, `'community:thread.*'`).
 * @param event - The bus event key to test against the pattern.
 * @returns `true` if the event matches the pattern; `false` otherwise.
 *
 * @remarks
 * - `.` in a pattern matches the literal dot character — it has no special regex meaning
 *   because all regex metacharacters (except `*`) are escaped before the pattern is compiled.
 * - `*` is expanded to `[\s\S]*`, meaning it matches **any** sequence of zero or more
 *   characters, including `.`, `:`, and segment separators. There is no `**` syntax —
 *   a single `*` already crosses segment boundaries.
 *
 * @example
 * ```ts
 * matchGlob('auth:*', 'auth:login'); // true
 * matchGlob('auth:*', 'community:thread.created'); // false
 * matchGlob('*', 'any.event'); // true
 * ```
 */
export function matchGlob(pattern: string, event: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[\\s\\S]*');
  return new RegExp('^' + escaped + '$').test(event);
}
