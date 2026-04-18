// packages/slingshot-chat/tests/integration/encryption.test.ts
import { describe, expect, it } from 'bun:test';
import { createChatTestApp, seedMember, seedRoom } from '../../src/testing';

const testKeyBase64 = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8').toString('base64');

const headers = (userId: string) => ({
  'x-user-id': userId,
  'content-type': 'application/json',
});

describe('encryption provider — message lifecycle', () => {
  it('encrypts message body on create for encrypted rooms', async () => {
    const { app, state } = await createChatTestApp({
      encryption: { provider: 'aes-gcm', keyBase64: testKeyBase64 },
    });
    const room = await seedRoom(state, { type: 'group', encrypted: true });
    await seedMember(state, { roomId: room.id, userId: 'user-1', role: 'member' });

    const res = await app.request('/chat/messages', {
      method: 'POST',
      headers: headers('user-1'),
      body: JSON.stringify({ roomId: room.id, body: 'Secret', authorId: 'user-1' }),
    });
    expect(res.status).toBe(201);

    // The response should contain the DECRYPTED body (plaintext for the client)
    const data = (await res.json()) as { body: string };
    expect(data.body).toBe('Secret');
  });

  it('does not encrypt in non-encrypted rooms', async () => {
    const { app, state } = await createChatTestApp({
      encryption: { provider: 'aes-gcm', keyBase64: testKeyBase64 },
    });
    const room = await seedRoom(state, { type: 'group', encrypted: false });
    await seedMember(state, { roomId: room.id, userId: 'user-1', role: 'member' });

    const res = await app.request('/chat/messages', {
      method: 'POST',
      headers: headers('user-1'),
      body: JSON.stringify({ roomId: room.id, body: 'Plain', authorId: 'user-1' }),
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as { body: string };
    expect(data.body).toBe('Plain');
  });

  it('encrypts edited body in encrypted rooms', async () => {
    const { app, state } = await createChatTestApp({
      encryption: { provider: 'aes-gcm', keyBase64: testKeyBase64 },
    });
    const room = await seedRoom(state, { type: 'group', encrypted: true });
    await seedMember(state, { roomId: room.id, userId: 'user-1', role: 'member' });

    // Create message through route (gets encrypted in storage, decrypted in response)
    const createRes = await app.request('/chat/messages', {
      method: 'POST',
      headers: headers('user-1'),
      body: JSON.stringify({ roomId: room.id, body: 'Original', authorId: 'user-1' }),
    });
    const msg = (await createRes.json()) as { id: string };

    // Edit message
    const editRes = await app.request(`/chat/messages/${msg.id}`, {
      method: 'PATCH',
      headers: headers('user-1'),
      body: JSON.stringify({ body: 'Edited secret' }),
    });
    expect(editRes.status).toBe(200);
    const editData = (await editRes.json()) as { body: string };
    // Response body should be decrypted plaintext
    expect(editData.body).toBe('Edited secret');
  });

  it('reports server-side encryption as enabled when a provider is configured', async () => {
    const { app } = await createChatTestApp({
      encryption: { provider: 'aes-gcm', keyBase64: testKeyBase64 },
    });

    const res = await app.request('/chat/encryption/status');
    expect(res.status).toBe(200);

    const body = (await res.json()) as { kmsEnabled: boolean };
    expect(body.kmsEnabled).toBe(true);
  });
});
