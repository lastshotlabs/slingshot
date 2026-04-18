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

// Plugin factory
export { createPollsPlugin } from './plugin';

// Entity definitions
export { Poll } from './entities/poll';
export { PollVote } from './entities/pollVote';

// Entity factories
export { pollFactories, pollVoteFactories } from './entities/factories';

// Operations
export { pollOperations, pollVoteOperations } from './operations/index';

// Plugin state key
export { POLLS_PLUGIN_STATE_KEY, POLL_VOTE_ERRORS, CLIENT_SAFE_POLL_EVENTS } from './types/public';

// Config schema
export { PollsPluginConfigSchema } from './validation/config';

// Policy factories — consumers register per-sourceType handlers via
// plugin.registerSourceHandler() (instance-scoped, not module-level).
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
} from './types/public';
