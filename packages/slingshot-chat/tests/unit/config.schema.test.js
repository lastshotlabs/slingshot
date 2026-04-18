// packages/slingshot-chat/tests/unit/config.schema.test.ts
import { describe, expect, it } from 'bun:test';
import { chatPluginConfigSchema } from '../../src/config.schema';

describe('chatPluginConfigSchema', () => {
  it('accepts minimal config with defaults', () => {
    const result = chatPluginConfigSchema.parse({ storeType: 'memory' });
    expect(result.storeType).toBe('memory');
    expect(result.mountPath).toBe('/chat');
    expect(result.pageSize).toBe(50);
    expect(result.enablePresence).toBe(true);
    expect(result.permissions).toEqual({});
  });
  it('accepts full config', () => {
    const result = chatPluginConfigSchema.parse({
      storeType: 'postgres',
      mountPath: '/my-chat',
      permissions: { createRoom: ['admin'] },
      pageSize: 25,
      enablePresence: false,
      encryption: {
        provider: 'aes-gcm',
        keyBase64: 'dGVzdC1rZXktYmFzZTY0',
      },
    });
    expect(result.storeType).toBe('postgres');
    expect(result.mountPath).toBe('/my-chat');
    expect(result.permissions.createRoom).toEqual(['admin']);
    expect(result.encryption).toEqual({
      provider: 'aes-gcm',
      keyBase64: 'dGVzdC1rZXktYmFzZTY0',
    });
  });
  it('rejects unknown storeType', () => {
    expect(() => chatPluginConfigSchema.parse({ storeType: 'cassandra' })).toThrow();
  });
  it('rejects pageSize over 200', () => {
    expect(() => chatPluginConfigSchema.parse({ storeType: 'memory', pageSize: 201 })).toThrow();
  });
  it('rejects missing storeType', () => {
    expect(() => chatPluginConfigSchema.parse({})).toThrow();
  });
  it('accepts all valid storeType values', () => {
    for (const storeType of ['memory', 'redis', 'sqlite', 'postgres', 'mongo']) {
      const result = chatPluginConfigSchema.parse({ storeType });
      expect(result.storeType).toBe(storeType);
    }
  });
  it('accepts a disabled encryption provider config', () => {
    const result = chatPluginConfigSchema.parse({
      storeType: 'memory',
      encryption: { provider: 'none' },
    });
    expect(result.encryption).toEqual({ provider: 'none' });
  });
  it('rejects incomplete AES-GCM encryption config', () => {
    expect(() =>
      chatPluginConfigSchema.parse({
        storeType: 'memory',
        encryption: { provider: 'aes-gcm' },
      }),
    ).toThrow();
  });
});
