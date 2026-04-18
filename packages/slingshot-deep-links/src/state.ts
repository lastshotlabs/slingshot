import type { DeepLinksConfig } from './config';

/** Runtime state published by `createDeepLinksPlugin()`. */
export interface DeepLinksPluginState {
  readonly config: DeepLinksConfig;
  readonly aasaBody: string | null;
  readonly assetlinksBody: string | null;
}
