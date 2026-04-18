/**
 * Entity audit runner — combines all audit rules.
 *
 * Pure function: (entityConfig, operations?) → EntityAuditResult
 */
import type { OperationConfig, ResolvedEntityConfig } from '@lastshotlabs/slingshot-core';
import { auditIndexCoverage } from './indexCoverage';
import { auditOperationConsistency } from './operationConsistency';
import { auditSearchConfig } from './searchConfig';
import { auditStructural } from './structuralChecks';
import type { EntityAuditFinding, EntityAuditResult } from './types';

export type { EntityAuditFinding, EntityAuditResult, AuditSeverity } from './types';

/**
 * Run all built-in audit rules against an entity definition and its operations.
 *
 * Combines four rule sets:
 * - **Structural** — field type/default compatibility, soft-delete field type,
 *   missing indexes on large entities.
 * - **Index coverage** — unindexed lookup fields, pagination cursor fields,
 *   soft-delete fields, aggregate `groupBy`, upsert match fields.
 * - **Operation consistency** — field existence and enum-value validity for
 *   transitions, immutability violations in fieldUpdates, collection config
 *   completeness, consume expiry field type.
 * - **Search config** — search field references, geo field types,
 *   filterable/facetable/sortable coverage.
 *
 * @param config - Resolved entity config from `defineEntity()`.
 * @param operations - Optional operations map from `defineOperations()`.
 * @returns An `EntityAuditResult` with all findings and their severity counts.
 *
 * @example
 * ```ts
 * import { auditEntity } from '@lastshotlabs/slingshot-entity';
 * import { Order } from './order.entity';
 * import { OrderOps } from './order.operations';
 *
 * const result = auditEntity(Order, OrderOps.operations);
 * console.log(`${result.errors} errors, ${result.warnings} warnings`);
 * for (const f of result.findings) {
 *   console.log(`[${f.severity}] ${f.rule}: ${f.message}`);
 *   if (f.suggestion) console.log(`  Suggestion: ${f.suggestion}`);
 * }
 * ```
 */
export function auditEntity(
  config: ResolvedEntityConfig,
  operations?: Record<string, OperationConfig>,
): EntityAuditResult {
  const findings: EntityAuditFinding[] = [
    ...auditStructural(config),
    ...auditIndexCoverage(config, operations),
    ...auditOperationConsistency(config, operations),
    ...auditSearchConfig(config),
  ];

  return {
    entity: config.name,
    findings,
    errors: findings.filter(f => f.severity === 'error').length,
    warnings: findings.filter(f => f.severity === 'warning').length,
    infos: findings.filter(f => f.severity === 'info').length,
  };
}
