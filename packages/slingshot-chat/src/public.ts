/**
 * Public contract for `slingshot-chat`.
 *
 * Two layers:
 *
 *   - `ChatEntities` — the canonical adapter surface. Each ref names a
 *     read-only slice of an entity adapter (Room.getById, Message.list,
 *     etc.). Consumers resolve these via `requireEntityAdapter(carrier, ref)`
 *     from `@lastshotlabs/slingshot-core`. The adapters are published into
 *     pluginState by the framework's package compiler during the package's
 *     `setupRoutes` phase, so consumers must read in `setupPost` or
 *     per-request handlers.
 *
 *   - `ChatInteractionsPeerCap` — the cross-package peer capability used
 *     by `slingshot-interactions` for component-tree resolution and
 *     updates. Resolved via `ctx.capabilities.require(ChatInteractionsPeerCap)`.
 */
import { definePackageContract } from '@lastshotlabs/slingshot-core';
// Import the standalone modules from each entity file. The package's
// runtime-wired modules are built inside `buildChatEntityModules(...)`
// with `onAdapter` callbacks — those are NOT the same values referenced
// here; the public contract only needs the entity metadata (config,
// operations) so the framework can derive typed adapter slices at compile
// time and runtime.
import { messageModule } from './entities/message';
import { roomModule } from './entities/room';
import { roomMemberModule } from './entities/room-member';

export const Chat = definePackageContract('slingshot-chat');

/**
 * Read-only adapter surface for chat entities.
 *
 * Cross-package consumers (SSR loaders, search indexers, application-defined
 * plugins) resolve adapters with:
 *
 * ```ts
 * import { ChatEntities } from '@lastshotlabs/slingshot-chat';
 * import { requireEntityAdapter } from '@lastshotlabs/slingshot-core';
 *
 * const rooms = requireEntityAdapter(carrier, ChatEntities.Room);
 * const room = await rooms.getById('room-123');
 * ```
 *
 * The exposed methods are the canonical lookup paths used elsewhere in this
 * package's HTTP routes; `readonly([...])` enforces the slice at runtime.
 *
 * Mutation paths (create/update/delete) are intentionally excluded — those go
 * through the HTTP routes, server actions, or the entity event bus so the
 * full middleware chain (banCheck, encryption, blockGuard, …) runs.
 */
export const ChatEntities = Chat.publicEntities({
  Room: Chat.publicEntity(roomModule).readonly(['getById', 'list', 'findDm']),
  Message: Chat.publicEntity(messageModule).readonly([
    'getById',
    'list',
    'listByRoom',
    'listReplies',
    'searchMessages',
  ]),
  RoomMember: Chat.publicEntity(roomMemberModule).readonly([
    'list',
    'getById',
    'listByRoom',
    'listByUser',
    'findMember',
  ]),
});

/**
 * Cross-package peer surface used by `slingshot-interactions` (and other
 * component-aware consumers) to resolve chat-owned message trees and apply
 * component updates returned by interaction dispatchers.
 */
export interface ChatInteractionsPeer {
  readonly peerKind: 'chat';
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

export const ChatInteractionsPeerCap = Chat.capability<ChatInteractionsPeer>('interactionsPeer');
