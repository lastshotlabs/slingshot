// packages/slingshot-ssr/src/assets.ts
import { existsSync, readFileSync } from 'node:fs';

/**
 * Subset of Vite's manifest.json structure.
 * Full spec: https://vitejs.dev/guide/backend-integration
 * @internal
 */
export interface ViteManifestEntry {
  /** Hashed output file path, relative to the output directory. e.g. `assets/index-B3xk9aJi.js` */
  file: string;
  /** Hashed CSS file paths imported by this entry. */
  css?: string[];
  /** Whether this is an entry point. */
  isEntry?: boolean;
  /** Statically imported chunk keys. Used for preload resolution. */
  imports?: string[];
  /** Dynamically imported chunk keys. */
  dynamicImports?: string[];
}

/**
 * Parsed Vite manifest.json structure.
 * @internal
 */
export type ViteManifest = Partial<Record<string, ViteManifestEntry>>;

/**
 * Error thrown when the asset manifest file cannot be read or parsed.
 *
 * In production mode, `createSsrPlugin()` treats this as a startup error —
 * the server will not start without a valid manifest. Run `bun run build`
 * before starting the server in production.
 */
export class SsrAssetManifestError extends Error {
  constructor(
    message: string,
    /** The absolute path of the manifest file that failed to load. */
    public readonly manifestPath: string,
  ) {
    super(message);
    this.name = 'SsrAssetManifestError';
  }
}

/**
 * Read and parse the Vite asset manifest JSON file.
 *
 * Call once at plugin startup and cache the result. Do not call per-request.
 *
 * @param manifestPath - Absolute path to `.vite/manifest.json`.
 * @returns The parsed manifest record.
 * @throws {SsrAssetManifestError} If the file does not exist or contains invalid JSON.
 * @internal
 */
export function readAssetManifest(manifestPath: string): ViteManifest {
  if (!existsSync(manifestPath)) {
    throw new SsrAssetManifestError(
      `Asset manifest not found at ${manifestPath}. Run your production build first (bun run build).`,
      manifestPath,
    );
  }

  let raw: string;
  try {
    raw = readFileSync(manifestPath, 'utf-8');
  } catch (err) {
    throw new SsrAssetManifestError(
      `Failed to read asset manifest at ${manifestPath}: ${String(err)}`,
      manifestPath,
    );
  }

  try {
    return JSON.parse(raw) as ViteManifest;
  } catch {
    throw new SsrAssetManifestError(
      `Asset manifest at ${manifestPath} is not valid JSON.`,
      manifestPath,
    );
  }
}

/**
 * Resolve an entry point key to its hashed `<script>` and `<link>` HTML tag strings.
 *
 * Recursively includes CSS from all statically imported chunks. Deduplicates
 * CSS files. Tags are returned in this order: CSS links first, then the entry script.
 *
 * @param manifest - Parsed Vite manifest.
 * @param entryPoint - The manifest entry key. Typically `'index.html'`.
 * @returns HTML string safe to inject into `<head>`. Empty string if entry not found.
 * @internal
 */
export function resolveAssetTags(manifest: ViteManifest, entryPoint: string): string {
  const entry = manifest[entryPoint];
  if (!entry) return '';

  const cssFiles = new Set<string>();
  collectCss(manifest, entryPoint, cssFiles, new Set());

  const cssLinks = [...cssFiles].map(css => `<link rel="stylesheet" href="/${css}">`).join('\n');

  const scriptTag = `<script type="module" src="/${entry.file}"></script>`;

  return [cssLinks, scriptTag].filter(Boolean).join('\n');
}

function collectCss(
  manifest: ViteManifest,
  key: string,
  cssFiles: Set<string>,
  visited: Set<string>,
): void {
  if (visited.has(key)) return;
  visited.add(key);

  const entry = manifest[key];
  if (!entry) return;

  if (entry.css !== undefined) {
    for (const css of entry.css) cssFiles.add(css);
  }
  if (entry.imports !== undefined) {
    for (const imp of entry.imports) collectCss(manifest, imp, cssFiles, visited);
  }
}

/**
 * Build the asset tags string for dev mode.
 *
 * In development, Vite serves assets from memory via its dev server.
 * The manifest file does not exist. Inject the Vite client script and the
 * app entry module directly.
 *
 * @param entryModule - The app entry module path relative to the Vite root.
 *   Typically `'/src/main.tsx'`.
 * @internal
 */
export function buildDevAssetTags(entryModule: string = '/src/main.tsx'): string {
  return [
    `<script type="module" src="/@vite/client"></script>`,
    `<script type="module" src="${entryModule}"></script>`,
  ].join('\n');
}
