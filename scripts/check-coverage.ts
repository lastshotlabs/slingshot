import { existsSync, readFileSync } from 'node:fs';
import { type CoverageSuite, coverageArtifactPath, coverageSuites } from './coverage-suites';

interface CoverageSummary {
  linesFound: number;
  linesHit: number;
  functionsFound: number;
  functionsHit: number;
  branchesFound: number;
  branchesHit: number;
}

function parseLcovSummary(path: string): CoverageSummary {
  const summary: CoverageSummary = {
    linesFound: 0,
    linesHit: 0,
    functionsFound: 0,
    functionsHit: 0,
    branchesFound: 0,
    branchesHit: 0,
  };

  const content = readFileSync(path, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    if (rawLine.startsWith('LF:')) summary.linesFound += Number(rawLine.slice(3));
    if (rawLine.startsWith('LH:')) summary.linesHit += Number(rawLine.slice(3));
    if (rawLine.startsWith('FNF:')) summary.functionsFound += Number(rawLine.slice(4));
    if (rawLine.startsWith('FNH:')) summary.functionsHit += Number(rawLine.slice(4));
    if (rawLine.startsWith('BRF:')) summary.branchesFound += Number(rawLine.slice(4));
    if (rawLine.startsWith('BRH:')) summary.branchesHit += Number(rawLine.slice(4));
  }

  return summary;
}

function percent(hit: number, found: number): number {
  return found === 0 ? 100 : (hit / found) * 100;
}

function formatPercent(hit: number, found: number): string {
  return `${percent(hit, found).toFixed(1)}% (${hit}/${found})`;
}

function suiteEnvPrefix(suite: CoverageSuite): string {
  return suite.name.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

function readThreshold(
  suite: CoverageSuite,
  metric: 'LINES' | 'FUNCTIONS' | 'BRANCHES',
): number | null {
  const suiteSpecific = Bun.env[`SLINGSHOT_COVERAGE_MIN_${suiteEnvPrefix(suite)}_${metric}`];
  const global = Bun.env[`SLINGSHOT_COVERAGE_MIN_${metric}`];
  const raw = suiteSpecific ?? global;
  if (raw == null || raw.trim().length === 0) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function assertNonEmptyCoverage(suite: CoverageSuite, summary: CoverageSummary): string[] {
  const failures: string[] = [];
  if (summary.linesFound === 0) {
    failures.push(`${suite.name}: no executable lines were captured`);
  }
  if (summary.functionsFound === 0) {
    failures.push(`${suite.name}: no functions were captured`);
  }
  return failures;
}

function assertThresholds(suite: CoverageSuite, summary: CoverageSummary): string[] {
  const failures: string[] = [];
  const lineThreshold = readThreshold(suite, 'LINES');
  if (lineThreshold != null && percent(summary.linesHit, summary.linesFound) < lineThreshold) {
    failures.push(
      `${suite.name}: line coverage ${formatPercent(summary.linesHit, summary.linesFound)} is below ${lineThreshold.toFixed(1)}%`,
    );
  }

  const functionThreshold = readThreshold(suite, 'FUNCTIONS');
  if (
    functionThreshold != null &&
    percent(summary.functionsHit, summary.functionsFound) < functionThreshold
  ) {
    failures.push(
      `${suite.name}: function coverage ${formatPercent(summary.functionsHit, summary.functionsFound)} is below ${functionThreshold.toFixed(1)}%`,
    );
  }

  const branchThreshold = readThreshold(suite, 'BRANCHES');
  if (
    branchThreshold != null &&
    summary.branchesFound > 0 &&
    percent(summary.branchesHit, summary.branchesFound) < branchThreshold
  ) {
    failures.push(
      `${suite.name}: branch coverage ${formatPercent(summary.branchesHit, summary.branchesFound)} is below ${branchThreshold.toFixed(1)}%`,
    );
  }

  return failures;
}

const failures: string[] = [];

for (const suite of coverageSuites) {
  const artifact = coverageArtifactPath(suite);
  if (!existsSync(artifact)) {
    failures.push(`${suite.name}: missing coverage artifact at ${artifact}`);
    continue;
  }

  const summary = parseLcovSummary(artifact);
  console.log(
    [
      `${suite.name}:`,
      `lines ${formatPercent(summary.linesHit, summary.linesFound)}`,
      `functions ${formatPercent(summary.functionsHit, summary.functionsFound)}`,
      `branches ${formatPercent(summary.branchesHit, summary.branchesFound)}`,
    ].join(' '),
  );

  failures.push(...assertNonEmptyCoverage(suite, summary));
  failures.push(...assertThresholds(suite, summary));
}

if (failures.length > 0) {
  console.error('coverage check failed');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(`coverage check passed for ${coverageSuites.length} suite(s)`);
