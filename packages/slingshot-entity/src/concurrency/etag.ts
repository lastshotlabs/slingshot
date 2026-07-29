const ENTITY_ETAG_PREFIX = 'slingshot.';
const ENTITY_ETAG_PATTERN = /^"slingshot\.([A-Za-z0-9_-]+)"$/;

/** The decoded identity and version carried by a Slingshot entity ETag. */
export interface ParsedEntityEtag {
  /** Resolved entity storage name encoded into the tag. */
  readonly storageName: string;
  /** String form of the entity primary key encoded into the tag. */
  readonly id: string;
  /** Positive entity version encoded into the tag. */
  readonly version: number;
}

function assertEtagPart(value: string, label: string): void {
  if (value.length === 0) {
    throw new TypeError(`Entity ETag ${label} must not be empty`);
  }
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decodeBase64Url(value: string): string {
  const padded = value
    .replaceAll('-', '+')
    .replaceAll('_', '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/** Encode one entity identity/version tuple as the canonical strong ETag. */
export function encodeEntityEtag(
  storageName: string,
  id: string | number,
  version: number,
): string {
  assertEtagPart(storageName, 'storage name');
  const stringId = String(id);
  assertEtagPart(stringId, 'id');
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new TypeError('Entity ETag version must be a positive safe integer');
  }
  const payload = encodeBase64Url(JSON.stringify([storageName, stringId, version]));
  return `"${ENTITY_ETAG_PREFIX}${payload}"`;
}

/**
 * Parse one canonical strong Slingshot entity ETag.
 *
 * Weak tags, wildcards, comma-separated alternatives, non-canonical base64url,
 * malformed JSON, and invalid tuple values are rejected.
 */
export function parseEntityEtag(value: string): ParsedEntityEtag {
  const candidate = value.trim();
  const match = ENTITY_ETAG_PATTERN.exec(candidate);
  if (!match) {
    throw new TypeError('If-Match must contain exactly one strong Slingshot entity ETag');
  }

  let decoded: string;
  try {
    decoded = decodeBase64Url(match[1]);
  } catch {
    throw new TypeError('If-Match contains a malformed Slingshot entity ETag');
  }

  let tuple: unknown;
  try {
    tuple = JSON.parse(decoded);
  } catch {
    throw new TypeError('If-Match contains a malformed Slingshot entity ETag');
  }
  if (
    !Array.isArray(tuple) ||
    tuple.length !== 3 ||
    typeof tuple[0] !== 'string' ||
    tuple[0].length === 0 ||
    typeof tuple[1] !== 'string' ||
    tuple[1].length === 0 ||
    !Number.isSafeInteger(tuple[2]) ||
    (tuple[2] as number) < 1
  ) {
    throw new TypeError('If-Match contains an invalid Slingshot entity ETag payload');
  }

  const parsed = {
    storageName: tuple[0],
    id: tuple[1],
    version: tuple[2] as number,
  };
  if (encodeEntityEtag(parsed.storageName, parsed.id, parsed.version) !== candidate) {
    throw new TypeError('If-Match contains a non-canonical Slingshot entity ETag');
  }
  return Object.freeze(parsed);
}
