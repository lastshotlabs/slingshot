#!/usr/bin/env bun
/**
 * Generate API reference markdown from workspace entrypoints.
 *
 * Usage:
 *   bun packages/docs/generate-api.ts
 *   bun run docs:api
 */
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverWorkspacePackages } from './workspacePackages';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../..');
const outBase = resolve(__dirname, 'src/content/docs/api');

interface PackageEntry {
  slug: string;
  label: string;
  entryPoint: string;
  description: string;
}

interface ExportedSymbol {
  name: string;
  kind: 'function' | 'interface' | 'type' | 'class' | 'const' | 'enum' | 'variable';
  signature?: string;
  description?: string;
  fieldDescriptions?: Record<string, string>;
  source: string;
}

const packages: PackageEntry[] = discoverWorkspacePackages().map(pkg => ({
  slug: pkg.slug,
  label: pkg.name,
  entryPoint: pkg.entryPoint,
  description: pkg.description,
}));

function isFilePath(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

async function parseExports(filePath: string): Promise<ExportedSymbol[]> {
  const content = await Bun.file(filePath).text();
  const symbols: ExportedSymbol[] = [];

  const reExportRegex = /export\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g;
  for (const match of content.matchAll(reExportRegex)) {
    const [, rawNames, source] = match;
    if (!rawNames || !source) continue;

    const names = rawNames.split(',').map((part: string) => {
      const pieces = part.trim().split(/\s+as\s+/);
      return pieces[pieces.length - 1].trim();
    });
    for (const name of names) {
      if (!name || name.startsWith('//')) continue;
      symbols.push({ name, kind: 'variable', source });
    }
  }

  const typeReExportRegex = /export\s+type\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g;
  for (const match of content.matchAll(typeReExportRegex)) {
    const [, rawNames, source] = match;
    if (!rawNames || !source) continue;

    const names = rawNames.split(',').map((part: string) => {
      const pieces = part.trim().split(/\s+as\s+/);
      return pieces[pieces.length - 1].trim();
    });
    for (const name of names) {
      if (!name || name.startsWith('//')) continue;
      symbols.push({ name, kind: 'type', source });
    }
  }

  const directExportRegex =
    /export\s+(async\s+)?(function|class|const|let|var|interface|type|enum)\s+(\w+)/g;
  for (const match of content.matchAll(directExportRegex)) {
    const [, , rawKind, name] = match;
    if (!rawKind || !name) continue;

    const kind: ExportedSymbol['kind'] =
      rawKind === 'let' || rawKind === 'var' ? 'variable' : (rawKind as ExportedSymbol['kind']);
    symbols.push({ name, kind, source: filePath });
  }

  return symbols;
}

function resolveSymbolSourcePath(symbol: ExportedSymbol, packageEntryPoint: string): string | null {
  if (symbol.source === packageEntryPoint || symbol.source === normalizeSource(packageEntryPoint)) {
    return packageEntryPoint;
  }

  if (
    symbol.source === packageEntryPoint ||
    symbol.source.endsWith('.ts') ||
    symbol.source.endsWith('.js')
  ) {
    const absoluteSource = resolve(root, symbol.source);
    if (absoluteSource === packageEntryPoint || isFilePath(absoluteSource)) {
      return absoluteSource;
    }
  }

  const entryDir = resolve(packageEntryPoint, '..');
  for (const ext of ['', '.ts', '.js', '/index.ts', '/index.js']) {
    const candidate = resolve(entryDir, symbol.source + ext);
    if (isFilePath(candidate)) {
      return candidate;
    }
  }

  return null;
}

function sanitizeJSDocInlineTags(text: string): string {
  return text.replace(
    /\{@(link|linkcode|linkplain)\s+([^}\s|]+)(?:\s*(?:\|\s*|\s+)([^}]+))?\}/g,
    (_match, _tag, target: string, label?: string) => {
      const visible = (label?.trim() || target).trim();
      return visible ? `\`${visible}\`` : '';
    },
  );
}

function escapeMdxText(text: string): string {
  return text
    .split(/(`[^`]*`)/g)
    .map(segment =>
      segment.startsWith('`') && segment.endsWith('`')
        ? segment
        : segment
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/\{/g, '\\{')
            .replace(/\}/g, '\\}'),
    )
    .join('');
}

function cleanJSDocBlock(block: string): string | null {
  const lines = block
    .replace(/^\/\*\*\s*/, '')
    .replace(/\s*\*\/$/, '')
    .split('\n')
    .map(line => line.replace(/^\s*\*\s?/, ''));

  const sections: string[] = [];
  let activeTag: 'description' | 'remarks' | null = 'description';

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith('@')) {
      activeTag = line.startsWith('@remarks') ? 'remarks' : null;
      const remarksText = line.startsWith('@remarks') ? line.slice('@remarks'.length).trim() : '';
      if (activeTag === 'remarks' && remarksText) {
        sections.push(`Remarks: ${remarksText}`);
      }
      continue;
    }

    if (!line) {
      if (sections.length > 0 && sections[sections.length - 1] !== '') {
        sections.push('');
      }
      continue;
    }

    if (activeTag === 'description') {
      sections.push(line);
    } else if (activeTag === 'remarks') {
      if (sections.length > 0 && sections[sections.length - 1].startsWith('Remarks:')) {
        sections[sections.length - 1] = `${sections[sections.length - 1]} ${line}`.trim();
      } else {
        sections.push(`Remarks: ${line}`);
      }
    }
  }

  const description = sections
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!description.length) return null;
  return escapeMdxText(sanitizeJSDocInlineTags(description));
}

export function extractJSDoc(content: string, symbolName: string): string | null {
  const escapedName = symbolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(
      `/\\*\\*[\\s\\S]*?\\*/\\s*export\\s+(?:async\\s+)?(?:function|class|const|let|var|interface|type|enum)\\s+${escapedName}\\b`,
      'g',
    ),
    new RegExp(
      `/\\*\\*[\\s\\S]*?\\*/\\s*export\\s+(?:type\\s+)?\\{[^}]*\\b${escapedName}\\b[^}]*\\}\\s*from`,
      'g',
    ),
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(content);
    if (!match) continue;
    const blockMatch = match[0].match(/\/\*\*[\s\S]*?\*\//);
    if (!blockMatch) continue;
    return cleanJSDocBlock(blockMatch[0]);
  }

  return null;
}

function findMatchingBrace(source: string, openIndex: number): number {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let escaped = false;

  for (let i = openIndex; i < source.length; i += 1) {
    const char = source[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (!inDouble && !inTemplate && char === "'") {
      inSingle = !inSingle;
      continue;
    }

    if (!inSingle && !inTemplate && char === '"') {
      inDouble = !inDouble;
      continue;
    }

    if (!inSingle && !inDouble && char === '`') {
      inTemplate = !inTemplate;
      continue;
    }

    if (inSingle || inDouble || inTemplate) continue;

    if (char === '{') {
      depth += 1;
      continue;
    }

    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }

  return -1;
}

function extractTopLevelFields(body: string): Array<{ name: string; source: string }> {
  const fields: Array<{ name: string; source: string }> = [];
  let current = '';
  let depthParen = 0;
  let depthBrace = 0;
  let depthBracket = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let escaped = false;

  const pushCurrent = (): void => {
    const segment = current.trim();
    current = '';
    if (!segment) return;

    const colonIndex = segment.indexOf(':');
    if (colonIndex === -1) return;

    const name = segment
      .slice(0, colonIndex)
      .trim()
      .replace(/^['"`]|['"`]$/g, '');
    if (!name) return;
    fields.push({ name, source: segment.slice(colonIndex + 1).trim() });
  };

  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      current += char;
      escaped = true;
      continue;
    }

    if (!inDouble && !inTemplate && char === "'") {
      inSingle = !inSingle;
      current += char;
      continue;
    }

    if (!inSingle && !inTemplate && char === '"') {
      inDouble = !inDouble;
      current += char;
      continue;
    }

    if (!inSingle && !inDouble && char === '`') {
      inTemplate = !inTemplate;
      current += char;
      continue;
    }

    if (!inSingle && !inDouble && !inTemplate) {
      if (char === '(') depthParen += 1;
      if (char === ')') depthParen -= 1;
      if (char === '{') depthBrace += 1;
      if (char === '}') depthBrace -= 1;
      if (char === '[') depthBracket += 1;
      if (char === ']') depthBracket -= 1;

      if (char === ',' && depthParen === 0 && depthBrace === 0 && depthBracket === 0) {
        pushCurrent();
        continue;
      }
    }

    current += char;
  }

  pushCurrent();
  return fields;
}

function extractDescribeText(fieldSource: string): string | null {
  const matches = Array.from(fieldSource.matchAll(/\.describe\(\s*(['"`])([\s\S]*?)\1\s*\)/g));
  const match = matches.at(-1);
  return match ? match[2].replace(/\s+/g, ' ').trim() : null;
}

export function extractZodDescriptions(
  content: string,
  symbolName: string,
): Record<string, string> {
  const escapedName = symbolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const declaration = new RegExp(`export\\s+const\\s+${escapedName}\\s*=`, 'm').exec(content);
  if (!declaration) return {};

  const start = declaration.index + declaration[0].length;
  const zObjectMatch = /z\s*(?:\.\s*object|\s*\.object)\s*\(\s*\{/.exec(content.slice(start));
  if (!zObjectMatch) return {};

  const bodyStart = start + zObjectMatch.index + zObjectMatch[0].lastIndexOf('{');
  const bodyEnd = findMatchingBrace(content, bodyStart);
  if (bodyEnd === -1) return {};

  const body = content.slice(bodyStart + 1, bodyEnd);
  const descriptions: Record<string, string> = {};

  for (const field of extractTopLevelFields(body)) {
    const description = extractDescribeText(field.source);
    if (description) {
      descriptions[field.name] = description;
    }
  }

  return descriptions;
}

async function resolveSymbolDetails(
  symbol: ExportedSymbol,
  packageEntryPoint: string,
): Promise<ExportedSymbol> {
  const sourcePath = resolveSymbolSourcePath(symbol, packageEntryPoint);
  if (!sourcePath) return symbol;

  const content = await Bun.file(sourcePath).text();
  const { name } = symbol;
  const description = extractJSDoc(content, name) ?? undefined;
  const fieldDescriptions = extractZodDescriptions(content, name);
  const detailsBase = {
    ...symbol,
    source: sourcePath,
    description,
    fieldDescriptions: Object.keys(fieldDescriptions).length > 0 ? fieldDescriptions : undefined,
  };

  const fnMatch = content.match(
    new RegExp(
      `export\\s+(async\\s+)?function\\s+${name}\\s*(<[^>]*>)?\\s*\\(([\\s\\S]*?)\\)\\s*(?::\\s*([\\s\\S]*?))?\\s*\\{`,
    ),
  );
  if (fnMatch) {
    const async_ = fnMatch[1] ? 'async ' : '';
    const generics = fnMatch[2] || '';
    const params = fnMatch[3].replace(/\n\s*/g, ' ').trim();
    const ret = fnMatch[4]?.replace(/\n\s*/g, ' ').trim() || 'void';
    return {
      ...detailsBase,
      kind: 'function',
      signature: `${async_}function ${name}${generics}(${params}): ${ret}`,
    };
  }

  if (content.match(new RegExp(`export\\s+interface\\s+${name}\\b`))) {
    return { ...detailsBase, kind: 'interface' };
  }

  if (content.match(new RegExp(`export\\s+type\\s+${name}\\b`))) {
    return { ...detailsBase, kind: 'type' };
  }

  if (content.match(new RegExp(`export\\s+class\\s+${name}\\b`))) {
    return { ...detailsBase, kind: 'class' };
  }

  const constLine = content.match(
    new RegExp(`export\\s+const\\s+${name}\\b[^]*?=>|export\\s+const\\s+${name}\\b[^;]*;`, 's'),
  );
  if (constLine) {
    const snippet = constLine[0];
    const isArrow = snippet.includes('=>');

    if (isArrow) {
      const arrowMatch = content.match(
        new RegExp(
          `export\\s+const\\s+${name}\\s*=\\s*(async\\s+)?` +
            `(?:<([^>]*)>\\s*)?` +
            `\\(([\\s\\S]*?)\\)` +
            `\\s*(?::\\s*([\\s\\S]*?))?` +
            `\\s*=>`,
        ),
      );
      if (arrowMatch) {
        const async_ = arrowMatch[1] ? 'async ' : '';
        const generics = arrowMatch[2] ? `<${arrowMatch[2].trim()}>` : '';
        const params = arrowMatch[3].replace(/\n\s*/g, ' ').trim();
        const ret = arrowMatch[4]?.replace(/\n\s*/g, ' ').trim() || 'void';
        return {
          ...detailsBase,
          kind: 'function',
          signature: `${async_}function ${name}${generics}(${params}): ${ret}`,
        };
      }
      return { ...detailsBase, kind: 'function' };
    }

    return { ...detailsBase, kind: 'const' };
  }

  if (content.match(new RegExp(`export\\s+const\\s+${name}\\b`))) {
    return { ...detailsBase, kind: 'const' };
  }

  if (content.match(new RegExp(`export\\s+enum\\s+${name}\\b`))) {
    return { ...detailsBase, kind: 'enum' };
  }

  return detailsBase;
}

function normalizeSource(source: string): string {
  const relative = source.replace(root, '').replace(/^[/\\]/, '');
  return relative.replace(/\\/g, '/');
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n+/g, '<br />');
}

function generatePackagePage(pkg: PackageEntry, symbols: ExportedSymbol[]): string {
  const lines: string[] = [
    '---',
    `title: "${pkg.label}"`,
    `description: "${pkg.description.replace(/"/g, '\\"')}"`,
    '---',
    '',
    `\`npm install ${pkg.label}\``,
    '',
  ];

  const groups = new Map<string, ExportedSymbol[]>();
  for (const symbol of symbols) {
    if (!groups.has(symbol.kind)) groups.set(symbol.kind, []);
    groups.get(symbol.kind)!.push(symbol);
  }

  const order: [string, string][] = [
    ['function', 'Functions'],
    ['const', 'Constants'],
    ['class', 'Classes'],
    ['interface', 'Interfaces'],
    ['type', 'Types'],
    ['enum', 'Enums'],
    ['variable', 'Exports'],
  ];

  for (const [kind, heading] of order) {
    const items = groups.get(kind);
    if (!items?.length) continue;

    lines.push(`## ${heading}`, '');
    items.sort((a, b) => a.name.localeCompare(b.name));

    for (const item of items) {
      lines.push(`### \`${item.name}\``, '');
      if (item.description) {
        lines.push(item.description, '');
      }
      if (item.signature) {
        lines.push('```typescript', item.signature, '```', '');
      }
      if (item.fieldDescriptions && Object.keys(item.fieldDescriptions).length > 0) {
        lines.push('#### Config Fields', '', '| Field | Description |', '|---|---|');
        for (const [field, desc] of Object.entries(item.fieldDescriptions).sort(([a], [b]) =>
          a.localeCompare(b),
        )) {
          lines.push(`| \`${field}\` | ${escapeTableCell(desc)} |`);
        }
        lines.push('');
      }

      const sourceLabel = normalizeSource(item.source);
      lines.push(`*Source: \`${sourceLabel}\`*`, '');
    }
  }

  return lines.join('\n');
}

async function main(): Promise<void> {
  rmSync(outBase, { recursive: true, force: true });
  mkdirSync(outBase, { recursive: true });

  const indexLines = [
    '---',
    'title: API Reference',
    'description: Auto-generated API reference for Slingshot workspace packages',
    '---',
    '',
    'Auto-generated from TypeScript source. Each package lists its public exports.',
    '',
    '| Package | Description |',
    '|---|---|',
  ];

  for (const pkg of packages) {
    indexLines.push(`| [${pkg.label}](/api/${pkg.slug}/) | ${pkg.description} |`);
  }
  writeFileSync(join(outBase, 'index.mdx'), `${indexLines.join('\n')}\n`);

  for (const pkg of packages) {
    console.log(`Generating: ${pkg.label}`);

    let symbols = await parseExports(pkg.entryPoint);
    symbols = await Promise.all(
      symbols.map(symbol => resolveSymbolDetails(symbol, pkg.entryPoint)),
    );

    const seen = new Set<string>();
    symbols = symbols.filter(symbol => {
      if (seen.has(symbol.name)) return false;
      seen.add(symbol.name);
      return true;
    });

    const content = generatePackagePage(pkg, symbols);
    const outDir = join(outBase, pkg.slug);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'index.mdx'), content);

    console.log(`  ${symbols.length} exports`);
  }

  console.log(`\nDone. Generated API reference for ${packages.length} packages.`);
}

if (import.meta.main) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
