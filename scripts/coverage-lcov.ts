import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import fg from 'fast-glob';
import ts from 'typescript';
import { type CoverageSuite } from './workspace-test-suites';

export interface CoverageFileSummary {
  linesFound: number;
  linesHit: number;
  functionsFound: number;
  functionsHit: number;
  branchesFound: number;
  branchesHit: number;
}

export interface CoverageReport {
  files: Map<string, CoverageFileSummary>;
}

interface CoverageAccumulator {
  lines: Map<number, number>;
  functions: Map<string, boolean>;
  branches: Map<string, boolean>;
  fallback: CoverageFileSummary;
}

const runtimeCoverageCache = new Map<string, boolean>();

function normalizePath(value: string): string {
  let normalized = value.replace(/\\/g, '/').replace(/^\.\//, '');
  if (isAbsolute(normalized)) {
    const relativePath = relative(process.cwd(), normalized).replace(/\\/g, '/');
    if (!relativePath.startsWith('../') && relativePath !== '..') {
      normalized = relativePath;
    }
  }
  while (normalized.startsWith('../')) {
    normalized = normalized.slice(3);
  }
  return normalized;
}

export async function discoverOwnedFiles(suite: CoverageSuite): Promise<string[]> {
  const files = await fg(suite.ownedGlobs, {
    cwd: process.cwd(),
    onlyFiles: true,
    ignore: suite.ignoredGlobs,
  });

  return files.map(normalizePath).sort((a, b) => a.localeCompare(b));
}

export function fileNeedsRuntimeCoverage(path: string): boolean {
  const normalizedPath = normalizePath(path);
  const cached = runtimeCoverageCache.get(normalizedPath);
  if (cached != null) return cached;

  const sourceText = readFileSync(normalizedPath, 'utf8');
  const sourceFile = ts.createSourceFile(normalizedPath, sourceText, ts.ScriptTarget.Latest, true);

  const hasSideEffectImport = sourceFile.statements.some(statement => {
    if (ts.isImportDeclaration(statement)) {
      // Side-effect imports execute runtime code even without bindings.
      return statement.importClause == null;
    }
    if (ts.isImportEqualsDeclaration(statement)) {
      return true;
    }
    return false;
  });

  const hasRuntimeStatement = sourceFile.statements.some(statement => {
    if (ts.isImportDeclaration(statement)) {
      return false;
    }
    if (ts.isImportEqualsDeclaration(statement)) {
      return true;
    }
    if (ts.isExportDeclaration(statement)) {
      // Pure re-export barrels do not produce stable LCOV entries under Bun.
      return false;
    }
    if (
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isModuleDeclaration(statement)
    ) {
      return false;
    }
    return true;
  });

  const needsRuntimeCoverage = hasSideEffectImport || hasRuntimeStatement;
  runtimeCoverageCache.set(normalizedPath, needsRuntimeCoverage);
  return needsRuntimeCoverage;
}

export function parseLcov(path: string): CoverageReport {
  const content = readFileSync(path, 'utf8');
  const files = new Map<string, CoverageAccumulator>();

  for (const record of content.split('end_of_record')) {
    const sourceFile = record.match(/^SF:(.+)$/m)?.[1];
    if (!sourceFile) continue;
    const normalized = normalizePath(sourceFile);
    const accumulator = files.get(normalized) ?? {
      lines: new Map<number, number>(),
      functions: new Map<string, boolean>(),
      branches: new Map<string, boolean>(),
      fallback: {
        linesFound: 0,
        linesHit: 0,
        functionsFound: 0,
        functionsHit: 0,
        branchesFound: 0,
        branchesHit: 0,
      },
    };

    const fnNames = new Map<string, string>();

    for (const line of record.split('\n')) {
      if (line.startsWith('FN:')) {
        const match = line.match(/^FN:\d+,(.+)$/);
        if (match) {
          fnNames.set(match[1], match[1]);
        }
        continue;
      }
      if (line.startsWith('FNDA:')) {
        const match = line.match(/^FNDA:(\d+),(.+)$/);
        if (match) {
          accumulator.functions.set(
            match[2],
            accumulator.functions.get(match[2]) === true || Number(match[1]) > 0,
          );
        }
        continue;
      }
      if (line.startsWith('DA:')) {
        const match = line.match(/^DA:(\d+),(\d+)$/);
        if (match) {
          const lineNo = Number(match[1]);
          const hits = Number(match[2]);
          accumulator.lines.set(lineNo, Math.max(accumulator.lines.get(lineNo) ?? 0, hits));
        }
        continue;
      }
      if (line.startsWith('BRDA:')) {
        const match = line.match(/^BRDA:(\d+),([^,]+),([^,]+),(.+)$/);
        if (match) {
          const key = `${match[1]},${match[2]},${match[3]}`;
          const hit = match[4] !== '-' && Number(match[4]) > 0;
          accumulator.branches.set(key, accumulator.branches.get(key) === true || hit);
        }
      }
    }

    for (const name of fnNames.keys()) {
      if (!accumulator.functions.has(name)) {
        accumulator.functions.set(name, false);
      }
    }

    if (accumulator.lines.size === 0) {
      accumulator.fallback.linesFound = Math.max(
        accumulator.fallback.linesFound,
        Number(record.match(/^LF:(\d+)$/m)?.[1] ?? 0),
      );
      accumulator.fallback.linesHit = Math.max(
        accumulator.fallback.linesHit,
        Number(record.match(/^LH:(\d+)$/m)?.[1] ?? 0),
      );
    }

    if (accumulator.functions.size === 0) {
      accumulator.fallback.functionsFound = Math.max(
        accumulator.fallback.functionsFound,
        Number(record.match(/^FNF:(\d+)$/m)?.[1] ?? 0),
      );
      accumulator.fallback.functionsHit = Math.max(
        accumulator.fallback.functionsHit,
        Number(record.match(/^FNH:(\d+)$/m)?.[1] ?? 0),
      );
    }

    if (accumulator.branches.size === 0) {
      accumulator.fallback.branchesFound = Math.max(
        accumulator.fallback.branchesFound,
        Number(record.match(/^BRF:(\d+)$/m)?.[1] ?? 0),
      );
      accumulator.fallback.branchesHit = Math.max(
        accumulator.fallback.branchesHit,
        Number(record.match(/^BRH:(\d+)$/m)?.[1] ?? 0),
      );
    }

    files.set(normalized, accumulator);
  }

  return {
    files: new Map(
      [...files.entries()].map(([sourceFile, accumulator]) => {
        const detailedFunctionsFound = accumulator.functions.size;
        const detailedFunctionsHit = [...accumulator.functions.values()].filter(Boolean).length;
        const useFunctionFallback =
          accumulator.fallback.functionsFound > 0 &&
          accumulator.fallback.functionsHit > detailedFunctionsHit;

        return [
          sourceFile,
          {
            linesFound:
              accumulator.lines.size > 0 ? accumulator.lines.size : accumulator.fallback.linesFound,
            linesHit:
              accumulator.lines.size > 0
                ? [...accumulator.lines.values()].filter(hits => hits > 0).length
                : accumulator.fallback.linesHit,
            functionsFound: useFunctionFallback
              ? accumulator.fallback.functionsFound
              : detailedFunctionsFound || accumulator.fallback.functionsFound,
            functionsHit: useFunctionFallback
              ? accumulator.fallback.functionsHit
              : detailedFunctionsHit || accumulator.fallback.functionsHit,
            branchesFound:
              accumulator.branches.size > 0
                ? accumulator.branches.size
                : accumulator.fallback.branchesFound,
            branchesHit:
              accumulator.branches.size > 0
                ? [...accumulator.branches.values()].filter(Boolean).length
                : accumulator.fallback.branchesHit,
          },
        ] as const;
      }),
    ),
  };
}

export function mergeLcovArtifacts(paths: string[], outputPath: string): void {
  mergeLcovContents(
    paths.filter(path => existsSync(path)).map(path => readFileSync(path, 'utf8')),
    outputPath,
  );
}

export function mergeLcovContents(contents: string[], outputPath: string): void {
  const merged = contents
    .map(content => content.trim())
    .filter(content => content.length > 0)
    .join('\n');
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, merged.length > 0 ? `${merged}\n` : '', 'utf8');
}

export async function waitForCoverageArtifacts(
  paths: string[],
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<string[]> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const intervalMs = options.intervalMs ?? 25;
  const deadline = Date.now() + timeoutMs;
  let missing = paths.filter(path => !existsSync(path));

  while (missing.length > 0 && Date.now() < deadline) {
    await sleep(intervalMs);
    missing = paths.filter(path => !existsSync(path));
  }

  return missing;
}

export async function filterLcovContentToOwnedFiles(
  content: string,
  suite: CoverageSuite,
): Promise<string> {
  const ownedFiles = new Set(await discoverOwnedFiles(suite));
  const keptRecords: string[] = [];

  for (const record of content.split('end_of_record')) {
    const trimmed = record.trim();
    if (trimmed.length === 0) continue;

    const sourceFile = record.match(/^SF:(.+)$/m)?.[1];
    if (!sourceFile) continue;

    if (ownedFiles.has(normalizePath(sourceFile))) {
      keptRecords.push(`${trimmed}\nend_of_record\n`);
    }
  }

  return keptRecords.join('');
}

export async function filterLcovToOwnedFiles(path: string, suite: CoverageSuite): Promise<void> {
  const content = readFileSync(path, 'utf8');
  const filtered = await filterLcovContentToOwnedFiles(content, suite);
  writeFileSync(path, filtered, 'utf8');
}
