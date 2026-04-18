import { webcrypto } from 'node:crypto';
import type { ChatAesGcmEncryptionConfig } from '../../types';
import type { ChatEncryptionProvider } from '../provider';

const cryptoApi = webcrypto;
const encoder = new TextEncoder();
const CIPHER_PREFIX = 'aes-gcm:v1';

function encodeBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function decodeBase64Url(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64url'));
}

function getAdditionalData(roomId: string, prefix: string | undefined): Uint8Array {
  return encoder.encode(`${prefix ?? 'slingshot-chat'}:${roomId}`);
}

function parseCiphertext(ciphertext: string): { iv: Uint8Array; payload: Uint8Array } {
  const parts = ciphertext.split('.');
  if (parts.length !== 3 || parts[0] !== CIPHER_PREFIX) {
    throw new Error('[slingshot-chat] Invalid AES-GCM ciphertext payload');
  }

  return {
    iv: decodeBase64Url(parts[1]),
    payload: decodeBase64Url(parts[2]),
  };
}

export function createAesGcmEncryptionProvider(
  config: ChatAesGcmEncryptionConfig,
): ChatEncryptionProvider {
  let keyPromise: Promise<CryptoKey> | undefined;

  const getKey = (): Promise<CryptoKey> => {
    keyPromise ??= cryptoApi.subtle.importKey(
      'raw',
      Buffer.from(config.keyBase64, 'base64'),
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt'],
    );

    return keyPromise;
  };

  return {
    async encrypt(plaintext, roomId) {
      const iv = cryptoApi.getRandomValues(new Uint8Array(12));
      const key = await getKey();
      const encrypted = await cryptoApi.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv,
          additionalData: getAdditionalData(roomId, config.aadPrefix),
        },
        key,
        encoder.encode(plaintext),
      );

      return `${CIPHER_PREFIX}.${encodeBase64Url(iv)}.${encodeBase64Url(new Uint8Array(encrypted))}`;
    },

    async decrypt(ciphertext, roomId) {
      const { iv, payload } = parseCiphertext(ciphertext);
      const key = await getKey();
      const decrypted = await cryptoApi.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv,
          additionalData: getAdditionalData(roomId, config.aadPrefix),
        },
        key,
        payload,
      );

      return new TextDecoder().decode(decrypted);
    },
  };
}
