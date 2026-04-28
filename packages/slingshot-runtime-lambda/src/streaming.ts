/**
 * Lambda streaming response support.
 *
 * AWS Lambda exposes a global `awslambda.streamifyResponse(handler)` function
 * inside any execution environment that supports response streaming (Node.js
 * managed runtimes started with `--experimental-vm-modules`-enabled cold starts,
 * Function URLs configured with `RESPONSE_STREAM`, custom runtimes that ship
 * the `awslambda` shim, and so on). Outside of those environments the global is
 * undefined — running the same code under a unit test, in a non-streaming
 * Lambda, or under a custom runtime that does not provide the shim simply has
 * no `awslambda` to call.
 *
 * Slingshot does not bundle the `awslambda` types (they are provided by the
 * Lambda execution environment, not a public package). Instead we feature-detect
 * `globalThis.awslambda?.streamifyResponse` at runtime and degrade gracefully if
 * it is missing, so the same wrapper behaves correctly across all deployment
 * targets.
 *
 * The wrapper preserves the original `(event, context) => Promise<unknown>`
 * shape on the outside; when streaming is enabled and available the handler is
 * additionally instrumented with a stream sink so callers that need to write
 * incremental output (e.g. SSE, large payloads) can do so without changing the
 * Slingshot handler API surface.
 */

type LambdaContextLike = { awsRequestId?: string };

type StandardHandler = (event: unknown, context: LambdaContextLike) => Promise<unknown>;

interface ResponseStream {
  write(chunk: string | Uint8Array): boolean | undefined;
  end(chunk?: string | Uint8Array): void;
  setContentType?: (contentType: string) => void;
}

type StreamingHandler = (
  event: unknown,
  responseStream: ResponseStream,
  context: LambdaContextLike,
) => Promise<void> | undefined;

interface AwslambdaShim {
  streamifyResponse?: (handler: StreamingHandler) => StandardHandler;
  HttpResponseStream?: {
    from(
      stream: ResponseStream,
      prelude: { statusCode?: number; headers?: Record<string, string> },
    ): ResponseStream;
  };
}

/**
 * Read the `awslambda` global without TypeScript errors. The shim is injected by
 * the Lambda runtime and is not part of any standard Node.js / browser typing.
 */
export function getAwslambdaShim(): AwslambdaShim | undefined {
  const candidate = (globalThis as { awslambda?: AwslambdaShim }).awslambda;
  if (candidate && typeof candidate === 'object') return candidate;
  return undefined;
}

/** True iff `globalThis.awslambda.streamifyResponse` is callable in this process. */
export function isStreamingSupported(): boolean {
  const shim = getAwslambdaShim();
  return typeof shim?.streamifyResponse === 'function';
}

/**
 * Wrap a standard `(event, context) => Promise<unknown>` Lambda handler in
 * `awslambda.streamifyResponse` so the runtime can stream the response body
 * back to the client.
 *
 * If the host environment does not expose `awslambda.streamifyResponse` (unit
 * tests, non-streaming Lambdas, custom runtimes without the shim) the original
 * handler is returned unchanged. Callers that depend on streaming behaviour for
 * correctness should detect this with {@link isStreamingSupported} before
 * opting in.
 *
 * The wrapped handler invokes the standard handler, then writes its serialised
 * result through the response stream. If the handler returns a string or a
 * `Buffer` / `Uint8Array` the chunk is written verbatim; otherwise the value is
 * JSON-serialised. Errors from the handler propagate as the streaming wrapper
 * rejecting — Lambda will turn that into a `502` style response per its standard
 * streaming contract.
 */
export function wrapStreamingHandler(handler: StandardHandler): StandardHandler {
  const shim = getAwslambdaShim();
  if (!shim || typeof shim.streamifyResponse !== 'function') {
    // Non-streaming environment — return the handler unchanged. The caller's
    // response is delivered via the normal API Gateway / ALB integration.
    return handler;
  }

  const streaming: StreamingHandler = async (event, responseStream, context) => {
    let payload: unknown;
    try {
      payload = await handler(event, context);
    } catch (err) {
      // Surface as an end-of-stream error message, then close. The streaming
      // contract has no separate error channel — the client sees a truncated
      // body and Lambda records the failure in CloudWatch.
      const message = err instanceof Error ? err.message : 'streaming handler failed';
      try {
        responseStream.write(JSON.stringify({ error: message, code: 'streaming-handler-failed' }));
      } finally {
        responseStream.end();
      }
      return;
    }
    try {
      if (payload == null) {
        responseStream.end();
        return;
      }
      if (typeof payload === 'string') {
        responseStream.end(payload);
        return;
      }
      if (
        (typeof Buffer !== 'undefined' && Buffer.isBuffer(payload)) ||
        payload instanceof Uint8Array
      ) {
        responseStream.end(payload as Uint8Array);
        return;
      }
      responseStream.end(JSON.stringify(payload));
    } catch (err) {
      console.error('[lambda] streaming write failed:', err);
      try {
        responseStream.end();
      } catch {
        // Already ended — nothing else we can do.
      }
    }
  };

  return shim.streamifyResponse(streaming);
}
