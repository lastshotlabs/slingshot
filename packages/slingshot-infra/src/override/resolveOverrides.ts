import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { OverrideSpec } from '../types/override';
import type { GeneratedFile } from '../types/preset';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Apply a user override to a generated deployment file.
 *
 * Override dispatch rules:
 * - `undefined` → return `generated` unchanged.
 * - `string` → replace file content entirely with the file at that path.
 * - `object` + `.json` file → deep-merge into the parsed JSON.
 * - `object` + `.yml`/`.yaml` file → deep-merge into the parsed YAML.
 * - `object` + any other format → replace named sections using
 *   `# --- section:name ---` / `# --- end:name ---` markers.
 *
 * @param generated - The generated file to potentially override.
 * @param override - An `OverrideSpec` from `OverrideMap`, or `undefined` for no change.
 * @param appRoot - Absolute app root used to resolve relative file override paths.
 * @returns The (potentially overridden) `GeneratedFile`.
 *
 * @throws {Error} If the `yaml` package is not installed when merging YAML files.
 *
 * @example
 * ```ts
 * import { resolveOverride } from '@lastshotlabs/slingshot-infra';
 *
 * const result = await resolveOverride(generatedFile, infra.overrides?.dockerfile, appRoot);
 * ```
 */
export async function resolveOverride(
  generated: GeneratedFile,
  override: OverrideSpec | undefined,
  appRoot: string,
): Promise<GeneratedFile> {
  if (!override) return generated;

  if (typeof override === 'string') {
    const filePath = isAbsolute(override) ? override : join(appRoot, override);
    const content = readFileSync(filePath, 'utf-8');
    return { ...generated, content, ephemeral: false };
  }

  if (generated.path.endsWith('.json')) {
    return mergeJsonFile(generated, override);
  }

  if (generated.path.endsWith('.yml') || generated.path.endsWith('.yaml')) {
    return await mergeYamlFile(generated, override);
  }

  return mergeSectionedFile(generated, override);
}

/**
 * Deep-merge a JSON override object into the parsed content of a generated JSON file.
 *
 * The base content is `JSON.parse()`d, merged with `deepMerge()`, then
 * re-serialized with 2-space indentation. Arrays in `override` replace (not
 * concat) the corresponding array in the base. All other values recurse.
 *
 * @param generated - The generated `GeneratedFile` whose `content` is valid JSON.
 * @param override - A plain-object patch to deep-merge into the parsed JSON.
 * @returns A new `GeneratedFile` with the merged JSON as `content`.
 *
 * @throws {SyntaxError} If `generated.content` is not valid JSON.
 *
 * @remarks
 * The `path` and all other `GeneratedFile` fields are preserved. Only `content`
 * is replaced.
 */
function mergeJsonFile(generated: GeneratedFile, override: Record<string, unknown>): GeneratedFile {
  const base = JSON.parse(generated.content) as unknown;
  if (!isRecord(base)) {
    throw new Error(`[slingshot-infra] Expected JSON object in ${generated.path}`);
  }
  const merged = deepMerge(base, override);
  return { ...generated, content: JSON.stringify(merged, null, 2) };
}

/**
 * Deep-merge a YAML override object into the parsed content of a generated YAML file.
 *
 * Lazily imports the `yaml` package (optional peer dependency). The base
 * content is parsed via `yaml.parse()`, merged with `deepMerge()`, and
 * re-serialized via `yaml.stringify()`. Arrays in `override` replace (not
 * concat) the corresponding array in the base.
 *
 * @param generated - The generated `GeneratedFile` whose `content` is valid YAML.
 * @param override - A plain-object patch to deep-merge into the parsed YAML.
 * @returns A new `GeneratedFile` with the merged YAML as `content`.
 *
 * @throws {Error} If the `yaml` package is not installed (`bun add yaml`).
 *
 * @remarks
 * The `path` and all other `GeneratedFile` fields are preserved. Only `content`
 * is replaced. YAML comments in the original generated file are not preserved
 * because `yaml.parse()` drops them.
 */
async function mergeYamlFile(
  generated: GeneratedFile,
  override: Record<string, unknown>,
): Promise<GeneratedFile> {
  let yaml: typeof import('yaml');
  try {
    yaml = await import('yaml');
  } catch {
    throw new Error(
      '[slingshot-infra] yaml package is required for YAML overrides. Run: bun add yaml',
    );
  }

  const base = yaml.parse(generated.content) as unknown;
  if (!isRecord(base)) {
    throw new Error(`[slingshot-infra] Expected YAML object in ${generated.path}`);
  }
  const merged = deepMerge(base, override);
  return { ...generated, content: yaml.stringify(merged) };
}

/**
 * Replace named sections inside a generated text file using section markers.
 *
 * Iterates over each key in `override` and replaces the body of the
 * corresponding named section in `generated.content`. Both `#` and `//`
 * comment-style markers are supported (first match wins for each section).
 *
 * Marker syntax (either comment style):
 * ```
 * # --- section:name ---
 * <content to replace>
 * # --- end:name ---
 * ```
 *
 * The marker lines themselves are preserved; only the body between them is
 * replaced. Sections not found in the content are silently skipped.
 *
 * @param generated - The generated `GeneratedFile` containing section markers.
 * @param override - A map of section name → replacement string.
 * @returns A new `GeneratedFile` with the specified sections replaced.
 *
 * @remarks
 * This is the fallback merge strategy for file formats that are neither JSON
 * nor YAML (e.g. Dockerfiles, nginx configs, Caddyfiles). All generated files
 * that support user customization include `# --- section:name ---` markers for
 * this reason.
 */
function mergeSectionedFile(
  generated: GeneratedFile,
  override: Record<string, unknown>,
): GeneratedFile {
  let content = generated.content;

  for (const [section, replacement] of Object.entries(override)) {
    // Support both # and // comment-style section markers
    for (const prefix of ['#', '//']) {
      const marker = `${prefix} --- section:${section} ---`;
      const endMarker = `${prefix} --- end:${section} ---`;
      const startIdx = content.indexOf(marker);
      const endIdx = content.indexOf(endMarker);

      if (startIdx !== -1 && endIdx !== -1) {
        content =
          content.slice(0, startIdx + marker.length) +
          '\n' +
          String(replacement) +
          '\n' +
          content.slice(endIdx);
        break;
      }
    }
  }

  return { ...generated, content };
}

/**
 * Recursively deep-merge `source` into `target`, returning a new object.
 *
 * Arrays in `source` replace (not concat) the corresponding array in `target`.
 * Plain objects are merged recursively. All other values (including `null`)
 * in `source` override the corresponding value in `target`.
 *
 * @param target - The base object.
 * @param source - The object whose values take priority.
 * @returns A new merged object (neither input is mutated).
 *
 * @example
 * ```ts
 * import { deepMerge } from '@lastshotlabs/slingshot-infra';
 *
 * const result = deepMerge({ a: 1, b: { c: 2 } }, { b: { d: 3 } });
 * // { a: 1, b: { c: 2, d: 3 } }
 * ```
 */
export function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };

  for (const key of Object.keys(source)) {
    const targetVal = target[key];
    const sourceVal = source[key];

    if (Array.isArray(sourceVal)) {
      result[key] = sourceVal;
    } else if (
      sourceVal !== null &&
      typeof sourceVal === 'object' &&
      targetVal !== null &&
      typeof targetVal === 'object' &&
      !Array.isArray(targetVal)
    ) {
      result[key] = deepMerge(
        targetVal as Record<string, unknown>,
        sourceVal as Record<string, unknown>,
      );
    } else {
      result[key] = sourceVal;
    }
  }

  return result;
}
