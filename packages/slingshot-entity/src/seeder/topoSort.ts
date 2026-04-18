/**
 * Topological sort for entity configs based on relation dependencies.
 *
 * Ensures parent entities are seeded before children so foreign keys
 * reference existing records.
 */
import type { ResolvedEntityConfig } from '../types/entity';

/**
 * Sort entity configs in dependency order (parents first).
 *
 * A `belongsTo` relation means this entity depends on the target — the
 * target must be seeded first. `hasMany` / `hasOne` relations point the
 * other way and don't create a dependency for the owning entity.
 *
 * Throws if a cycle is detected.
 */
export function topoSortEntities(configs: ResolvedEntityConfig[]): ResolvedEntityConfig[] {
  const byName = new Map<string, ResolvedEntityConfig>();
  for (const cfg of configs) byName.set(cfg.name, cfg);

  // Build adjacency: entity name → set of entity names it depends on
  const deps = new Map<string, Set<string>>();
  for (const cfg of configs) {
    const d = new Set<string>();
    if (cfg.relations) {
      for (const rel of Object.values(cfg.relations)) {
        if (rel.kind === 'belongsTo' && byName.has(rel.target)) {
          d.add(rel.target);
        }
      }
    }
    deps.set(cfg.name, d);
  }

  const sorted: ResolvedEntityConfig[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  function visit(name: string) {
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      throw new Error(`Circular entity dependency detected involving "${name}"`);
    }
    visiting.add(name);
    const d = deps.get(name);
    if (d) {
      for (const dep of d) visit(dep);
    }
    visiting.delete(name);
    visited.add(name);
    const cfg = byName.get(name);
    if (cfg) sorted.push(cfg);
  }

  for (const cfg of configs) visit(cfg.name);
  return sorted;
}
