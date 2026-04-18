/**
 * Post-processes an OpenAPI 3.x spec object to remove `components/schemas` entries
 * not directly or transitively referenced by any path operation.
 *
 * Prevents phantom types in generated TypeScript clients (openapi-typescript, orval)
 * when multiple versioned specs share a single OpenAPI registry.
 *
 * @param spec - The OpenAPI spec document (from `app.getOpenAPIDocument()`).
 * @returns A shallow-cloned spec with unreferenced schemas removed.
 */
export function stripUnreferencedSchemas(spec: Record<string, unknown>): Record<string, unknown> {
  const components = spec.components;
  const schemas =
    components && typeof components === 'object'
      ? (components as Record<string, unknown>).schemas
      : undefined;
  if (!schemas || typeof schemas !== 'object') return spec;
  const schemasRecord = schemas as Record<string, unknown>;

  // Collect all $ref strings from an arbitrary JSON node
  function collectRefs(node: unknown, refs: Set<string>): void {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) collectRefs(item, refs);
      return;
    }
    for (const [key, val] of Object.entries(node as Record<string, unknown>)) {
      if (key === '$ref' && typeof val === 'string') {
        refs.add(val);
      } else {
        collectRefs(val, refs);
      }
    }
  }

  // Extract schema name from a $ref like "#/components/schemas/Foo"
  function schemaNameFromRef(ref: string): string | null {
    const prefix = '#/components/schemas/';
    return ref.startsWith(prefix) ? ref.slice(prefix.length) : null;
  }

  // Collect initial refs from paths (not from components to avoid circular bootstrapping)
  const pathRefs = new Set<string>();
  collectRefs(spec.paths, pathRefs);

  // BFS to transitively follow refs within referenced schemas
  const referenced = new Set<string>();
  const queue: string[] = [];

  for (const ref of pathRefs) {
    const name = schemaNameFromRef(ref);
    if (name && Object.hasOwn(schemasRecord, name) && !referenced.has(name)) {
      referenced.add(name);
      queue.push(name);
    }
  }

  let name: string | undefined;
  while ((name = queue.pop()) !== undefined) {
    const inner = new Set<string>();
    collectRefs(schemasRecord[name], inner);
    for (const ref of inner) {
      const refName = schemaNameFromRef(ref);
      if (refName && Object.hasOwn(schemasRecord, refName) && !referenced.has(refName)) {
        referenced.add(refName);
        queue.push(refName);
      }
    }
  }

  // Build cleaned spec — shallow clone, then rebuild components/schemas with only referenced entries
  const cleaned: Record<string, unknown> = { ...spec };
  cleaned.components = { ...(spec.components as Record<string, unknown>) };
  const cleanedComponents = cleaned.components as Record<string, unknown>;

  if (referenced.size === 0) {
    delete cleanedComponents.schemas;
  } else {
    const cleanedSchemas: Record<string, unknown> = {};
    for (const refName of referenced) {
      cleanedSchemas[refName] = schemasRecord[refName];
    }
    cleanedComponents.schemas = cleanedSchemas;
  }

  if (Object.keys(cleanedComponents).length === 0) {
    delete cleaned.components;
  }

  return cleaned;
}
