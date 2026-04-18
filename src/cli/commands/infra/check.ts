import { Command } from '@oclif/core';
import { loadInfraConfig, loadPlatformConfig } from '@lastshotlabs/slingshot-infra';
import {
  auditWebsocketScaling,
  compareInfraResources,
  deriveUsesFromAppConfig,
} from '@lastshotlabs/slingshot-infra';
import { deriveRequiredSecrets } from '../../../framework/secrets/deriveRequiredSecrets';

/**
 * Extract a plain config object from an opaque dynamic-import result.
 *
 * Dynamic `import()` is typed `any`, so we treat the result as `unknown` and
 * narrow without unjustified hard casts. Returns `null` when the module does
 * not expose a config-shaped object via `default`, `config`, or the module
 * itself.
 */
function extractConfigObject(mod: unknown): Record<string, unknown> | null {
  if (!mod || typeof mod !== 'object') return null;
  const namespace = mod as Record<string, unknown>;
  const candidates: unknown[] = [namespace.default, namespace.config, namespace];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object') {
      return candidate as Record<string, unknown>;
    }
  }
  return null;
}

/**
 * Common locations to probe for an app config module when auto-deriving
 * uses and auditing WS scaling. Resolved relative to process.cwd() at
 * call sites so the CLI always picks up the invoker's working directory.
 */
const APP_CONFIG_PATHS = ['src/appConfig.ts', 'src/config/index.ts', 'src/index.ts'];

export default class InfraCheck extends Command {
  static override description =
    'Compare infra uses against platform resources and app config detection';

  async run() {
    const { config: platform } = await loadPlatformConfig();
    const { config: infra } = await loadInfraConfig();

    const infraUses = infra.uses ?? [];
    const platformResources = Object.keys(platform.resources ?? {});

    // Attempt to auto-derive uses from a nearby app config.
    // In practice users will pass their own config object; here we use an
    // empty config as a baseline since we cannot safely import the user's
    // runtime entry point without executing side effects.
    let derivedUses: string[] = [];
    try {
      // Try loading the app config from common locations
      for (const relativePath of APP_CONFIG_PATHS) {
        const configPath = `${process.cwd()}/${relativePath}`;
        try {
          const mod: unknown = await import(configPath);
          const config = extractConfigObject(mod);
          if (config) {
            derivedUses = deriveUsesFromAppConfig(config);
            if (derivedUses.length > 0) break;
          }
        } catch {
          // Config file not found or not importable — try next
        }
      }
    } catch {
      // Auto-derive failed — proceed with empty derived list
    }

    const diagnostics = compareInfraResources({
      infraUses,
      platformResources,
      derivedUses,
    });

    // --- Format output ---

    this.log('');
    this.log('Infra config declares:');
    if (infraUses.length === 0) {
      this.log('  (no uses declared)');
    } else {
      this.log(`  uses: [${infraUses.map(u => `'${u}'`).join(', ')}]`);
    }

    this.log('');
    this.log('Platform resources:');
    if (platformResources.length === 0) {
      this.log('  (no resources defined)');
    } else {
      for (const r of platformResources) {
        const inUses = infraUses.includes(r);
        this.log(`  ${inUses ? '\u2713' : '\u2022'} ${r}`);
      }
    }

    if (derivedUses.length > 0) {
      this.log('');
      this.log('App config analysis:');
      for (const r of derivedUses) {
        const inUses = infraUses.includes(r);
        this.log(`  ${inUses ? '\u2713' : '\u2717'} ${r} (detected from app config)`);
      }
    }

    // Diagnostics
    const hasIssues =
      diagnostics.warnings.length > 0 ||
      diagnostics.infos.length > 0 ||
      diagnostics.suggestions.length > 0;

    if (hasIssues) {
      this.log('');

      for (const w of diagnostics.warnings) {
        this.log(`  \u26A0 ${w.message}`);
      }

      for (const i of diagnostics.infos) {
        this.log(`  \u2139 ${i.message}`);
      }

      for (const s of diagnostics.suggestions) {
        this.log(`  \u2192 ${s.message}`);
      }
    } else if (infraUses.length > 0) {
      this.log('');
      this.log('  \u2713 All resources are consistent.');
    }

    // Load app config once — used for both required secrets and WS scaling audit
    let appConfig: Record<string, unknown> = {};
    for (const relativePath of APP_CONFIG_PATHS) {
      const configPath = `${process.cwd()}/${relativePath}`;
      try {
        const mod: unknown = await import(configPath);
        const config = extractConfigObject(mod);
        if (config) {
          appConfig = config;
          break;
        }
      } catch {
        // Config file not found or not importable — try next
      }
    }

    // --- Required secrets ---

    const secrets = deriveRequiredSecrets(
      (appConfig.db ?? {}) as import('../../../config/types/db').DbConfig,
    );
    this.log('');
    this.log('Required secrets:');
    for (const key of secrets.required) {
      this.log(`  ${key}`);
    }
    for (const key of secrets.optional) {
      this.log(`  ${key} *`);
    }
    if (secrets.optional.length > 0) {
      this.log('  * optional — used when present');
    }

    // --- WebSocket scaling diagnostics ---

    const wsAudit = auditWebsocketScaling(appConfig);
    if (wsAudit.diagnostics.length > 0) {
      this.log('');
      this.log('WebSocket scaling:');
      for (const d of wsAudit.diagnostics) {
        const icon = d.severity === 'warning' ? '\u26A0' : '\u2139';
        this.log(`  ${icon} ${d.message}`);
        this.log(`    \u2192 ${d.suggestion}`);
      }
    }

    this.log('');
  }
}
