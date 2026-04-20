import type { CreateAppConfig } from './app';
import {
  createServerFromManifest,
  resolveManifestConfig,
  type CreateServerFromManifestOptions,
  type ResolvedManifestConfig,
} from './lib/createServerFromManifest';
import type { AppManifest } from './lib/manifest';
import type { ManifestHandlerRegistry } from './lib/manifestHandlerRegistry';

export { createServerFromManifest, resolveManifestConfig };
export type { CreateServerFromManifestOptions };

/**
 * Shared manifest bootstrap entrypoint for hosts that need config resolution
 * without binding an HTTP server.
 */
export type { AppManifest, CreateAppConfig, ManifestHandlerRegistry, ResolvedManifestConfig };
