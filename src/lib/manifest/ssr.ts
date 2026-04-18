import { z } from 'zod';
import { appManifestHandlerRefSchema } from './helpers';

// -- SSR --
const ssrCacheControlSchema = z.object({
  default: z
    .string()
    .optional()
    .describe(
      'Default Cache-Control header value for SSR responses. Omit to leave cache-control unset by default.',
    ),
  routes: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      'Per-route Cache-Control header overrides keyed by route pattern. Omit to use the default cache-control value for every route.',
    ),
});

const ssrIsrSectionSchema = z.object({
  adapter: z
    .union([
      z.literal('memory').describe('In-memory ISR cache (development only).'),
      appManifestHandlerRefSchema,
    ])
    .optional()
    .describe('ISR cache adapter or handler reference. Omit to disable ISR caching.'),
});

export const ssrSectionSchema = z.object({
  renderer: appManifestHandlerRefSchema.describe('Handler reference to the SSR renderer factory.'),
  serverRoutesDir: z
    .string()
    .describe('Absolute path to the directory containing SSR server route modules.'),
  assetsManifest: z
    .string()
    .describe('Path to the client assets manifest used to resolve bundled assets.'),
  entryPoint: z
    .string()
    .optional()
    .describe(
      'Explicit SSR entry module path. Omit to let the SSR runtime resolve its default entrypoint.',
    ),
  cacheControl: ssrCacheControlSchema
    .loose()
    .optional()
    .describe(
      'Cache-Control header settings for SSR responses. Omit to use the SSR default behavior.',
    ),
  exclude: z
    .array(z.string())
    .optional()
    .describe('Route patterns the SSR runtime should skip. Omit to evaluate every request path.'),
  devMode: z
    .boolean()
    .optional()
    .describe('Whether SSR should run in development mode. Omit to use the runtime default.'),
  isr: ssrIsrSectionSchema
    .loose()
    .optional()
    .describe('Incremental static regeneration configuration. Omit to disable ISR.'),
  staticDir: z
    .string()
    .optional()
    .describe(
      'Directory of static assets served alongside SSR routes. Omit to use the renderer or app default.',
    ),
  trustedOrigins: z
    .array(z.string())
    .optional()
    .describe(
      'Additional trusted origins for server action CSRF checks. Omit to trust only the server origin.',
    ),
  serverActionsDir: z
    .string()
    .optional()
    .describe(
      'Absolute path to the directory containing server action modules. Omit to use the SSR default actions directory.',
    ),
  runtime: z
    .union([
      z
        .enum(['bun', 'node', 'edge'])
        .describe(
          'Built-in SSR runtime. Resolved to the corresponding runtime package ' +
            '(@lastshotlabs/slingshot-runtime-bun, slingshot-runtime-node, or slingshot-runtime-edge).',
        ),
      appManifestHandlerRefSchema,
    ])
    .optional()
    .describe(
      'SSR runtime implementation or handler reference. Omit to use the framework default runtime.',
    ),
  draftModeSecret: z
    .string()
    .optional()
    .describe(
      'Secret required to enable or disable draft mode endpoints. Omit to disable draft mode endpoints.',
    ),
});

// -- Pages --
const pageTitleFieldSchema = z.object({
  field: z.string().min(1).describe('Entity field whose value becomes the page title.'),
});

const pageTitleTemplateSchema = z.object({
  template: z
    .string()
    .min(1)
    .describe('Template string used to derive the page title from entity fields.'),
});

const pagePermissionSchema = z.object({
  requires: z.string().min(1).describe('Permission name required to access the page.'),
  scope: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      'Dynamic scope values passed to the permission check. Omit to perform an unscoped permission check.',
    ),
});

const pageDeclarationBaseSchema = z.object({
  path: z.string().startsWith('/').describe('Route path where the page is mounted.'),
  title: z
    .union([z.string(), pageTitleFieldSchema, pageTitleTemplateSchema])
    .describe('Static title or title derivation for the page.'),
  auth: z
    .enum(['none', 'userAuth', 'bearer'])
    .optional()
    .describe(
      'Authentication mode required to access the page. One of: none, userAuth, bearer. Omit to use the renderer default.',
    ),
  permission: pagePermissionSchema
    .optional()
    .describe(
      'Additional permission requirement for the page. Omit to require only the configured auth mode.',
    ),
  cacheControl: z
    .string()
    .optional()
    .describe(
      'Cache-Control header override for the page response. Omit to use the renderer or SSR default.',
    ),
  revalidate: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      'Revalidation interval in seconds for cached page output. Omit to disable page-level revalidation overrides.',
    ),
  tags: z
    .array(z.string())
    .optional()
    .describe(
      'Cache tags associated with the page for selective invalidation. Omit to apply no page-level tags.',
    ),
  layout: z
    .string()
    .optional()
    .describe('Named layout used to render the page. Omit to use the renderer default layout.'),
});

const pageFilterSchema = z.object({
  field: z.string().min(1).describe('Entity field filtered by the UI control.'),
  operator: z
    .enum(['eq', 'contains', 'gt', 'lt', 'gte', 'lte', 'in'])
    .optional()
    .describe(
      'Filter operator used by the UI control. One of: eq, contains, gt, lt, gte, lte, in. Omit to use the page default operator.',
    ),
  label: z
    .string()
    .optional()
    .describe(
      'Human-readable label shown for the filter control. Omit to derive the label from the field name.',
    ),
});

const entityListPageSchema = pageDeclarationBaseSchema.extend({
  type: z.literal('entity-list').describe("Page type discriminator. Must be 'entity-list'."),
  entity: z.string().min(1).describe('Entity displayed by the list page.'),
  fields: z
    .array(z.string().min(1))
    .min(1)
    .describe('Entity fields shown in the list table or collection view.'),
  defaultSort: z
    .object({
      field: z.string().min(1).describe('Field used for the default list sort.'),
      order: z
        .enum(['asc', 'desc'])
        .describe('Sort order for the default list sort. One of: asc, desc.'),
    })
    .optional()
    .describe(
      'Default sort applied when the page first loads. Omit to use the entity or renderer default sort.',
    ),
  searchable: z
    .boolean()
    .optional()
    .describe('Whether the page exposes a search control. Omit to use the renderer default.'),
  pageSize: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Number of records loaded per page. Omit to use the renderer or entity default.'),
  filters: z
    .array(pageFilterSchema)
    .optional()
    .describe(
      'Filters exposed to the user for list narrowing. Omit to render no page-level filters.',
    ),
  actions: z
    .object({
      create: z
        .string()
        .min(1)
        .optional()
        .describe('Page key for the create action target. Omit to hide the create action.'),
      bulkDelete: z
        .boolean()
        .optional()
        .describe(
          'Whether bulk delete is available from the list page. Omit to use the renderer default.',
        ),
    })
    .optional()
    .describe('List-level action configuration. Omit to use the renderer default actions.'),
  rowClick: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Page key opened when a user clicks a row. Omit to leave rows without a click-through target.',
    ),
});

const pageDetailSectionSchema = z.object({
  label: z
    .string()
    .optional()
    .describe(
      'Section label shown on the detail page. Omit to render the section without a label.',
    ),
  fields: z.array(z.string().min(1)).min(1).describe('Entity fields rendered in the section.'),
  layout: z
    .enum(['grid', 'stack'])
    .optional()
    .describe('Section layout style. One of: grid, stack. Omit to use the renderer default.'),
});

const pageRelatedSectionSchema = z.object({
  entity: z.string().min(1).describe('Related entity shown in the section.'),
  label: z
    .string()
    .optional()
    .describe(
      'Section label shown for the related records. Omit to derive the label from the entity name.',
    ),
  foreignKey: z
    .string()
    .min(1)
    .describe('Field on the related entity that points back to the current record.'),
  fields: z
    .array(z.string().min(1))
    .min(1)
    .describe('Related-entity fields rendered in the section.'),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Maximum number of related records shown. Omit to use the renderer default.'),
});

const entityDetailPageSchema = pageDeclarationBaseSchema.extend({
  type: z.literal('entity-detail').describe("Page type discriminator. Must be 'entity-detail'."),
  entity: z.string().min(1).describe('Entity displayed by the detail page.'),
  lookup: z
    .string()
    .min(1)
    .optional()
    .describe('Lookup operation used to load the record. Omit to load by id.'),
  sections: z
    .array(pageDetailSectionSchema)
    .optional()
    .describe(
      'Structured field sections for the detail page. Omit to use the flat fields list instead.',
    ),
  fields: z
    .array(z.string().min(1))
    .optional()
    .describe('Flat list of entity fields shown on the detail page. Omit when sections are used.'),
  related: z
    .array(pageRelatedSectionSchema)
    .optional()
    .describe(
      'Related-entity sections shown below the primary record. Omit to render no related sections.',
    ),
  actions: z
    .object({
      edit: z
        .string()
        .min(1)
        .optional()
        .describe('Page key for the edit action target. Omit to hide the edit action.'),
      delete: z
        .boolean()
        .optional()
        .describe(
          'Whether the detail page exposes a delete action. Omit to use the renderer default.',
        ),
      back: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Page key for the back-navigation target. Omit to let the renderer choose the back destination.',
        ),
    })
    .optional()
    .describe(
      'Action configuration for the detail page. Omit to use the renderer default actions.',
    ),
});

const pageFieldOverrideSchema = z.object({
  label: z
    .string()
    .optional()
    .describe(
      'Field label override shown in the form UI. Omit to derive the label from the field name.',
    ),
  placeholder: z
    .string()
    .optional()
    .describe('Placeholder text shown in the form input. Omit to render no custom placeholder.'),
  helpText: z
    .string()
    .optional()
    .describe('Help text shown alongside the form input. Omit to render no help text.'),
  inputType: z
    .string()
    .optional()
    .describe(
      'Input widget type override used by the renderer. Omit to infer the input type from the field schema.',
    ),
  readOnly: z
    .boolean()
    .optional()
    .describe(
      'Whether the field is read-only in the form UI. Omit to use the renderer default behavior.',
    ),
  defaultValue: z
    .union([z.string(), z.number(), z.boolean()])
    .optional()
    .describe(
      'Default form value used when creating a new record. Omit to leave the field unset by default.',
    ),
});

const entityFormPageSchema = pageDeclarationBaseSchema.extend({
  type: z.literal('entity-form').describe("Page type discriminator. Must be 'entity-form'."),
  entity: z.string().min(1).describe('Entity created or updated by the form page.'),
  operation: z.enum(['create', 'update']).describe('Form operation mode. One of: create, update.'),
  lookup: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Lookup operation used to load an existing record for updates. Omit when the form creates new records.',
    ),
  fields: z.array(z.string().min(1)).min(1).describe('Entity fields shown in the form.'),
  fieldConfig: z
    .record(z.string(), pageFieldOverrideSchema)
    .optional()
    .describe(
      'Per-field UI overrides for the form. Omit to use renderer defaults for every field.',
    ),
  redirect: z
    .object({
      on: z.literal('success').describe("Redirect trigger. Must be 'success'."),
      to: z
        .string()
        .min(1)
        .describe('Page key or path to redirect to after a successful submission.'),
    })
    .optional()
    .describe(
      'Redirect behavior after a successful form submission. Omit to let the renderer keep the user on the form page.',
    ),
  cancel: z
    .object({
      to: z
        .string()
        .min(1)
        .describe('Page key or path to navigate to when the user cancels the form.'),
    })
    .optional()
    .describe(
      'Cancel navigation target for the form. Omit to let the renderer choose the cancel behavior.',
    ),
});

const pageStatSchema = z.object({
  entity: z.string().min(1).describe('Entity queried to compute the dashboard stat.'),
  aggregate: z
    .enum(['count', 'sum', 'avg', 'min', 'max'])
    .describe('Aggregate function used for the stat. One of: count, sum, avg, min, max.'),
  field: z
    .string()
    .min(1)
    .optional()
    .describe('Entity field aggregated by the stat. Omit when aggregate is count.'),
  label: z.string().min(1).describe('Label shown for the dashboard stat.'),
  filter: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'Filter applied before computing the stat. Omit to aggregate over all matching records.',
    ),
  icon: z
    .string()
    .optional()
    .describe('Optional icon name shown with the stat. Omit to render the stat without an icon.'),
});

const pageChartSchema = z.object({
  entity: z.string().min(1).describe('Entity queried to populate the chart.'),
  chartType: z
    .enum(['bar', 'line', 'pie', 'area'])
    .describe('Chart visualization type. One of: bar, line, pie, area.'),
  categoryField: z.string().min(1).describe('Entity field used for chart categories.'),
  valueField: z.string().min(1).describe('Entity field used for chart values.'),
  aggregate: z
    .enum(['count', 'sum', 'avg'])
    .describe('Aggregate function used for chart values. One of: count, sum, avg.'),
  label: z
    .string()
    .optional()
    .describe('Label shown for the chart. Omit to let the renderer derive the chart label.'),
});

const entityDashboardPageSchema = pageDeclarationBaseSchema.extend({
  type: z
    .literal('entity-dashboard')
    .describe("Page type discriminator. Must be 'entity-dashboard'."),
  stats: z.array(pageStatSchema).min(1).describe('Dashboard stat cards rendered on the page.'),
  activity: z
    .object({
      entity: z.string().min(1).describe('Entity queried for the activity feed.'),
      fields: z
        .array(z.string().min(1))
        .min(1)
        .describe('Entity fields shown in each activity item.'),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Maximum number of activity records shown. Omit to use the renderer default.'),
      sortField: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Field used to sort the activity feed. Omit to use the entity or renderer default.',
        ),
    })
    .optional()
    .describe('Recent activity feed configuration. Omit to render no activity feed.'),
  chart: pageChartSchema
    .optional()
    .describe('Chart shown on the dashboard. Omit to render no chart.'),
});

const customPageSchema = pageDeclarationBaseSchema.extend({
  type: z.literal('custom').describe("Page type discriminator. Must be 'custom'."),
  handler: appManifestHandlerRefSchema.describe('Handler reference that renders the custom page.'),
});

const pageDeclarationSchema = z.discriminatedUnion('type', [
  entityListPageSchema,
  entityDetailPageSchema,
  entityFormPageSchema,
  entityDashboardPageSchema,
  customPageSchema,
]);

export const pagesSectionSchema = z
  .record(z.string(), pageDeclarationSchema)
  .optional()
  .describe(
    'Renderer-agnostic page declarations keyed by page name. Omit to define no manifest-driven pages.',
  );

// -- Navigation --
const navigationBadgeSchema = z.union([
  z.string().min(1),
  z.object({
    entity: z.string().min(1).describe('Entity queried to compute the badge count.'),
    aggregate: z.literal('count').describe("Badge aggregation mode. Must be 'count'."),
    filter: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'Filter applied before counting badge records. Omit to count all matching records.',
      ),
  }),
]);

export type NavigationItemInput = {
  label: string;
  path: string;
  icon?: string;
  children?: NavigationItemInput[];
  auth?: 'none' | 'userAuth' | 'bearer';
  permission?: string;
  badge?: string | { entity: string; aggregate: 'count'; filter?: Record<string, unknown> };
};

const navigationItemSchema: z.ZodType<NavigationItemInput> = z.lazy(() =>
  z.object({
    label: z.string().min(1).describe('Label shown for the navigation item.'),
    path: z.string().startsWith('/').describe('Path navigated to when the item is selected.'),
    icon: z
      .string()
      .optional()
      .describe(
        'Icon name shown for the navigation item. Omit to render the item without an icon.',
      ),
    children: z
      .array(navigationItemSchema)
      .optional()
      .describe(
        'Nested navigation items shown under this item. Omit when the item has no children.',
      ),
    auth: z
      .enum(['none', 'userAuth', 'bearer'])
      .optional()
      .describe(
        'Authentication mode required to show or access the item. One of: none, userAuth, bearer. Omit to use the shell default.',
      ),
    permission: z
      .string()
      .optional()
      .describe(
        'Permission required to show or access the item. Omit to require only the configured auth mode.',
      ),
    badge: navigationBadgeSchema
      .optional()
      .describe('Static or computed badge shown next to the item. Omit to render no badge.'),
  }),
);

export const navigationSectionSchema = z.object({
  shell: z
    .enum(['sidebar', 'top-nav', 'none'])
    .describe('Navigation shell style. One of: sidebar, top-nav, none.'),
  title: z
    .string()
    .optional()
    .describe(
      'Application title shown in the navigation shell. Omit to use the renderer default title.',
    ),
  logo: z
    .union([z.string(), appManifestHandlerRefSchema])
    .optional()
    .describe(
      'Static logo asset or handler reference used to render the navigation logo. Omit to render no logo.',
    ),
  items: z.array(navigationItemSchema).describe('Primary navigation items shown in the shell.'),
  userMenu: z
    .array(navigationItemSchema)
    .optional()
    .describe('Navigation items shown in the user menu. Omit to render no user menu items.'),
});
