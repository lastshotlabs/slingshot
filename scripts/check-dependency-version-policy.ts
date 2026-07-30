import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const EXACT_VERSION =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/;
const OWNED_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;

interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  overrides?: Record<string, string>;
}

const manifestPaths = [
  'package.json',
  ...readdirSync('packages', { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => join('packages', entry.name, 'package.json')),
];

const violations: string[] = [];

function checkOwnedVersion(
  manifestPath: string,
  section: string,
  dependency: string,
  version: string,
): void {
  if (version.startsWith('workspace:') || EXACT_VERSION.test(version)) {
    return;
  }

  violations.push(`${manifestPath} ${section}.${dependency} uses ${JSON.stringify(version)}`);
}

for (const manifestPath of manifestPaths) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PackageManifest;

  for (const section of OWNED_SECTIONS) {
    for (const [dependency, version] of Object.entries(manifest[section] ?? {})) {
      checkOwnedVersion(manifestPath, section, dependency, version);
    }
  }

  for (const [dependency, version] of Object.entries(manifest.overrides ?? {})) {
    checkOwnedVersion(manifestPath, 'overrides', dependency, version);
  }
}

if (violations.length > 0) {
  console.error(
    [
      'Owned dependencies must use exact versions.',
      'Compatibility ranges remain allowed only in peerDependencies; internal packages use workspace:.',
      '',
      ...violations.map(violation => `- ${violation}`),
    ].join('\n'),
  );
  process.exit(1);
}

console.log(
  `Dependency version policy passed for ${manifestPaths.length} manifests: owned dependencies are exact; peer compatibility ranges are preserved.`,
);
