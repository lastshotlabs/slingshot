export { createOAuthPlugin, oauthPluginConfigSchema } from './plugin';
export type { OAuthPluginConfig, OAuthPluginOptions } from './plugin';
export { createOAuthRouter } from './routes/oauth';
export { verifyAppleIdentityToken } from './lib/appleIdentityToken';
export type { AppleIdentityClaims } from './lib/appleIdentityToken';
export {
  buildConnectionClient,
  createConnectionsRouter,
  getConnectionAccessToken,
  getProviderConnection,
} from './connections';
export type {
  ConnectionAccessToken,
  ConnectionOAuthClient,
  ConnectionProviderConfig,
  ConnectionsOptions,
  ProviderConnectionSummary,
} from './connections';
