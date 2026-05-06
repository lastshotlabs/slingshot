/**
 * Public contract for `slingshot-chat`.
 *
 * Cross-package consumers (notably `slingshot-interactions` for component-tree
 * resolution) resolve `ChatInteractionsPeerCap` through
 * `ctx.capabilities.require(...)`.
 */

import { definePackageContract } from '@lastshotlabs/slingshot-core';

export const Chat = definePackageContract('slingshot-chat');

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

export const ChatInteractionsPeerCap =
  Chat.capability<ChatInteractionsPeer>('interactionsPeer');
