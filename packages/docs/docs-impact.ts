#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { repoRoot } from './workspacePackages';

const DEFAULT_MAP_PATH = resolve(repoRoot, '../slingshot-docs/documentation-impact-map.json');

export interface DocumentationSurface {
  id: string;
  description?: string;
  codePaths: string[];
  docPaths: string[];
}

export interface DocumentationImpactMap {
  surfaces: DocumentationSurface[];
}

export interface SurfaceImpactResult {
  surface: DocumentationSurface;
  changedCodePaths: string[];
  changedDocPaths: string[];
}

export interface DocumentationImpactResult {
  impacted: SurfaceImpactResult[];
  failing: SurfaceImpactResult[];
}

interface CliOptions {
  mapPath: string;
  staged: boolean;
  base?: string;
  head?: string;
  files: string[];
}

function toPosixPath(value: string): string {
  return value.replace(/\\/g, '/');
}

function normalizeRelativePath(value: string): string {
  const absolute = resolve(repoRoot, value);
  const relative = absolute.startsWith(repoRoot) ? absolute.slice(repoRoot.length + 1) : value;
  return toPosixPath(relative);
}

export function loadImpactMap(filePath = DEFAULT_MAP_PATH): DocumentationImpactMap {
  if (!existsSync(filePath)) {
    throw new Error(`[docs:impact] Impact map not found: ${filePath}`);
  }

  const raw = JSON.parse(readFileSync(filePath, 'utf8')) as DocumentationImpactMap;
  if (!raw || !Array.isArray(raw.surfaces)) {
    throw new Error('[docs:impact] Invalid impact map: missing "surfaces" array');
  }

  for (const surface of raw.surfaces) {
    if (!surface.id || !Array.isArray(surface.codePaths) || !Array.isArray(surface.docPaths)) {
      throw new Error('[docs:impact] Invalid surface entry in impact map');
    }
  }

  return raw;
}

export function pathMatches(pattern: string, candidate: string): boolean {
  const normalizedPattern = toPosixPath(pattern);
  const normalizedCandidate = toPosixPath(candidate);
  if (normalizedPattern.endsWith('/')) {
    return normalizedCandidate.startsWith(normalizedPattern);
  }
  return normalizedCandidate === normalizedPattern;
}

export function analyzeDocumentationImpact(
  changedFiles: string[],
  impactMap: DocumentationImpactMap,
): DocumentationImpactResult {
  const normalizedFiles = changedFiles.map(normalizeRelativePath);
  const impacted: SurfaceImpactResult[] = [];

  for (const surface of impactMap.surfaces) {
    const changedCodePaths = normalizedFiles.filter(file =>
      surface.codePaths.some(pattern => pathMatches(pattern, file)),
    );
    if (changedCodePaths.length === 0) {
      continue;
    }

    const changedDocPaths = normalizedFiles.filter(file =>
      surface.docPaths.some(pattern => pathMatches(pattern, file)),
    );

    impacted.push({
      surface,
      changedCodePaths,
      changedDocPaths,
    });
  }

  return {
    impacted,
    failing: impacted.filter(result => result.changedDocPaths.length === 0),
  };
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    mapPath: DEFAULT_MAP_PATH,
    staged: false,
    files: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--staged') {
      options.staged = true;
      continue;
    }
    if (arg === '--base') {
      options.base = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--head') {
      options.head = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--map') {
      options.mapPath = resolve(repoRoot, argv[index + 1] ?? '');
      index += 1;
      continue;
    }
    if (arg === '--files') {
      options.files.push(...argv.slice(index + 1));
      break;
    }
    throw new Error(`[docs:impact] Unknown argument: ${arg}`);
  }

  return options;
}

function gitChangedFiles(options: CliOptions): string[] {
  const gitArgs = ['git', 'diff', '--name-only'];
  if (options.staged) {
    gitArgs.push('--cached');
  } else if (options.base && options.head) {
    gitArgs.push(`${options.base}..${options.head}`);
  } else if (options.base) {
    gitArgs.push(`${options.base}...HEAD`);
  } else {
    gitArgs.push('HEAD');
  }

  const result = Bun.spawnSync(gitArgs, {
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  if (result.exitCode !== 0) {
    const stderr = new TextDecoder().decode(result.stderr).trim();
    throw new Error(stderr || '[docs:impact] git diff failed');
  }

  return new TextDecoder()
    .decode(result.stdout)
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
}

function printResult(result: DocumentationImpactResult): void {
  if (result.impacted.length === 0) {
    console.log('docs:impact - no mapped cross-cutting documentation surfaces were affected.');
    return;
  }

  console.log('docs:impact - impacted documentation surfaces:');
  for (const entry of result.impacted) {
    const status = entry.changedDocPaths.length > 0 ? 'updated' : 'missing docs update';
    console.log(`- ${entry.surface.id}: ${status}`);
    console.log(`  code: ${entry.changedCodePaths.join(', ')}`);
    if (entry.changedDocPaths.length > 0) {
      console.log(`  docs: ${entry.changedDocPaths.join(', ')}`);
    } else {
      console.log(`  expected docs: ${entry.surface.docPaths.join(', ')}`);
    }
  }
}

export async function main(argv = Bun.argv.slice(2)): Promise<number> {
  const options = parseArgs(argv);

  if (!existsSync(options.mapPath)) {
    console.log(`[docs:impact] Impact map not found: ${options.mapPath} — skipping.`);
    return 0;
  }

  const impactMap = loadImpactMap(options.mapPath);
  const changedFiles = options.files.length > 0 ? options.files : gitChangedFiles(options);
  const result = analyzeDocumentationImpact(changedFiles, impactMap);

  printResult(result);

  if (result.failing.length > 0) {
    console.error('');
    console.error(
      `[docs:impact] ${result.failing.length} cross-cutting surface(s) changed without a mapped docs update.`,
    );
    return 1;
  }

  return 0;
}

if (import.meta.main) {
  const exitCode = await main();
  process.exit(exitCode);
}
