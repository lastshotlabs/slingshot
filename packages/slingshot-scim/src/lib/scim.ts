import type { UserQuery, UserRecord } from '@lastshotlabs/slingshot-core';

/**
 * A SCIM 2.0 User resource as defined by RFC 7643 §4.1.
 * Returned by the `/scim/v2/Users` endpoints in JSON response bodies.
 */
export interface ScimUser {
  /** Fixed SCIM schema URN identifying this as a User resource. */
  schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'];
  /** Unique identifier of the user within the service provider. */
  id: string;
  /** External identifier assigned by the provisioning client (e.g. IdP user ID). */
  externalId?: string;
  /** Unique login name, typically the primary email address. */
  userName: string;
  /** Human-readable display name. */
  displayName?: string;
  /** Structured name components. */
  name?: { givenName?: string; familyName?: string; formatted?: string };
  /** Email address list. */
  emails?: Array<{ value: string; primary: boolean }>;
  /** `true` when the account is active (not suspended). */
  active: boolean;
  /** Resource metadata block required by the SCIM spec. */
  meta: { resourceType: 'User'; created?: string; lastModified?: string };
}

/**
 * A SCIM 2.0 `ListResponse` envelope as defined by RFC 7644 §3.4.2.
 * Wraps paginated `ScimUser` results returned by `GET /scim/v2/Users`.
 */
export interface ScimListResponse {
  /** Fixed SCIM schema URN identifying this as a ListResponse. */
  schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'];
  /** Total number of matching resources across all pages. */
  totalResults: number;
  /** 1-based index of the first result in this page. */
  startIndex: number;
  /** Number of resources returned in this page (`Resources.length`). */
  itemsPerPage: number;
  /** The resources on this page. */
  Resources: ScimUser[];
}

/**
 * A SCIM 2.0 error response body as defined by RFC 7644 §3.12.
 * Returned with the appropriate HTTP status code on SCIM errors.
 */
export interface ScimError {
  /** Fixed SCIM error schema URN. */
  schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'];
  /** HTTP status code as a string, e.g. `"400"`. */
  status: string;
  /** RFC 7644 §3.12 SCIM-specific error type keyword, e.g. `"invalidFilter"`. */
  scimType?: string;
  /** Human-readable error description. */
  detail: string;
}

/**
 * Converts a Slingshot `UserRecord` to a SCIM 2.0 `ScimUser` response object.
 *
 * Maps `suspended: true` to `active: false`. Falls back to `user.id` as `userName` when
 * no email is present.
 *
 * @param user - The `UserRecord` from the auth adapter.
 * @param config - Optional mapping config (currently unused; reserved for future `userName` strategy).
 * @returns A `ScimUser` ready for serialisation in a SCIM response body.
 *
 * @example
 * ```ts
 * import { userRecordToScim } from '@lastshotlabs/slingshot-scim';
 *
 * const scimUser = userRecordToScim(userRecord);
 * return Response.json(scimUser, { status: 200 });
 * ```
 */
export function userRecordToScim(
  user: UserRecord,
  config?: { userName?: 'email' | 'username' },
): ScimUser {
  void config;
  const userName = user.email ?? user.id;
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
    id: user.id,
    externalId: user.externalId,
    userName,
    displayName: user.displayName,
    name:
      user.firstName || user.lastName
        ? {
            givenName: user.firstName,
            familyName: user.lastName,
            formatted: [user.firstName, user.lastName].filter(Boolean).join(' ') || undefined,
          }
        : undefined,
    emails: user.email ? [{ value: user.email, primary: true }] : undefined,
    active: !user.suspended,
    meta: { resourceType: 'User' },
  };
}

/**
 * Parses a SCIM filter string into a `UserQuery` object suitable for `AuthAdapter.listUsers`.
 *
 * Supports single-clause `attr eq "value"` filters on: `userName`, `email`, `externalId`,
 * and `active`. Compound expressions (`AND`, `OR`, `NOT`), grouped expressions, and
 * unsupported attributes are rejected and return `null`.
 *
 * @param filter - The raw SCIM `filter` query parameter value.
 * @returns A `UserQuery` object when the filter is valid and parseable.
 *   Returns `{}` (list all) when `filter` is absent or empty.
 *   Returns `null` specifically for compound expressions (`AND`, `OR`, `NOT`),
 *   grouped expressions containing parentheses, unsupported attributes, and any
 *   single-clause expression that does not match the `attr eq "value"` pattern.
 *   Single simple `attr eq "value"` expressions on supported attributes always
 *   return a populated `UserQuery`. Callers must respond with HTTP 400
 *   `scimType: "invalidFilter"` per RFC 7644 §3.4.2.2 when `null` is returned.
 *
 * @example
 * ```ts
 * import { parseScimFilter } from '@lastshotlabs/slingshot-scim';
 *
 * const query = parseScimFilter('userName eq "alice@example.com"');
 * // => { email: 'alice@example.com' }
 *
 * const invalid = parseScimFilter('userName eq "alice" AND active eq "true"');
 * // => null  (compound filter — respond with 400 invalidFilter)
 * ```
 */
export function parseScimFilter(filter?: string): UserQuery | null {
  if (!filter) return {};

  const trimmed = filter.trim();

  // Reject compound / nested expressions before attempting the simple parse so
  // callers get a proper invalidFilter 400 instead of a silently empty result set.
  if (/\b(AND|OR|NOT)\b/i.test(trimmed) || trimmed.includes('(')) {
    return null;
  }

  // Simple single-clause filter: `attr eq "value"`
  const match = trimmed.match(/^(\w+)\s+eq\s+"?([^"]*)"?$/i);
  if (!match) return null;

  const [, attr, value] = match;
  const attrLower = attr.toLowerCase();

  const query: UserQuery = {};

  if (attrLower === 'username' || attrLower === 'email') {
    query.email = value;
  } else if (attrLower === 'externalid') {
    query.externalId = value;
  } else if (attrLower === 'active') {
    const normalized = value.toLowerCase();
    if (normalized !== 'true' && normalized !== 'false') {
      return null;
    }
    query.suspended = value.toLowerCase() !== 'true'; // active=true means suspended=false
  } else {
    return null;
  }

  return query;
}

/**
 * Creates a SCIM 2.0 error `Response` with the correct `application/scim+json` content type.
 *
 * @param status - HTTP status code (e.g. 400, 404, 409).
 * @param detail - Human-readable error detail string.
 * @param scimType - Optional RFC 7644 §3.12 SCIM error type keyword (e.g. `"invalidFilter"`).
 * @returns A `Response` object with the serialised `ScimError` body.
 *
 * @example
 * ```ts
 * import { scimError } from '@lastshotlabs/slingshot-scim';
 *
 * return scimError(404, 'User not found');
 * return scimError(400, 'Unsupported filter syntax', 'invalidFilter');
 * ```
 */
export function scimError(status: number, detail: string, scimType?: string): Response {
  const body: ScimError = {
    schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
    status: String(status),
    ...(scimType ? { scimType } : {}),
    detail,
  };
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/scim+json' },
  });
}
