import type { AiContentPart, AiMessage, AiMessageContent } from '../provider/types';

/** Return only the textual portion of a provider-neutral message. */
export function messageContentText(content: AiMessageContent): string {
  if (typeof content === 'string') return content;
  return content
    .filter((part): part is Extract<AiContentPart, { type: 'text' }> => part.type === 'text')
    .map(part => part.text)
    .join('');
}

/** Conservative request-size estimate including decoded inline image bytes. */
export function messageContentUnits(content: AiMessageContent): number {
  if (typeof content === 'string') return content.length;
  return content.reduce(
    (sum, part) =>
      sum + (part.type === 'text' ? part.text.length : Math.ceil(part.data.length * 0.75)),
    0,
  );
}

export function messagesText(messages: readonly AiMessage[]): string {
  return messages.map(message => messageContentText(message.content)).join('\n');
}
