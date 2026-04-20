import { z } from 'zod';

// ---------------------------------------------------------------------------
// Cross-field validation helpers
// ---------------------------------------------------------------------------

function getEntityFieldNames(
  entities: Record<string, unknown> | undefined,
  entityName: string,
): Set<string> {
  const entity = entities?.[entityName];
  if (!entity || typeof entity !== 'object') return new Set<string>();

  const fields = (entity as { fields?: unknown }).fields;
  if (!fields || typeof fields !== 'object') return new Set<string>();

  return new Set(Object.keys(fields as Record<string, unknown>));
}

function hasEntityOperation(
  entities: Record<string, unknown> | undefined,
  entityName: string,
  operationName: string,
): boolean {
  const entity = entities?.[entityName];
  if (!entity || typeof entity !== 'object') return false;

  const operations = (entity as { operations?: unknown }).operations;
  return !!operations && typeof operations === 'object' && operationName in operations;
}

function addManifestIssue(
  ctx: z.RefinementCtx,
  path: ReadonlyArray<string | number>,
  message: string,
): void {
  ctx.addIssue({
    code: 'custom',
    path: [...path],
    message,
  });
}

function validateTemplateFields(
  template: string,
  fieldNames: ReadonlySet<string>,
  ctx: z.RefinementCtx,
  path: ReadonlyArray<string | number>,
): void {
  for (const match of template.matchAll(/\{(\w+)\}/g)) {
    const fieldName = match[1];
    if (!fieldNames.has(fieldName)) {
      addManifestIssue(ctx, path, `Unknown template field "${fieldName}".`);
    }
  }
}

function validateFieldRefs(
  fields: readonly string[],
  fieldNames: ReadonlySet<string>,
  ctx: z.RefinementCtx,
  path: ReadonlyArray<string | number>,
): void {
  for (const fieldName of fields) {
    if (!fieldNames.has(fieldName)) {
      addManifestIssue(ctx, path, `Unknown field "${fieldName}".`);
    }
  }
}

// ---------------------------------------------------------------------------
// Cross-field superRefine callback
// ---------------------------------------------------------------------------

export function validateManifestCrossFields(
  manifest: Record<string, unknown>,
  ctx: z.RefinementCtx,
): void {
  const kafkaConnectors = manifest.kafkaConnectors as
    | {
        inbound?: Array<{
          topic?: string;
          topicPattern?: string;
          errorStrategy?: 'dlq' | 'skip' | 'pause';
          dlqTopic?: string;
          autoCreateDLQ?: boolean;
          sessionTimeout?: number;
          heartbeatInterval?: number;
        }>;
        outbound?: Array<{
          durable?: boolean;
          name?: string;
        }>;
      }
    | undefined;

  if (kafkaConnectors) {
    for (const [index, inbound] of (kafkaConnectors.inbound ?? []).entries()) {
      const hasTopic = typeof inbound.topic === 'string' && inbound.topic.length > 0;
      const hasTopicPattern =
        typeof inbound.topicPattern === 'string' && inbound.topicPattern.length > 0;

      if (hasTopic === hasTopicPattern) {
        addManifestIssue(
          ctx,
          ['kafkaConnectors', 'inbound', index],
          'Exactly one of "topic" or "topicPattern" is required.',
        );
      }

      if (inbound.dlqTopic && (inbound.errorStrategy ?? 'dlq') !== 'dlq') {
        addManifestIssue(
          ctx,
          ['kafkaConnectors', 'inbound', index, 'dlqTopic'],
          '"dlqTopic" requires errorStrategy "dlq".',
        );
      }

      if (
        typeof inbound.sessionTimeout === 'number' &&
        typeof inbound.heartbeatInterval === 'number' &&
        inbound.heartbeatInterval >= inbound.sessionTimeout
      ) {
        addManifestIssue(
          ctx,
          ['kafkaConnectors', 'inbound', index, 'heartbeatInterval'],
          '"heartbeatInterval" must be less than "sessionTimeout".',
        );
      }

      if (typeof inbound.topicPattern === 'string') {
        try {
          new RegExp(inbound.topicPattern);
        } catch {
          addManifestIssue(
            ctx,
            ['kafkaConnectors', 'inbound', index, 'topicPattern'],
            'Invalid regular expression.',
          );
        }
      }

      if (inbound.autoCreateDLQ && (inbound.errorStrategy ?? 'dlq') !== 'dlq') {
        addManifestIssue(
          ctx,
          ['kafkaConnectors', 'inbound', index, 'autoCreateDLQ'],
          '"autoCreateDLQ" is only meaningful when errorStrategy is "dlq".',
        );
      }
    }

    for (const [index, outbound] of (kafkaConnectors.outbound ?? []).entries()) {
      if (outbound.durable && !outbound.name) {
        addManifestIssue(
          ctx,
          ['kafkaConnectors', 'outbound', index, 'name'],
          '"name" is required when outbound connector "durable" is true.',
        );
      }
    }
  }

  if (!manifest.pages) return;

  const pages = manifest.pages as Record<string, Record<string, unknown>>;
  const pageKeys = new Set(Object.keys(pages));
  const entities = (manifest.entities ?? {}) as Record<string, unknown>;
  const entityNames = new Set(Object.keys(entities));

  for (const [pageKey, page] of Object.entries(pages)) {
    const pagePath: Array<string | number> = ['pages', pageKey];

    const entityName =
      'entity' in page && typeof page.entity === 'string' ? page.entity : undefined;
    const fieldNames =
      entityName && entityNames.has(entityName)
        ? getEntityFieldNames(entities, entityName)
        : new Set<string>();

    if (entityName && !entityNames.has(entityName)) {
      addManifestIssue(ctx, [...pagePath, 'entity'], `Unknown entity "${entityName}".`);
    }

    if (typeof page.title !== 'string') {
      const title = page.title as Record<string, string>;
      if ('field' in title && entityName && !fieldNames.has(title.field)) {
        addManifestIssue(ctx, [...pagePath, 'title', 'field'], `Unknown field "${title.field}".`);
      }
      if ('template' in title && entityName) {
        validateTemplateFields(title.template, fieldNames, ctx, [...pagePath, 'title']);
      }
    }

    switch (page.type) {
      case 'entity-list': {
        validateFieldRefs(page.fields as string[], fieldNames, ctx, [...pagePath, 'fields']);
        const defaultSort = page.defaultSort as { field: string } | undefined;
        if (defaultSort && !fieldNames.has(defaultSort.field)) {
          addManifestIssue(
            ctx,
            [...pagePath, 'defaultSort', 'field'],
            `Unknown field "${defaultSort.field}".`,
          );
        }
        for (const [index, filter] of (
          (page.filters ?? []) as Array<{ field: string }>
        ).entries()) {
          if (!fieldNames.has(filter.field)) {
            addManifestIssue(
              ctx,
              [...pagePath, 'filters', index, 'field'],
              `Unknown field "${filter.field}".`,
            );
          }
        }
        const rowClick = typeof page.rowClick === 'string' ? page.rowClick : undefined;
        if (rowClick && !pageKeys.has(rowClick)) {
          addManifestIssue(ctx, [...pagePath, 'rowClick'], `Unknown page reference "${rowClick}".`);
        }
        const listActions = page.actions as { create?: string } | undefined;
        if (listActions?.create && !pageKeys.has(listActions.create)) {
          addManifestIssue(
            ctx,
            [...pagePath, 'actions', 'create'],
            `Unknown page reference "${listActions.create}".`,
          );
        }
        break;
      }

      case 'entity-detail': {
        if (page.fields && page.sections) {
          addManifestIssue(
            ctx,
            pagePath,
            'entity-detail pages cannot declare both "fields" and "sections".',
          );
        }
        validateFieldRefs((page.fields ?? []) as string[], fieldNames, ctx, [
          ...pagePath,
          'fields',
        ]);
        for (const [index, section] of (
          (page.sections ?? []) as Array<{ fields: string[] }>
        ).entries()) {
          validateFieldRefs(section.fields, fieldNames, ctx, [...pagePath, 'sections', index]);
        }
        for (const [index, related] of (
          (page.related ?? []) as Array<{
            entity: string;
            foreignKey: string;
            fields: string[];
          }>
        ).entries()) {
          const relatedFieldNames = getEntityFieldNames(entities, related.entity);
          if (!entityNames.has(related.entity)) {
            addManifestIssue(
              ctx,
              [...pagePath, 'related', index, 'entity'],
              `Unknown entity "${related.entity}".`,
            );
          }
          if (!relatedFieldNames.has(related.foreignKey)) {
            addManifestIssue(
              ctx,
              [...pagePath, 'related', index, 'foreignKey'],
              `Unknown field "${related.foreignKey}" on entity "${related.entity}".`,
            );
          }
          validateFieldRefs(related.fields, relatedFieldNames, ctx, [
            ...pagePath,
            'related',
            index,
            'fields',
          ]);
        }
        const detailLookup = typeof page.lookup === 'string' ? page.lookup : undefined;
        if (
          entityName &&
          detailLookup &&
          detailLookup !== 'id' &&
          !hasEntityOperation(entities, entityName, detailLookup)
        ) {
          addManifestIssue(
            ctx,
            [...pagePath, 'lookup'],
            `Unknown lookup operation "${detailLookup}".`,
          );
        }
        const detailActions = page.actions as { edit?: string; back?: string } | undefined;
        if (detailActions?.edit && !pageKeys.has(detailActions.edit)) {
          addManifestIssue(
            ctx,
            [...pagePath, 'actions', 'edit'],
            `Unknown page reference "${detailActions.edit}".`,
          );
        }
        if (detailActions?.back && !pageKeys.has(detailActions.back)) {
          addManifestIssue(
            ctx,
            [...pagePath, 'actions', 'back'],
            `Unknown page reference "${detailActions.back}".`,
          );
        }
        break;
      }

      case 'entity-form': {
        validateFieldRefs(page.fields as string[], fieldNames, ctx, [...pagePath, 'fields']);
        validateFieldRefs(
          Object.keys((page.fieldConfig ?? {}) as Record<string, unknown>),
          fieldNames,
          ctx,
          [...pagePath, 'fieldConfig'],
        );
        if (page.operation === 'update' && !page.lookup) {
          addManifestIssue(
            ctx,
            [...pagePath, 'lookup'],
            'entity-form pages with operation "update" require a lookup.',
          );
        }
        const formLookup = typeof page.lookup === 'string' ? page.lookup : undefined;
        if (
          entityName &&
          formLookup &&
          formLookup !== 'id' &&
          !hasEntityOperation(entities, entityName, formLookup)
        ) {
          addManifestIssue(
            ctx,
            [...pagePath, 'lookup'],
            `Unknown lookup operation "${formLookup}".`,
          );
        }
        break;
      }

      case 'entity-dashboard': {
        const stats = page.stats as Array<{
          entity: string;
          aggregate: string;
          field?: string;
        }>;
        for (const [index, stat] of stats.entries()) {
          if (!entityNames.has(stat.entity)) {
            addManifestIssue(
              ctx,
              [...pagePath, 'stats', index, 'entity'],
              `Unknown entity "${stat.entity}".`,
            );
          }
          const statFieldNames = getEntityFieldNames(entities, stat.entity);
          if (stat.aggregate !== 'count' && !stat.field) {
            addManifestIssue(
              ctx,
              [...pagePath, 'stats', index, 'field'],
              `Stats using "${stat.aggregate}" require a field.`,
            );
          }
          if (stat.field && !statFieldNames.has(stat.field)) {
            addManifestIssue(
              ctx,
              [...pagePath, 'stats', index, 'field'],
              `Unknown field "${stat.field}" on entity "${stat.entity}".`,
            );
          }
        }
        const activity = page.activity as
          | {
              entity: string;
              fields: string[];
              sortField?: string;
            }
          | undefined;
        if (activity) {
          if (!entityNames.has(activity.entity)) {
            addManifestIssue(
              ctx,
              [...pagePath, 'activity', 'entity'],
              `Unknown entity "${activity.entity}".`,
            );
          }
          const activityFieldNames = getEntityFieldNames(entities, activity.entity);
          validateFieldRefs(activity.fields, activityFieldNames, ctx, [
            ...pagePath,
            'activity',
            'fields',
          ]);
          if (activity.sortField && !activityFieldNames.has(activity.sortField)) {
            addManifestIssue(
              ctx,
              [...pagePath, 'activity', 'sortField'],
              `Unknown field "${activity.sortField}" on entity "${activity.entity}".`,
            );
          }
        }
        const chart = page.chart as
          | {
              entity: string;
              categoryField: string;
              valueField: string;
            }
          | undefined;
        if (chart) {
          if (!entityNames.has(chart.entity)) {
            addManifestIssue(
              ctx,
              [...pagePath, 'chart', 'entity'],
              `Unknown entity "${chart.entity}".`,
            );
          }
          const chartFieldNames = getEntityFieldNames(entities, chart.entity);
          for (const [key, fieldName] of [
            ['categoryField', chart.categoryField],
            ['valueField', chart.valueField],
          ] as const) {
            if (!chartFieldNames.has(fieldName)) {
              addManifestIssue(
                ctx,
                [...pagePath, 'chart', key],
                `Unknown field "${fieldName}" on entity "${chart.entity}".`,
              );
            }
          }
        }
        break;
      }

      case 'custom':
        break;
    }
  }
}
