/**
 * Convert a Slingshot event key to a Kafka topic name.
 *
 * The event's `:` separators are replaced with `.` (preserving the namespace
 * convention) and the prefix is prepended verbatim. Inputs that contain
 * Kafka-illegal characters or consecutive colons are passed through; callers
 * are responsible for keeping event names well-formed (use `defineEvent` and
 * the `namespace:resource.action` convention).
 */
export function toTopicName(prefix: string, event: string): string {
  return `${prefix}.${event.replace(/:/g, '.')}`;
}

/**
 * Build a consumer group ID scoped to the fully resolved topic name and
 * subscription name.
 */
export function toGroupId(prefix: string, topic: string, name: string): string {
  return `${prefix}.${topic}.${name}`;
}
