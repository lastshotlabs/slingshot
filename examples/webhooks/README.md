# Webhooks Example

Source-backed example for `slingshot-webhooks` outbound delivery.

## What it shows

- `createWebhookPlugin()` wired into the app
- a small "orders" plugin that publishes a registered event the webhook plugin subscribes to
- a per-endpoint `deliveryTimeoutMs` override (the plugin-wide default is 10s; each endpoint can override)
- HMAC-SHA256 signing with timestamped headers and a recipe for verifying signatures

## Files

- `app.config.ts` - typed app config with the toy `orders` plugin

## Run

From the repo root:

```bash
JWT_SECRET=dev-secret-change-me-dev-secret-change-me slingshot start --config examples/webhooks/app.config.ts
```

## Walkthrough

```bash
# 1. Register an admin user (the management routes require the 'admin' role)
TOKEN=$(curl -s -X POST http://localhost:3000/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"admin@example.com","password":"hunter2hunter2","roles":["admin"]}' \
  | jq -r .token)

# 2. Create a webhook endpoint with a custom 5-second per-endpoint timeout.
#    This wins over the plugin-wide deliveryTimeoutMs (10s) for this endpoint.
curl -X POST http://localhost:3000/webhooks/endpoints \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "ownerType": "tenant",
    "ownerId": "tenant-acme",
    "tenantId": "tenant-acme",
    "url": "https://your-receiver.example.com/hook",
    "secret": "hook-secret-please-rotate",
    "subscriptions": [{ "event": "orders:order.placed" }],
    "enabled": true,
    "deliveryTimeoutMs": 5000
  }'

# 3. Trigger the source event. The webhook plugin will sign and POST the
#    payload to the endpoint URL, retrying on 5xx with exponential backoff.
curl -X POST http://localhost:3000/orders \
  -H 'content-type: application/json' \
  -d '{"tenantId":"tenant-acme","orderId":"ord_42","amountCents":4200}'
```

## Verifying signatures on the receiver

The dispatcher signs each request with HMAC-SHA256 and sends a Stripe-style
header `X-Webhook-Signature: t=<unix_ts>,v1=<hex_hmac>`. The signed data is
`<ts>.<raw body>`.

```typescript
import { verifySignature } from '@lastshotlabs/slingshot-webhooks';

// In your receiver (any framework):
const rawBody = await req.text();
const header = req.headers.get('x-webhook-signature') ?? '';
const valid = await verifySignature(
  process.env.WEBHOOK_SECRET!, // same value passed when creating the endpoint
  rawBody,
  header,
);
if (!valid) {
  return new Response('Unauthorized', { status: 401 });
}
const payload = JSON.parse(rawBody);
// process payload...
```

`verifySignature` enforces a 5-minute timestamp tolerance to defeat replay
attacks. Pass a different `toleranceSeconds` argument to widen or narrow the
window.

## Production checklist

- Set `secretEncryptionKey` (base64 32-byte AES-256 key) or an `encryptor`
  implementation. The example sets `allowPlaintextSecrets: true` so it boots
  cleanly with the in-memory adapter — never do that in production.
- Replace the in-memory queue with `createWebhookBullMQQueue()` so deliveries
  survive restarts.
- Tune `queueConfig.maxAttempts` and `queueConfig.retryBaseDelayMs` for your
  receiver SLO.
