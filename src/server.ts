import { validateServerConfig } from '@framework/config/schema';
import { log } from '@framework/lib/logger';
import { runPluginTeardown } from '@framework/runPluginLifecycle';
import { routePatternCanMatchLiteral } from '@framework/sse/collision';
// ensureClientSafeEventKey is now an instance method on SlingshotEventBus
import { type SseFilter, createSseRegistry, createSseUpgradeHandler } from '@framework/sse/index';
import { handleIncomingEvent } from '@framework/ws/dispatch';
import {
  type HeartbeatConfig,
  deregisterSocket,
  handlePong,
  registerSocket,
  startHeartbeat,
  stopHeartbeat,
} from '@framework/ws/heartbeat';
import { type SocketData, createWsUpgradeHandler } from '@framework/ws/index';
import { wsEndpointKey } from '@framework/ws/namespace';
import { trackSocket, untrackSocket } from '@framework/ws/presence';
import { checkRateLimit, cleanupRateLimitBucket } from '@framework/ws/rateLimit';
import { writeSession } from '@framework/ws/recovery';
import { cleanupSocket, handleRoomActions, publish } from '@framework/ws/rooms';
import { disconnectMongo } from '@lib/mongo';
import { disconnectRedis } from '@lib/redis';
import type { Server, WebSocketHandler } from 'bun';
import type { Connection } from 'mongoose';
import type {
  ClientSafeEventKey,
  RuntimeServerInstance,
  SlingshotEventBus,
  SlingshotEventMap,
  SlingshotPlugin,
  SlingshotRuntime,
} from '@lastshotlabs/slingshot-core';
import {
  getClientIp,
  setStandaloneClientIp,
  setStandaloneTrustProxy,
} from '@lastshotlabs/slingshot-core';
import type { SlingshotContext } from '@lastshotlabs/slingshot-core';
import { type CreateAppConfig, createApp } from './app';
import type { SseConfig } from './config/types/sse';
import type { BunTLSConfig } from './config/types/tls';
import type { WsConfig } from './config/types/ws';

// Re-export SocketData so consumers can type their socket data
export type { SocketData };
export type { BunTLSConfig } from './config/types/tls';
export type { SseConfig } from './config/types/sse';
export type { SseEndpointConfig } from '@lastshotlabs/slingshot-core';
export type { WsConfig, WsEndpointConfig } from './config/types/ws';

// ---------------------------------------------------------------------------
// Server → Context mapping (for testing / tooling access)
// ---------------------------------------------------------------------------

const SERVER_CONTEXT_SYMBOL = Symbol.for('slingshot.serverContext');
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;
type ShutdownSignal = 'SIGTERM' | 'SIGINT';

/**
 * Shutdown registry shape. Lives on `process` via a well-known Symbol so there
 * is zero module-level mutable state. The registry is truly process-scoped
 * (where POSIX signals live) and survives module re-evaluation.
 */
interface ProcessShutdownRegistry {
  callbacks: Map<string, (signal: ShutdownSignal) => Promise<number>>;
  listeners: { sigterm: () => void; sigint: () => void } | null;
}

const SHUTDOWN_REGISTRY_SYMBOL = Symbol.for('slingshot.shutdownRegistry');

function getShutdownRegistry(): ProcessShutdownRegistry {
  const proc = process as unknown as Record<symbol, ProcessShutdownRegistry | undefined>;
  let registry = proc[SHUTDOWN_REGISTRY_SYMBOL];
  if (!registry) {
    registry = { callbacks: new Map(), listeners: null };
    proc[SHUTDOWN_REGISTRY_SYMBOL] = registry;
  }
  return registry;
}

function ensureProcessShutdownListeners() {
  const registry = getShutdownRegistry();
  if (registry.listeners) return;
  let dispatching = false;
  const dispatch = (signal: ShutdownSignal) => {
    if (dispatching) return;
    dispatching = true;

    const forceExit = setTimeout(() => {
      console.error(
        `[shutdown] Timed out after ${DEFAULT_SHUTDOWN_TIMEOUT_MS}ms during ${signal}; forcing exit`,
      );
      process.exit(1);
    }, DEFAULT_SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    const cbs = [...registry.callbacks.values()];
    void Promise.allSettled(cbs.map(cb => cb(signal))).then(results => {
      clearTimeout(forceExit);
      const exitCode = results.some(r => r.status === 'rejected' || r.value !== 0) ? 1 : 0;
      console.log(`[shutdown] All servers completed with exit code ${exitCode}`);
      process.exit(exitCode);
    });
  };
  const sigterm = () => dispatch('SIGTERM');
  const sigint = () => dispatch('SIGINT');
  process.on('SIGTERM', sigterm);
  process.on('SIGINT', sigint);
  registry.listeners = { sigterm, sigint };
}

function removeProcessShutdownListeners() {
  const registry = getShutdownRegistry();
  const { listeners } = registry;
  if (!listeners) return;
  process.off('SIGTERM', listeners.sigterm);
  process.off('SIGINT', listeners.sigint);
  registry.listeners = null;
}

/**
 * Retrieve the SlingshotContext associated with a server.
 * Available after createServer() completes. Used by test helpers.
 */
export function getServerContext(server: object): SlingshotContext | null {
  return (
    ((server as Record<PropertyKey, unknown>)[SERVER_CONTEXT_SYMBOL] as
      | SlingshotContext
      | undefined) ?? null
  );
}

// ---------------------------------------------------------------------------
// Server config
// ---------------------------------------------------------------------------

export interface CreateServerConfig<T extends object = object> extends Omit<
  CreateAppConfig<T>,
  'ws'
> {
  port?: number;
  /**
   * Bind address. Default "0.0.0.0".
   * Omitted when `unix` is set.
   */
  hostname?: string;
  /**
   * Unix domain socket path. Mutually exclusive with port, hostname, and tls.
   */
  unix?: string;
  /** TLS configuration. Passed through to Bun.serve(). */
  tls?: BunTLSConfig;
  /** Absolute path to the service's workers directory — auto-imports all .ts files */
  workersDir?: string;
  /** Set false to disable auto-loading workers. Defaults to true */
  enableWorkers?: boolean;
  /** WebSocket configuration */
  ws?: WsConfig<T>;
  /** SSE configuration */
  sse?: SseConfig<T>;
  /**
   * Maximum request body size in bytes. Defaults to the upload config limit when present
   * (maxFileSize * maxFiles), otherwise Bun's default (128 MB).
   */
  maxRequestBodySize?: number;
}

// ---------------------------------------------------------------------------
// createServer
// ---------------------------------------------------------------------------

export const createServer = async <T extends object = object>(
  config: CreateServerConfig<T>,
): Promise<Server<SocketData<T>>> => {
  const serverOwnerId = crypto.randomUUID();
  const isProd = process.env.NODE_ENV === 'production';
  // Validate the full server config shape — catches typos and type errors.
  // createApp separately validates its own subset (app-level keys only).
  const { warnings } = validateServerConfig(config as unknown as Record<string, unknown>, {
    isProd,
  });
  for (const w of warnings) console.warn(w);

  // Startup validation — unix is mutually exclusive with port/hostname/tls
  if (config.unix && config.port !== undefined)
    throw new Error('[slingshot] unix and port are mutually exclusive');
  if (config.unix && config.hostname)
    throw new Error('[slingshot] unix and hostname are mutually exclusive');
  if (config.unix && config.tls) throw new Error('[slingshot] unix sockets do not support TLS');

  // Extract only app-level config keys — createApp validates its own shape and
  // will warn about unknown keys. Passing the full CreateServerConfig would
  // trigger false warnings for server-only keys like port, sse, ws, etc.
  const {
    port: _port,
    hostname: _hostname,
    unix: _unix,
    tls: _tls,
    workersDir: _workersDir,
    enableWorkers: _enableWorkers,
    sse: _sse,
    maxRequestBodySize: _maxRequestBodySize,
    ...rawAppConfig
  } = config;
  void _port;
  void _hostname;
  void _unix;
  void _tls;
  void _workersDir;
  void _enableWorkers;
  void _sse;
  void _maxRequestBodySize;
  const appConfig: CreateAppConfig<T> = rawAppConfig;
  const { app, ctx } = await createApp<T>(appConfig);
  // Runtime is resolved inside createApp; extract it from ctx or re-resolve here.
  // We re-resolve with the same fallback to ensure server.ts has the runtime available
  // for Bun.serve() calls and workers glob.
  const runtime: SlingshotRuntime =
    config.runtime ?? (await import('@slingshot/runtime-bun')).bunRuntime();
  const rawPort = process.env.PORT ?? config.port ?? 3000;
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`[slingshot] Invalid port: ${rawPort} (must be an integer 0–65535)`);
  }
  const { workersDir, enableWorkers = true, ws: wsConfig } = config;

  const sseRegistry = createSseRegistry();
  const sseBusListeners: Array<{ key: ClientSafeEventKey; listener: (p: unknown) => void }> = [];

  if (config.sse) {
    // Read bus from context (replaces appMeta WeakMap)
    const bus = ctx.bus;

    const { endpoints: sseEndpoints } = config.sse;
    const wsEndpointPaths = new Set(Object.keys(config.ws?.endpoints ?? {}));
    const honoGetPatterns: string[] = (
      app as unknown as { routes: Array<{ method: string; path: string }> }
    ).routes
      .filter(r => r.method === 'GET')
      .map(r => r.path);

    for (const [ssePath, epConfig] of Object.entries(sseEndpoints)) {
      // 1. Literal path — no :params or wildcards in sse.endpoints keys
      if (ssePath.includes(':') || ssePath.includes('*'))
        throw new Error(`[sse] "${ssePath}" must be a literal path — no :params or * wildcards`);

      // 2. Prefix enforcement
      if (!ssePath.startsWith('/__sse/'))
        throw new Error(`[sse] "${ssePath}" must be under the /__sse/ prefix`);

      // 3. WS path collision
      if (wsEndpointPaths.has(ssePath))
        throw new Error(`[sse] "${ssePath}" collides with an existing WS endpoint`);

      // 4. Hono GET route collision (pattern-aware — existing routes may use :param or *)
      for (const pattern of honoGetPatterns) {
        if (routePatternCanMatchLiteral(pattern, ssePath))
          throw new Error(`[sse] "${ssePath}" collides with Hono GET route "${pattern}"`);
      }

      // 5. Per-endpoint bus subscriptions (once per event key, not per client)
      const heartbeatMs = epConfig.heartbeat === undefined ? 30_000 : epConfig.heartbeat;
      const upgradeHandler = epConfig.upgrade ?? createSseUpgradeHandler(ssePath, ctx.userResolver);

      for (const rawKey of epConfig.events) {
        const key = bus.ensureClientSafeEventKey(rawKey, `sse.endpoints["${ssePath}"].events`);
        const listener = (payload: unknown) => {
          sseRegistry.fanout(ssePath, key, payload, epConfig.filter as SseFilter | undefined);
        };
        bus.on(key as keyof SlingshotEventMap, listener);
        sseBusListeners.push({ key, listener });
      }

      // 6. Mount Hono GET route
      app.get(ssePath, async c => {
        setStandaloneTrustProxy(c.req.raw, ctx.trustProxy);
        const clientIp = getClientIp(c);
        if (clientIp !== 'unknown') {
          setStandaloneClientIp(c.req.raw, clientIp);
        }
        const result = await upgradeHandler(c.req.raw);
        if (result instanceof Response) return result;
        const stream = sseRegistry.createClientStream(ssePath, result, heartbeatMs);
        c.header('Content-Type', 'text/event-stream');
        c.header('Cache-Control', 'no-cache');
        c.header('Connection', 'keep-alive');
        c.header('X-Accel-Buffering', 'no');
        return c.newResponse(stream);
      });
    }
  }

  // Compute maxRequestBodySize: explicit config wins, else derive from upload config
  let maxRequestBodySize: number | undefined = config.maxRequestBodySize;
  if (maxRequestBodySize === undefined && config.upload) {
    const maxFileSize = config.upload.maxFileSize ?? 10 * 1024 * 1024;
    const maxFiles = config.upload.maxFiles ?? 10;
    maxRequestBodySize = maxFileSize * maxFiles;
  }

  type SD = SocketData<T>;

  // server is typed as the Bun Server type for API compatibility (consumers use server.port,
  // server.upgrade, server.publish). The runtime.server.listen() cast is valid when using the
  // Bun runtime, which returns a native Bun Server that satisfies this interface.
  let server: Server<SD>;
  // Helper to cast RuntimeServerInstance → Server<SD> at the Bun runtime boundary
  const asServer = (instance: RuntimeServerInstance): Server<SD> =>
    instance as unknown as Server<SD>;

  if (wsConfig) {
    const {
      endpoints: configuredEndpoints,
      transport: wsTransport,
      idleTimeout,
      backpressureLimit,
      closeOnBackpressureLimit,
      perMessageDeflate,
      publishToSelf,
    } = wsConfig;
    const endpoints =
      (ctx.wsEndpoints as typeof configuredEndpoints | null | undefined) ?? configuredEndpoints;

    // Compute presence flag once — true if any endpoint enables presence
    const presenceEnabled = Object.values(endpoints).some(ep => !!ep.presence);
    const wsState: NonNullable<SlingshotContext['ws']> = {
      server: null,
      transport: wsTransport ?? null,
      instanceId: crypto.randomUUID(),
      presenceEnabled,
      roomRegistry: new Map<string, Set<string>>(),
      heartbeatSockets: new Map<string, { ws: unknown; endpoint: string; timeoutAt: number }>(),
      heartbeatEndpointConfigs: new Map<string, { intervalMs?: number; timeoutMs?: number }>(),
      heartbeatTimer: null,
      socketUsers: new Map<string, string>(),
      roomPresence: new Map<string, Map<string, Set<string>>>(),
      socketRegistry: new Map<string, unknown>(),
      rateLimitState: new Map(),
      sessionRegistry: new Map(),
      lastEventIds: new Map<string, string>(),
    };

    // Configure per-endpoint side effects + startup validation
    for (const [name, ep] of Object.entries(endpoints)) {
      if (ep.persistence?.defaults) {
        ctx.persistence.setDefaults(ep.persistence.defaults);
      }
      if (ep.recovery && !ep.persistence) {
        throw new Error(
          `[slingshot] WS endpoint '${name}': recovery requires persistence to be configured`,
        );
      }
    }

    const wsHandler: WebSocketHandler<SD> = {
      async open(socket) {
        const ep = endpoints[socket.data.endpoint];
        if (ep.heartbeat) registerSocket(wsState, socket, socket.data.id, socket.data.endpoint);
        if (ep.presence) trackSocket(wsState, socket.data.id, socket.data.userId);
        wsState.socketRegistry.set(socket.data.id, socket);
        if (ep.recovery) {
          socket.data.sessionId = crypto.randomUUID();
        }
        socket.send(
          JSON.stringify({
            event: 'connected',
            id: socket.data.id,
            ...(socket.data.sessionId ? { sessionId: socket.data.sessionId } : {}),
          }),
        );
        if (ep.on?.open) {
          try {
            await ep.on.open(socket);
          } catch (e) {
            console.error(`[ws:hook] ${socket.data.endpoint} open error`, e);
          }
        }
      },
      async message(socket, message) {
        const ep = endpoints[socket.data.endpoint];
        const maxSize = ep.maxMessageSize ?? 65_536;
        const size = typeof message === 'string' ? message.length : message.byteLength;
        if (size > maxSize) {
          socket.close(1009, 'Message too large');
          return;
        }
        const rl = ep.rateLimit;
        if (rl) {
          const decision = checkRateLimit(wsState, socket.data.endpoint, socket.data.id, rl);
          if (decision === 'close') {
            socket.close(1008, 'rate limit exceeded');
            return;
          }
          if (decision === 'drop') return;
        }
        const handledAsRoomAction = await handleRoomActions(
          wsState,
          socket,
          message,
          ep.onRoomSubscribe,
          ep,
          app,
        );
        if (!handledAsRoomAction) {
          const handledAsEvent = await handleIncomingEvent(wsState, socket, message, ep);
          if (!handledAsEvent) {
            if (ep.on?.message) {
              try {
                await ep.on.message(socket, message);
              } catch (e) {
                console.error(`[ws:hook] ${socket.data.endpoint} message error`, e);
              }
            }
          }
        }
      },
      async close(socket, code, reason) {
        const ep = endpoints[socket.data.endpoint];
        if (ep.recovery && socket.data.sessionId) {
          writeSession(
            wsState,
            socket.data.id,
            socket.data.sessionId,
            socket.data.rooms,
            ep.recovery.windowMs ?? 120_000,
          );
        }
        if (ep.heartbeat) deregisterSocket(wsState, socket.data.id);
        if (ep.presence) untrackSocket(wsState, socket.data.id);
        cleanupSocket(wsState, socket, {
          trackDelivery: ep.recovery ? true : undefined,
        });
        wsState.socketRegistry.delete(socket.data.id);
        wsState.lastEventIds.delete(socket.data.id);
        cleanupRateLimitBucket(wsState, socket.data.endpoint, socket.data.id);
        if (ep.on?.close) {
          try {
            await ep.on.close(socket, code, reason);
          } catch (e) {
            console.error(`[ws:hook] ${socket.data.endpoint} close error`, e);
          }
        }
      },
      pong(socket) {
        handlePong(wsState, socket.data.id);
      },
      drain(socket) {
        void endpoints[socket.data.endpoint].on?.drain?.(socket);
      },
    };

    // One upgrade route per endpoint
    const routes = Object.fromEntries(
      Object.entries(endpoints).map(([path, ep]) => [
        path,
        (req: Request) => {
          setStandaloneTrustProxy(req, ctx.trustProxy);
          return ep.upgrade
            ? ep.upgrade(req, server)
            : createWsUpgradeHandler(server as Server<SocketData>, path, ctx.userResolver)(req);
        },
      ]),
    );

    // The WS integration uses Bun-specific features (routes, ServerWebSocket<SD> socket API,
    // backpressureLimit) that don't map cleanly to RuntimeServerOptions. The Bun runtime
    // cast is applied here at the opaque Bun/WS boundary.
    server = Bun.serve<SD>({
      ...(config.unix
        ? { unix: config.unix }
        : { port, ...(config.hostname ? { hostname: config.hostname } : {}) }),
      ...(config.tls ? { tls: config.tls } : {}),
      ...(maxRequestBodySize !== undefined ? { maxRequestBodySize } : {}),
      routes,
      fetch: app.fetch,
      websocket: {
        ...wsHandler,
        ...(idleTimeout !== undefined ? { idleTimeout } : {}),
        ...(backpressureLimit !== undefined ? { backpressureLimit } : {}),
        ...(closeOnBackpressureLimit !== undefined ? { closeOnBackpressureLimit } : {}),
        ...(perMessageDeflate !== undefined ? { perMessageDeflate } : {}),
        ...(publishToSelf !== undefined ? { publishToSelf } : {}),
      },
      error(err) {
        console.error(err);
        return Response.json({ error: 'Internal Server Error' }, { status: 500 });
      },
    });

    wsState.server = server;

    // Connect cross-instance transport
    if (wsTransport) {
      const localId = wsState.instanceId;
      await wsTransport.connect((endpoint, room, msg, origin) => {
        if (origin === localId) return;
        server.publish(wsEndpointKey(endpoint, room), msg);
      });
    }

    // Heartbeat — collect per-endpoint configs
    const heartbeatConfigs: Record<string, HeartbeatConfig | boolean> = {};
    for (const [path, ep] of Object.entries(endpoints)) {
      if (ep.heartbeat) heartbeatConfigs[path] = ep.heartbeat;
    }
    if (Object.keys(heartbeatConfigs).length > 0) {
      startHeartbeat(wsState, heartbeatConfigs);
    }

    // Populate WS state on the SlingshotContext so instance-scoped consumers
    // can read it via getContext(app).ws instead of module-level singletons.
    // presenceEnabled already computed above.
    ctx.ws = wsState;
    // Preserve the live endpoint map on context. createApp() now seeds
    // ctx.wsEndpoints before plugin setupPost so plugins can wire incoming
    // handlers prior to server startup, and createServer() boots from this
    // same object reference.
    ctx.wsEndpoints = endpoints as unknown as typeof ctx.wsEndpoints;
    ctx.wsPublish = publish;
  } else {
    // No WS config — plain HTTP server via runtime abstraction
    const httpOpts: import('@lastshotlabs/slingshot-core').RuntimeServerOptions = {
      port: config.unix ? undefined : port,
      hostname: config.unix ? undefined : config.hostname,
      unix: config.unix,
      tls: config.tls as { key?: string | Uint8Array; cert?: string | Uint8Array } | undefined,
      maxRequestBodySize,
      fetch: app.fetch,
      error(err: Error) {
        console.error(err);
        return Response.json({ error: 'Internal Server Error' }, { status: 500 });
      },
    };
    server = asServer(await runtime.server.listen(httpOpts));
  }

  const releaseProcessShutdownOwnership = () => {
    const registry = getShutdownRegistry();
    registry.callbacks.delete(serverOwnerId);
    if (registry.callbacks.size === 0) {
      removeProcessShutdownListeners();
    }
  };

  const originalStop = server.stop.bind(server);
  server.stop = (async (...args: Parameters<typeof originalStop>) => {
    releaseProcessShutdownOwnership();
    return originalStop(...args);
  }) as typeof server.stop;

  // Graceful shutdown — stop accepting new work, then tear down plugins/bus/db.
  // Returns an exit code (0 = clean, 1 = errors). process.exit() is called by
  // the dispatch layer after all registered servers have finished shutting down.
  let shutdownPromise: Promise<number> | null = null;
  const gracefulShutdown = (signal: ShutdownSignal): Promise<number> => {
    if (shutdownPromise) {
      console.warn(`[shutdown] ${signal} received while shutdown is already in progress`);
      return shutdownPromise;
    }

    shutdownPromise = (async () => {
      console.log(`[shutdown] Received ${signal}; starting graceful shutdown`);

      let exitCode = 0;

      try {
        await server.stop();

        if (ctx.ws) stopHeartbeat(ctx.ws);

        // Plugin teardown runs BEFORE WS transport disconnect so plugins can
        // still publish to rooms (e.g. "user X disconnected" broadcasts).
        const slingshotPlugins: SlingshotPlugin[] = [...ctx.plugins];
        const slingshotBus: SlingshotEventBus = ctx.bus;
        slingshotBus.emit('app:shutdown', { signal });

        try {
          await runPluginTeardown(slingshotPlugins);
        } catch (err) {
          console.error('[shutdown] Plugin teardown error(s):', err);
          exitCode = 1;
        }

        // SSE teardown — close streams first so no fanout fires after unsubscribe,
        // then remove bus listeners, both before bus shutdown.
        sseRegistry.closeAll();
        for (const { key, listener } of sseBusListeners)
          slingshotBus.off(key as keyof SlingshotEventMap, listener as (payload: unknown) => void);

        try {
          await slingshotBus.shutdown?.();
        } catch (e) {
          console.error('[shutdown] Event bus shutdown error:', e);
          exitCode = 1;
        }

        // WS transport disconnect — after plugins and SSE are torn down,
        // no more consumers need the transport.
        const wsTransport = wsConfig?.transport;
        if (wsTransport) {
          try {
            await wsTransport.disconnect();
          } catch (e) {
            console.error('[ws-transport] disconnect error:', e);
            exitCode = 1;
          }
          if (ctx.ws) ctx.ws.transport = null;
        }

        // Database disconnects — close persistent connections last, after all consumers are torn down
        const dbConfig = config.db ?? {};
        const enableRedis = dbConfig.redis ?? true;
        const mongoMode = dbConfig.mongo ?? 'single';
        if (enableRedis && ctx.redis) {
          try {
            await disconnectRedis(ctx.redis as import('ioredis').default | null);
          } catch (e) {
            console.error('[shutdown] Redis disconnect error:', e);
            exitCode = 1;
          }
        }
        if (mongoMode !== false && ctx.mongo) {
          try {
            await disconnectMongo(
              ctx.mongo.auth as Connection | null,
              ctx.mongo.app as Connection | null,
            );
          } catch (e) {
            console.error('[shutdown] MongoDB disconnect error:', e);
            exitCode = 1;
          }
        }
        if (ctx.sqliteDb) {
          try {
            ctx.sqliteDb.close();
          } catch (e) {
            console.error('[shutdown] SQLite close error:', e);
            exitCode = 1;
          }
        }
      } catch (e) {
        console.error(`[shutdown] Unhandled shutdown error during ${signal}:`, e);
        exitCode = 1;
      }

      console.log(
        `[shutdown] Server ${serverOwnerId.slice(0, 8)} completed with exit code ${exitCode}`,
      );
      return exitCode;
    })();

    return shutdownPromise;
  };
  // Register this server's shutdown callback. Multiple concurrent servers are
  // supported — each gets its own entry, all invoked in parallel on signal.
  getShutdownRegistry().callbacks.set(serverOwnerId, signal => gracefulShutdown(signal));
  ensureProcessShutdownListeners();

  if (enableWorkers && workersDir) {
    const { loadWorkers } = await import('@framework/workers/loadWorkers');
    await loadWorkers({
      workersDir,
      runtime,
      resolvedSecrets: ctx.resolvedSecrets,
      persistence: { cronRegistry: ctx.persistence.cronRegistry },
    });
  }

  // Store context on server for test/tooling access
  Object.defineProperty(server, SERVER_CONTEXT_SYMBOL, {
    configurable: true,
    enumerable: false,
    writable: true,
    value: ctx,
  });

  if (!config.unix) {
    log(`[server] running at http://localhost:${server.port}`);
    log(`[server] API docs at http://localhost:${server.port}/docs`);
  } else {
    log(`[server] running at unix:${config.unix}`);
  }

  return server;
};
