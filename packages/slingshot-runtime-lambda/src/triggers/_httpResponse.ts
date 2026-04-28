/**
 * Shared serialization helpers for HTTP-flavoured Lambda triggers (apigw,
 * apigw-v2, alb).
 *
 * `JSON.stringify` can throw on circular references and on `BigInt` values,
 * and it can produce strings large enough to exceed API Gateway's 6 MB
 * response cap. An uncaught throw here would crash the Lambda container
 * mid-response — the request fails with no observability. Callers that go
 * through {@link safeStringify} get either a serialized payload or a guaranteed
 * 500 fallback they can safely return.
 */

/**
 * API Gateway and Lambda Function URL impose a 6 MB synchronous response cap.
 * ALB allows 1 MB. We use the smallest cap as the default warning threshold so
 * the same code is safe across all HTTP-flavoured triggers.
 */
const DEFAULT_MAX_BODY_BYTES = 1 * 1024 * 1024;

export interface SafeStringifyResult {
  /** Stringified body. On failure, a JSON error message safe for clients. */
  body: string;
  /** Status code to use. Caller should override only on success. */
  statusCode: number;
  /** True if serialization or size check failed and the caller should treat this as an error response. */
  failed: boolean;
}

export function safeStringify(
  value: unknown,
  opts: { maxBytes?: number } = {},
): SafeStringifyResult {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BODY_BYTES;
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch (err) {
    // Circular references, BigInt, or other reasons JSON.stringify rejects.
    // Surface a structured error so the client sees something useful and the
    // runtime keeps responding.
    console.error('[lambda] response serialization failed:', err);
    return {
      body: JSON.stringify({
        error: 'Response serialization failed',
        code: 'response-serialization-failed',
      }),
      statusCode: 500,
      failed: true,
    };
  }
  // JSON.stringify(undefined) === undefined. Treat as empty body.
  if (serialized === undefined) {
    return { body: '', statusCode: 200, failed: false };
  }
  if (maxBytes > 0) {
    // UTF-8 byte length, not character count. API Gateway measures bytes.
    const byteLength = Buffer.byteLength(serialized, 'utf8');
    if (byteLength > maxBytes) {
      console.error(
        `[lambda] response body ${byteLength} bytes exceeds maxBytes=${maxBytes}; returning 500`,
      );
      return {
        body: JSON.stringify({
          error: 'Response too large',
          code: 'response-too-large',
        }),
        statusCode: 500,
        failed: true,
      };
    }
  }
  return { body: serialized, statusCode: 200, failed: false };
}
