import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'bun:test';
import { createSecretCipher, wrapSecretEncryptor } from '../../src/lib/secretCipher';

function key(byte: number): string {
  return Buffer.alloc(32, byte).toString('base64');
}

function keyUrlSafe(byte: number): string {
  return key(byte).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

describe('webhook secret cipher', () => {
  it('passes plaintext through when no key is configured', () => {
    const cipher = createSecretCipher(undefined);

    expect(cipher.enabled).toBe(false);
    expect(cipher.encrypt('plain-secret')).toBe('plain-secret');
    expect(cipher.decrypt('plain-secret')).toBe('plain-secret');
  });

  it('fails closed when encrypted material is read without a configured key', () => {
    const cipher = createSecretCipher(null);

    expect(() => cipher.decrypt('enc:v1:iv:ciphertext:tag')).toThrow(
      'cannot decrypt: encrypted secret found but no secretEncryptionKey is configured',
    );
  });

  it('rejects keys that do not decode to 32 bytes', () => {
    expect(() => createSecretCipher(Buffer.alloc(16, 1).toString('base64'))).toThrow(
      'must decode to 32 bytes',
    );
  });

  it('encrypts and decrypts secrets with a base64 key', () => {
    const cipher = createSecretCipher(key(7));

    const encrypted = cipher.encrypt('webhook-secret');

    expect(cipher.enabled).toBe(true);
    expect(encrypted).toStartWith('enc:v1:');
    expect(encrypted).not.toContain('webhook-secret');
    expect(cipher.decrypt(encrypted)).toBe('webhook-secret');
  });

  it('accepts base64url keys and treats legacy plaintext as readable during migration', () => {
    const cipher = createSecretCipher(keyUrlSafe(9));

    expect(cipher.enabled).toBe(true);
    expect(cipher.decrypt('legacy-plaintext')).toBe('legacy-plaintext');
  });

  it('rejects malformed encrypted secret envelopes', () => {
    const cipher = createSecretCipher(key(11));
    const shortIv = Buffer.alloc(2, 1).toString('base64');
    const ciphertext = Buffer.from('secret').toString('base64');
    const validLengthTag = Buffer.alloc(16, 1).toString('base64');

    expect(() => cipher.decrypt('enc:v1:missing:parts')).toThrow('malformed encrypted secret');
    expect(() => cipher.decrypt('enc:v1::ciphertext:tag')).toThrow('malformed encrypted secret');
    expect(() => cipher.decrypt(`enc:v1:${shortIv}:${ciphertext}:${validLengthTag}`)).toThrow(
      'malformed encrypted secret components',
    );
  });

  it('surfaces authentication failures for tampered ciphertext', () => {
    const cipher = createSecretCipher(key(13));
    const encrypted = cipher.encrypt('webhook-secret');
    const [iv, ciphertext, tag] = encrypted.slice('enc:v1:'.length).split(':');
    const tamperedCiphertext = `${ciphertext?.[0] === 'A' ? 'B' : 'A'}${ciphertext?.slice(1)}`;
    const tampered = `enc:v1:${iv}:${tamperedCiphertext}:${tag}`;

    expect(() => cipher.decrypt(tampered)).toThrow();
  });
});

describe('webhook secret encryptor wrapper', () => {
  it('normalizes sync and async custom encryptors to an async runtime shape', async () => {
    const wrapped = wrapSecretEncryptor({
      encrypt: plaintext => `wrapped:${plaintext}`,
      decrypt: async stored => stored.replace(/^wrapped:/, ''),
    });

    await expect(wrapped.encrypt('secret')).resolves.toBe('wrapped:secret');
    await expect(wrapped.decrypt('wrapped:secret')).resolves.toBe('secret');
  });
});
