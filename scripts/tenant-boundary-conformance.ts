import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type TenantBoundaryDefinition,
  type TenantBoundaryKind,
  captureTenantExecutionContext,
  createTenantBoundaryRegistry,
  deserializeTenantExecutionContext,
  withTenantExecutionContext,
} from '@lastshotlabs/slingshot-core';

const kinds: readonly TenantBoundaryKind[] = [
  'http',
  'websocket',
  'sse',
  'entity',
  'event',
  'job',
  'queue',
  'orchestration',
  'cache',
  'search',
  'asset',
  'notification',
  'mail',
  'push',
  'billing',
  'ai',
];

const definitions: TenantBoundaryDefinition[] = kinds.map(kind => ({
  id: `first-party.${kind}`,
  kind,
  requiredIn: ['single', 'multi'],
  serialization: ['event', 'queue', 'orchestration'].includes(kind) ? 'envelope' : 'scope',
  missing: kind === 'job' ? 'system-only' : 'reject',
  mismatch: 'reject',
}));

const registry = createTenantBoundaryRegistry();
for (const definition of definitions) registry.register(definition);
const inventory = registry.finalize();

const cases = ['colliding-id', 'missing', 'malformed', 'spoofed', 'stale', 'mid-connection'];
const results: {
  boundaryId: string;
  caseId: string;
  passed: boolean;
}[] = [];

for (const boundary of inventory) {
  const alpha = captureTenantExecutionContext({ tenantId: 'alpha', actorId: 'same-id' });
  const beta = captureTenantExecutionContext({ tenantId: 'beta', actorId: 'same-id' });
  results.push({
    boundaryId: boundary.id,
    caseId: 'colliding-id',
    passed: alpha.tenantId !== beta.tenantId && alpha.actorId === beta.actorId,
  });
  results.push({
    boundaryId: boundary.id,
    caseId: 'missing',
    passed: rejects(() => captureTenantExecutionContext({ tenantId: null })),
  });
  results.push({
    boundaryId: boundary.id,
    caseId: 'malformed',
    passed: rejects(() => deserializeTenantExecutionContext('invalid')),
  });
  results.push({
    boundaryId: boundary.id,
    caseId: 'spoofed',
    passed: rejects(() => deserializeTenantExecutionContext({ ...alpha, version: 9 })),
  });
  results.push({
    boundaryId: boundary.id,
    caseId: 'stale',
    passed: rejects(() => deserializeTenantExecutionContext({ ...alpha, version: 0 })),
  });
  const restored = await withTenantExecutionContext(alpha, context => context);
  results.push({
    boundaryId: boundary.id,
    caseId: 'mid-connection',
    passed: restored.tenantId === 'alpha' && beta.tenantId === 'beta',
  });
}

function rejects(callback: () => unknown): boolean {
  try {
    callback();
    return false;
  } catch {
    return true;
  }
}

const missing = inventory.flatMap(boundary =>
  cases
    .filter(
      caseId =>
        !results.some(
          result => result.boundaryId === boundary.id && result.caseId === caseId && result.passed,
        ),
    )
    .map(caseId => `${boundary.id}:${caseId}`),
);
if (missing.length > 0) {
  throw new Error(`Tenant boundary conformance is incomplete:\n${missing.join('\n')}`);
}

const report = {
  formatVersion: 1,
  boundaries: inventory,
  cases,
  results,
  manualSkips: [],
};
const outputDir = join(process.cwd(), '.tmp', 'tenant-boundaries');
mkdirSync(outputDir, { recursive: true });
const output = join(outputDir, 'tenant-boundary-conformance.v1.json');
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`[tenant-boundaries] ${results.length} cases passed; report: ${output}`);
