import { isProd } from '@auth/lib/env';
import type { IdentityProfile } from '@lastshotlabs/slingshot-core';

/**
 * Normalised SAML identity profile extracted from a successful login response.
 *
 * Produced by `validateSamlResponse` and passed to the OAuth/SAML route handler
 * for user provisioning.  All fields except `nameId` and `attributes` are
 * optional because IdP attribute sets vary widely.
 */
export interface SamlProfile {
  /** The NameID value from the SAML assertion — used as the primary subject identifier. */
  nameId: string;
  /** NameID format URI (e.g. `"urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress"`). */
  nameIdFormat?: string;
  /** User email address, resolved via `SamlAttributeMapping.email`. Falls back to `nameId`. */
  email?: string;
  /** User's given name, resolved via `SamlAttributeMapping.firstName`. */
  firstName?: string;
  /** User's family name, resolved via `SamlAttributeMapping.lastName`. */
  lastName?: string;
  /** Concatenated `firstName + " " + lastName` when both are present. */
  displayName?: string;
  /** Group membership list, resolved via `SamlAttributeMapping.groups`. */
  groups?: string[];
  /** Raw assertion attributes keyed by attribute name. */
  attributes: Record<string, string | string[]>;
}

/**
 * Maps IdP-specific SAML attribute names to the normalised `SamlProfile` fields.
 *
 * Each property is the attribute key in the IdP's assertion to read for the
 * corresponding profile field.  When a field is omitted the default attribute
 * name is used (e.g. `"email"` for email, `"firstName"` for firstName).
 *
 * @example
 * // Azure AD uses different attribute names
 * const mapping: SamlAttributeMapping = {
 *   email: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
 *   firstName: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname',
 *   lastName: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname',
 *   groups: 'http://schemas.microsoft.com/ws/2008/06/identity/claims/groups',
 * };
 */
export interface SamlAttributeMapping {
  /** Attribute key for the user's email address. Defaults to `"email"`. */
  email?: string;
  /** Attribute key for the user's given name. Defaults to `"firstName"`. */
  firstName?: string;
  /** Attribute key for the user's family name. Defaults to `"lastName"`. */
  lastName?: string;
  /** Attribute key for the user's group memberships. Defaults to `"groups"`. */
  groups?: string;
}

/** Opaque handle for a samlify IdentityProvider instance. Only passed to SP methods — no methods called on it directly. */
export type SamlifyIdpInstance = Record<string, unknown>;

interface SamlLoginRequest {
  id: string;
  context: string;
  entityEndpoint: string;
}

interface SamlParseResult {
  extract: {
    attributes: Record<string, string | string[]>;
    nameID: string;
  };
}

/**
 * Minimal interface for a samlify `ServiceProvider` instance.
 *
 * Only the methods consumed by slingshot-auth are declared here.  The full
 * samlify SP type is not imported directly so that `samlify` remains an
 * optional peer dependency — slingshot-auth casts the real instance via
 * `as unknown as SamlifySpInstance` at init time.
 */
export interface SamlifySpInstance {
  createLoginRequest(idp: SamlifyIdpInstance, binding: string): SamlLoginRequest;
  parseLoginResponse(
    idp: SamlifyIdpInstance,
    binding: string,
    args: { body: { SAMLResponse: string } },
    requestId?: string,
  ): Promise<SamlParseResult>;
  getMetadata(): string;
}

/**
 * Initialised SP + IdP instance pair returned by `initSaml`.
 *
 * Pass both handles to `createAuthnRequest` and `validateSamlResponse`.
 * The `idp` handle is opaque — it is never called directly by slingshot-auth
 * and is only forwarded to SP methods.
 */
export interface SamlInstances {
  /** The configured samlify `ServiceProvider` instance. */
  sp: SamlifySpInstance;
  /** The configured samlify `IdentityProvider` instance. */
  idp: SamlifyIdpInstance;
}

/**
 * Initialises a SAML 2.0 service provider and identity provider from config.
 *
 * Dynamically imports `samlify` (optional peer dependency) and constructs SP
 * and IdP instances.  The IdP metadata can be supplied either as a URL (fetched
 * at startup) or as a raw XML string.
 *
 * @param config - SAML configuration from `AuthConfig.saml`.
 * @returns A `SamlInstances` object containing the SP and IdP handles.
 *
 * @throws {Error} When `config.idpMetadata` is an HTTP URL in production
 *   (HTTPS required for production IdP metadata endpoints).
 * @throws {Error} When the `samlify` package is not installed.
 *
 * @example
 * import { initSaml } from '@lastshotlabs/slingshot-auth';
 *
 * const { sp, idp } = await initSaml({
 *   entityId: 'https://app.example.com/auth/saml/metadata',
 *   acsUrl: 'https://app.example.com/auth/saml/callback',
 *   idpMetadata: 'https://idp.example.com/metadata',
 *   signingCert: process.env.SAML_SIGNING_CERT!,
 *   signingKey: process.env.SAML_SIGNING_KEY!,
 * });
 *
 * @remarks
 * Call this once at startup and store the result on the auth runtime context.
 * Re-initialising on every request is expensive — it involves an HTTP fetch
 * for URL-based metadata.
 */
export async function initSaml(
  config: import('../config/authConfig').SamlConfig,
): Promise<SamlInstances> {
  const metadataUrl =
    config.idpMetadata.startsWith('http://') || config.idpMetadata.startsWith('https://')
      ? new URL(config.idpMetadata)
      : null;
  // Guard before loading the optional peer dependency so the error/warning is
  // unambiguous even if samlify's own SP constructor throws.
  if (metadataUrl?.protocol === 'http:') {
    if (isProd()) {
      throw new Error('SAML IdP metadata URL must use HTTPS in production');
    }
    console.warn('[saml] WARNING: IdP metadata over HTTP — do not use in production');
  }

  const samlify = await import('samlify');

  // Configure XML schema validation to prevent signature wrapping and XXE attacks.
  // Try to load the full XSD validator (optional peer dep); fall back to a minimal
  // structural validator in development. Production requires the full validator.
  try {
    // @ts-expect-error — optional peer dependency; type declarations may not be installed

    const validator = await import('@authenio/samlify-xsd-schema-validator');

    samlify.setSchemaValidator(validator);
  } catch {
    if (isProd()) {
      throw new Error(
        'SAML in production requires @authenio/samlify-xsd-schema-validator. ' +
          'Install it: npm install @authenio/samlify-xsd-schema-validator',
      );
    }
    console.warn(
      '[saml] WARNING: @authenio/samlify-xsd-schema-validator not installed. ' +
        'SAML assertions will not be validated against the XSD schema. ' +
        'Install it for production use.',
    );
    // Set a permissive validator in development to avoid samlify's own warning
    samlify.setSchemaValidator({
      validate: () => Promise.resolve('skipped'),
    });
  }

  const sp = samlify.ServiceProvider({
    entityID: config.entityId,
    assertionConsumerService: [
      {
        Binding: samlify.Constants.BindingNamespace.Post,
        Location: config.acsUrl,
      },
    ],
    signingCert: config.signingCert,
    privateKey: config.signingKey,
    allowCreate: true,
  }) as unknown as SamlifySpInstance;

  let idp: SamlifyIdpInstance;

  // Load IdP metadata
  if (metadataUrl) {
    // URL — fetch it
    const res = await fetch(config.idpMetadata);
    if (isProd() && res.url) {
      const finalUrl = new URL(res.url, metadataUrl);
      if (finalUrl.protocol !== 'https:') {
        throw new Error(
          'SAML IdP metadata URL must stay on HTTPS in production (redirect downgrade detected)',
        );
      }
    }
    const xml = await res.text();
    idp = samlify.IdentityProvider({ metadata: xml }) as unknown as SamlifyIdpInstance;
  } else {
    // XML string
    idp = samlify.IdentityProvider({
      metadata: config.idpMetadata,
    }) as unknown as SamlifyIdpInstance;
  }

  return { sp, idp };
}

export function createAuthnRequest(
  sp: SamlifySpInstance,
  idp: SamlifyIdpInstance,
): { redirectUrl: string; id: string } {
  const { id, context, entityEndpoint } = sp.createLoginRequest(idp, 'redirect');
  return { redirectUrl: entityEndpoint + '?' + context, id };
}

/**
 * Validates a SAML login response assertion.
 *
 * @param sp - The samlify ServiceProvider instance.
 * @param idp - The samlify IdentityProvider instance.
 * @param body - The raw base64-encoded SAMLResponse from the IdP.
 * @param config - SAML configuration for attribute mapping.
 * @param requestId - The InResponseTo request ID for anti-replay validation. Required to
 *   prevent assertion replay attacks — the ID is matched against the stored request ID
 *   from `createAuthnRequest`.
 * @returns The normalised `SamlProfile` extracted from the assertion.
 * @throws When the assertion signature, schema, or InResponseTo check fails.
 */
export async function validateSamlResponse(
  sp: SamlifySpInstance,
  idp: SamlifyIdpInstance,
  body: string,
  config: import('../config/authConfig').SamlConfig,
  requestId: string,
): Promise<SamlProfile> {
  const { extract } = await sp.parseLoginResponse(
    idp,
    'post',
    { body: { SAMLResponse: body } },
    requestId,
  );

  const mapping = config.attributeMapping ?? {};
  const attrs = extract.attributes;

  const emailKey = mapping.email ?? 'email';
  const firstNameKey = mapping.firstName ?? 'firstName';
  const lastNameKey = mapping.lastName ?? 'lastName';
  const groupsKey = mapping.groups ?? 'groups';

  const nameId: string = extract.nameID;
  const email = (attrs[emailKey] as string | undefined) ?? nameId;
  const firstName = attrs[firstNameKey] as string | undefined;
  const lastName = attrs[lastNameKey] as string | undefined;
  const displayName = firstName && lastName ? `${firstName} ${lastName}` : undefined;
  const rawGroups = attrs[groupsKey];
  const groups = rawGroups ? (Array.isArray(rawGroups) ? rawGroups : [rawGroups]) : undefined;

  return { nameId, email, firstName, lastName, displayName, groups, attributes: attrs };
}

export function samlProfileToIdentityProfile(profile: SamlProfile): IdentityProfile {
  return {
    email: profile.email,
    displayName: profile.displayName,
    firstName: profile.firstName,
    lastName: profile.lastName,
  };
}

export function getSamlSpMetadata(sp: SamlifySpInstance): string {
  return sp.getMetadata();
}
