import type { MessageKind } from '../components/types';

/** Peer contract implemented by chat/community owners of component trees. */
export interface InteractionsPeer {
  resolveMessageByKindAndId(
    kind: MessageKind,
    id: string,
  ): Promise<{ readonly components?: unknown } | null>;
  updateComponents(
    kind: MessageKind,
    id: string,
    components: ReadonlyArray<unknown>,
  ): Promise<void>;
}

/** Chat peer implementation contract. */
export interface ChatInteractionsPeer extends InteractionsPeer {
  readonly peerKind: 'chat';
}

/** Community peer implementation contract. */
export interface CommunityInteractionsPeer extends InteractionsPeer {
  readonly peerKind: 'community';
}
