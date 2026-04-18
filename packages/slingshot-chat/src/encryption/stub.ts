// packages/slingshot-chat/src/encryption/stub.ts
/**
 * @status PENDING — full Signal protocol implementation is v2.
 *
 * v1: server-side at-rest encryption is configured through the manifest-safe
 * `ChatPluginConfig.encryption` provider settings. Message encryption/decryption
 * runs automatically when `Room.encrypted = true`.
 *
 * v2 requirements: see Phase 11 spec notes for Signal protocol implementation.
 */
import { Hono } from 'hono';
import type { ChatPluginState } from '../types';

/**
 * Key bundle stored per user.
 * v1: stub shape. v2: populated by full Signal key upload flow.
 *
 * @status PENDING
 */
export interface UserKeyBundle {
  /** User ID this bundle belongs to. */
  userId: string;
  /**
   * Base64-encoded X25519 public identity key.
   * @status PENDING — not stored in v1
   */
  identityKey?: string;
  /**
   * Base64-encoded signed prekey (X25519).
   * @status PENDING — not stored in v1
   */
  signedPrekey?: string;
  /**
   * Signature over signedPrekey using the identity key (Ed25519).
   * @status PENDING — not stored in v1
   */
  signature?: string;
  /**
   * Base64-encoded one-time prekey. Consumed on use — server deletes it.
   * @status PENDING — not stored in v1
   */
  oneTimePrekey?: string;
}

/**
 * Build the Hono router for encryption key exchange routes.
 *
 * v1 routes are stubs that return the `{ status: 'pending' }` response.
 * v2 must replace each stub with a working implementation.
 *
 * Routes:
 * - `GET  /chat/encryption/status`                 v1: returns encryption capability status
 * - `POST /chat/encryption/init`                   v1: stub — v2: initialize key material
 * - `GET  /chat/encryption/key-bundle/:userId`     v1: stub — v2: return key bundle for X3DH
 * - `PUT  /chat/encryption/prekeys`                v1: stub — v2: upload prekey batch
 *
 * @param _state - The ChatPluginState (used in v2 for key storage queries).
 * @internal
 */
export function buildEncryptionRouter(state: ChatPluginState): Hono {
  const router = new Hono();

  /**
   * GET /encryption/status
   *
   * v1: Returns the server's encryption capability.
   * Clients check this before attempting E2E session setup.
   *
   * v2 response should include:
   * - `e2eSupported: boolean` — true when Signal protocol is implemented
   * - `kmsEnabled: boolean` — true when server-side encryption is configured
   */
  router.get('/status', c => {
    return c.json({
      e2eSupported: false, // @status PENDING — set to true when Signal is implemented
      kmsEnabled: state.config.encryption?.provider !== 'none',
      v2PendingNote: 'Full E2E encryption (Signal protocol) is scheduled for v2.',
    });
  });

  /**
   * POST /encryption/init
   *
   * v1: Stub. Returns 501.
   *
   * v2: Client uploads initial key material (identity key, signed prekey batch,
   * one-time prekeys). Server stores public keys only. Private keys never leave device.
   *
   * v2 request body:
   * ```json
   * {
   *   "identityKey": "base64...",
   *   "signedPrekey": "base64...",
   *   "signedPrekeyId": 1,
   *   "signature": "base64...",
   *   "oneTimePrekeys": [{ "id": 1, "key": "base64..." }, ...]
   * }
   * ```
   */
  router.post('/init', c => {
    return c.json(
      {
        error:
          'E2E encryption init is not implemented in v1. See Phase 11 spec for v2 requirements.',
      },
      501,
    );
  });

  /**
   * GET /encryption/key-bundle/:targetUserId
   *
   * v1: Stub. Returns 501.
   *
   * v2: Returns `UserKeyBundle` for X3DH key agreement. Consumes a one-time
   * prekey (deletes it from server storage after returning).
   *
   * v2 implementation steps:
   * 1. Load identity key and current signed prekey for `userId`.
   * 2. Pop one OPK from the user's OPK pool (delete from storage).
   * 3. Return bundle. If OPK pool is empty, return bundle without OPK
   *    (caller handles OPK-less X3DH with reduced forward secrecy).
   * 4. Trigger push notification to target user that prekeys are running low.
   */
  router.get('/key-bundle/:targetUserId', c => {
    return c.json(
      {
        error:
          'E2E key bundle fetch is not implemented in v1. See Phase 11 spec for v2 requirements.',
      },
      501,
    );
  });

  /**
   * PUT /encryption/prekeys
   *
   * v1: Stub. Returns 501.
   *
   * v2: Client uploads a batch of new one-time prekeys when supply is running low.
   * Server appends to the OPK pool. Does not replace existing prekeys.
   *
   * v2 request body:
   * ```json
   * { "oneTimePrekeys": [{ "id": number, "key": "base64..." }, ...] }
   * ```
   */
  router.put('/prekeys', c => {
    return c.json(
      { error: 'Prekey upload is not implemented in v1. See Phase 11 spec for v2 requirements.' },
      501,
    );
  });

  return router;
}
