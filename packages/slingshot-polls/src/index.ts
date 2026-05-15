/**
 * @lastshotlabs/slingshot-polls
 *
 * Multiple-choice polls attachable to any user content. Content-agnostic
 * via `sourceType` / `sourceId` / `scopeId` — consumers (chat, community)
 * register policy resolvers under stable keys so polls never imports
 * consumer packages.
 *
 * Public API surface — see Rule 7 (minimal public API). Internal helpers
 * (`pollVoteGuard`, `closeSweep`, the results handler) are NOT exported.
 * Testing utilities live on the `/testing` subpath.
 *
 * @packageDocumentation
 */

// Package factory
export { createPollsPackage } from './plugin';

// Entity definitions
export { Poll } from './entities/poll';
export { PollVote } from './entities/pollVote';

// Entity factories
export { pollFactories, pollVoteFactories } from './entities/factories';

// Operations
export { pollOperations, pollVoteOperations } from './operations/index';

// Plugin state key
/**
 * @deprecated Use the typed `PollsRuntimeCap` capability instead.
 */
export { POLLS_PLUGIN_STATE_KEY } from './types';
export { POLL_VOTE_ERRORS, CLIENT_SAFE_POLL_EVENTS } from './types';

/**
 * Provider-owned package contract and capability for cross-package consumers.
 */
export { Polls, PollsRuntimeCap } from './public';

// Config schema
export { PollsPluginConfigSchema } from './validation/config';

// Policy factories — apps declare per-sourceType handlers via the package's
// `sourceHandlers` / `voteHandlers` config fields.
export {
  createPollSourcePolicy,
  createPollVotePolicy,
  POLL_SOURCE_POLICY_KEY,
  POLL_VOTE_POLICY_KEY,
} from './policy';

// Public types
// Rate limiting
export { createInMemoryRateLimiter } from './lib/rateLimit';
export type { RateLimitBackend } from './lib/rateLimit';

export type {
  PollsPluginConfig,
  PollsPluginState,
  PollsRateLimitConfig,
  PollsRateLimitRule,
  PollsRateLimitBucket,
  PollRecord,
  PollVoteRecord,
  PollCreateInput,
  PollVoteCreateInput,
  PollResult,
  PollResultsParams,
  PollResultsResponse,
  PollPolicyKey,
  PollsRouteKey,
  PollCreatedEvent,
  PollClosedEvent,
  PollDeletedEvent,
  PollVotedEvent,
  PollVoteRetractedEvent,
  PollVoteErrorCode,
} from './types';
