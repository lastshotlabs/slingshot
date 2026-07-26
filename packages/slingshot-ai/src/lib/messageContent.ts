import type { AiContentPart, AiMessage, AiMessageContent } from '../provider/types';

/** Return only the textual portion of a provider-neutral message. */
export function messageContentText(content: AiMessageContent): string {
  if (typeof content === 'string') return content;
  return content
    .filter((part): part is Extract<AiContentPart, { type: 'text' }> => part.type === 'text')
    .map(part => part.text)
    .join('');
}

/** Size one content part for the pre-flight spend estimate. */
function partUnits(part: AiContentPart): number {
  switch (part.type) {
    case 'text':
      return part.text.length;
    case 'image':
      return Math.ceil(part.data.length * 0.75);
    case 'tool_call':
      return part.name.length + part.argumentsJson.length;
    case 'tool_result':
      // A tool result is often the LARGEST thing in the conversation — a page of
      // rows, a computed trend — and the message list grows by one of these on
      // every loop iteration. An estimator blind to them would under-count
      // precisely the loop the pre-flight spend guard exists to catch.
      return part.name.length + safeJsonLength(part.result);
  }
}

/** Length of the JSON an adapter would send, without throwing on a cyclic value. */
function safeJsonLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return String(value).length;
  }
}

/** Conservative request-size estimate including decoded inline image bytes. */
export function messageContentUnits(content: AiMessageContent): number {
  if (typeof content === 'string') return content.length;
  return content.reduce((sum, part) => sum + partUnits(part), 0);
}

export function messagesText(messages: readonly AiMessage[]): string {
  return messages.map(message => messageContentText(message.content)).join('\n');
}
