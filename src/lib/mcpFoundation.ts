import type { CreateServerConfig } from '../server';
import type {
  AppManifest,
  AppManifestValidationError,
  AppManifestValidationResult,
} from './manifest';
import { validateAppManifest } from './manifest';
import { createManifestHandlerRegistry } from './manifestHandlerRegistry';
import type { ManifestHandlerRegistry } from './manifestHandlerRegistry';
import { manifestToAppConfig } from './manifestToAppConfig';
import type { PluginSchemaEntry } from './pluginSchemaRegistry';
import { listPlugins as listPluginEntries, loadPluginSchema } from './pluginSchemaRegistry';

/**
 * Public metadata for a built-in plugin exposed through the MCP foundation.
 */
export interface McpPluginSummary {
  readonly name: string;
  readonly package: string;
  readonly factory: string;
  readonly description: string;
  readonly category: string;
  readonly requires: readonly string[];
}

export type McpManifestValidationResult = AppManifestValidationResult | AppManifestValidationError;

export interface McpGenerateConfigSuccess {
  readonly success: true;
  readonly manifest: AppManifest;
  readonly warnings: string[];
  readonly config: CreateServerConfig;
}

export type McpGenerateConfigResult = McpGenerateConfigSuccess | AppManifestValidationError;

export interface McpGenerateConfigOptions {
  readonly registry?: ManifestHandlerRegistry;
  readonly baseDir?: string;
}

export interface CreateMcpFoundationOptions {
  readonly registry?: ManifestHandlerRegistry;
  readonly baseDir?: string;
}

export interface McpFoundation {
  createRegistry(): ManifestHandlerRegistry;
  listPlugins(): McpPluginSummary[];
  getPlugin(name: string): McpPluginSummary | null;
  getPluginSchema(name: string): Promise<Awaited<ReturnType<typeof loadPluginSchema>>>;
  validateManifest(raw: unknown): McpManifestValidationResult;
  generateConfig(raw: unknown, options?: McpGenerateConfigOptions): McpGenerateConfigResult;
}

function toPluginSummary(entry: PluginSchemaEntry): McpPluginSummary {
  return {
    name: entry.name,
    package: entry.package,
    factory: entry.factory,
    description: entry.description,
    category: entry.category,
    requires: entry.requires,
  };
}

/**
 * Create a transport-agnostic MCP foundation service for manifest-driven tooling.
 *
 * The service intentionally stays below the protocol boundary: it exposes the
 * concrete operations an MCP transport would need, but leaves JSON-RPC or stdio
 * wiring to the caller.
 */
export function createMcpFoundation(options: CreateMcpFoundationOptions = {}): McpFoundation {
  const pluginEntries = listPluginEntries();
  const pluginByName = new Map(pluginEntries.map(entry => [entry.name, entry] as const));
  const defaultRegistry = options.registry;
  const defaultBaseDir = options.baseDir;

  return {
    createRegistry() {
      return createManifestHandlerRegistry();
    },

    listPlugins() {
      return pluginEntries.map(toPluginSummary);
    },

    getPlugin(name) {
      const entry = pluginByName.get(name);
      return entry ? toPluginSummary(entry) : null;
    },

    async getPluginSchema(name) {
      return loadPluginSchema(name);
    },

    validateManifest(raw) {
      return validateAppManifest(raw);
    },

    generateConfig(raw, runtimeOptions = {}) {
      const validation = validateAppManifest(raw);
      if (!validation.success) {
        return validation;
      }

      return {
        success: true,
        manifest: validation.manifest,
        warnings: validation.warnings,
        config: manifestToAppConfig(
          validation.manifest,
          runtimeOptions.registry ?? defaultRegistry,
          {
            baseDir: runtimeOptions.baseDir ?? defaultBaseDir,
          },
        ),
      };
    },
  };
}
