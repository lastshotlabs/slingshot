#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  type WorkspacePackage,
  discoverWorkspacePackages,
  docsPackageRoot,
  repoRoot,
} from './workspacePackages';

const STARTER_TEMPLATE_MARKERS = [
  '> Human-owned documentation. This page should explain how to use the package, not just how it is organized internally.',
  'Package documentation for this Slingshot workspace module.',
  '- Describe the app or platform problem this package solves.',
  '- Call out when a user should install it and when they probably should not.',
  '- Show the smallest realistic code example for wiring the package into an app.',
  '- List required neighboring packages, middleware, or config.',
  '- Summarize the main capabilities, routes, exports, or runtime behavior this package adds.',
  '- Document the main config knobs or extension points a user is likely to touch first.',
  '- Record integration requirements, sharp edges, and debugging tips.',
] as const;

const DOC_REFERENCE_ROOT = resolve(docsPackageRoot, 'src/content/docs');
const TOP_LEVEL_SKIP_DIRS = new Set(['api', 'packages']);
const DEFAULT_COVERAGE_POLICY_PATH = resolve(
  repoRoot,
  '../slingshot-docs/documentation-coverage.json',
);

interface JsDocCoverage {
  documented: number;
  total: number;
}

interface CoverageThreshold {
  slug: string;
  minimumPercent: number;
}

interface CoveragePolicy {
  packageThresholds?: CoverageThreshold[];
}

interface CoverageEntry {
  pkg: WorkspacePackage;
  lineCount: number;
  guideState: 'documented' | 'template-only' | 'no-guide';
  hasTopicCoverage: boolean;
  jsDocCoverage: JsDocCoverage;
}

interface ThresholdFailure {
  entry: CoverageEntry;
  threshold: CoverageThreshold;
  percent: number;
}

function readTextIfExists(filePath: string): string | null {
  return existsSync(filePath) ? readFileSync(filePath, 'utf8') : null;
}

function loadCoveragePolicy(filePath = DEFAULT_COVERAGE_POLICY_PATH): CoveragePolicy {
  const content = readTextIfExists(filePath);
  if (!content) {
    return {};
  }

  const raw = JSON.parse(content) as CoveragePolicy;
  const thresholds = raw.packageThresholds ?? [];

  for (const threshold of thresholds) {
    if (!threshold.slug || typeof threshold.minimumPercent !== 'number') {
      throw new Error('[docs:coverage] Invalid documentation coverage policy entry');
    }
  }

  return raw;
}

function countLines(content: string): number {
  return content.split(/\r?\n/).length;
}

function isStarterTemplate(content: string): boolean {
  const normalized = content.trim();
  let markerMatches = 0;

  for (const marker of STARTER_TEMPLATE_MARKERS) {
    if (normalized.includes(marker)) {
      markerMatches += 1;
    }
  }

  return markerMatches >= 3;
}

function classifyGuide(pkg: WorkspacePackage): Pick<CoverageEntry, 'guideState' | 'lineCount'> {
  const guidePath = resolve(pkg.docsSourceDir, 'human/index.md');
  const content = readTextIfExists(guidePath);
  if (!content) {
    return { guideState: 'no-guide', lineCount: 0 };
  }

  return {
    guideState: isStarterTemplate(content) ? 'template-only' : 'documented',
    lineCount: countLines(content),
  };
}

async function loadDocReferenceCorpus(): Promise<string> {
  const glob = new Bun.Glob('**/*.{md,mdx}');
  const chunks: string[] = [];

  for await (const relativePath of glob.scan({ cwd: DOC_REFERENCE_ROOT })) {
    const topLevelDir = relativePath.split(/[\\/]/)[0];
    if (TOP_LEVEL_SKIP_DIRS.has(topLevelDir)) {
      continue;
    }

    const filePath = resolve(DOC_REFERENCE_ROOT, relativePath);
    chunks.push(readFileSync(filePath, 'utf8').toLowerCase());
  }

  return chunks
    .filter(section => section.length > 0)
    .join('\n')
    .trim();
}

function hasTopicCoverage(pkg: WorkspacePackage, corpus: string): boolean {
  const tokens = new Set<string>([
    pkg.name.toLowerCase(),
    pkg.slug.toLowerCase(),
    pkg.relativeDir.toLowerCase(),
  ]);

  for (const token of tokens) {
    if (token.length > 2 && corpus.includes(token)) {
      return true;
    }
  }

  return false;
}

function parseNamedExports(
  content: string,
  regex: RegExp,
): Array<{ name: string; documented: boolean }> {
  const matches: Array<{ name: string; documented: boolean }> = [];

  for (const match of content.matchAll(regex)) {
    const documented = Boolean(match[1]);
    const rawNames = match[2]
      .split(',')
      .map(part => part.trim())
      .filter(Boolean);

    for (const rawName of rawNames) {
      const withoutType = rawName.replace(/^type\s+/, '');
      const aliasParts = withoutType.split(/\s+as\s+/);
      const exportedName = aliasParts[aliasParts.length - 1]?.trim();
      if (!exportedName) {
        continue;
      }

      matches.push({ name: exportedName, documented });
    }
  }

  return matches;
}

function collectExportCoverage(content: string): JsDocCoverage {
  const exports = new Map<string, boolean>();
  const patterns = [
    /(\/\*\*[\s\S]*?\*\/\s*)?export\s+(?:type\s+)?\{([\s\S]*?)\}\s*from\s*['"][^'"]+['"]\s*;?/g,
    /(\/\*\*[\s\S]*?\*\/\s*)?export\s+(?:async\s+)?function\s+(\w+)/g,
    /(\/\*\*[\s\S]*?\*\/\s*)?export\s+class\s+(\w+)/g,
    /(\/\*\*[\s\S]*?\*\/\s*)?export\s+interface\s+(\w+)/g,
    /(\/\*\*[\s\S]*?\*\/\s*)?export\s+type\s+(\w+)/g,
    /(\/\*\*[\s\S]*?\*\/\s*)?export\s+enum\s+(\w+)/g,
    /(\/\*\*[\s\S]*?\*\/\s*)?export\s+(?:const|let|var)\s+(\w+)/g,
  ] as const;

  for (const pattern of patterns) {
    const namedMatches = parseNamedExports(content, pattern);
    for (const match of namedMatches) {
      exports.set(match.name, (exports.get(match.name) ?? false) || match.documented);
    }
  }

  let documented = 0;
  for (const hasJsDoc of exports.values()) {
    if (hasJsDoc) {
      documented += 1;
    }
  }

  return {
    documented,
    total: exports.size,
  };
}

function collectJsDocCoverage(pkg: WorkspacePackage): JsDocCoverage {
  const content = readFileSync(pkg.entryPoint, 'utf8');
  return collectExportCoverage(content);
}

function coveragePercent(coverage: JsDocCoverage): number {
  return coverage.total === 0 ? 100 : (coverage.documented / coverage.total) * 100;
}

function slugToTopic(slug: string): string {
  return slug
    .split('-')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function formatEntry(entry: CoverageEntry, note?: string): string {
  const packageLabel = entry.pkg.slug.padEnd(22, ' ');
  const lineLabel = `${String(entry.lineCount).padStart(3, ' ')} lines`;
  const jsDocLabel = `${entry.jsDocCoverage.documented}/${entry.jsDocCoverage.total} exports have JSDoc`;

  return note
    ? `  ${packageLabel} ${lineLabel} ${note}`
    : `  ${packageLabel} ${lineLabel} ${jsDocLabel}`;
}

export async function main(): Promise<number> {
  const packages = discoverWorkspacePackages().filter(pkg => pkg.kind === 'workspace');
  const coveragePolicy = loadCoveragePolicy();
  const thresholdMap = new Map(
    (coveragePolicy.packageThresholds ?? []).map(threshold => [threshold.slug, threshold]),
  );
  const corpus = await loadDocReferenceCorpus();

  const entries: CoverageEntry[] = packages.map(pkg => {
    const guide = classifyGuide(pkg);
    return {
      pkg,
      lineCount: guide.lineCount,
      guideState: guide.guideState,
      hasTopicCoverage: hasTopicCoverage(pkg, corpus),
      jsDocCoverage: collectJsDocCoverage(pkg),
    };
  });

  const documented = entries.filter(entry => entry.guideState === 'documented');
  const templateOnly = entries.filter(entry => entry.guideState === 'template-only');
  const noGuide = entries.filter(entry => entry.guideState === 'no-guide');
  const missingTopics = entries.filter(entry => !entry.hasTopicCoverage);
  const totalJsDoc = entries.reduce((sum, entry) => sum + entry.jsDocCoverage.total, 0);
  const documentedJsDoc = entries.reduce((sum, entry) => sum + entry.jsDocCoverage.documented, 0);
  const jsDocPercent = totalJsDoc === 0 ? 0 : Math.round((documentedJsDoc / totalJsDoc) * 100);
  const thresholdFailures: ThresholdFailure[] = entries
    .map(entry => {
      const threshold = thresholdMap.get(entry.pkg.slug);
      if (!threshold) {
        return null;
      }

      const percent = coveragePercent(entry.jsDocCoverage);
      if (percent >= threshold.minimumPercent) {
        return null;
      }

      return {
        entry,
        threshold,
        percent,
      };
    })
    .filter((value): value is ThresholdFailure => value !== null);

  console.log('Documentation Coverage Report');
  console.log('=============================');
  console.log('');

  console.log(`Documented (${documented.length}/${entries.length}):`);
  if (documented.length === 0) {
    console.log('  (none)');
  } else {
    for (const entry of documented) {
      console.log(formatEntry(entry));
    }
  }
  console.log('');

  console.log(`Template only (${templateOnly.length}/${entries.length}):`);
  if (templateOnly.length === 0) {
    console.log('  (none)');
  } else {
    for (const entry of templateOnly) {
      console.log(formatEntry(entry, '(starter template)'));
    }
  }
  console.log('');

  console.log(`No guide (${noGuide.length}/${entries.length}):`);
  if (noGuide.length === 0) {
    console.log('  (none)');
  } else {
    for (const entry of noGuide) {
      console.log(`  ${entry.pkg.slug}`);
    }
  }
  console.log('');

  console.log(
    `JSDoc coverage: ${documentedJsDoc}/${totalJsDoc} exported symbols (${jsDocPercent}%)`,
  );
  console.log('');

  console.log('Missing topic coverage:');
  if (missingTopics.length === 0) {
    console.log('  (none)');
  } else {
    console.log(
      `  No guide section for: ${missingTopics.map(entry => slugToTopic(entry.pkg.slug)).join(', ')}`,
    );
  }

  console.log('');
  console.log('Thresholds:');
  if (thresholdMap.size === 0) {
    console.log('  (none)');
  } else {
    for (const entry of entries) {
      const threshold = thresholdMap.get(entry.pkg.slug);
      if (!threshold) {
        continue;
      }

      const percent = Math.round(coveragePercent(entry.jsDocCoverage));
      const status = percent >= threshold.minimumPercent ? 'ok' : 'below threshold';
      console.log(
        `  ${entry.pkg.slug.padEnd(22, ' ')} ${String(percent).padStart(3, ' ')}% / ${String(threshold.minimumPercent).padStart(3, ' ')}% ${status}`,
      );
    }
  }

  if (thresholdFailures.length > 0) {
    console.error('');
    console.error(
      `[docs:coverage] ${thresholdFailures.length} package(s) fell below enforced JSDoc thresholds.`,
    );
    for (const failure of thresholdFailures) {
      console.error(
        `  ${failure.entry.pkg.slug}: ${failure.percent.toFixed(1)}% < ${failure.threshold.minimumPercent}%`,
      );
    }
    return 1;
  }

  return 0;
}

if (import.meta.main) {
  const exitCode = await main();
  process.exit(exitCode);
}
