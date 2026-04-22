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
/**
 * Public metadata for a built-in plugin exposed through the MCP foundation.
 */
export interface McpPluginSummary {
  /** Plugin name (e.g. `'slingshot-auth'`). */
  readonly name: string;
  /** npm package name. */
  readonly package: string;
  /** Named factory export used to instantiate the plugin. */
  readonly factory: string;
  /** Human-readable one-line description. */
  readonly description: string;
  /** Capability category (e.g. `'identity'`, `'community'`). */
  readonly category: string;
  /** Plugin names that must be registered before this one. */
  readonly requires: readonly string[];
}

/**
 * Discriminated union result from {@link McpFoundation.validateManifest}.
 */
export type McpManifestValidationResult = AppManifestValidationResult | AppManifestValidationError;

/**
 * Successful result from {@link McpFoundation.generateConfig}: the validated
 * manifest, any warnings, and the fully resolved server configuration.
 */
export interface McpGenerateConfigSuccess {
  /** Discriminator — always `true` on success. */
  readonly success: true;
  /** The validated manifest. */
  readonly manifest: AppManifest;
  /** Non-fatal validation warnings. */
  readonly warnings: string[];
  /** The resolved server configuration ready for {@link createServer}. */
  readonly config: CreateServerConfig;
}

/**
 * Discriminated union result from {@link McpFoundation.generateConfig}.
 */
export type McpGenerateConfigResult = McpGenerateConfigSuccess | AppManifestValidationError;

/**
 * Options for {@link McpFoundation.generateConfig}.
 */
export interface McpGenerateConfigOptions {
  /** Override the handler registry used for named reference resolution. */
  readonly registry?: ManifestHandlerRegistry;
  /** Override the base directory for path resolution. */
  readonly baseDir?: string;
}

/**
 * Options for {@link createMcpFoundation}.
 */
export interface CreateMcpFoundationOptions {
  /** Default handler registry for manifest operations. */
  readonly registry?: ManifestHandlerRegistry;
  /** Default base directory for path resolution. */
  readonly baseDir?: string;
}

/**
 * Transport-agnostic MCP foundation service for manifest-driven tooling.
 *
 * Exposes plugin discovery, manifest validation, and config generation
 * without binding to a specific MCP transport protocol.
 */
export interface McpFoundation {
  /** Create a fresh {@link ManifestHandlerRegistry}. */
  createRegistry(): ManifestHandlerRegistry;
  /** List all built-in plugin summaries. */
  listPlugins(): McpPluginSummary[];
  /** Look up a single built-in plugin by name, or `null` if not found. */
  getPlugin(name: string): McpPluginSummary | null;
  /** Load the Zod config schema for a built-in plugin. */
  getPluginSchema(name: string): Promise<Awaited<ReturnType<typeof loadPluginSchema>>>;
  /** Validate a raw manifest object. */
  validateManifest(raw: unknown): McpManifestValidationResult;
  /** Validate a raw manifest and convert it to a resolved server config. */
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
 *
 * @param options - Optional default registry and base directory.
 * @returns An {@link McpFoundation} instance.
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
