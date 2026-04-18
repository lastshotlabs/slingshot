import { describe, expect, test } from 'vitest';
import { extractJSDoc, extractZodDescriptions } from '../generate-api';

describe('extractJSDoc', () => {
  test('extracts description from function JSDoc', () => {
    const content = `
      /**
       * Create the auth plugin for an app.
       */
      export function createAuthPlugin() {}
    `;

    expect(extractJSDoc(content, 'createAuthPlugin')).toBe('Create the auth plugin for an app.');
  });

  test('stops at non-remarks tags and keeps remarks text', () => {
    const content = `
      /**
       * Validate a raw manifest.
       *
       * @remarks
       * Returns structured errors instead of throwing.
       * @param input - Raw manifest input.
       */
      export function validateAppManifest(input: unknown) {}
    `;

    expect(extractJSDoc(content, 'validateAppManifest')).toBe(
      'Validate a raw manifest.\n\nRemarks: Returns structured errors instead of throwing.',
    );
  });

  test('returns null when no JSDoc exists', () => {
    const content = `export const createPlugin = () => {};`;

    expect(extractJSDoc(content, 'createPlugin')).toBeNull();
  });

  test('handles multi-line descriptions', () => {
    const content = `
      /**
       * Create a plugin registry entry.
       * Includes package metadata and dependency details.
       */
      export const createRegistryEntry = () => {};
    `;

    expect(extractJSDoc(content, 'createRegistryEntry')).toBe(
      'Create a plugin registry entry.\nIncludes package metadata and dependency details.',
    );
  });

  test('sanitizes inline JSDoc link tags for MDX output', () => {
    const content = `
      /**
       * DNS rebinding protection is handled by {@link resolveAndValidate}, which
       * resolves the hostname before each fetch hop.
       */
      export function validateUrl() {}
    `;

    expect(extractJSDoc(content, 'validateUrl')).toBe(
      'DNS rebinding protection is handled by `resolveAndValidate`, which\nresolves the hostname before each fetch hop.',
    );
  });

  test('escapes raw angle brackets in prose for MDX output', () => {
    const content = `
      /**
       * Takes entity definitions and returns Record<string, string>
       * where each <backend>.ts file is generated on demand.
       */
      export function generate() {}
    `;

    expect(extractJSDoc(content, 'generate')).toBe(
      'Takes entity definitions and returns Record&lt;string, string&gt;\nwhere each &lt;backend&gt;.ts file is generated on demand.',
    );
  });

  test('escapes raw braces in prose for MDX output', () => {
    const content = `
      /**
       * Call writeGenerated(messageConfig, { outDir: './src/generated/message' }).
       */
      export function writeGenerated() {}
    `;

    expect(extractJSDoc(content, 'writeGenerated')).toBe(
      "Call writeGenerated(messageConfig, \\{ outDir: './src/generated/message' \\}).",
    );
  });
});

describe('extractZodDescriptions', () => {
  test('extracts .describe() from schema fields', () => {
    const content = `
      export const pluginConfigSchema = z.object({
        mountPath: z.string().default('/auth').describe('URL path prefix for auth routes. Default: /auth.'),
        enabled: z.boolean().optional().describe('Whether auth routes are mounted. Omit to use the plugin default.'),
      });
    `;

    expect(extractZodDescriptions(content, 'pluginConfigSchema')).toEqual({
      mountPath: 'URL path prefix for auth routes. Default: /auth.',
      enabled: 'Whether auth routes are mounted. Omit to use the plugin default.',
    });
  });

  test('returns empty record for schemas without .describe()', () => {
    const content = `
      export const pluginConfigSchema = z.object({
        mountPath: z.string(),
      });
    `;

    expect(extractZodDescriptions(content, 'pluginConfigSchema')).toEqual({});
  });

  test('handles nested schemas without losing top-level descriptions', () => {
    const content = `
      export const pluginConfigSchema = z
        .object({
          mountPath: z.string().describe('URL path prefix for the plugin routes.'),
          retries: z
            .object({
              maxAttempts: z.number().describe('Maximum retry attempts.'),
            })
            .optional()
            .describe('Retry policy for failed deliveries.'),
        })
        .loose();
    `;

    expect(extractZodDescriptions(content, 'pluginConfigSchema')).toEqual({
      mountPath: 'URL path prefix for the plugin routes.',
      retries: 'Retry policy for failed deliveries.',
    });
  });
});
