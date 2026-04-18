import { consumeDeletionCancelToken } from '@auth/lib/deletionCancelToken';
import { ErrorResponse } from '@auth/schemas/error';
import { SuccessResponse } from '@auth/schemas/success';
import { z } from 'zod';
import { createRoute, errorResponse } from '@lastshotlabs/slingshot-core';
import { createRouter } from '@lastshotlabs/slingshot-core';
import type { AccountDeletionConfig } from '../config/authConfig';
import type { AuthRuntimeContext } from '../runtime';

export interface AccountDeletionRouterOptions {
  accountDeletion: AccountDeletionConfig & { queued: true; gracePeriod: number };
}

/**
 * Creates the account-deletion cancellation router.
 *
 * Only mounted when `accountDeletion.queued` is `true` and a `gracePeriod` is set.
 *
 * Mounted routes:
 * - `POST /auth/cancel-deletion` — Consume a cancel token to abort a scheduled deletion job.
 *
 * @param options - Router configuration.
 * @param options.accountDeletion - Account deletion config with `queued: true` and a
 *   `gracePeriod` (seconds) set. Both are required for this router to be useful.
 * @param runtime - The auth runtime context. `runtime.queueFactory` must be present
 *   (i.e. BullMQ and Redis must be installed and configured).
 * @returns A Hono router with the cancel-deletion route mounted.
 *
 * @throws {HttpError} 400 — The cancel token is invalid or has already been consumed/expired.
 *
 * @remarks
 * The cancel token is issued when a deletion is scheduled and delivered via the
 * `auth:delivery.account_deletion` event on the event bus. Consuming the token removes
 * the pending BullMQ job from the `${appName}:account-deletions` queue. If the job has
 * already executed (grace period elapsed) the token is still consumed and a 200 is
 * returned — callers should treat this as a best-effort cancellation. Requires BullMQ
 * (`bun add bullmq`) and an active Redis connection.
 *
 * @example
 * const router = createAccountDeletionRouter(
 *   { accountDeletion: { queued: true, gracePeriod: 86400 } },
 *   runtime,
 * );
 * app.route('/', router);
 */
export const createAccountDeletionRouter = (
  _options: AccountDeletionRouterOptions,
  runtime: AuthRuntimeContext,
) => {
  const router = createRouter();
  const tags = ['Auth'];

  router.openapi(
    createRoute({
      method: 'post',
      path: '/auth/cancel-deletion',
      summary: 'Cancel scheduled account deletion',
      description:
        'Cancels a pending queued account deletion using the cancel token delivered via the auth:delivery.account_deletion bus event. Must be called before the grace period expires.',
      tags,
      request: {
        body: {
          content: {
            'application/json': {
              schema: z.object({
                token: z
                  .string()
                  .describe('Cancel token received in the deletion scheduled notification.'),
              }),
            },
          },
          description: 'Cancel token.',
        },
      },
      responses: {
        200: {
          content: { 'application/json': { schema: SuccessResponse } },
          description: 'Account deletion cancelled.',
        },
        400: {
          content: { 'application/json': { schema: ErrorResponse } },
          description: 'Invalid or expired cancel token.',
        },
      },
    }),
    async c => {
      const { token } = c.req.valid('json');
      const entry = await consumeDeletionCancelToken(runtime.repos.deletionCancelToken, token);
      if (!entry) return errorResponse(c, 'Invalid or expired cancel token', 400);
      // Remove the pending BullMQ job
      try {
        const appName = runtime.config.appName;
        if (!runtime.queueFactory) throw new Error('[slingshot-auth] queueFactory is required');
        const queue = runtime.queueFactory.createQueue<{ userId: string }>(
          `${appName}:account-deletions`,
        );
        const job = await queue.getJob(entry.jobId);
        if (job) await job.remove();
        await queue.close();
      } catch {
        // Job may have already executed — that's an error case but we still consumed the token
      }
      return c.json({ ok: true as const }, 200);
    },
  );

  return router;
};
