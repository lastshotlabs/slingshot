import type { AndroidAppLink } from './config';

/** One entry in Android's `assetlinks.json` response body. */
export interface AssetLinksEntry {
  relation: ['delegate_permission/common.handle_all_urls'];
  target: {
    namespace: 'android_app';
    package_name: string;
    sha256_cert_fingerprints: string[];
  };
}

/**
 * Build the Android Digital Asset Links response body.
 *
 * @param android - Normalized Android app-link entry.
 * @returns The response body or `null` when Android links are disabled.
 */
export function buildAssetlinksBody(android: AndroidAppLink | undefined): AssetLinksEntry[] | null {
  if (android == null) return null;

  return [
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: android.packageName,
        sha256_cert_fingerprints: [...android.sha256Fingerprints],
      },
    },
  ];
}

/**
 * Serialize the Android Digital Asset Links body once for reuse on every request.
 *
 * @param android - Normalized Android app-link entry.
 * @returns JSON string or `null` when Android links are disabled.
 */
export function serializeAssetlinksBody(android: AndroidAppLink | undefined): string | null {
  const body = buildAssetlinksBody(android);
  return body == null ? null : JSON.stringify(body);
}
