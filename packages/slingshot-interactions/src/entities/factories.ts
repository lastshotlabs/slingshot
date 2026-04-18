import { createEntityFactories } from '@lastshotlabs/slingshot-entity';
import { InteractionEvent, interactionEventOperations } from './interactionEvent';

/** Store-type keyed factories for the `InteractionEvent` audit entity. */
export const interactionEventFactories = createEntityFactories(
  InteractionEvent,
  interactionEventOperations.operations,
);
