/**
 * Convert a Slingshot event key to a Kafka topic name.
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
