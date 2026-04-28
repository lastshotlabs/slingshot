import { HeaderInjectionError, sanitizeHeaderValue } from '@lastshotlabs/slingshot-core';
import type { MailAddress, MailMessage } from '../types/provider';
import { MailSendError } from '../types/provider';

/**
 * Convert a {@link MailAddress} to its RFC 5322 wire form, rejecting any
 * input that contains `\r`, `\n`, or NUL — those bytes would let an
 * attacker forge additional message headers when the resulting string is
 * used as `From`, `To`, `Reply-To`, or any other address header.
 *
 * Throws {@link MailSendError} (non-retryable) when the input is unsafe so
 * the surrounding queue worker treats the failure as permanent rather than
 * silently stripping and producing surprising mail.
 */
export function formatSafeAddress(addr: MailAddress, header?: string): string {
  if (typeof addr === 'string') {
    return ensureSafe(addr, header);
  }
  const email = ensureSafe(addr.email, header);
  if (addr.name) {
    const name = ensureSafe(addr.name, header);
    return `${name} <${email}>`;
  }
  return email;
}

/**
 * Reject `\r`, `\n`, NUL inside a header-bound string and convert the
 * shared `HeaderInjectionError` into a non-retryable {@link MailSendError}.
 */
export function ensureSafe(value: string, header?: string): string {
  try {
    return sanitizeHeaderValue(value, header);
  } catch (err) {
    if (err instanceof HeaderInjectionError) {
      throw new MailSendError(
        header
          ? `Refusing to send mail: ${header} contains CR, LF, or NUL`
          : 'Refusing to send mail: header value contains CR, LF, or NUL',
        false,
      );
    }
    throw err;
  }
}

/**
 * Validate the header-bound fields on a {@link MailMessage} before handing
 * the message to a provider. Non-mutating — returns nothing on success and
 * throws on injection. Headers map values are checked but their keys are
 * left to the provider (provider SDKs typically reject malformed names).
 */
export function assertSafeMailHeaders(message: MailMessage): void {
  ensureSafe(message.subject, 'Subject');
  if (message.headers) {
    for (const [key, value] of Object.entries(message.headers)) {
      if (typeof value === 'string') {
        ensureSafe(value, key);
      }
    }
  }
}
