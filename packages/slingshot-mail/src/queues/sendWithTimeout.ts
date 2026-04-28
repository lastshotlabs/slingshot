import type { MailMessage, MailProvider, SendResult } from '../types/provider';
import { MailSendError } from '../types/provider';

export async function sendWithTimeout(
  provider: MailProvider,
  message: MailMessage,
  timeoutMs: number,
): Promise<SendResult> {
  if (timeoutMs <= 0) return provider.send(message);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      provider.send(message, { signal: controller.signal }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(
            new MailSendError(
              `Mail provider "${provider.name}" timed out after ${timeoutMs}ms`,
              true,
            ),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
