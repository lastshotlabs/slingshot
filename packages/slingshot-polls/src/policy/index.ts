/**
 * Poll policy factories.
 *
 * Polls are content-agnostic — the poll entity has no idea whether it was
 * created inside a chat room or a community thread. Authorization is
 * delegated to consumer plugins via `definePolicyDispatch` on the
 * `sourceType` discriminator field.
 *
 * Handler maps are caller-provided (owned by the plugin closure per Rule 3),
 * not module-scoped. Consumer plugins register per-source-type handlers via
 * `plugin.registerSourceHandler()` before `setupMiddleware` freezes the
 * policy dispatch tables.
 *
 * @module
 */
import type { PolicyResolver } from '@lastshotlabs/slingshot-core';
import { definePolicyDispatch } from '@lastshotlabs/slingshot-entity';
import type { PollRecord, PollVoteRecord } from '../types/public';

/** Stable registry key for poll source policy. */
export const POLL_SOURCE_POLICY_KEY = 'polls:sourcePolicy' as const;

/** Stable registry key for poll vote policy. */
export const POLL_VOTE_POLICY_KEY = 'polls:votePolicy' as const;

/**
 * Build the dispatched `PolicyResolver` for the Poll entity.
 *
 * Dispatches on `sourceType` read from the record (for get/update/delete) or
 * the input body (for create). Unregistered source types are denied.
 *
 * @param handlers - Per-sourceType handler map, owned by the plugin closure.
 */
export function createPollSourcePolicy(
  handlers: Map<string, PolicyResolver<PollRecord, Partial<PollRecord>>>,
): PolicyResolver<PollRecord, Partial<PollRecord>> {
  return definePolicyDispatch<PollRecord, Partial<PollRecord>>({
    dispatch: input => {
      const rec = input.record ?? input.input;
      return (rec as Record<string, unknown> | null)?.sourceType as string | undefined;
    },
    handlers: Object.fromEntries(handlers) as Record<
      string,
      PolicyResolver<PollRecord, Partial<PollRecord>>
    >,
    fallback: 'deny',
  });
}

/**
 * Build the dispatched `PolicyResolver` for the PollVote entity.
 *
 * Same dispatch strategy as polls — reads `sourceType` from the vote record
 * or input. Unregistered source types are denied.
 *
 * @param handlers - Per-sourceType handler map, owned by the plugin closure.
 */
export function createPollVotePolicy(
  handlers: Map<string, PolicyResolver<PollVoteRecord, Partial<PollVoteRecord>>>,
): PolicyResolver<PollVoteRecord, Partial<PollVoteRecord>> {
  return definePolicyDispatch<PollVoteRecord, Partial<PollVoteRecord>>({
    dispatch: input => {
      const rec = input.record ?? input.input;
      return (rec as Record<string, unknown> | null)?.sourceType as string | undefined;
    },
    handlers: Object.fromEntries(handlers) as Record<
      string,
      PolicyResolver<PollVoteRecord, Partial<PollVoteRecord>>
    >,
    fallback: 'deny',
  });
}
