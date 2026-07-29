#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { format } from 'prettier';
import {
  ENTITY_BACKEND_CAPABILITIES,
  type EntityBackendCapability,
} from '@lastshotlabs/slingshot-core';
import { ENTITY_BACKEND_PROFILES } from '../packages/slingshot-entity/src/configDriven/backendProfiles';
import {
  CONCURRENCY_GUARANTEE_CATALOG,
  ENTITY_CONFORMANCE_STORES,
  TRANSACTION_GUARANTEE_CATALOG,
} from './entity-conformance-report';

export const ENTITY_SUPPORT_MATRIX_PATH = resolve(
  import.meta.dir,
  '../packages/docs/src/content/docs/reference/entity-backend-support.mdx',
);

const GROUPS = [
  {
    title: 'CRUD and configuration features',
    capabilities: ENTITY_BACKEND_CAPABILITIES.filter(
      capability =>
        !capability.startsWith('filter.') &&
        !capability.startsWith('operation.') &&
        !capability.startsWith('atomic.') &&
        capability !== 'transaction.rollback',
    ),
  },
  {
    title: 'Filters',
    capabilities: ENTITY_BACKEND_CAPABILITIES.filter(capability =>
      capability.startsWith('filter.'),
    ),
  },
  {
    title: 'Declarative operations',
    capabilities: ENTITY_BACKEND_CAPABILITIES.filter(capability =>
      capability.startsWith('operation.'),
    ),
  },
  {
    title: 'Atomicity and rollback guarantees',
    capabilities: ENTITY_BACKEND_CAPABILITIES.filter(
      capability => capability.startsWith('atomic.') || capability === 'transaction.rollback',
    ),
  },
] as const;

function escapeCell(value: string): string {
  return value.replaceAll('|', '\\|').replace(/\s+/gu, ' ').trim();
}

function claimCell(
  store: (typeof ENTITY_CONFORMANCE_STORES)[number],
  capability: EntityBackendCapability,
) {
  const claim = ENTITY_BACKEND_PROFILES[store].capabilities[capability];
  return claim.status === 'supported' ? '✅ Supported' : `❌ ${escapeCell(claim.reason)}`;
}

export async function renderEntitySupportMatrix(): Promise<string> {
  const lines = [
    '---',
    'title: Entity Backend Support',
    'description: Generated semantic capability matrix for standard Slingshot entity stores.',
    '---',
    '',
    '{/* GENERATED FILE — run `bun run docs:entity-support` to update. */}',
    '',
    '# Entity backend support',
    '',
    'This page is generated from `ENTITY_BACKEND_PROFILES`, the same immutable registry used by',
    'startup validation and the conformance report. A method name existing internally is not a',
    'support claim: unsupported configurations fail before backend infrastructure is opened.',
    '',
    '> Memory is a development/test store. It is not a durable production store and does not provide',
    '> rollback durability for composite transactions.',
    '',
    'Version concurrency requires both `concurrency.version-update` and',
    '`concurrency.version-delete`. Memory, SQLite, PostgreSQL, and MongoDB perform atomic',
    'compare-and-write operations; Redis rejects the configuration before infrastructure access.',
    'See [Optimistic Concurrency](/entity-system/optimistic-concurrency/) for HTTP and migration',
    'behavior.',
    '',
  ];

  for (const group of GROUPS) {
    lines.push(`## ${group.title}`, '');
    lines.push(
      `| Capability | ${ENTITY_CONFORMANCE_STORES.map(store => store[0]?.toUpperCase() + store.slice(1)).join(' | ')} |`,
    );
    lines.push(`| --- | ${ENTITY_CONFORMANCE_STORES.map(() => '---').join(' | ')} |`);
    for (const capability of group.capabilities) {
      lines.push(
        `| \`${capability}\` | ${ENTITY_CONFORMANCE_STORES.map(store => claimCell(store, capability)).join(' | ')} |`,
      );
    }
    lines.push('');
  }

  lines.push(
    '## Transaction manager guarantees',
    '',
    'The versioned conformance report requires every guarantee below to pass on both SQLite and',
    'PostgreSQL. Removing a guarantee, changing its cases, or recording a non-passing result makes',
    'report validation fail.',
    '',
    '| Guarantee | SQLite | PostgreSQL | Evidence cases |',
    '| --- | --- | --- | --- |',
  );
  for (const guarantee of TRANSACTION_GUARANTEE_CATALOG) {
    lines.push(
      `| \`${guarantee.id}\` | ✅ Required | ✅ Required | ${guarantee.caseIds.map(caseId => `\`${caseId}\``).join(', ')} |`,
    );
  }
  lines.push('');

  lines.push(
    '## Optimistic-concurrency guarantees',
    '',
    'The versioned conformance report requires every listed case to pass on each backend shown.',
    'SQLite and PostgreSQL additionally prove parity through transaction-scoped adapters.',
    '',
    '| Guarantee | Required stores | Evidence cases |',
    '| --- | --- | --- |',
  );
  for (const guarantee of CONCURRENCY_GUARANTEE_CATALOG) {
    lines.push(
      `| \`${guarantee.id}\` | ${guarantee.stores.map(store => `\`${store}\``).join(', ')} | ${guarantee.caseIds.map(caseId => `\`${caseId}\``).join(', ')} |`,
    );
  }
  lines.push('');

  lines.push('{/* END GENERATED FILE */}', '');
  return await format(lines.join('\n'), { parser: 'mdx' });
}

export async function main(argv = Bun.argv.slice(2)): Promise<number> {
  const expected = await renderEntitySupportMatrix();
  const check = argv.includes('--check');
  if (check) {
    const actual = existsSync(ENTITY_SUPPORT_MATRIX_PATH)
      ? readFileSync(ENTITY_SUPPORT_MATRIX_PATH, 'utf8')
      : '';
    if (actual !== expected) {
      console.error(
        '[entity-support] Generated matrix is stale. Run `bun run docs:entity-support` and commit the result.',
      );
      return 1;
    }
    console.log('[entity-support] Generated matrix is current.');
    return 0;
  }

  mkdirSync(dirname(ENTITY_SUPPORT_MATRIX_PATH), { recursive: true });
  writeFileSync(ENTITY_SUPPORT_MATRIX_PATH, expected, 'utf8');
  console.log(`[entity-support] Wrote ${ENTITY_SUPPORT_MATRIX_PATH}`);
  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}
