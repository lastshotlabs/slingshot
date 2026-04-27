const emittedWarnings = new Set<string>();

export type PackageStability = 'stable' | 'rc' | 'beta' | 'alpha' | 'experimental' | 'unstable';

function normalizePackageName(packageName: string): string {
  return packageName
    .replace(/^@[^/]+\//, '')
    .replace(/^slingshot-/, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
}

function getEmitWarning(): ((warning: string, type?: string, code?: string) => void) | null {
  if (typeof process === 'undefined' || typeof process.emitWarning !== 'function') {
    return null;
  }

  return process.emitWarning.bind(process);
}

/**
 * Emit a standard Node/Bun runtime warning once per package stability label.
 *
 * Use this from public factory functions in packages that are not yet stable.
 * The warning is deduplicated per package name and stability label so repeated
 * calls do not spam logs.
 */
export function emitPackageStabilityWarning(
  packageName: string,
  stability: Exclude<PackageStability, 'stable'>,
  detail?: string,
): void {
  const key = `${packageName}:${stability}`;
  if (emittedWarnings.has(key)) return;
  emittedWarnings.add(key);

  const emitWarning = getEmitWarning();
  if (!emitWarning) return;

  const normalizedName = normalizePackageName(packageName);
  const code = `SLINGSHOT_${normalizedName}_${stability.toUpperCase()}`;
  const suffix = detail ? ` ${detail}` : '';
  emitWarning(
    `Slingshot package "${packageName}" is ${stability}.${suffix}`,
    'ExperimentalWarning',
    code,
  );
}

export function markPackageExperimental(packageName: string, detail?: string): void {
  emitPackageStabilityWarning(packageName, 'experimental', detail);
}

export function resetPackageStabilityWarnings(): void {
  emittedWarnings.clear();
}
