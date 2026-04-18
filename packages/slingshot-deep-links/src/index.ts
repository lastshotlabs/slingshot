export { createDeepLinksPlugin } from './plugin';
export { DEEP_LINKS_PLUGIN_STATE_KEY } from './stateKey';
export type { DeepLinksPluginStateKey } from './stateKey';
export type { DeepLinksPluginState } from './state';
export {
  deepLinksConfigSchema,
  appleAppLinkSchema,
  androidAppLinkSchema,
  compileDeepLinksConfig,
} from './config';
export type { DeepLinksConfig, DeepLinksConfigInput, AppleAppLink, AndroidAppLink } from './config';
export { buildAppleAasaBody, serializeAppleAasaBody } from './aasa';
export type { AppleAasaBody } from './aasa';
export { buildAssetlinksBody, serializeAssetlinksBody } from './assetlinks';
export type { AssetLinksEntry } from './assetlinks';
export { expandFallback } from './fallback';
export {
  APPLE_AASA_PATH,
  ANDROID_ASSETLINKS_PATH,
  DEEP_LINKS_PUBLIC_PATHS,
  mountDeepLinkRoutes,
} from './routes';
