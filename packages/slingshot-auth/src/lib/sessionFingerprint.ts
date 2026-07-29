import { sha256 } from '@lastshotlabs/slingshot-core';

export type SessionBindingField = 'ip' | 'ua' | 'accept-language';

export interface SessionFingerprintValues {
  readonly ip?: string;
  readonly ua?: string;
  readonly acceptLanguage?: string;
}

/**
 * Computes the canonical session-binding fingerprint used by both authenticated
 * request identification and refresh-token rotation.
 */
export function computeSessionFingerprint(
  fields: readonly SessionBindingField[],
  values: SessionFingerprintValues,
): string {
  const parts = fields.map(field => {
    if (field === 'ip') return values.ip ?? '';
    if (field === 'ua') return values.ua ?? '';
    return values.acceptLanguage ?? '';
  });
  return sha256(parts.join(':'));
}
