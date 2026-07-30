#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { format, resolveConfig } from 'prettier';

export const repoRoot = resolve(import.meta.dir, '..');

interface Profile {
  gates: string[];
  docsRequired: boolean;
  jsdocThreshold: number;
  consumerCanaryRequired: boolean;
}

interface PackageDeclaration {
  name: string;
  owner: string;
  profile: 'core' | 'prod-path' | 'experimental' | 'deferred';
  stability: 'stable' | 'experimental';
  distTag: 'latest' | 'next';
  warning: 'none' | 'factory';
}

interface Declaration {
  schemaVersion: 1;
  evidenceSourceCommit: string;
  profiles: Record<PackageDeclaration['profile'], Profile>;
  packages: PackageDeclaration[];
}

interface LaneEvidence {
  schemaVersion: number;
  lane: string;
  passed: boolean;
  sourceCommit: string;
}

export const outputPaths = {
  report: 'artifacts/maturity/maturity.v1.json',
  docs: 'packages/docs/src/content/docs/core-features/generated-maturity.mdx',
  release: 'artifacts/maturity/release-summary.md',
  runtime: 'packages/slingshot-core/src/generated/packageMaturity.ts',
} as const;

const laneFiles: Record<string, string> = {
  entity: 'artifacts/evidence/entity.v3.json',
  event: 'artifacts/evidence/event.v2.json',
  migration: 'artifacts/evidence/migration.v2.json',
  tenant: 'artifacts/evidence/tenant.v1.json',
  docs: 'artifacts/evidence/docs.v1.json',
  packed: 'artifacts/evidence/packed.v1.json',
  provider: 'artifacts/evidence/provider.v1.json',
};

function readJson<T>(root: string, path: string): T {
  const absolute = resolve(root, path);
  if (!existsSync(absolute)) throw new Error(`[maturity] Missing required artifact: ${path}`);
  try {
    return JSON.parse(readFileSync(absolute, 'utf8')) as T;
  } catch {
    throw new Error(`[maturity] Malformed JSON artifact: ${path}`);
  }
}

function publicPackageNames(root: string): string[] {
  const manifests = [resolve(root, 'package.json')];
  for (const directory of readdirSync(resolve(root, 'packages'), { withFileTypes: true })) {
    if (directory.isDirectory())
      manifests.push(resolve(root, 'packages', directory.name, 'package.json'));
  }
  return manifests
    .filter(existsSync)
    .map(path => readJson<{ name: string; private?: boolean }>(root, path))
    .filter(manifest => manifest.private !== true)
    .map(manifest => manifest.name)
    .sort();
}

export async function generateMaturityOutputs(root = repoRoot): Promise<Record<string, string>> {
  const declaration = readJson<Declaration>(root, 'package-maturity.json');
  if (declaration.schemaVersion !== 1)
    throw new Error('[maturity] Unsupported declaration schema.');

  const declared = declaration.packages.map(pkg => pkg.name).sort();
  const publicNames = publicPackageNames(root);
  if (new Set(declared).size !== declared.length)
    throw new Error('[maturity] Duplicate package declaration.');
  if (JSON.stringify(declared) !== JSON.stringify(publicNames)) {
    const missing = publicNames.filter(name => !declared.includes(name));
    const extra = declared.filter(name => !publicNames.includes(name));
    throw new Error(
      `[maturity] Package inventory mismatch. missing=${missing.join(',')} extra=${extra.join(',')}`,
    );
  }

  const evidence = Object.fromEntries(
    Object.entries(laneFiles).map(([lane, path]) => {
      const value = readJson<LaneEvidence>(root, path);
      if (
        value.lane !== lane ||
        value.passed !== true ||
        value.sourceCommit !== declaration.evidenceSourceCommit ||
        !Number.isInteger(value.schemaVersion)
      ) {
        throw new Error(`[maturity] Stale or malformed ${lane} evidence.`);
      }
      return [lane, value];
    }),
  );

  const packages = declaration.packages
    .map(pkg => {
      const profile = declaration.profiles[pkg.profile];
      if (!profile) throw new Error(`[maturity] Unknown profile for ${pkg.name}.`);
      if ((pkg.stability === 'experimental') !== (pkg.distTag === 'next')) {
        throw new Error(`[maturity] Unsupported promotion/dist-tag for ${pkg.name}.`);
      }
      if ((pkg.warning === 'factory') !== (pkg.stability === 'experimental')) {
        throw new Error(`[maturity] Runtime warning policy drift for ${pkg.name}.`);
      }
      const missingGates = profile.gates.filter(gate => !evidence[gate]?.passed);
      return { ...pkg, ...profile, passed: missingGates.length === 0, missingGates };
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  const report = {
    schemaVersion: 1,
    sourceCommit: declaration.evidenceSourceCommit,
    evidence: Object.fromEntries(
      Object.entries(evidence).sort(([left], [right]) => left.localeCompare(right)),
    ),
    packages,
  };

  const rows = packages
    .map(
      pkg =>
        `| \`${pkg.name}\` | ${pkg.profile} | ${pkg.stability} | \`${pkg.distTag}\` | ${pkg.passed ? 'Passed' : 'Blocked'} |`,
    )
    .join('\n');
  const docs = `---\ntitle: Generated Package Maturity\ndescription: Authoritative generated package maturity and release-channel evidence.\n---\n\n{/* Generated by scripts/generate-maturity-evidence.ts. Do not edit. */}\n\n| Package | Category | Stability | Dist-tag | Evidence |\n| --- | --- | --- | --- | --- |\n${rows}\n`;
  const release = `<!-- Generated by scripts/generate-maturity-evidence.ts. Do not edit. -->\n\n# Maturity evidence\n\n- Schema: v1\n- Evidence source commit: \`${declaration.evidenceSourceCommit}\`\n- Public packages: ${packages.length}\n- Satisfied packages: ${packages.filter(pkg => pkg.passed).length}\n`;
  const runtimeRows = packages
    .map(
      pkg =>
        `  ${JSON.stringify(pkg.name)}: Object.freeze({ profile: ${JSON.stringify(pkg.profile)}, stability: ${JSON.stringify(pkg.stability)}, distTag: ${JSON.stringify(pkg.distTag)}, warning: ${JSON.stringify(pkg.warning)} }),`,
    )
    .join('\n');
  const runtime = `/** Generated package stability metadata. Do not edit by hand. */\nexport const PACKAGE_MATURITY = Object.freeze({\n${runtimeRows}\n} as const);\n\n/** Public package name represented in generated maturity metadata. */\nexport type MaturePackageName = keyof typeof PACKAGE_MATURITY;\n`;

  const prettierConfig = (await resolveConfig(resolve(root, 'package.json'))) ?? {};
  return {
    [outputPaths.report]: await format(JSON.stringify(report), {
      ...prettierConfig,
      filepath: resolve(root, outputPaths.report),
    }),
    [outputPaths.docs]: await format(docs, {
      ...prettierConfig,
      filepath: resolve(root, outputPaths.docs),
    }),
    [outputPaths.release]: await format(release, {
      ...prettierConfig,
      filepath: resolve(root, outputPaths.release),
    }),
    [outputPaths.runtime]: await format(runtime, {
      ...prettierConfig,
      filepath: resolve(root, outputPaths.runtime),
    }),
  };
}

export async function writeMaturityOutputs(root = repoRoot): Promise<void> {
  for (const [path, content] of Object.entries(await generateMaturityOutputs(root))) {
    const absolute = resolve(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
}

if (import.meta.main) {
  await writeMaturityOutputs();
  console.log('[maturity] Generated deterministic evidence for all public packages.');
}
