import { describe, expect, it } from 'bun:test';
import { resolveChatEncryptionProvider } from '../../src/encryption/provider';

const keyBase64 = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8').toString('base64');

describe('resolveChatEncryptionProvider', () => {
  it('returns null when encryption is disabled', () => {
    expect(resolveChatEncryptionProvider(undefined)).toBeNull();
    expect(resolveChatEncryptionProvider({ provider: 'none' })).toBeNull();
  });

  it('round-trips AES-GCM ciphertext for the same room', async () => {
    const provider = resolveChatEncryptionProvider({
      provider: 'aes-gcm',
      keyBase64,
      aadPrefix: 'test-suite',
    });

    if (!provider) {
      throw new Error('Expected AES-GCM provider to resolve');
    }

    const ciphertext = await provider.encrypt('top secret', 'room-1');
    expect(ciphertext).toStartWith('aes-gcm:v1.');

    await expect(provider.decrypt(ciphertext, 'room-1')).resolves.toBe('top secret');
  });

  it('binds ciphertext to the room id via authenticated data', async () => {
    const provider = resolveChatEncryptionProvider({
      provider: 'aes-gcm',
      keyBase64,
    });

    if (!provider) {
      throw new Error('Expected AES-GCM provider to resolve');
    }

    const ciphertext = await provider.encrypt('top secret', 'room-1');

    await expect(provider.decrypt(ciphertext, 'room-2')).rejects.toThrow();
  });
});
