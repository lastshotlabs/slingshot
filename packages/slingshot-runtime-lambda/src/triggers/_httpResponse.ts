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

/** Content types that always indicate an opaque/binary payload. */
const BINARY_CONTENT_TYPE_PREFIXES = ['image/', 'audio/', 'video/'];
const BINARY_CONTENT_TYPE_EXACT = new Set(['application/octet-stream', 'application/pdf']);

/**
 * True when the supplied Content-Type denotes a binary payload that must be
 * base64-encoded before being returned through API Gateway / ALB.
 */
export function isBinaryContentType(contentType: string | undefined | null): boolean {
  if (!contentType || typeof contentType !== 'string') return false;
  const ct = contentType.toLowerCase().split(';')[0]?.trim() ?? '';
  if (BINARY_CONTENT_TYPE_EXACT.has(ct)) return true;
  return BINARY_CONTENT_TYPE_PREFIXES.some(prefix => ct.startsWith(prefix));
}

/** True for `Buffer`, `Uint8Array`, `ArrayBuffer`, or any other `ArrayBufferView`. */
export function isBinaryBody(value: unknown): value is Buffer | Uint8Array | ArrayBuffer {
  if (value == null) return false;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return true;
  if (value instanceof Uint8Array) return true;
  if (value instanceof ArrayBuffer) return true;
  // Other ArrayBufferViews (DataView, Int32Array, etc.)
  if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(value as ArrayBufferView)) {
    return true;
  }
  return false;
}

export interface EncodeHttpBodyResult {
  /** The body to return on the Lambda response. */
  body: string;
  /** Whether the response should be flagged `isBase64Encoded:true`. */
  isBase64Encoded: boolean;
  /** Status code to use. Caller should override only on success. */
  statusCode: number;
  /** True if encoding failed and the caller should treat this as an error response. */
  failed: boolean;
}

/**
 * Encode an HTTP response body for return through an API Gateway / ALB Lambda
 * integration. Handles three cases:
 *
 *   1. Binary `Buffer` / `Uint8Array` / `ArrayBuffer` — base64-encoded with
 *      `isBase64Encoded:true`.
 *   2. String body when `Content-Type` indicates binary — passed through with
 *      `isBase64Encoded:true` (caller is asserting it is already base64).
 *   3. Anything else — JSON-serialised through {@link safeStringify}.
 */
export function encodeHttpBody(
  body: unknown,
  opts: { contentType?: string; maxBytes?: number } = {},
): EncodeHttpBodyResult {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BODY_BYTES;

  // Binary buffer-shaped bodies always base64-encode. The caller is responsible
  // for setting an appropriate Content-Type header upstream.
  if (isBinaryBody(body)) {
    let buf: Buffer;
    if (Buffer.isBuffer(body)) {
      buf = body;
    } else if (body instanceof ArrayBuffer) {
      buf = Buffer.from(new Uint8Array(body));
    } else {
      // Uint8Array or other ArrayBufferView
      const view = body as ArrayBufferView;
      buf = Buffer.from(view.buffer, view.byteOffset, view.byteLength);
    }
    if (maxBytes > 0 && buf.byteLength > maxBytes) {
      console.error(
        `[lambda] response body ${buf.byteLength} bytes exceeds maxBytes=${maxBytes}; returning 500`,
      );
      return {
        body: JSON.stringify({
          error: 'Response too large',
          code: 'response-too-large',
        }),
        isBase64Encoded: false,
        statusCode: 500,
        failed: true,
      };
    }
    return {
      body: buf.toString('base64'),
      isBase64Encoded: true,
      statusCode: 200,
      failed: false,
    };
  }

  // String body with a binary content-type: caller is asserting it is already
  // base64 — pass through and flag accordingly.
  if (typeof body === 'string' && isBinaryContentType(opts.contentType)) {
    if (maxBytes > 0) {
      const byteLength = Buffer.byteLength(body, 'utf8');
      if (byteLength > maxBytes) {
        console.error(
          `[lambda] response body ${byteLength} bytes exceeds maxBytes=${maxBytes}; returning 500`,
        );
        return {
          body: JSON.stringify({
            error: 'Response too large',
            code: 'response-too-large',
          }),
          isBase64Encoded: false,
          statusCode: 500,
          failed: true,
        };
      }
    }
    return { body, isBase64Encoded: true, statusCode: 200, failed: false };
  }

  // Default JSON path.
  const json = safeStringify(body, { maxBytes });
  return {
    body: json.body,
    isBase64Encoded: false,
    statusCode: json.statusCode,
    failed: json.failed,
  };
}

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
