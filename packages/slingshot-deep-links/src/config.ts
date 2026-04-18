import { z } from 'zod';
import { deepFreeze } from '@lastshotlabs/slingshot-core';

const teamIdPattern = /^[A-Z0-9]{10}$/;
const reverseDnsPattern = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/;
const sha256FingerprintPattern = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/;
const aasaPathPattern = /^\/.*$/;
const fallbackSourcePattern = /^\/(?:[^*]*\/)?\*$/;
const fallbackTargetPattern = /^\/[^*]*$/;

/** Apple universal-links entry schema. */
export const appleAppLinkSchema = z
  .object({
    teamId: z
      .string()
      .regex(teamIdPattern, 'teamId must be 10 uppercase alphanumeric characters')
      .describe('Apple Team ID for the iOS app that should claim the universal links.'),
    bundleId: z
      .string()
      .regex(reverseDnsPattern, 'bundleId must be a reverse-DNS identifier')
      .describe('Reverse-DNS iOS bundle identifier for the universal-link target app.'),
    paths: z
      .array(z.string().regex(aasaPathPattern))
      .min(1, 'at least one path required')
      .describe('URL path patterns the iOS app is allowed to open.'),
  })
  .strict();

/** Android Digital Asset Links entry schema. */
export const androidAppLinkSchema = z
  .object({
    packageName: z
      .string()
      .regex(reverseDnsPattern, 'packageName must be a reverse-DNS identifier')
      .describe('Reverse-DNS Android package name for the app-link target app.'),
    sha256Fingerprints: z
      .array(z.string().regex(sha256FingerprintPattern))
      .min(1, 'at least one SHA-256 fingerprint required')
      .describe('SHA-256 certificate fingerprints trusted for the Android package.'),
  })
  .strict();

/** Manifest-safe config schema for {@link createDeepLinksPlugin}. */
export const deepLinksConfigSchema = z
  .object({
    apple: z
      .union([appleAppLinkSchema, z.array(appleAppLinkSchema).min(1)])
      .optional()
      .describe(
        'Apple universal-link targets to publish. Omit when iOS deep-link support is not needed.',
      ),
    android: androidAppLinkSchema
      .optional()
      .describe(
        'Android app-link target to publish. Omit when Android deep-link support is not needed.',
      ),
    fallbackBaseUrl: z
      .url()
      .refine(url => url.startsWith('https://'), 'fallbackBaseUrl must use https://')
      .refine(url => !url.endsWith('/'), 'fallbackBaseUrl must not have a trailing slash')
      .optional()
      .describe(
        'HTTPS base URL used for browser fallback redirects. Omit when fallback redirects are not configured.',
      ),
    fallbackRedirects: z
      .record(
        z.string().regex(fallbackSourcePattern, 'source must be e.g. /share/*'),
        z.string().regex(fallbackTargetPattern, 'target must not contain *'),
      )
      .optional()
      .describe(
        'Wildcard path redirects served to browsers when no native app handles the link. Omit to disable fallback redirects.',
      ),
  })
  .strict()
  .refine(config => (config.fallbackRedirects ? Boolean(config.fallbackBaseUrl) : true), {
    message: 'fallbackBaseUrl is required when fallbackRedirects is set',
  })
  .refine(config => Boolean(config.apple ?? config.android ?? config.fallbackRedirects), {
    message: 'at least one of apple / android / fallbackRedirects must be provided',
  });

/** Raw config input accepted by `createDeepLinksPlugin()`. */
export type DeepLinksConfigInput = z.input<typeof deepLinksConfigSchema>;
/** One Apple universal-links application mapping. */
export type AppleAppLink = z.output<typeof appleAppLinkSchema>;
/** Android Digital Asset Links application mapping. */
export type AndroidAppLink = z.output<typeof androidAppLinkSchema>;

/** Normalized and deeply frozen deep-links config. */
export interface DeepLinksConfig {
  readonly apple?: readonly AppleAppLink[];
  readonly android?: AndroidAppLink;
  readonly fallbackBaseUrl?: string;
  readonly fallbackRedirects?: Readonly<Record<string, string>>;
}

/**
 * Validate, normalize, and deeply freeze deep-links config input.
 *
 * @param input - Raw config input.
 * @returns Frozen config with single-apple shorthand normalized to an array.
 */
export function compileDeepLinksConfig(input: DeepLinksConfigInput): DeepLinksConfig {
  const parsed = deepLinksConfigSchema.parse(input);

  return deepFreeze({
    apple:
      parsed.apple == null
        ? undefined
        : Array.isArray(parsed.apple)
          ? parsed.apple
          : [parsed.apple],
    android: parsed.android,
    fallbackBaseUrl: parsed.fallbackBaseUrl,
    fallbackRedirects: parsed.fallbackRedirects,
  });
}
