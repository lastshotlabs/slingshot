import type { ChatAesGcmEncryptionConfig, ChatEncryptionConfig } from '../types';
import { createAesGcmEncryptionProvider } from './providers/aesGcm';

export interface ChatEncryptionProvider {
  encrypt(plaintext: string, roomId: string): Promise<string>;
  decrypt(ciphertext: string, roomId: string): Promise<string>;
}

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
