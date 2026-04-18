import type { Context } from 'hono';

/**
 * Before-hook called with the incoming request input before the operation is
 * executed.
 *
 * Return the (optionally transformed) input to allow the operation to proceed.
 * Return `null` or `undefined` to reject the request with a `400 Bad Request`
 * response.
 *
 * @typeParam TInput - The shape of the input object for the operation.
 *
 * @example
 * ```ts
 * const beforeCreateContainer: BeforeHook<Record<string, unknown>> = async (input, c) => {
 *   // Normalise the slug to lowercase
 *   return { ...input, slug: String(input.slug).toLowerCase() };
 * };
 * ```
 *
 * @remarks
 * Before-hooks fire **after** request body parsing and **before** any write to
 * the entity store. They run synchronously in the request lifecycle so any
 * thrown error or rejected promise will bubble up as a 500 unless caught by
 * the Hono error handler. Input mutations (e.g. injecting computed fields,
 * stripping forbidden keys) should be done here rather than in after-hooks.
 */
export type BeforeHook<TInput> = (
  input: TInput,
  c: Context,
) => TInput | null | undefined | Promise<TInput | null | undefined>;

/**
 * After-hook called with the committed result for side effects.
 *
 * The operation has already been written to the store before this hook runs.
 * The return value is ignored.
 *
 * @typeParam TResult - The shape of the committed entity or payload.
 *
 * @example
 * ```ts
 * const afterCreateThread: AfterHook<Thread> = async (thread, c) => {
 *   await analytics.track('thread_created', { threadId: thread.id });
 * };
 * ```
 *
 * @remarks
 * After-hooks fire **after** the entity has been written to the store and the
 * success response has been prepared. They are called in-band — the HTTP
 * response is not sent until all after-hooks resolve. Use them for immediate
 * side effects (e.g. analytics, cache invalidation, event emission) rather
 * than deferred async work. If an after-hook throws, the write has already
 * been committed and cannot be rolled back.
 */
export type AfterHook<TResult> = (result: TResult, c: Context) => void | Promise<void>;
