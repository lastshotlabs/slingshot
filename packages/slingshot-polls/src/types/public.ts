import { POLLS_PLUGIN_STATE_KEY as CORE_POLLS_PLUGIN_STATE_KEY } from '@lastshotlabs/slingshot-core';

/**
 * Public types for `@lastshotlabs/slingshot-polls`.
 *
 * All consumer-facing types are defined here and re-exported from the
 * package entry point. Internal types live in implementation files.
 *
 * @module
 */

// --- Plugin state key ---

/**
 * Plugin state key for polls plugin state in `ctx.pluginState`.
 *
 * Plain string matching the `plugin.name`. Consumers look up polls
 * state via `ctx.pluginState.get(POLLS_PLUGIN_STATE_KEY)`.
 */
export const POLLS_PLUGIN_STATE_KEY = CORE_POLLS_PLUGIN_STATE_KEY;

// --- Create inputs ---

/** Fields accepted by the `POST /polls/polls` route body. */
export interface PollCreateInput {
  readonly sourceType: string;
  readonly sourceId: string;
  readonly scopeId: string;
  readonly question: string;
  readonly options: readonly string[];
  readonly multiSelect?: boolean;
  readonly anonymous?: boolean;
  readonly closesAt?: string;
}

/** Fields accepted by the `POST /polls/poll-votes` route body. */
export interface PollVoteCreateInput {
  readonly pollId: string;
  readonly optionIndex: number;
}

// --- Results op ---

/** Path params for the `GET /polls/polls/:id/results` route. */
export interface PollResultsParams {
  readonly id: string;
}

/** One row of aggregated results per option. */
export interface PollResult {
  readonly optionIndex: number;
  readonly count: number;
  /** Absent when `poll.anonymous === true`. */
  readonly voters?: readonly string[];
}

/** Full response from the results handler. */
export interface PollResultsResponse {
  readonly poll: PollRecord;
  readonly results: readonly PollResult[];
  readonly totalVotes: number;
}

// --- Records ---

/** A persisted poll record. */
export interface PollRecord {
  readonly id: string;
  readonly tenantId?: string;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly scopeId: string;
  readonly authorId: string;
  readonly question: string;
  readonly options: readonly string[];
  readonly multiSelect: boolean;
  readonly anonymous: boolean;
  readonly closed: boolean;
  readonly closesAt?: string | Date | null;
  readonly closedBy?: string | null;
  readonly closedAt?: string | Date | null;
  readonly createdAt: string | Date;
}

/** A persisted vote record. */
export interface PollVoteRecord {
  readonly id: string;
  readonly tenantId?: string;
  readonly pollId: string;
  readonly userId: string;
  readonly optionIndex: number;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly scopeId: string;
  readonly createdAt: string | Date;
}

// --- Policy dispatch keys ---

/**
 * Policy resolver keys used in entity route configs. Consumers register
 * resolvers under these keys via `registerEntityPolicy()`.
 */
export type PollPolicyKey = 'poll:read' | 'poll:vote' | 'poll:create' | 'poll:admin';

// --- Route disable keys ---

/**
 * Every mountable route keyed by `entityName.opName`. Passed to
 * `PollsPluginConfig.disableRoutes`.
 */
export type PollsRouteKey =
  | 'poll.get'
  | 'poll.list'
  | 'poll.create'
  | 'poll.delete'
  | 'poll.listBySource'
  | 'poll.closePoll'
  | 'poll.results'
  | 'pollVote.get'
  | 'pollVote.list'
  | 'pollVote.create'
  | 'pollVote.delete'
  | 'pollVote.listByPoll'
  | 'pollVote.myVotes'
  | 'pollVote.countByOption';

// --- Event payloads ---

/** Payload for `polls:poll.created` events. */
export interface PollCreatedEvent {
  readonly id: string;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly scopeId: string;
  readonly authorId: string;
}

/** Payload for `polls:poll.closed` events. */
export interface PollClosedEvent {
  readonly id: string;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly scopeId: string;
  readonly closedBy: string | null;
}

/** Payload for `polls:poll.deleted` events. */
export interface PollDeletedEvent {
  readonly id: string;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly scopeId: string;
}

/** Payload for `polls:poll.voted` events. */
export interface PollVotedEvent {
  readonly pollId: string;
  readonly optionIndex: number;
  readonly userId: string;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly scopeId: string;
}

/** Payload for `polls:poll.vote_retracted` events. */
export interface PollVoteRetractedEvent {
  readonly pollId: string;
  readonly optionIndex: number;
  readonly userId: string;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly scopeId: string;
}

// --- Client-safe event keys ---

/** All client-safe poll event keys. */
export const CLIENT_SAFE_POLL_EVENTS = [
  'polls:poll.created',
  'polls:poll.closed',
  'polls:poll.deleted',
  'polls:poll.voted',
  'polls:poll.vote_retracted',
] as const;

// --- Rate limiting ---

/** A rate-limit bucket for a single scope (user or tenant). */
export interface PollsRateLimitBucket {
  /** Sliding window — `"10s"`, `"1m"`, `"1h"`. */
  readonly window: string;
  /** Max requests allowed in the window. */
  readonly max: number;
}

/** A rate-limit rule for a single operation. */
export interface PollsRateLimitRule {
  /** Per-user bucket. Counted against the resolved session userId. */
  readonly perUser?: PollsRateLimitBucket;
  /** Per-tenant bucket. Counted against the resolved tenantId. */
  readonly perTenant?: PollsRateLimitBucket;
}

/** Per-operation rate-limit config. Opt-in — omit to disable limiting. */
export interface PollsRateLimitConfig {
  /** Rate limit for `POST /polls/poll-votes` (vote casting). */
  readonly vote?: PollsRateLimitRule;
  /** Rate limit for `POST /polls/polls` (poll creation). */
  readonly pollCreate?: PollsRateLimitRule;
  /** Rate limit for `GET /polls/polls/:id/results` (results scraping). */
  readonly results?: PollsRateLimitRule;
}

// --- Plugin config ---

/** Configuration for the polls plugin. */
export interface PollsPluginConfig {
  /** Max poll options. Default: 10. */
  readonly maxOptions: number;
  /** Max question length (chars). Default: 500. */
  readonly maxQuestionLength: number;
  /** Max option text length (chars). Default: 200. */
  readonly maxOptionLength: number;
  /** Auto-close sweep interval (ms). Default: 60000. 0 to disable. */
  readonly closeCheckIntervalMs: number;
  /** Mount path for polls routes. Default: '/polls'. */
  readonly mountPath: string;
  /** Routes to disable. */
  readonly disableRoutes: readonly PollsRouteKey[];
  /** Per-operation rate limiting. Opt-in — omit for no limiting. */
  readonly rateLimit?: PollsRateLimitConfig;
}

// --- Plugin state ---

/** Runtime state stored in `ctx.pluginState.get(POLLS_PLUGIN_STATE_KEY)`. */
export interface PollsPluginState {
  readonly config: Readonly<PollsPluginConfig>;
  readonly pollAdapter: unknown;
  readonly pollVoteAdapter: unknown;
  readonly sweepHandle: { stop(): void } | null;
  /** Register a per-sourceType policy handler. Call before `setupMiddleware`. */
  readonly registerSourceHandler: (
    sourceType: string,
    handler: unknown,
    entity?: 'poll' | 'vote',
  ) => void;
}

// --- Vote guard error codes ---

/** Structured error codes returned by the poll vote guard. */
export const POLL_VOTE_ERRORS = {
  POLL_NOT_FOUND: 'POLL_NOT_FOUND',
  POLL_CLOSED: 'POLL_CLOSED',
  ALREADY_VOTED: 'ALREADY_VOTED',
  INVALID_OPTION: 'INVALID_OPTION',
} as const;

export type PollVoteErrorCode = (typeof POLL_VOTE_ERRORS)[keyof typeof POLL_VOTE_ERRORS];
