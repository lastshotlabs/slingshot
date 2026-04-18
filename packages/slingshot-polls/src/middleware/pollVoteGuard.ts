/**
 * Content-level vote guard middleware.
 *
 * Runs on `PollVote.create` AFTER the `poll:vote` policy resolver clears
 * source-level auth. Validates rules that polls itself owns — the guard
 * is NOT responsible for "can this user see this poll's source content".
 *
 * Rejection branches:
 * 1. Poll not found → 404
 * 2. `poll.closed === true` → 403 POLL_CLOSED
 * 3. `poll.closesAt` in the past → 403 POLL_CLOSED
 * 4. Single-select and user already voted → 409 ALREADY_VOTED
 * 5. `optionIndex` out of range → 400 INVALID_OPTION
 *
 * The guard also writes denormalized fields (`sourceType`, `sourceId`,
 * `scopeId`) from the fetched poll onto the request body so event payloads
 * can be built via field-pick without an extra fetch.
 *
 * @internal
 */
import type { Context, Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { PollAdapter, PollVoteAdapter } from '../types/adapters';
import { POLL_VOTE_ERRORS } from '../types/public';

function isPollVoteBody(value: unknown): value is { pollId: string; optionIndex: number } {
  if (typeof value !== 'object' || value === null) return false;
  const rec = value as Record<string, unknown>;
  return typeof rec.pollId === 'string' && typeof rec.optionIndex === 'number';
}

/**
 * Build the poll vote guard middleware.
 *
 * Captures resolved adapters via closure (Rule 3 — factory pattern, no
 * module state). Registered under the name `'pollVoteGuard'` in
 * `RouteConfigDeps.middleware` so the entity route config can reference
 * it by string.
 */
export function buildPollVoteGuard({
  pollAdapter,
  pollVoteAdapter,
}: {
  pollAdapter: PollAdapter;
  pollVoteAdapter: PollVoteAdapter;
}) {
  return async (c: Context, next: Next) => {
    const body: unknown = await c.req.json();
    if (!isPollVoteBody(body)) {
      throw new HTTPException(400, { message: 'Invalid poll vote payload' });
    }
    const pollId = body.pollId;
    const optionIndex = body.optionIndex;
    const authUserId = (c as { get(key: string): unknown }).get('authUserId');
    if (typeof authUserId !== 'string' || authUserId.length === 0) {
      throw new HTTPException(401, { message: 'Unauthorized' });
    }
    const userId = authUserId;

    // 1. Poll not found — race between policy eval and guard.
    const poll = await pollAdapter.getById(pollId);
    if (!poll) {
      throw new HTTPException(404, { message: 'Poll not found' });
    }

    // 2. Poll explicitly closed.
    if (poll.closed) {
      throw new HTTPException(403, {
        message: POLL_VOTE_ERRORS.POLL_CLOSED,
      });
    }

    // 3. Poll time-expired (closesAt in the past).
    if (poll.closesAt && new Date(poll.closesAt) <= new Date()) {
      throw new HTTPException(403, {
        message: POLL_VOTE_ERRORS.POLL_CLOSED,
      });
    }

    // 4. Single-select duplicate vote check.
    if (!poll.multiSelect) {
      const existing = await pollVoteAdapter.listByPoll({ pollId });
      const userVotes = existing.items.filter(v => v.userId === userId);
      if (userVotes.length > 0) {
        throw new HTTPException(409, {
          message: POLL_VOTE_ERRORS.ALREADY_VOTED,
        });
      }
    }

    // 5. Option index out of range.
    const options = poll.options;
    if (optionIndex < 0 || optionIndex >= options.length) {
      throw new HTTPException(400, {
        message: POLL_VOTE_ERRORS.INVALID_OPTION,
      });
    }

    // Store denormalized fields from the poll as context variables.
    // The PollVote entity's dataScope picks these up in the create handler
    // via ctx:__voteSourceType etc. Body mutations via c.req.json() do NOT
    // persist across middleware in Hono — context variables are the correct
    // mechanism for server-side field injection.
    (c as typeof c & { set(key: string, value: unknown): void }).set(
      '__voteSourceType',
      poll.sourceType,
    );
    (c as typeof c & { set(key: string, value: unknown): void }).set(
      '__voteSourceId',
      poll.sourceId,
    );
    (c as typeof c & { set(key: string, value: unknown): void }).set('__voteScopeId', poll.scopeId);

    await next();
  };
}
