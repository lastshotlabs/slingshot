import type { AppleAppLink } from './config';

/** Apple App Site Association response body. */
export interface AppleAasaBody {
  applinks: {
    apps: [];
    details: Array<{
      appID: string;
      paths: string[];
    }>;
  };
}

/**
 * Build the Apple App Site Association response body.
 *
 * @param apple - Normalized Apple app-link entries.
 * @returns The response body or `null` when Apple links are disabled.
 */
export function buildAppleAasaBody(
  apple: readonly AppleAppLink[] | undefined,
): AppleAasaBody | null {
  if (apple == null || apple.length === 0) return null;

  return {
    applinks: {
      apps: [],
      details: apple.map(app => ({
        appID: `${app.teamId}.${app.bundleId}`,
        paths: [...app.paths],
      })),
    },
  };
}

/**
 * Serialize the Apple App Site Association body once for reuse on every request.
 *
 * @param apple - Normalized Apple app-link entries.
 * @returns JSON string or `null` when Apple links are disabled.
 */
export function serializeAppleAasaBody(apple: readonly AppleAppLink[] | undefined): string | null {
  const body = buildAppleAasaBody(apple);
  return body == null ? null : JSON.stringify(body);
}
