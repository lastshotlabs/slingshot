/**
 * Known email providers that ignore dots in the local part and plus-addressing.
 *
 * For these providers, `user.name+tag@gmail.com` and `username@gmail.com` resolve
 * to the same mailbox. Normalising these prevents one person from registering
 * multiple accounts via cosmetic address variations.
 */
const DOT_PLUS_PROVIDERS = new Set(['gmail.com', 'googlemail.com']);

/**
 * Normalises an email address for deduplication and lookup.
 *
 * Applies three transformations:
 * 1. **Case folding** — lowercases the entire address (RFC 5321 §2.4 says the local-part
 *    is technically case-sensitive, but all major providers treat it as case-insensitive).
 * 2. **Plus-addressing removal** — for known providers (Gmail, Googlemail), strips the
 *    `+tag` suffix from the local part so that `user+tag@gmail.com` maps to
 *    `user@gmail.com`.
 * 3. **Dot removal** — for the same providers, removes dots from the local part so that
 *    `u.s.e.r@gmail.com` maps to `user@gmail.com`.
 *
 * Other providers only receive case folding — the local part is treated as opaque per
 * RFC 5321.
 *
 * @param email - The raw email address to normalise.
 * @returns The normalised email string.
 *
 * @example
 * ```ts
 * normalizeEmail('User.Name+tag@Gmail.com');  // → 'username@gmail.com'
 * normalizeEmail('Alice@example.com');         // → 'alice@example.com'
 * ```
 */
export function normalizeEmail(email: string): string {
  const lowered = email.toLowerCase();
  const atIndex = lowered.lastIndexOf('@');
  if (atIndex === -1) return lowered;

  let local = lowered.slice(0, atIndex);
  const domain = lowered.slice(atIndex + 1);

  if (DOT_PLUS_PROVIDERS.has(domain)) {
    // Strip plus-addressing
    const plusIndex = local.indexOf('+');
    if (plusIndex !== -1) {
      local = local.slice(0, plusIndex);
    }
    // Remove dots
    local = local.replace(/\./g, '');
  }

  return `${local}@${domain}`;
}
