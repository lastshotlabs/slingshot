import { createRequire } from 'node:module';
import type { default as RedisClass, RedisOptions } from 'ioredis';
import { wsEndpointKey } from './namespace';
import type { WsTransportAdapter } from './transport';

export type { WsTransportAdapter };

const require = createRequire(import.meta.url);

export interface RedisTransportOptions {
  /** ioredis connection options or a Redis URL string */
  connection: RedisOptions | string;
  /** Channel prefix for pub/sub. Default: "ws:room:" */
  channelPrefix?: string;
}

type RedisConstructor = new (opts: RedisOptions | string) => RedisClass;

function isRedisConstructor(value: unknown): value is RedisConstructor {
  return typeof value === 'function';
}

function hasDefaultRedisConstructor(value: unknown): value is { default: RedisConstructor } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'default' in value &&
    isRedisConstructor((value as { default: unknown }).default)
  );
}

function requireIoredis(): new (opts: RedisOptions | string) => RedisClass {
  try {
    const mod: unknown = require('ioredis');
    if (hasDefaultRedisConstructor(mod)) return mod.default;
    if (isRedisConstructor(mod)) return mod;
    throw new TypeError('[RedisTransport] Invalid ioredis module shape');
  } catch {
    throw new Error('ioredis is required for RedisTransport. Install it: bun add ioredis');
  }
}

/**
 * Redis pub/sub transport for horizontal WebSocket scaling.
 *
 * Uses two ioredis clients — one for publishing and one for subscribing —
 * as required by the Redis pub/sub protocol (a client in subscribe mode
 * cannot issue regular commands).
 *
 * Uses `psubscribe` on `<prefix>*` so that joining new rooms never
 * requires an additional SUBSCRIBE call.
 *
 * Self-echo prevention: every published message is wrapped with the
 * `origin` passed in from `ws.ts` (the server instance UUID). Messages
 * whose origin matches the local instance are dropped by the caller —
 * the origin is forwarded intact to the `onMessage` callback.
 *
 * @example
 * ```ts
 * import { createRedisTransport } from '@lastshotlabs/slingshot'
 *
 * // Pass transport via ws.transport in createServer config:
 * createServer({
 *   ws: {
 *     transport: createRedisTransport({ connection: { host: 'localhost', port: 6379 } }),
 *     endpoints: { '/ws': {} },
 *   },
 * })
 * ```
 */
export function createRedisTransport(opts: RedisTransportOptions): WsTransportAdapter {
  const channelPrefix = opts.channelPrefix ?? 'ws:room:';

  let pubClient: RedisClass | null = null;
  let subClient: RedisClass | null = null;

  function buildClients(): { pub: RedisClass; sub: RedisClass } {
    const Redis = requireIoredis();
    const conn = opts.connection;
    const pub = new Redis(conn);
    const sub = new Redis(conn);
    return { pub, sub };
  }

  function channelForKey(key: string): string {
    return `${channelPrefix}${key}`;
  }

  function keyFromChannel(channel: string): string {
    return channel.slice(channelPrefix.length);
  }

  return {
    async publish(endpoint: string, room: string, message: string, origin: string): Promise<void> {
      if (!pubClient)
        return Promise.reject(new Error('[RedisTransport] Not connected — call connect() first'));
      const payload = JSON.stringify({ msg: message, origin });
      await pubClient.publish(channelForKey(wsEndpointKey(endpoint, room)), payload);
    },

    async connect(
      onMessage: (endpoint: string, room: string, message: string, origin: string) => void,
    ): Promise<void> {
      const { pub, sub } = buildClients();
      pubClient = pub;
      subClient = sub;

      // ioredis v5+ requires error listeners to avoid crashing on connection errors
      pubClient.on('error', (err: Error) => console.error('[RedisTransport] pub error:', err));
      subClient.on('error', (err: Error) => console.error('[RedisTransport] sub error:', err));

      // psubscribe covers all rooms under the prefix — avoids per-room subscribe churn
      await subClient.psubscribe(`${channelPrefix}*`);

      subClient.on('pmessage', (_pattern: string, channel: string, rawPayload: string) => {
        let parsed: { msg: string; origin: string };
        try {
          parsed = JSON.parse(rawPayload) as { msg: string; origin: string };
        } catch {
          // Malformed payload — skip silently
          return;
        }
        // Channel key is a wsEndpointKey composite — decode endpoint and room
        const compositeKey = keyFromChannel(channel);
        const colonIdx = compositeKey.indexOf(':');
        if (colonIdx === -1) return;
        let endpoint: string;
        let room: string;
        try {
          endpoint = decodeURIComponent(compositeKey.slice(0, colonIdx));
          room = decodeURIComponent(compositeKey.slice(colonIdx + 1));
        } catch {
          return;
        }
        onMessage(endpoint, room, parsed.msg, parsed.origin);
      });
    },

    disconnect(): Promise<void> {
      if (subClient) {
        // Force-close the subscriber connection. In ioredis, a client in
        // subscribe mode will hang on quit() because it waits for pending
        // subscribe-mode commands. disconnect() closes the socket immediately
        // without waiting, which is safe at shutdown time.
        subClient.disconnect();
        subClient = null;
      }
      if (pubClient) {
        // Use disconnect() for consistency — quit() can hang if ioredis is
        // in the middle of a reconnect cycle and has queued commands.
        pubClient.disconnect();
        pubClient = null;
      }
      return Promise.resolve();
    },
  };
}
