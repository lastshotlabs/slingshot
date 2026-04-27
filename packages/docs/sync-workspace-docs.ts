#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import {
  type WorkspacePackage,
  discoverWorkspacePackages,
  docsPackageRoot,
  repoRoot,
} from './workspacePackages';

const outputRoot = resolve(docsPackageRoot, 'src/content/docs/packages');
const levels = ['generated', 'ai', 'human', 'notes'] as const;

type DocLevel = (typeof levels)[number];
type PackageStatus = 'Core path' | 'Prod path' | 'Experimental' | 'Deferred';

interface PackageStatusMeta {
  label: PackageStatus;
  variant: 'default' | 'note' | 'tip' | 'caution' | 'danger' | 'success';
  note: string;
}

const corePathPackages = new Set(['slingshot', 'slingshot-core', 'slingshot-entity']);
const productionPathPackages = new Set([
  'slingshot-permissions',
  'slingshot-organizations',
  'slingshot-orchestration',
  'slingshot-orchestration-bullmq',
  'slingshot-orchestration-temporal',
  'slingshot-orchestration-plugin',
  'slingshot-bullmq',
  'slingshot-assets',
  'slingshot-search',
  'slingshot-webhooks',
  'slingshot-kafka',
  'slingshot-admin',
  'slingshot-mail',
  'slingshot-notifications',
  'slingshot-push',
  'slingshot-runtime-bun',
  'slingshot-runtime-node',
  'slingshot-runtime-edge',
  'slingshot-runtime-lambda',
  'slingshot-ssr',
  'slingshot-ssg',
  'slingshot-postgres',
]);
const experimentalPackages = new Set([
  'slingshot-auth',
  'slingshot-oauth',
  'slingshot-oidc',
  'slingshot-m2m',
  'slingshot-scim',
]);
const deferredPackages = new Set([
  'slingshot-community',
  'slingshot-chat',
  'slingshot-game-engine',
  'slingshot-deep-links',
  'slingshot-embeds',
  'slingshot-emoji',
  'slingshot-gifs',
  'slingshot-image',
  'slingshot-interactions',
  'slingshot-polls',
  'slingshot-infra',
]);

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function writeIfMissing(path: string, content: string): void {
  if (existsSync(path)) return;
  writeFileSync(path, content);
}

function titleForLevel(level: DocLevel): string {
  switch (level) {
    case 'generated':
      return 'Generated';
    case 'ai':
      return 'AI Draft';
    case 'human':
      return 'Human Guide';
    case 'notes':
      return 'Notes';
  }
}

function normalizeText(value: string): string {
  return value.replace(/â€”/g, '-').trim();
}

function packageKindLabel(pkg: WorkspacePackage): string {
  return pkg.kind === 'root' ? 'Root package' : 'Workspace package';
}

function packageRole(pkg: WorkspacePackage): string {
  if (pkg.kind === 'root') return 'app assembly package';
  if (pkg.slug.startsWith('runtime-')) return 'runtime package';
  if (pkg.slug === 'slingshot-core') return 'contracts package';
  if (pkg.slug === 'slingshot-entity') return 'config-driven tooling package';
  if (pkg.slug === 'slingshot-permissions') return 'library package';
  if (pkg.slug === 'slingshot-postgres') return 'adapter package';
  if (pkg.slug === 'slingshot-infra') return 'platform tooling package';
  return 'feature package';
}

function packageStatus(pkg: WorkspacePackage): PackageStatusMeta | null {
  if (corePathPackages.has(pkg.slug)) {
    return {
      label: 'Core path',
      variant: 'success',
      note: 'This is part of the canonical framework foundation.',
    };
  }

  if (productionPathPackages.has(pkg.slug)) {
    return {
      label: 'Prod path',
      variant: 'tip',
      note: 'This package is on the hardening track, but still pre-1.0.',
    };
  }

  if (experimentalPackages.has(pkg.slug)) {
    return {
      label: 'Experimental',
      variant: 'caution',
      note: 'This package is published on the `next` channel and emits runtime warnings when used.',
    };
  }

  if (deferredPackages.has(pkg.slug)) {
    return {
      label: 'Deferred',
      variant: 'note',
      note: 'This package is documented and usable, but it is not currently on the production-hardening track.',
    };
  }

  return null;
}

function dependencyLines(deps: Record<string, string>): string[] {
  const entries = Object.entries(deps).sort((a, b) => a[0].localeCompare(b[0]));
  if (!entries.length) return ['- None'];
  return entries.map(([name, version]) => `- \`${name}\`: \`${version}\``);
}

function scriptLines(scripts: Record<string, string>): string[] {
  const entries = Object.entries(scripts).sort((a, b) => a[0].localeCompare(b[0]));
  if (!entries.length) return ['- None'];
  return entries.map(([name, script]) => `- \`${name}\`: \`${script}\``);
}

function exportLines(exportsList: string[]): string[] {
  if (!exportsList.length) return ['- `.`'];
  return exportsList.map(value => `- \`${value}\``);
}

function apiReferenceLink(pkg: WorkspacePackage): string {
  return `/api/${pkg.slug}/`;
}

function splitFrontmatter(content: string): { frontmatter: string; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    return { frontmatter: '', body: content };
  }

  return {
    frontmatter: match[1],
    body: content.slice(match[0].length),
  };
}

function readFileIfExists(path: string): string | null {
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8');
}

function frontmatterValue(frontmatter: string, key: string): string | null {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  if (!match) return null;

  return match[1].trim().replace(/^['"]|['"]$/g, '');
}

function titleCaseSegment(value: string): string {
  return value
    .replace(/[-_]/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map(word => word[0]?.toUpperCase() + word.slice(1))
    .join(' ');
}

function friendlyDocTitle(level: DocLevel, relativePath: string, frontmatter: string): string {
  const relativeNoExt = relativePath.replace(/\.(md|mdx)$/i, '');
  const existingTitle = frontmatterValue(frontmatter, 'title');
  const segments = relativeNoExt.split(/[\\/]/g).filter(Boolean);
  const isIndex = segments.at(-1) === 'index';

  if (isIndex) {
    switch (level) {
      case 'human':
        return 'Overview';
      case 'generated':
        return 'Reference';
      case 'notes':
        return 'Maintainer Notes';
      case 'ai':
        return 'AI Draft';
    }
  }

  if (existingTitle && !['Human Guide', 'Generated', 'Notes', 'AI Draft'].includes(existingTitle)) {
    return existingTitle;
  }

  return titleCaseSegment(segments.at(-1) ?? 'Overview');
}

function friendlyDocDescription(
  pkg: WorkspacePackage,
  level: DocLevel,
  frontmatter: string,
  title: string,
): string {
  const existingDescription = frontmatterValue(frontmatter, 'description');
  if (existingDescription) return existingDescription;

  switch (level) {
    case 'human':
      return `Human-maintained documentation for ${pkg.name}: ${title}`;
    case 'generated':
      return `Generated reference for ${pkg.name}: ${title}`;
    case 'notes':
      return `Maintainer notes for ${pkg.name}: ${title}`;
    case 'ai':
      return `AI-assisted draft for ${pkg.name}: ${title}`;
  }
}

function syncedRelativePath(level: DocLevel, relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/');
  const extension = extname(normalized) || '.md';
  const withoutExt = normalized.slice(0, -extension.length);

  if (withoutExt === 'index') {
    switch (level) {
      case 'human':
        return `overview${extension}`;
      case 'generated':
        return `reference${extension}`;
      case 'notes':
        return `maintainer-notes${extension}`;
      case 'ai':
        return `ai-draft${extension}`;
    }
  }

  switch (level) {
    case 'human':
      return `guides/${normalized}`;
    case 'generated':
      return `reference/${normalized}`;
    case 'notes':
      return `maintainer-notes/${normalized}`;
    case 'ai':
      return `ai-draft/${normalized}`;
  }
}

function serializedFrontmatter(
  pkg: WorkspacePackage,
  level: DocLevel,
  relativePath: string,
  content: string,
): string {
  const { frontmatter, body } = splitFrontmatter(content);
  const title = friendlyDocTitle(level, relativePath, frontmatter);
  const description = friendlyDocDescription(pkg, level, frontmatter, title).replace(/"/g, '\\"');
  const lines = ['---', `title: "${title.replace(/"/g, '\\"')}"`, `description: "${description}"`];

  if (level === 'ai') {
    lines.push('sidebar:');
    lines.push('  hidden: true');
  }

  lines.push('---', '', body.trimStart());
  return lines.join('\n');
}

function legacyPlaceholderText(level: DocLevel, pkg: WorkspacePackage): string[] {
  switch (level) {
    case 'generated':
      return [];
    case 'ai':
      return [
        '> AI-assisted draft. Replace, refine, or delete anything here once the human docs are stronger.',
        '- Describe the user-facing responsibility of this package.',
        '- Capture areas that still need human review.',
      ];
    case 'human':
      return [
        '> Human-owned documentation. Use this lane for architecture, tradeoffs, and anything that should not be overwritten automatically.',
        `Describe why \`${pkg.name}\` exists and the problem it solves.`,
        '- Document invariants and boundaries.',
      ];
    case 'notes':
      return [
        '> Notes lane for rough ideas, investigation breadcrumbs, and hand-written reminders.',
        '- Add ongoing notes here.',
        'Create `private.md` in this folder for untracked personal notes. The repo `.gitignore` excludes it and the docs sync skips it.',
      ];
  }
}

function shouldRefreshStarter(path: string, pkg: WorkspacePackage, level: DocLevel): boolean {
  if (!existsSync(path)) return true;
  const existing = normalizeText(readFileSync(path, 'utf8'));
  return legacyPlaceholderText(level, pkg).every(fragment =>
    existing.includes(normalizeText(fragment)),
  );
}

function generatedIndex(pkg: WorkspacePackage): string {
  const relativeEntry = relative(repoRoot, pkg.entryPoint).replace(/\\/g, '/');
  const relativePackageDir = pkg.relativeDir.replace(/\\/g, '/');
  const description = normalizeText(pkg.description);

  return [
    '---',
    `title: ${titleForLevel('generated')}`,
    `description: Auto-generated workspace facts for ${pkg.name}`,
    '---',
    '',
    '> Generated from package metadata by `bun run docs:sync`. Re-run the command to refresh this page.',
    '',
    '## Package Facts',
    '',
    `- Package: \`${pkg.name}\``,
    `- Version: \`${pkg.version}\``,
    `- Kind: ${packageKindLabel(pkg)}`,
    `- Role: ${packageRole(pkg)}`,
    `- Description: ${description}`,
    `- Workspace path: \`${relativePackageDir}\``,
    `- Entry point: \`${relativeEntry}\``,
    '',
    '## Install',
    '',
    '```bash',
    `bun add ${pkg.name}`,
    '```',
    '',
    '## Export Paths',
    '',
    ...exportLines(pkg.exports),
    '',
    '## Package Scripts',
    '',
    ...scriptLines(pkg.scripts),
    '',
    '## Dependencies',
    '',
    ...dependencyLines(pkg.dependencies),
    '',
    '## Peer Dependencies',
    '',
    ...dependencyLines(pkg.peerDependencies),
    '',
    '## Related Docs',
    '',
    `- [API reference](${apiReferenceLink(pkg)})`,
    '',
  ].join('\n');
}

function aiIndex(pkg: WorkspacePackage): string {
  const description = normalizeText(pkg.description);
  return [
    '---',
    `title: ${titleForLevel('ai')}`,
    `description: AI-assisted starting point for ${pkg.name}`,
    '---',
    '',
    '> AI-assisted draft. Use this page for fast orientation, then harden important details in the human guide.',
    '',
    '## Summary',
    '',
    `${pkg.name} is the ${packageRole(pkg)} in the Slingshot workspace.`,
    '',
    description,
    '',
    '## Quick Map',
    '',
    `- Package kind: ${packageKindLabel(pkg)}`,
    `- Public exports: ${pkg.exports.length ? pkg.exports.map(value => `\`${value}\``).join(', ') : '\`.\`'}`,
    `- API reference: ${apiReferenceLink(pkg)}`,
    '',
    '## What To Clarify Next',
    '',
    '- Add one real setup example for this package.',
    '- Explain how it integrates with neighboring packages.',
    '- Record any runtime assumptions or config shapes that changed recently.',
    '',
  ].join('\n');
}

function humanIndex(pkg: WorkspacePackage): string {
  const description = normalizeText(pkg.description);
  const relativeEntry = relative(repoRoot, pkg.entryPoint).replace(/\\/g, '/');
  return [
    '---',
    `title: ${titleForLevel('human')}`,
    `description: Human-maintained guidance for ${pkg.name}`,
    '---',
    '',
    '> Human-owned documentation. This page should explain how to use the package, not just how it is organized internally.',
    '',
    '## What This Package Is For',
    '',
    `${pkg.name} is the ${packageRole(pkg)} in the Slingshot workspace.`,
    '',
    description,
    '',
    '## When To Use It',
    '',
    '- Describe the app or platform problem this package solves.',
    '- Call out when a user should install it and when they probably should not.',
    '',
    '## Minimum Setup',
    '',
    '- Show the smallest realistic code example for wiring the package into an app.',
    '- List required neighboring packages, middleware, or config.',
    '',
    '## What You Get',
    '',
    '- Summarize the main capabilities, routes, exports, or runtime behavior this package adds.',
    '',
    '## Common Customization',
    '',
    '- Document the main config knobs or extension points a user is likely to touch first.',
    '',
    '## Gotchas',
    '',
    '- Record integration requirements, sharp edges, and debugging tips.',
    '',
    '## Key Files',
    '',
    `- \`${relativeEntry}\``,
    '',
  ].join('\n');
}

function notesIndex(pkg: WorkspacePackage): string {
  return [
    '---',
    `title: ${titleForLevel('notes')}`,
    `description: Working notes for ${pkg.name}`,
    '---',
    '',
    '> Notes lane for rough ideas, investigation breadcrumbs, and hand-written reminders.',
    '',
    '## Current Follow-Ups',
    '',
    '- Capture doc gaps discovered while touching this package.',
    '- Keep migration breadcrumbs here before promoting them into the human guide.',
    '',
    '## Private Notes',
    '',
    'Create `private.md` in this folder for untracked personal notes. The repo `.gitignore` excludes it and the docs sync skips it.',
    '',
  ].join('\n');
}

function firstUsefulParagraph(content: string): string | null {
  const { body } = splitFrontmatter(content);
  const lines = body.split(/\r?\n/);
  const paragraphs: string[] = [];
  let current: string[] = [];
  let inCodeBlock = false;

  const flush = () => {
    if (!current.length) return;
    paragraphs.push(current.join(' ').trim());
    current = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (line.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }

    if (inCodeBlock) continue;

    if (!line) {
      flush();
      continue;
    }

    if (
      line.startsWith('#') ||
      line.startsWith('>') ||
      line.startsWith('- ') ||
      /^\d+\.\s/.test(line)
    ) {
      flush();
      continue;
    }

    current.push(line);
  }

  flush();
  return paragraphs.find(Boolean) ?? null;
}

function packageOverviewSummary(pkg: WorkspacePackage): string | null {
  const humanOverviewPath = join(pkg.docsSourceDir, 'human', 'index.md');
  const humanOverview = readFileIfExists(humanOverviewPath);
  if (!humanOverview) return null;

  const summary = firstUsefulParagraph(humanOverview);
  return summary ? normalizeText(summary) : null;
}

function starterContent(pkg: WorkspacePackage, level: DocLevel): string {
  switch (level) {
    case 'generated':
      return generatedIndex(pkg);
    case 'ai':
      return aiIndex(pkg);
    case 'human':
      return humanIndex(pkg);
    case 'notes':
      return notesIndex(pkg);
  }
}

function ensurePackageSourceDocs(pkg: WorkspacePackage): void {
  ensureDir(pkg.docsSourceDir);

  for (const level of levels) {
    const levelDir = join(pkg.docsSourceDir, level);
    ensureDir(levelDir);

    const indexPath = join(levelDir, 'index.md');
    if (level === 'generated') {
      writeFileSync(indexPath, starterContent(pkg, level));
      continue;
    }

    if (shouldRefreshStarter(indexPath, pkg, level)) {
      writeFileSync(indexPath, starterContent(pkg, level));
      continue;
    }

    writeIfMissing(indexPath, starterContent(pkg, level));
  }
}

function shouldCopyDoc(filePath: string): boolean {
  const name = basename(filePath).toLowerCase();
  if (name.startsWith('_')) return false;
  if (name === 'private.md' || name === 'private.mdx') return false;
  return true;
}

function copyDocsRecursive(
  pkg: WorkspacePackage,
  level: DocLevel,
  sourceDir: string,
  destinationRoot: string,
): void {
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = join(sourceDir, entry.name);

    if (!shouldCopyDoc(sourcePath)) continue;

    if (entry.isDirectory()) {
      copyDocsRecursive(pkg, level, sourcePath, destinationRoot);
      continue;
    }

    if (!/\.(md|mdx)$/i.test(entry.name)) continue;

    const relativePath = relative(join(pkg.docsSourceDir, level), sourcePath);
    const destinationPath = join(destinationRoot, syncedRelativePath(level, relativePath));
    ensureDir(dirname(destinationPath));
    const content = readFileSync(sourcePath, 'utf8');
    writeFileSync(destinationPath, serializedFrontmatter(pkg, level, relativePath, content));
  }
}

function packageOverview(pkg: WorkspacePackage): string {
  const description = normalizeText(pkg.description);
  const summary = packageOverviewSummary(pkg) ?? description;
  const status = packageStatus(pkg);
  const statusLines = status
    ? [
        '',
        `> Status: ${status.label}. ${status.note}`,
        '',
      ]
    : [''];

  const frontmatterLines = [
    '---',
    `title: "${pkg.name}"`,
    `description: "${summary.replace(/"/g, '\\"')}"`,
  ];

  if (status) {
    frontmatterLines.push('sidebar:');
    frontmatterLines.push(`  badge:`);
    frontmatterLines.push(`    text: "${status.label}"`);
    frontmatterLines.push(`    variant: "${status.variant}"`);
  }

  return [
    ...frontmatterLines,
    '---',
    '',
    `${summary}`,
    ...statusLines,
    '## Start Here',
    '',
    '- [Overview](./overview/): how to use the package, what it is for, and setup guidance.',
    '- [Reference](./reference/): generated package facts, exports, and inventories.',
    '- [Maintainer Notes](./maintainer-notes/): internal notes, follow-ups, and migration breadcrumbs.',
    '',
    '## Package Facts',
    '',
    `- Install: \`bun add ${pkg.name}\``,
    `- Version: \`${pkg.version}\``,
    `- Role: ${packageRole(pkg)}`,
    ...(status ? [`- Status: ${status.label}`] : []),
    `- Workspace path: \`${pkg.relativeDir.replace(/\\/g, '/')}\``,
    `- API reference: [${pkg.name}](${apiReferenceLink(pkg)})`,
    '',
    '## Reader Note',
    '',
    '- If you are trying to learn the package, start with Overview. The Reference page is inventory, not a tutorial.',
    '',
  ].join('\n');
}

function packagesIndex(packages: WorkspacePackage[]): string {
  const byName = (a: WorkspacePackage, b: WorkspacePackage) => a.name.localeCompare(b.name);
  const rootPackages = packages.filter(pkg => pkg.kind === 'root').sort(byName);
  const corePackages = packages
    .filter(pkg => pkg.kind !== 'root' && packageStatus(pkg)?.label === 'Core path')
    .sort(byName);
  const productionPackages = packages
    .filter(pkg => pkg.kind !== 'root' && packageStatus(pkg)?.label === 'Prod path')
    .sort(byName);
  const experimentalPackagesList = packages
    .filter(pkg => pkg.kind !== 'root' && packageStatus(pkg)?.label === 'Experimental')
    .sort(byName);
  const deferredPackagesList = packages
    .filter(pkg => pkg.kind !== 'root' && packageStatus(pkg)?.label === 'Deferred')
    .sort(byName);

  const lines = [
    '---',
    'title: Workspace Packages',
    'description: Package-level docs across Slingshot and its workspace packages',
    '---',
    '',
    'Each package keeps four source lanes behind the scenes:',
    '',
    '- Generated: machine-owned facts and inventories.',
    '- AI Draft: AI-assisted explanations that humans can overwrite.',
    '- Human Guide: human-maintained architecture and decision docs.',
    '- Notes: free-form notes and working scratch space.',
    '',
    'The published docs flatten those lanes into reader-friendly pages such as Overview, Reference, and Maintainer Notes.',
    '',
    'The chart below mirrors the maturity policy. `@lastshotlabs/slingshot-docs` is listed separately because it is private docs tooling, not a product package.',
    '',
    '## Packages',
    '',
  ];

  const addSection = (heading: string, items: WorkspacePackage[]): void => {
    if (!items.length) return;
    lines.push(`### ${heading}`, '');
    for (const pkg of items) {
      lines.push(`- [${pkg.name}](/packages/${pkg.slug}/)`);
    }
    lines.push('');
  };

  addSection('Assembly layer', rootPackages);
  addSection('Core path', corePackages);
  addSection('Prod path', productionPackages);
  addSection('Experimental', experimentalPackagesList);
  addSection('Deferred', deferredPackagesList);

  lines.push('');
  return lines.join('\n');
}

function syncPackageDocs(pkg: WorkspacePackage, destinationRoot: string): void {
  ensurePackageSourceDocs(pkg);

  const packageDestinationRoot = join(destinationRoot, pkg.slug);
  ensureDir(packageDestinationRoot);
  writeFileSync(join(packageDestinationRoot, 'index.mdx'), packageOverview(pkg));

  for (const level of levels) {
    copyDocsRecursive(pkg, level, join(pkg.docsSourceDir, level), packageDestinationRoot);
  }
}

export interface SyncWorkspaceDocsOptions {
  packages?: WorkspacePackage[];
  outputRootPath?: string;
}

export async function main(options: SyncWorkspaceDocsOptions = {}): Promise<void> {
  const packages = options.packages ?? discoverWorkspacePackages();
  const destinationRoot = options.outputRootPath ?? outputRoot;

  rmSync(destinationRoot, { recursive: true, force: true });
  ensureDir(destinationRoot);

  writeFileSync(join(destinationRoot, 'index.mdx'), packagesIndex(packages));

  for (const pkg of packages) {
    syncPackageDocs(pkg, destinationRoot);
    console.log(`Synced docs: ${pkg.name}`);
  }
}

if (import.meta.main) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
