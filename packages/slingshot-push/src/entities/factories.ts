import { createEntityFactories } from '@lastshotlabs/slingshot-entity';
import { PushDelivery, pushDeliveryOperations } from './pushDelivery';
import { PushSubscription, pushSubscriptionOperations } from './pushSubscription';
import { PushTopic, pushTopicOperations } from './pushTopic';
import { PushTopicMembership, pushTopicMembershipOperations } from './pushTopicMembership';

/** Store-type keyed factories for `PushSubscription`. */
export const pushSubscriptionFactories = createEntityFactories(
  PushSubscription,
  pushSubscriptionOperations.operations,
);
/** Store-type keyed factories for `PushTopic`. */
export const pushTopicFactories = createEntityFactories(PushTopic, pushTopicOperations.operations);
/** Store-type keyed factories for `PushTopicMembership`. */
export const pushTopicMembershipFactories = createEntityFactories(
  PushTopicMembership,
  pushTopicMembershipOperations.operations,
);
/** Store-type keyed factories for `PushDelivery`. */
export const pushDeliveryFactories = createEntityFactories(
  PushDelivery,
  pushDeliveryOperations.operations,
);
