import type { ChatAesGcmEncryptionConfig, ChatEncryptionConfig } from '../types';
import type { ChatEncryptionProvider } from './types';
import { createAesGcmEncryptionProvider } from './providers/aesGcm';

function assertNever(value: never): never {
  throw new Error(`[slingshot-chat] Unsupported encryption provider: ${String(value)}`);
}

function createNoopEncryptionProvider(): ChatEncryptionProvider | null {
  return null;
}

export function resolveChatEncryptionProvider(
  config: ChatEncryptionConfig | undefined,
): ChatEncryptionProvider | null {
  const provider = config?.provider ?? 'none';

  switch (provider) {
    case 'none':
      return createNoopEncryptionProvider();
    case 'aes-gcm':
      return createAesGcmEncryptionProvider(config as ChatAesGcmEncryptionConfig);
    default:
      return assertNever(provider);
  }
}
