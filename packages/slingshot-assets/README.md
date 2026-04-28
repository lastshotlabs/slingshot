---
title: Human Guide
description: Human-maintained guidance for @lastshotlabs/slingshot-assets
---

`@lastshotlabs/slingshot-assets` is Slingshot's asset storage package. It owns asset metadata, storage
adapter resolution, presigned-upload support, image-aware asset behavior, and the runtime wiring
that keeps stored bytes and persisted asset records aligned.
The asset entities themselves follow the shared package-first/entity authoring model;
`createAssetsPlugin()` is the runtime shell that composes them into the live plugin.

## When To Use It

Use this package when your app needs:

- uploaded files with persisted metadata
- storage adapters that can swap between memory, local files, and S3-compatible backends
- presigned upload or download flows
- image-serving or transform-aware asset routes
- a standard asset domain that other packages can reference instead of inventing their own upload tables

## What You Need Before Wiring It In

This plugin declares these dependencies:

- `slingshot-auth`
- `slingshot-permissions`

It also requires a storage adapter configuration. `storage` is the only required config field.

You can provide storage as either:

- a runtime adapter instance
- a manifest-safe built-in adapter reference such as `s3`, `local`, or `memory`

## Minimum Setup

At minimum, provide:

- a storage adapter

Then layer on the optional controls as needed:

- `mountPath` for route placement. It must start with `/`; trailing slashes are trimmed.
- `maxFileSize` and `maxFiles` for upload limits
- `allowedMimeTypes` for MIME policy
- `keyPrefix` and `tenantScopedKeys` for storage-key shape
- `presignedUrls` for direct upload/download flows
- `registryTtlSeconds` for metadata caching
- `image` for image-specific limits and cache behavior

If `mountPath` is omitted, the plugin mounts at `/assets`.

## What You Get

The package gives you both data and byte-storage plumbing:

- an asset entity manifest and runtime wiring
- storage adapter resolution for built-in or runtime-provided backends
- asset routes mounted through the entity plugin
- presign, image-serving, TTL, and delete-to-storage behavior through the manifest runtime
- plugin state published under `slingshot-assets` with the resolved asset adapter, storage adapter,
  and frozen config

This makes it the right package to standardize uploads for the rest of the platform.

## Common Customization

The first files to read when changing behavior are:

- `src/plugin.ts` for lifecycle and dependency behavior
- `src/config.schema.ts` for supported config and validation rules
- `src/adapters/index.ts` for storage resolution
- `src/manifest/runtime.ts` for asset-specific runtime hooks
- `src/image/` for image-serving and caching behavior

The most important configuration choices are:

- storage backend selection
- MIME and file-count limits
- whether keys are tenant-scoped
- whether presigned URLs are enabled
- whether image transforms are enabled and cached

## Credential rotation

The S3 adapter accepts either a static credentials object or an
`AwsCredentialProvider` — an async function the AWS SDK calls each time it
needs fresh credentials. Use the provider form for any long-running service:
the SDK caches the result until `expiration` passes, then calls back into your
function so STS, Vault, or instance-metadata rotation is honored without a
restart.

If you omit `credentials` entirely the SDK uses its default credential chain
(env, profile, EC2/ECS metadata, STS web identity), which already refreshes
itself. Pass a `AwsCredentialProvider` only when you load credentials from a
backend the default chain doesn't cover.

```typescript
import { createAssetsPlugin, s3Storage } from '@lastshotlabs/slingshot-assets';
import type { AwsCredentialProvider } from '@lastshotlabs/slingshot-assets';

// The SDK calls this whenever cached creds are within `expiration` of expiring,
// so set `expiration` to the upstream credential expiry, not your local polling
// interval. This example uses an internal credential broker; STS, Vault, and
// AWS Secrets Manager work the same way.
const rotatingCredentialProvider: AwsCredentialProvider = async () => {
  const response = await fetch(process.env.ASSETS_CREDENTIAL_ENDPOINT!, {
    headers: { authorization: `Bearer ${process.env.ASSETS_CREDENTIAL_TOKEN!}` },
  });
  if (!response.ok) {
    throw new Error('asset credential endpoint failed');
  }
  const creds = (await response.json()) as {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
    expiresAt: string;
  };
  return {
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    sessionToken: creds.sessionToken,
    expiration: new Date(creds.expiresAt),
  };
};

createAssetsPlugin({
  storage: s3Storage({
    bucket: 'my-app-assets',
    region: 'us-east-1',
    credentials: rotatingCredentialProvider,
  }),
});
```

Vault, AWS Secrets Manager, or any other store works the same way — fetch the
current secret inside the provider and return an object with an accurate
`expiration`. Do not roll your own `setInterval` rotation loop; the SDK
already invalidates the cached value when the returned `expiration` is near.

## Gotchas

- The package expects permissions state to exist and throws during startup if `slingshot-permissions`
  is missing.
- Image behavior is opt-in. If `image` is omitted, the package does not apply image-specific
  overrides.
- When `image` config is present but `image.cache` is not a runtime cache adapter, the plugin falls
  back to an in-memory image cache.
- Storage can be a manifest-safe ref or a runtime object. Do not document only one shape unless the
  code has actually narrowed the supported contract.
- Asset-record deletion and underlying storage cleanup are coordinated through middleware set up by
  the manifest runtime. If you change delete behavior, trace both entity and storage paths.

## Key Files

- `src/index.ts`
- `src/plugin.ts`
- `src/config.schema.ts`
- `src/types.ts`
- `src/adapters/index.ts`
- `src/manifest/runtime.ts`
- `src/image/serve.ts`
