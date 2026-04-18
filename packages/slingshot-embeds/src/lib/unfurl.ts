import type { UnfurlResult } from '../types';
import { parseOgMetadata } from './htmlParser';
import { resolveAndValidate } from './ssrfGuard';

/** Maximum number of redirects to follow before aborting. */
const MAX_REDIRECTS = 5;

/**
 * Fetch a URL and extract structured OG/meta metadata.
 *
 * Sends a GET request with a bot user-agent, checks that the response is HTML,
 * enforces a byte-size limit on the body, then parses OG tags from the `<head>`.
 *
 * Redirects are followed manually — each hop's hostname is resolved via DNS and
 * checked against private/reserved IP ranges before the next request is issued.
 * This prevents DNS rebinding attacks where a redirect leads to an internal host.
 *
 * @param url - The validated URL to unfurl (must already pass the sync SSRF check).
 * @param config - Fetch constraints.
 * @param config.timeoutMs - Abort the request after this many milliseconds.
 * @param config.maxResponseBytes - Maximum response body size in bytes.
 * @returns Structured metadata extracted from the page.
 * @throws {Error} If DNS resolution fails, any resolved IP is private, or too many
 *   redirects are followed.
 */
export async function unfurl(
  url: string,
  config: { timeoutMs: number; maxResponseBytes: number },
): Promise<UnfurlResult> {
  let currentUrl = url;
  let response!: Response;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const parsed = new URL(currentUrl);
    // Strip brackets from IPv6 literals for DNS resolution
    const hostname =
      parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']')
        ? parsed.hostname.slice(1, -1)
        : parsed.hostname;

    const dnsCheck = await resolveAndValidate(hostname);
    if (!dnsCheck.ok) {
      throw new Error(`SSRF check failed: ${dnsCheck.reason}`);
    }

    response = await fetch(currentUrl, {
      signal: AbortSignal.timeout(config.timeoutMs),
      headers: {
        'User-Agent': 'SlingshotBot/1.0 (+https://slingshot.dev)',
        Accept: 'text/html',
      },
      redirect: 'manual',
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) break; // No Location header — treat as final response
      if (hop === MAX_REDIRECTS) throw new Error('Too many redirects');
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    break;
  }

  // If not HTML, return minimal result
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('text/html')) {
    // Consume body to avoid leaking the connection
    await response.body?.cancel();
    return { url: currentUrl };
  }

  // Read body with size limit using ReadableStream
  const body = response.body;
  if (!body) {
    return { url: currentUrl };
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > config.maxResponseBytes) {
        // We have enough of the head section — stop reading
        chunks.push(value);
        break;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
    // Cancel any remaining body to free resources
    await body.cancel().catch(() => {});
  }

  const decoder = new TextDecoder('utf-8', { fatal: false });
  const html = decoder.decode(concatUint8Arrays(chunks));

  const metadata = parseOgMetadata(html, currentUrl);
  return { url: currentUrl, ...metadata };
}

/** Concatenate an array of Uint8Arrays into a single Uint8Array. */
function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.byteLength, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.byteLength;
  }
  return result;
}
