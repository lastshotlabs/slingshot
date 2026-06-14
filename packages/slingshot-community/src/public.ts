/**
 * Public contract for `slingshot-community`.
 *
 * Cross-package consumers reach community state through this surface, not by
 * importing the plugin's internals.
 *
 * Two layers:
 *
 *   - `CommunityEntities` — the canonical adapter surface. Each ref names a
 *     read-only slice of an entity adapter (Container.getById, Thread.list,
 *     etc.). Consumers resolve these via `requireEntityAdapter(carrier, ref)`
 *     from `@lastshotlabs/slingshot-core`. The adapters are published into
 *     pluginState by `createEntityPlugin()` during the plugin's `setupRoutes`
 *     phase, so consumers must read in `setupPost` or per-request handlers.
 *
 *   - `CommunityInteractionsPeerCap` — the cross-package peer capability used
 *     by `slingshot-interactions` for component-tree resolution and updates.
 *     Resolved via `ctx.capabilities.require(CommunityInteractionsPeerCap)`.
 */
import { definePackageContract } from '@lastshotlabs/slingshot-core';
// Import modules from their source files, not through ./index — index re-exports
// from this file too, which would create a circular evaluation order and a
// `Cannot access X before initialization` ReferenceError at boot.
import { containerModule } from './entities/container';
import { containerMemberModule } from './entities/containerMember';
import { reactionModule } from './entities/reaction';
import { replyModule } from './entities/reply';
import { threadModule } from './entities/thread';

export const Community = definePackageContract('slingshot-community');

/**
 * Read-only adapter surface for community entities.
 *
 * Cross-package consumers (SSR loaders, search indexers, application-defined
 * plugins) resolve adapters with:
 *
 * ```ts
 * import { CommunityEntities } from '@lastshotlabs/slingshot-community';
 * import { requireEntityAdapter } from '@lastshotlabs/slingshot-core';
 *
 * const containers = requireEntityAdapter(carrier, CommunityEntities.Container);
 * const c = await containers.getBySlug('cool-community');
 * ```
 *
 * The exposed methods are the canonical lookup paths used elsewhere in this
 * package's HTTP routes; `readonly([...])` enforces the slice at runtime.
 *
 * Mutation paths (create/update/delete) are intentionally excluded — those go
 * through the HTTP routes, server actions, or the entity event bus so the
 * full middleware chain (banCheck, autoMod, threadStateGuard, …) runs.
 */
export const CommunityEntities = Community.publicEntities({
  Container: Community.publicEntity(containerModule).readonly(['getById', 'list', 'getBySlug']),
  ContainerMember: Community.publicEntity(containerMemberModule).readonly([
    'list',
    'getMember',
    'isMember',
  ]),
  Thread: Community.publicEntity(threadModule).readonly([
    'getById',
    'list',
    'listByContainer',
    'listByContainerSorted',
    'search',
  ]),
  Reply: Community.publicEntity(replyModule).readonly(['listByThread', 'search']),
  Reaction: Community.publicEntity(reactionModule).readonly(['listByTarget', 'getUserReaction']),
});

/**
 * Cross-package peer surface used by `slingshot-interactions` (and other
 * component-aware consumers) to resolve community-owned message trees and
 * apply component updates returned by interaction dispatchers.
 */
export interface CommunityInteractionsPeer {
  readonly peerKind: 'community';
  resolveMessageByKindAndId(
    kind: 'chat:message' | 'community:thread' | 'community:reply' | 'community:post',
    id: string,
  ): Promise<{ readonly components?: unknown } | null>;
  updateComponents(
    kind: 'chat:message' | 'community:thread' | 'community:reply' | 'community:post',
    id: string,
    components: ReadonlyArray<unknown>,
  ): Promise<void>;
}

export const CommunityInteractionsPeerCap =
  Community.capability<CommunityInteractionsPeer>('interactionsPeer');
