/**
 * Entity audit types — findings produced by audit rules.
 */

/**
 * The severity of an audit finding.
 *
 * - `'error'` — the entity definition is incorrect and will likely cause
 *   runtime failures (e.g. a `transition.field` that doesn't exist).
 * - `'warning'` — the definition is valid but has a quality issue that will
 *   likely cause performance problems or subtle bugs (e.g. missing index on a
 *   lookup field).
 * - `'info'` — an advisory note with no urgency (e.g. no facetable search
 *   fields configured).
 *
 * @example
 * ```ts
 * import { auditEntity } from '@lastshotlabs/slingshot-entity';
 * import type { AuditSeverity } from '@lastshotlabs/slingshot-entity';
 *
 * const result = auditEntity(Message, MessageOps.operations);
 * const severities: AuditSeverity[] = ['error', 'warning', 'info'];
 * for (const severity of severities) {
 *   const findings = result.findings.filter(f => f.severity === severity);
 *   console.log(`${severity}: ${findings.length}`);
 * }
 * ```
 */
export type AuditSeverity = 'error' | 'warning' | 'info';

/**
 * A single finding produced by one audit rule.
 *
 * Findings are aggregated into an `EntityAuditResult` by `auditEntity()`.
 *
 * @example
 * ```ts
 * import { auditEntity } from '@lastshotlabs/slingshot-entity';
 * import type { EntityAuditFinding } from '@lastshotlabs/slingshot-entity';
 *
 * const result = auditEntity(Order, OrderOps.operations);
 * result.findings.forEach((finding: EntityAuditFinding) => {
 *   console.log(`[${finding.severity}] ${finding.rule}: ${finding.message}`);
 *   if (finding.suggestion) console.log(`  Suggestion: ${finding.suggestion}`);
 * });
 * ```
 */
export interface EntityAuditFinding {
  /** Severity level. */
  readonly severity: AuditSeverity;
  /**
   * Namespaced rule identifier (e.g. `'index-coverage/lookup'`,
   * `'structural/soft-delete-type'`). Use this to suppress specific rules
   * programmatically.
   */
  readonly rule: string;
  /** Name of the entity the finding relates to. */
  readonly entity: string;
  /** Name of the operation the finding relates to, if applicable. */
  readonly operation?: string;
  /** Human-readable description of the issue. */
  readonly message: string;
  /** Suggested remediation steps. */
  readonly suggestion?: string;
}

/**
 * The aggregated result of running all audit rules against one entity.
 *
 * Returned by `auditEntity()`. Check `errors > 0` to gate CI pipelines.
 *
 * @example
 * ```ts
 * import { auditEntity } from '@lastshotlabs/slingshot-entity';
 * import { Message } from './message.entity';
 * import { MessageOps } from './message.operations';
 *
 * const result = auditEntity(Message, MessageOps.operations);
 * if (result.errors > 0) {
 *   for (const f of result.findings.filter(f => f.severity === 'error')) {
 *     console.error(`[${f.rule}] ${f.message}`);
 *   }
 *   process.exit(1);
 * }
 * ```
 */
export interface EntityAuditResult {
  /** Entity name. */
  readonly entity: string;
  /** All findings from all audit rules. */
  readonly findings: readonly EntityAuditFinding[];
  /** Number of findings with `severity === 'error'`. */
  readonly errors: number;
  /** Number of findings with `severity === 'warning'`. */
  readonly warnings: number;
  /** Number of findings with `severity === 'info'`. */
  readonly infos: number;
}
