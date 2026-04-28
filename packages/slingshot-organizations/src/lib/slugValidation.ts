import { z } from 'zod';

/**
 * Default reserved slug words that callers cannot use to name an organization.
 *
 * The list intentionally captures common conflict-prone subdomain or path values
 * that operators usually want to keep available for internal infrastructure.
 */
export const DEFAULT_RESERVED_ORG_SLUGS: ReadonlyArray<string> = Object.freeze([
  'admin',
  'api',
  'app',
  'auth',
  'public',
  'www',
  'system',
  'root',
  'support',
  'help',
]);

/**
 * DNS-safe slug pattern: lower-case alphanumerics with optional internal dashes,
 * up to 63 characters, and never starting or ending with a dash.
 */
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Build a Zod schema enforcing the DNS-safe slug pattern and reserved-word list.
 *
 * @param reservedWords - Words that must not be used as a slug. Pass `[]` to disable
 *   the reserved-word check entirely. Reserved-word matches are case-insensitive.
 */
export function createOrgSlugSchema(
  reservedWords: ReadonlyArray<string> = DEFAULT_RESERVED_ORG_SLUGS,
): z.ZodType<string> {
  const reservedSet = new Set(reservedWords.map(word => word.trim().toLowerCase()));
  return z
    .string()
    .min(1, 'slug must not be empty')
    .max(63, 'slug must be at most 63 characters')
    .regex(
      SLUG_PATTERN,
      'slug must be DNS-safe: lower-case alphanumerics and internal dashes only, no leading or trailing dash',
    )
    .refine(value => !reservedSet.has(value.toLowerCase()), {
      message: 'slug is reserved and cannot be used',
    });
}

/**
 * Validate a slug, throwing a Zod error on failure.
 *
 * Convenience wrapper around `createOrgSlugSchema(reservedWords).parse(slug)`.
 */
export function assertValidOrgSlug(
  slug: unknown,
  reservedWords: ReadonlyArray<string> = DEFAULT_RESERVED_ORG_SLUGS,
): string {
  return createOrgSlugSchema(reservedWords).parse(slug);
}
