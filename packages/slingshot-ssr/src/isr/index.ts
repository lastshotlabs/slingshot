// packages/slingshot-ssr/src/isr/index.ts
// Subpath export for @lastshotlabs/slingshot-ssr/isr

export { createMemoryIsrCache } from './memory';
export type { MemoryIsrCacheOptions } from './memory';

export { createRedisIsrCache } from './redis';

export { createIsrInvalidators } from './revalidate';
export type { IsrInvalidators } from './revalidate';

export type { IsrCacheAdapter, IsrCacheEntry, IsrConfig, RedisLike } from './types';

// ─── Server action revalidation helpers ──────────────────────────────────────
// Ambient functions for use inside server actions. Must be called within the
// async context set up by `withActionContext()` (the /_snapshot/action handler).
export { revalidatePath, revalidateTag } from '../actions/context';
