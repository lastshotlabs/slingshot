// connections — per-user third-party provider connections (token linking).
//
// Distinct from social LOGIN (routes/oauth.ts): a connection grants the app
// ongoing API access on the user's behalf (Spotify playback, Drive, …). The
// user must already be signed in; the flow captures and stores the provider's
// access+refresh tokens keyed (userId, provider) in the auth runtime's
// `connectionStore`, with ARBITRARY scopes configured per provider.
//
// Mounted only when `createOAuthPlugin({ connections: {...} })` is configured —
// zero behavior change otherwise.
//
// Callback authentication: the callback arrives as a browser redirect, which
// carries no bearer token for SPA (localStorage-token) apps. The consumed
// state row — CSRF-random, single-use, 5-minute TTL, bound to the initiating
// userId at start time (when the user WAS authenticated) — is the proof of
// initiation. When the callback request DOES carry an authenticated actor, it
// must match the initiating user; an anonymous callback is accepted on the
// strength of the state row alone.
import { GitHub, Google, Spotify } from 'arctic';
import type { OAuth2Tokens } from 'arctic';
import type { Context } from 'hono';
import { generateCodeVerifier, generateState, userAuth } from '@lastshotlabs/slingshot-auth';
import type { AuthRuntimeContext, ProviderConnection } from '@lastshotlabs/slingshot-auth';
import type { ProviderConnectionStore } from '@lastshotlabs/slingshot-auth';
import { createRouter, errorResponse, getActor } from '@lastshotlabs/slingshot-core';
import type { AppEnv } from '@lastshotlabs/slingshot-core';

/**
 * Normalized OAuth client for a connection provider. Arctic's per-provider
 * classes differ in PKCE arity; this interface papers over that so the routes
 * and the refresh helper stay provider-agnostic. `createClient` in the
 * provider config is the escape hatch for providers arctic lacks.
 */
export interface ConnectionOAuthClient {
  createAuthorizationURL(state: string, codeVerifier: string | null, scopes: string[]): URL;
  validateAuthorizationCode(code: string, codeVerifier: string | null): Promise<OAuth2Tokens>;
  refreshAccessToken(refreshToken: string): Promise<OAuth2Tokens>;
  /** Whether the provider flow uses PKCE (a code verifier is generated + stored). */
  usesPkce: boolean;
  /** Fetch the user's id at the provider (cheap profile call), when supported. */
  fetchProviderUserId?: (accessToken: string) => Promise<string | null>;
  /** Extra query params appended to the authorize URL (e.g. Google offline access). */
  extraAuthParams?: Record<string, string>;
}

export interface ConnectionProviderConfig {
  /** Built-in client kind. Defaults to the provider key when it matches one. */
  kind?: 'spotify' | 'google' | 'github';
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Scopes to request — arbitrary, unlike the fixed login-provider scopes. */
  scopes: string[];
  /** Extra authorize-URL params (merged over the kind's defaults). */
  extraAuthParams?: Record<string, string>;
  /** Escape hatch: supply a fully custom client (ignores `kind`). */
  createClient?: (config: ConnectionProviderConfig) => ConnectionOAuthClient;
}

export interface ConnectionsOptions {
  providers: Record<string, ConnectionProviderConfig>;
  /**
   * Where the callback redirects the browser after storing the connection
   * (`?connected=<provider>` appended, or `?error=<code>`). Falls back to the
   * plugin-level postRedirect.
   */
  postRedirect?: string;
}

function buildSpotifyClient(config: ConnectionProviderConfig): ConnectionOAuthClient {
  const client = new Spotify(config.clientId, config.clientSecret, config.redirectUri);
  return {
    usesPkce: false,
    createAuthorizationURL: (state, _verifier, scopes) =>
      client.createAuthorizationURL(state, null, scopes),
    validateAuthorizationCode: code => client.validateAuthorizationCode(code, null),
    refreshAccessToken: refreshToken => client.refreshAccessToken(refreshToken),
    fetchProviderUserId: async accessToken => {
      const res = await fetch('https://api.spotify.com/v1/me', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { id?: string };
      return typeof body.id === 'string' ? body.id : null;
    },
  };
}

function buildGoogleClient(config: ConnectionProviderConfig): ConnectionOAuthClient {
  const client = new Google(config.clientId, config.clientSecret, config.redirectUri);
  return {
    usesPkce: true,
    createAuthorizationURL: (state, verifier, scopes) =>
      client.createAuthorizationURL(state, verifier ?? '', scopes),
    validateAuthorizationCode: (code, verifier) =>
      client.validateAuthorizationCode(code, verifier ?? ''),
    refreshAccessToken: refreshToken => client.refreshAccessToken(refreshToken),
    // Offline access is the whole point of a connection — request a refresh token.
    extraAuthParams: { access_type: 'offline', prompt: 'consent' },
    fetchProviderUserId: async accessToken => {
      const res = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { sub?: string };
      return typeof body.sub === 'string' ? body.sub : null;
    },
  };
}

function buildGitHubClient(config: ConnectionProviderConfig): ConnectionOAuthClient {
  const client = new GitHub(config.clientId, config.clientSecret, config.redirectUri);
  return {
    usesPkce: false,
    createAuthorizationURL: (state, _verifier, scopes) =>
      client.createAuthorizationURL(state, scopes),
    validateAuthorizationCode: code => client.validateAuthorizationCode(code),
    refreshAccessToken: refreshToken => client.refreshAccessToken(refreshToken),
    fetchProviderUserId: async accessToken => {
      const res = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': 'slingshot-oauth' },
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { id?: number };
      return body.id != null ? String(body.id) : null;
    },
  };
}

const BUILTIN_CLIENTS: Record<string, (config: ConnectionProviderConfig) => ConnectionOAuthClient> =
  {
    spotify: buildSpotifyClient,
    google: buildGoogleClient,
    github: buildGitHubClient,
  };

export function buildConnectionClient(
  providerKey: string,
  config: ConnectionProviderConfig,
): ConnectionOAuthClient {
  if (config.createClient) {
    const client = config.createClient(config);
    return config.extraAuthParams
      ? { ...client, extraAuthParams: { ...client.extraAuthParams, ...config.extraAuthParams } }
      : client;
  }
  const kind = config.kind ?? providerKey;
  const factory = BUILTIN_CLIENTS[kind];
  if (!factory) {
    throw new Error(
      `[slingshot-oauth] Unknown connection provider kind '${kind}' for '${providerKey}'. ` +
        `Built-ins: ${Object.keys(BUILTIN_CLIENTS).join(', ')}. Pass createClient for others.`,
    );
  }
  const client = factory(config);
  if (config.extraAuthParams) {
    return { ...client, extraAuthParams: { ...client.extraAuthParams, ...config.extraAuthParams } };
  }
  return client;
}

// ---------------------------------------------------------------------------
// Per-app connections runtime (WeakMap-keyed, for the server-side helpers)
// ---------------------------------------------------------------------------

interface ConnectionsRuntime {
  store: ProviderConnectionStore;
  clients: Map<string, ConnectionOAuthClient>;
}

const connectionsRuntimes = new WeakMap<object, ConnectionsRuntime>();

function requireConnectionsRuntime(app: object): ConnectionsRuntime {
  const runtime = connectionsRuntimes.get(app);
  if (!runtime) {
    throw new Error(
      '[slingshot-oauth] Provider connections are not configured on this app ' +
        '(pass `connections` to createOAuthPlugin).',
    );
  }
  return runtime;
}

/** Token payload returned by {@link getConnectionAccessToken}. */
export interface ConnectionAccessToken {
  accessToken: string;
  /** Epoch ms. */
  expiresAt: number;
}

/** Sanitized connection projection — safe for HTTP responses (no tokens). */
export interface ProviderConnectionSummary {
  provider: string;
  providerUserId: string | null;
  scopes: string[];
  accessTokenExpiresAt: number | null;
  createdAt: number;
  updatedAt: number;
}

function toSummary(connection: ProviderConnection): ProviderConnectionSummary {
  return {
    provider: connection.provider,
    providerUserId: connection.providerUserId,
    scopes: connection.scopes,
    accessTokenExpiresAt: connection.accessTokenExpiresAt,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
}

/** The user's stored connection (sanitized — never includes tokens). */
export async function getProviderConnection(
  app: object,
  userId: string,
  provider: string,
): Promise<ProviderConnectionSummary | null> {
  const { store } = requireConnectionsRuntime(app);
  const connection = await store.get(userId, provider);
  return connection ? toSummary(connection) : null;
}

// Refresh when less than a minute of validity remains — long enough that a
// token handed to a client survives its immediate use.
const REFRESH_WINDOW_MS = 60_000;

/**
 * Returns a valid access token for the user's provider connection,
 * transparently refreshing (and persisting the rotation) when expired or
 * inside the refresh window. Returns null when the user has no connection or
 * the refresh fails terminally (revoked consent).
 */
export async function getConnectionAccessToken(
  app: object,
  userId: string,
  provider: string,
): Promise<ConnectionAccessToken | null> {
  const { store, clients } = requireConnectionsRuntime(app);
  const client = clients.get(provider);
  if (!client) return null;
  const connection = await store.get(userId, provider);
  if (!connection) return null;

  const expiresAt = connection.accessTokenExpiresAt ?? 0;
  if (connection.accessToken && expiresAt - Date.now() > REFRESH_WINDOW_MS) {
    return { accessToken: connection.accessToken, expiresAt };
  }

  if (!connection.refreshToken) return null;
  let tokens: OAuth2Tokens;
  try {
    tokens = await client.refreshAccessToken(connection.refreshToken);
  } catch {
    // Revoked or invalid grant — the connection is dead; the caller surfaces
    // a reconnect prompt. Keep the row so the UI can show "reconnect".
    return null;
  }

  const accessToken = tokens.accessToken();
  const newExpiresAt = safeExpiresAt(tokens);
  // Most providers (Spotify included) do NOT rotate the refresh token on
  // refresh — keep the existing one unless a new one is returned.
  const refreshToken = tokens.hasRefreshToken() ? tokens.refreshToken() : connection.refreshToken;
  await store.upsert({
    userId: connection.userId,
    provider: connection.provider,
    providerUserId: connection.providerUserId,
    scopes: connection.scopes,
    accessToken,
    refreshToken,
    accessTokenExpiresAt: newExpiresAt,
  });
  return { accessToken, expiresAt: newExpiresAt };
}

function safeExpiresAt(tokens: OAuth2Tokens): number {
  try {
    return tokens.accessTokenExpiresAt().getTime();
  } catch {
    // Provider returned no expiry — assume the conventional hour.
    return Date.now() + 3600_000;
  }
}

function safeGrantedScopes(tokens: OAuth2Tokens, requested: string[]): string[] {
  try {
    if (tokens.hasScopes()) return tokens.scopes();
  } catch {
    // fall through
  }
  return requested;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const CONNECT_CONTEXT_PREFIX = 'connect:';

function encodeConnectContext(userId: string): string {
  return `${CONNECT_CONTEXT_PREFIX}${encodeURIComponent(userId)}`;
}

function parseConnectContext(value: string | undefined): string | null {
  if (!value?.startsWith(CONNECT_CONTEXT_PREFIX)) return null;
  const encoded = value.slice(CONNECT_CONTEXT_PREFIX.length);
  return encoded ? decodeURIComponent(encoded) : null;
}

function requireUser(c: Context<AppEnv>): string | null {
  const actor = getActor(c);
  return actor.kind === 'user' && actor.id ? actor.id : null;
}

/**
 * Builds the connections router. Mounted by `createOAuthPlugin` only when a
 * `connections` option is configured.
 */
export function createConnectionsRouter(
  app: object,
  options: ConnectionsOptions,
  runtime: AuthRuntimeContext,
  postRedirect: string,
) {
  const store = runtime.oauth.connectionStore;
  if (!store) {
    throw new Error(
      '[slingshot-oauth] connections configured but the auth runtime has no connectionStore ' +
        '(upgrade slingshot-auth or check the oauthState store configuration).',
    );
  }

  const clients = new Map<string, ConnectionOAuthClient>();
  for (const [key, providerConfig] of Object.entries(options.providers)) {
    clients.set(key, buildConnectionClient(key, providerConfig));
  }
  connectionsRuntimes.set(app, { store, clients });

  const redirectBase = options.postRedirect ?? postRedirect;
  const redirectWith = (params: Record<string, string>) => {
    const sep = redirectBase.includes('?') ? '&' : '?';
    const query = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    return `${redirectBase}${sep}${query}`;
  };

  const router = createRouter();

  router.get('/auth/connections', userAuth, async c => {
    const userId = requireUser(c);
    if (!userId) return errorResponse(c, 'Authenticated user required', 401);
    const connections = await store.listByUser(userId);
    return c.json({ connections: connections.map(toSummary) });
  });

  router.get('/auth/connections/:provider/start', userAuth, async c => {
    const userId = requireUser(c);
    if (!userId) return errorResponse(c, 'Authenticated user required', 401);
    const provider = c.req.param('provider');
    const client = clients.get(provider);
    const providerConfig = options.providers[provider];
    if (!client || !providerConfig) {
      return errorResponse(c, `Unknown connection provider '${provider}'`, 404);
    }

    const state = generateState();
    const codeVerifier = client.usesPkce ? generateCodeVerifier() : undefined;
    await runtime.oauth.stateStore.store(state, codeVerifier, encodeConnectContext(userId));

    const url = client.createAuthorizationURL(state, codeVerifier ?? null, providerConfig.scopes);
    for (const [key, value] of Object.entries(client.extraAuthParams ?? {})) {
      url.searchParams.set(key, value);
    }
    return c.redirect(url.toString());
  });

  router.get('/auth/connections/:provider/callback', async c => {
    const provider = c.req.param('provider');
    const client = clients.get(provider);
    const providerConfig = options.providers[provider];
    if (!client || !providerConfig) {
      return errorResponse(c, `Unknown connection provider '${provider}'`, 404);
    }

    const state = c.req.query('state');
    const code = c.req.query('code');
    const providerError = c.req.query('error');
    if (providerError) {
      return c.redirect(redirectWith({ error: 'consent_denied' }));
    }
    if (!state || !code) return errorResponse(c, 'Missing state or code', 400);

    const stored = await runtime.oauth.stateStore.consume(state);
    if (!stored) return errorResponse(c, 'Invalid or expired state', 400);
    const userId = parseConnectContext(stored.linkUserId);
    if (!userId) return errorResponse(c, 'Invalid or expired state', 400);
    if (client.usesPkce && !stored.codeVerifier) {
      return errorResponse(c, 'Invalid or expired state', 400);
    }

    // If the redirect carried an authenticated actor (cookie mode), it must
    // match the initiating user. Anonymous callbacks (SPA token mode) are
    // accepted on the strength of the single-use state row.
    const actor = getActor(c);
    if (actor.kind === 'user' && actor.id && actor.id !== userId) {
      return errorResponse(c, 'Authenticated session does not match connection request', 401);
    }

    let tokens: OAuth2Tokens;
    try {
      tokens = await client.validateAuthorizationCode(code, stored.codeVerifier ?? null);
    } catch {
      return c.redirect(redirectWith({ error: 'exchange_failed' }));
    }

    const accessToken = tokens.accessToken();
    const providerUserId = (await client.fetchProviderUserId?.(accessToken)) ?? null;
    await store.upsert({
      userId,
      provider,
      providerUserId,
      scopes: safeGrantedScopes(tokens, providerConfig.scopes),
      accessToken,
      refreshToken: tokens.hasRefreshToken() ? tokens.refreshToken() : null,
      accessTokenExpiresAt: safeExpiresAt(tokens),
    });

    runtime.eventBus.emit('security.auth.oauth.linked', {
      userId,
      meta: { provider, connection: true },
    });
    return c.redirect(redirectWith({ connected: provider }));
  });

  router.delete('/auth/connections/:provider', userAuth, async c => {
    const userId = requireUser(c);
    if (!userId) return errorResponse(c, 'Authenticated user required', 401);
    const provider = c.req.param('provider');
    const deleted = await store.delete(userId, provider);
    if (!deleted) return errorResponse(c, 'No such connection', 404);
    return c.json({ ok: true });
  });

  return router;
}
