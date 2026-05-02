import {
  type SlingshotPlugin,
  defineEvent,
  getContext,
} from '../../packages/slingshot-core/src/index.ts';
import { createAuthPlugin } from '../../packages/slingshot-auth/src/index.ts';
import { createWebhookPlugin } from '../../packages/slingshot-webhooks/src/index.ts';
import { defineApp } from '../../src/index.ts';

declare module '@lastshotlabs/slingshot-core' {
  interface SlingshotEventMap {
    'orders:order.placed': {
      tenantId: string;
      orderId: string;
      amountCents: number;
    };
  }
}

/**
 * Toy "orders" plugin that emits a single registered event the webhook plugin
 * can subscribe to. In a real app the source event would come from any plugin —
 * `slingshot-entity`, an OAuth callback, a queue worker, etc.
 */
function createOrdersPlugin(): SlingshotPlugin {
  return {
    name: 'orders',
    async setupMiddleware({ events }) {
      events.register(
        defineEvent('orders:order.placed', {
          ownerPlugin: 'orders',
          exposure: ['tenant-webhook'],
          resolveScope(payload) {
            return {
              tenantId: payload.tenantId,
              resourceType: 'order',
              resourceId: payload.orderId,
            };
          },
        }),
      );
    },
    async setupRoutes({ app }) {
      app.post('/orders', async c => {
        const body = (await c.req.json()) as {
          tenantId: string;
          orderId: string;
          amountCents: number;
        };
        const ctx = getContext(app);
        ctx.events.publish('orders:order.placed', body, {
          source: 'http',
          requestTenantId: body.tenantId,
        });
        return c.json({ ok: true }, 202);
      });
    },
  };
}

export default defineApp({
  port: 3000,
  db: { mongo: false, redis: false },
  security: {
    signing: {
      secret: process.env.JWT_SECRET ?? 'dev-secret-change-me-dev-secret-change-me',
    },
  },
  plugins: [
    createAuthPlugin({
      auth: { roles: ['user', 'admin'], defaultRole: 'user' },
      db: { auth: 'memory', sessions: 'memory', oauthState: 'memory' },
    }),
    createWebhookPlugin({
      // Plugin-wide default delivery timeout. Per-endpoint
      // `deliveryTimeoutMs` overrides this when set on the endpoint record.
      deliveryTimeoutMs: 10_000,
      // Allow plaintext secrets in this in-memory example only — production
      // deployments must set `secretEncryptionKey` (base64 32-byte AES key)
      // or supply a custom `encryptor`.
      allowPlaintextSecrets: true,
      events: ['orders:order.placed'],
    }),
    createOrdersPlugin(),
  ],
});
