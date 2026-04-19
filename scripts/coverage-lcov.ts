import { readFileSync, writeFileSync } from 'node:fs';
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

const runtimeCoverageCache = new Map<string, boolean>();

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '');
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

  const needsRuntimeCoverage = sourceFile.statements.some(statement => {
    if (ts.isImportDeclaration(statement)) {
      return !statement.importClause?.isTypeOnly;
    }
    if (ts.isImportEqualsDeclaration(statement)) {
      return true;
    }
    if (ts.isExportDeclaration(statement)) {
      return !statement.isTypeOnly;
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

  runtimeCoverageCache.set(normalizedPath, needsRuntimeCoverage);
  return needsRuntimeCoverage;
}

export function parseLcov(path: string): CoverageReport {
  const content = readFileSync(path, 'utf8');
  const files = new Map<string, CoverageFileSummary>();

  for (const record of content.split('end_of_record')) {
    const sourceFile = record.match(/^SF:(.+)$/m)?.[1];
    if (!sourceFile) continue;

    files.set(normalizePath(sourceFile), {
      linesFound: Number(record.match(/^LF:(\d+)$/m)?.[1] ?? 0),
      linesHit: Number(record.match(/^LH:(\d+)$/m)?.[1] ?? 0),
      functionsFound: Number(record.match(/^FNF:(\d+)$/m)?.[1] ?? 0),
      functionsHit: Number(record.match(/^FNH:(\d+)$/m)?.[1] ?? 0),
      branchesFound: Number(record.match(/^BRF:(\d+)$/m)?.[1] ?? 0),
      branchesHit: Number(record.match(/^BRH:(\d+)$/m)?.[1] ?? 0),
    });
  }

  return { files };
}

export async function filterLcovToOwnedFiles(path: string, suite: CoverageSuite): Promise<void> {
  const ownedFiles = new Set(await discoverOwnedFiles(suite));
  const content = readFileSync(path, 'utf8');
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

  writeFileSync(path, keptRecords.join(''), 'utf8');
}
