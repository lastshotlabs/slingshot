/**
 * Package-authoring entity modules for the Poll and PollVote entities.
 *
 * The modules are kept here (not co-located with each entity file) because
 * the named operations live in `../operations/index.ts`, which already imports
 * the entity configs — co-locating the module exports there would create a
 * cycle. This file exposes a factory `buildPollEntityModules(...)` so the
 * package factory can wire `onAdapter` callbacks that capture the resolved
 * adapter instances at boot time — sharing a single in-memory adapter between
 * the entity-plugin routes and the package's cross-entity surfaces (the
 * /results route, the close sweep, and the vote-guard middleware).
 *
 * @internal
 */
import { entity } from '@lastshotlabs/slingshot-entity';
import type { BareEntityAdapter } from '@lastshotlabs/slingshot-entity/routing';
import { Poll } from './poll';
import { PollVote } from './pollVote';
import { pollFactories, pollVoteFactories } from './factories';
import { pollOperations, pollVoteOperations } from '../operations/index';

/**
 * Build the Poll and PollVote entity modules wired to share their adapters
 * with the caller through `onAdapter` callbacks. Each call yields a fresh
 * pair — the closures captured by `onAdapter` are caller-owned, so multiple
 * package instances stay isolated (Rule 3).
 */
export function buildPollEntityModules(callbacks: {
  onPollAdapter: (adapter: BareEntityAdapter) => void;
  onPollVoteAdapter: (adapter: BareEntityAdapter) => void;
}) {
  const pollModule = entity({
    config: Poll,
    operations: pollOperations,
    wiring: {
      mode: 'factories',
      factories: pollFactories,
      onAdapter: callbacks.onPollAdapter,
    },
  });

  const pollVoteModule = entity({
    config: PollVote,
    operations: pollVoteOperations,
    wiring: {
      mode: 'factories',
      factories: pollVoteFactories,
      onAdapter: callbacks.onPollVoteAdapter,
    },
  });

  return { pollModule, pollVoteModule };
}
