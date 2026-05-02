#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, posix, relative, resolve } from 'node:path';
import { discoverWorkspacePackages, docsPackageRoot, repoRoot } from './workspacePackages';

const DOCS_CONTENT_DIR = resolve(docsPackageRoot, 'src/content/docs');
const TMP_DIR = resolve(docsPackageRoot, '.docs-typecheck');
const TYPECHECK_TSCONFIG = resolve(TMP_DIR, 'tsconfig.json');
const ROOT_TSCONFIG = resolve(repoRoot, 'tsconfig.json');
const SKIP_TOP_LEVEL_DIRS = new Set(['api']);

export interface CodeBlock {
  sourceFile: string;
  sourceLine: number;
  code: string;
  blockIndex: number;
  virtualPath: string | null;
}

export interface TypecheckError {
  sourceFile: string;
  sourceLine: number;
  message: string;
}

interface TypecheckSource {
  sourceFile: string;
  sourceLine: number;
}

interface PackageJsonExportTarget {
  bun?: string;
  import?: string;
  types?: string;
  default?: string;
}

interface PackageJsonShape {
  exports?: Record<string, PackageJsonExportTarget | string> | string;
}

function isTypescriptFence(line: string): boolean {
  return /^```(?:typescript|ts)\b/.test(line.trim());
}

function shouldTypecheckBlock(code: string): boolean {
  return /\bimport\s/.test(code) && !code.includes('@skip-typecheck');
}

function extractVirtualPath(line: string): string | null {
  const match = line.match(/\btitle=(?:"([^"]+)"|'([^']+)')/);
  return match?.[1] || match?.[2] || null;
}

function toPosixRelativePath(filePath: string): string {
  return relative(repoRoot, filePath).replace(/\\/g, '/');
}

export function extractTypescriptBlocks(filePath: string, content?: string): CodeBlock[] {
  const fileContent = content ?? readFileSync(filePath, 'utf8');
  const lines = fileContent.split(/\r?\n/);
  const blocks: CodeBlock[] = [];

  let inBlock = false;
  let blockStartLine = 0;
  let currentCode: string[] = [];
  let blockIndex = 0;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!inBlock && isTypescriptFence(line)) {
      inBlock = true;
      blockStartLine = index + 1;
      currentCode = [];
      continue;
    }

    if (inBlock && line.trim() === '```') {
      const code = currentCode.join('\n');
      const block = {
        sourceFile: filePath,
        sourceLine: blockStartLine,
        code,
        blockIndex,
        virtualPath: extractVirtualPath(lines[blockStartLine - 1] ?? ''),
      };
      if ((shouldTypecheckBlock(code) || block.virtualPath) && !code.includes('@skip-typecheck')) {
        blocks.push({
          ...block,
        });
      }
      blockIndex += 1;
      inBlock = false;
      currentCode = [];
      continue;
    }

    if (inBlock) {
      currentCode.push(line);
    }
  }

  return blocks;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, 'utf8')) as T;
}

function toPosixPath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function getSourceCandidates(
  packageDir: string,
  entryPoint: string,
  exportKey: string,
  exportValue: string | PackageJsonExportTarget,
): string[] {
  const candidates = new Set<string>();

  if (exportKey === '.') {
    candidates.add(entryPoint);
  }

  if (typeof exportValue === 'string') {
    candidates.add(resolve(packageDir, exportValue));
  } else if (isRecord(exportValue)) {
    for (const key of ['bun', 'types', 'import', 'default'] as const) {
      const target = exportValue[key];
      if (typeof target === 'string') {
        candidates.add(resolve(packageDir, target));
      }
    }
  }

  if (exportKey !== '.') {
    const subpath = exportKey.replace(/^\.\//, '');
    candidates.add(resolve(packageDir, 'src', `${subpath}.ts`));
    candidates.add(resolve(packageDir, 'src', subpath, 'index.ts'));
  }

  return Array.from(candidates);
}

function toSourceVariants(filePath: string): string[] {
  const variants = new Set<string>();
  const addTypeScriptFirst = (candidate: string): void => {
    for (const sourceCandidate of [
      candidate.replace(/\.d\.ts$/, '.ts'),
      candidate.replace(/\.m?js$/, '.ts'),
      candidate.replace(/\.cjs$/, '.ts'),
      candidate.replace(/\.jsx$/, '.tsx'),
    ]) {
      if (sourceCandidate !== candidate) {
        variants.add(sourceCandidate);
      }
    }
    variants.add(candidate);
  };

  if (filePath.includes('/dist/')) {
    const sourceLikePaths = new Set<string>([
      filePath.replace('/dist/src/', '/src/'),
      filePath.replace('/dist/', '/src/'),
    ]);

    for (const sourceLikePath of sourceLikePaths) {
      addTypeScriptFirst(sourceLikePath);
    }
  }

  addTypeScriptFirst(filePath);

  return Array.from(variants);
}

function resolveExistingFile(candidates: string[]): string | null {
  for (const candidate of candidates) {
    const normalizedCandidate = toPosixPath(candidate);
    for (const variant of toSourceVariants(normalizedCandidate)) {
      if (existsSync(variant)) {
        return variant;
      }
    }
  }

  return null;
}

export function buildWorkspacePathMappings(): Record<string, string[]> {
  const packages = discoverWorkspacePackages();
  const mappings: Record<string, string[]> = {};

  for (const workspacePackage of packages) {
    const packageJson = readJsonFile<PackageJsonShape>(workspacePackage.packageJsonPath);
    const exportMap =
      typeof packageJson.exports === 'string'
        ? { '.': packageJson.exports }
        : packageJson.exports || { '.': './src/index.ts' };

    for (const [exportKey, exportValue] of Object.entries(exportMap)) {
      const resolvedFile = resolveExistingFile(
        getSourceCandidates(
          workspacePackage.packageDir,
          workspacePackage.entryPoint,
          exportKey,
          exportValue,
        ),
      );

      if (!resolvedFile) {
        continue;
      }

      const mappingKey =
        exportKey === '.'
          ? workspacePackage.name
          : `${workspacePackage.name}/${exportKey.replace(/^\.\//, '')}`;
      mappings[mappingKey] = [toPosixRelativePath(resolvedFile)];
    }
  }

  return mappings;
}

function createTypecheckTsconfig(): void {
  const rootTsconfig = readJsonFile<{
    compilerOptions?: { paths?: Record<string, string[]> };
  }>(ROOT_TSCONFIG);
  const paths = {
    ...(rootTsconfig.compilerOptions?.paths || {}),
    ...buildWorkspacePathMappings(),
    // Force zod to resolve to the workspace-root v4 installation so code blocks
    // and workspace package sources see the same ZodType. The docs package pins
    // zod v3 for Astro's content collections, but all Slingshot packages use v4.
    zod: ['node_modules/zod'],
    'zod/*': ['node_modules/zod/*'],
  };

  writeFileSync(
    TYPECHECK_TSCONFIG,
    `${JSON.stringify(
      {
        extends: '../tsconfig.typecheck.json',
        compilerOptions: {
          baseUrl: '../../..',
          paths,
        },
        include: ['./**/*.ts'],
        exclude: [],
      },
      null,
      2,
    )}\n`,
  );
}

function collectDocsBlocks(): Promise<CodeBlock[]> {
  return (async () => {
    const allBlocks: CodeBlock[] = [];
    const glob = new Bun.Glob('**/*.{md,mdx}');

    for await (const relativePath of glob.scan({ cwd: DOCS_CONTENT_DIR })) {
      const topLevelDir = relativePath.split(/[\\/]/)[0];
      if (SKIP_TOP_LEVEL_DIRS.has(topLevelDir)) {
        continue;
      }

      const fullPath = resolve(DOCS_CONTENT_DIR, relativePath);
      if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
        continue;
      }
      allBlocks.push(...extractTypescriptBlocks(fullPath));
    }

    return allBlocks;
  })();
}

function sanitizePathSegment(segment: string): string {
  return segment.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function getDocTempDir(filePath: string): string {
  const relativeDocPath = toPosixRelativePath(filePath).replace(/\.[^.]+$/, '');
  const segments = relativeDocPath.split('/').map(sanitizePathSegment);
  return resolve(TMP_DIR, ...segments);
}

function normalizeVirtualPath(virtualPath: string): string {
  return virtualPath
    .split(/[\\/]+/)
    .filter(segment => segment.length > 0 && segment !== '.' && segment !== '..')
    .map(sanitizePathSegment)
    .join('/');
}

function getBlockRelativePath(block: CodeBlock): string {
  return block.virtualPath
    ? normalizeVirtualPath(block.virtualPath)
    : `block-${block.blockIndex}.ts`;
}

function getRelativeImports(code: string): string[] {
  const imports = new Set<string>();
  const pattern =
    /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)/g;

  for (const match of code.matchAll(pattern)) {
    const specifier = match[1] || match[2];
    if (specifier) {
      imports.add(specifier);
    }
  }

  return Array.from(imports);
}

function resolveImportedVirtualPath(fromPath: string, specifier: string): string[] {
  const resolvedBase = posix.normalize(posix.join(posix.dirname(fromPath), specifier));
  const candidates = [
    resolvedBase,
    resolvedBase.replace(/\.m?js$/, '.ts'),
    resolvedBase.replace(/\.cjs$/, '.ts'),
    resolvedBase.replace(/\.jsx$/, '.tsx'),
    `${resolvedBase}.ts`,
    `${resolvedBase}.tsx`,
    posix.join(resolvedBase, 'index.ts'),
    posix.join(resolvedBase, 'index.tsx'),
  ];

  return Array.from(new Set(candidates.map(candidate => candidate.replace(/^\.\/+/, ''))));
}

function selectBlocksForTypecheck(blocks: CodeBlock[]): CodeBlock[] {
  const included = new Map<string, CodeBlock>();
  const blocksByDoc = new Map<string, CodeBlock[]>();

  for (const block of blocks) {
    const docBlocks = blocksByDoc.get(block.sourceFile) ?? [];
    docBlocks.push(block);
    blocksByDoc.set(block.sourceFile, docBlocks);
  }

  for (const docBlocks of blocksByDoc.values()) {
    const titledBlocks = new Map<string, CodeBlock>();
    const queue: CodeBlock[] = [];

    for (const block of docBlocks) {
      if (block.virtualPath) {
        titledBlocks.set(normalizeVirtualPath(block.virtualPath), block);
      }
      if (shouldTypecheckBlock(block.code)) {
        queue.push(block);
      }
    }

    const seenInDoc = new Set<number>();
    while (queue.length > 0) {
      const block = queue.shift();
      if (!block || seenInDoc.has(block.blockIndex)) {
        continue;
      }
      seenInDoc.add(block.blockIndex);
      included.set(`${block.sourceFile}::${block.blockIndex}`, block);

      const relativePath = getBlockRelativePath(block);
      for (const specifier of getRelativeImports(block.code)) {
        for (const candidate of resolveImportedVirtualPath(relativePath, specifier)) {
          const dependency = titledBlocks.get(candidate);
          if (dependency && !seenInDoc.has(dependency.blockIndex)) {
            queue.push(dependency);
          }
        }
      }
    }
  }

  return Array.from(included.values());
}

function getTempRelativePath(block: CodeBlock): string {
  const docTempDir = getDocTempDir(block.sourceFile);
  const tempPath = block.virtualPath
    ? resolve(docTempDir, normalizeVirtualPath(block.virtualPath))
    : resolve(docTempDir, getBlockRelativePath(block));
  return toPosixPath(relative(TMP_DIR, tempPath));
}

function createTempFiles(blocks: CodeBlock[]): Map<string, TypecheckSource> {
  rmSync(TMP_DIR, { recursive: true, force: true });
  mkdirSync(TMP_DIR, { recursive: true });
  createTypecheckTsconfig();

  const sourceMap = new Map<string, TypecheckSource>();
  const includedBlocks = selectBlocksForTypecheck(blocks);

  for (const block of includedBlocks) {
    const tempName = getTempRelativePath(block);
    const tempPath = resolve(TMP_DIR, tempName);
    mkdirSync(dirname(tempPath), { recursive: true });
    writeFileSync(tempPath, block.code);
    sourceMap.set(tempName, {
      sourceFile: block.sourceFile,
      sourceLine: block.sourceLine,
    });
  }

  return sourceMap;
}

function mapTypecheckErrors(
  output: string,
  sourceMap: Map<string, TypecheckSource>,
): TypecheckError[] {
  const errors: TypecheckError[] = [];
  const pattern = /\.docs-typecheck[/\\]([^(]+)\((\d+),\d+\):\s*(.+)/g;

  for (const match of output.matchAll(pattern)) {
    const tempFile = match[1];
    const tscLine = Number.parseInt(match[2], 10);
    const message = match[3].trim();
    const source = sourceMap.get(tempFile);

    errors.push({
      sourceFile: source?.sourceFile ?? tempFile,
      sourceLine: source ? source.sourceLine + tscLine - 1 : tscLine,
      message,
    });
  }

  return errors;
}

function formatTypecheckErrors(errors: TypecheckError[]): string {
  const lines = [`docs:typecheck - ${errors.length} error(s):`, ''];
  for (const error of errors) {
    lines.push(`  ${toPosixRelativePath(error.sourceFile)}:${error.sourceLine}`);
    lines.push(`    ${error.message}`);
    lines.push('');
  }
  return lines.join('\n');
}

export async function main(): Promise<number> {
  const blocks = await collectDocsBlocks();

  if (blocks.length === 0) {
    console.log('docs:typecheck - no typecheckable code blocks found.');
    return 0;
  }

  const sourceMap = createTempFiles(blocks);

  try {
    const proc = Bun.spawn(['npx', 'tsc', '--project', TYPECHECK_TSCONFIG], {
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (exitCode === 0) {
      console.log(`docs:typecheck - ${blocks.length} code blocks, 0 errors.`);
      return 0;
    }

    const output = stdout || stderr;
    const errors = mapTypecheckErrors(output, sourceMap);
    if (errors.length > 0) {
      console.error(formatTypecheckErrors(errors));
    } else {
      console.error('docs:typecheck - tsc failed, but no mapped errors were found.');
      console.error(output.trim());
    }

    return 1;
  } finally {
    rmSync(TMP_DIR, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const exitCode = await main();
  process.exit(exitCode);
}
