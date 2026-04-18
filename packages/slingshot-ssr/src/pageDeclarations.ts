import type { FieldType, ResolvedEntityConfig } from '@lastshotlabs/slingshot-core';

/**
 * Serializable handler reference used in manifest-backed page declarations.
 *
 * This mirrors the root manifest handler-ref shape without introducing a runtime
 * dependency from `slingshot-ssr` back to the root package.
 */
export interface SerializableHandlerRef {
  /** Registered handler name. */
  readonly handler: string;
  /** Optional serializable handler params. */
  readonly params?: Readonly<Record<string, unknown>>;
}

/**
 * Field-reference page title.
 */
export interface PageTitleField {
  /** Entity field whose value becomes the page title. */
  readonly field: string;
}

/**
 * Template-based page title.
 */
export interface PageTitleTemplate {
  /** String template with `{field}` placeholders. */
  readonly template: string;
}

/**
 * Permission requirement declared directly on a page.
 */
export interface PagePermissionConfig {
  /** Required permission action. */
  readonly requires: string;
  /** Optional scope values resolved from route params and literals. */
  readonly scope?: Readonly<Record<string, string>>;
}

/**
 * Base fields shared by all page declarations.
 */
export interface PageDeclarationBase {
  /** URL path pattern. Supports `[param]` and `[...rest]` segments. */
  readonly path: string;
  /** Static, field-based, or template-based page title. */
  readonly title: string | PageTitleField | PageTitleTemplate;
  /** Auth requirement for this page. */
  readonly auth?: 'none' | 'userAuth' | 'bearer';
  /** Permission requirement for this page. */
  readonly permission?: PagePermissionConfig;
  /** Optional Cache-Control header override. */
  readonly cacheControl?: string;
  /** ISR revalidation interval in seconds. */
  readonly revalidate?: number;
  /** Explicit ISR tags, with `{param}` interpolation support. */
  readonly tags?: readonly string[];
  /** Optional layout key for renderer-specific grouping. */
  readonly layout?: string;
}

/**
 * Filter control declaration for entity-list pages.
 */
export interface PageFilterConfig {
  /** Entity field to filter on. */
  readonly field: string;
  /** Filter operator. */
  readonly operator?: 'eq' | 'contains' | 'gt' | 'lt' | 'gte' | 'lte' | 'in';
  /** Optional display label override. */
  readonly label?: string;
}

/**
 * Paginated list/table of entity records.
 */
export interface EntityListPageDeclaration extends PageDeclarationBase {
  readonly type: 'entity-list';
  /** Entity name. */
  readonly entity: string;
  /** Fields displayed as columns. */
  readonly fields: readonly string[];
  /** Optional default sort. */
  readonly defaultSort?: {
    readonly field: string;
    readonly order: 'asc' | 'desc';
  };
  /** Whether free-text search is enabled. */
  readonly searchable?: boolean;
  /** Page size for SSR pagination. */
  readonly pageSize?: number;
  /** Declared filter controls. */
  readonly filters?: readonly PageFilterConfig[];
  /** Available list actions. */
  readonly actions?: {
    readonly create?: string;
    readonly bulkDelete?: boolean;
  };
  /** Target page key to navigate to on row click. */
  readonly rowClick?: string;
}

/**
 * Section declaration for detail pages.
 */
export interface PageDetailSection {
  /** Optional section heading. */
  readonly label?: string;
  /** Fields displayed in this section. */
  readonly fields: readonly string[];
  /** Layout hint for the renderer. */
  readonly layout?: 'grid' | 'stack';
}

/**
 * Related-entity section on a detail page.
 */
export interface PageRelatedSection {
  /** Related entity name. */
  readonly entity: string;
  /** Optional section label. */
  readonly label?: string;
  /** Foreign-key field on the related entity. */
  readonly foreignKey: string;
  /** Fields displayed from the related records. */
  readonly fields: readonly string[];
  /** Maximum related records to show. */
  readonly limit?: number;
}

/**
 * Single-record page resolved by primary key or lookup operation.
 */
export interface EntityDetailPageDeclaration extends PageDeclarationBase {
  readonly type: 'entity-detail';
  /** Entity name. */
  readonly entity: string;
  /** Optional lookup operation name. */
  readonly lookup?: string;
  /** Sectioned field layout. */
  readonly sections?: readonly PageDetailSection[];
  /** Flat shorthand field list. */
  readonly fields?: readonly string[];
  /** Related-record sections. */
  readonly related?: readonly PageRelatedSection[];
  /** Available page actions. */
  readonly actions?: {
    readonly edit?: string;
    readonly delete?: boolean;
    readonly back?: string;
  };
}

/**
 * Per-field form override.
 */
export interface PageFieldOverride {
  /** Label override. */
  readonly label?: string;
  /** Placeholder text. */
  readonly placeholder?: string;
  /** Help text. */
  readonly helpText?: string;
  /** Input type override. */
  readonly inputType?: string;
  /** Whether the field is read-only. */
  readonly readOnly?: boolean;
  /** Default value override for create forms. */
  readonly defaultValue?: string | number | boolean;
}

/**
 * Create or edit form bound to an entity.
 */
export interface EntityFormPageDeclaration extends PageDeclarationBase {
  readonly type: 'entity-form';
  /** Entity name. */
  readonly entity: string;
  /** Whether this page creates or updates a record. */
  readonly operation: 'create' | 'update';
  /** Lookup operation used to resolve the record for update forms. */
  readonly lookup?: string;
  /** Fields included in the form. */
  readonly fields: readonly string[];
  /** Per-field renderer overrides. */
  readonly fieldConfig?: Readonly<Record<string, PageFieldOverride>>;
  /** Post-submit redirect configuration. */
  readonly redirect?: {
    readonly on: 'success';
    readonly to: string;
  };
  /** Cancel navigation target. */
  readonly cancel?: {
    readonly to: string;
  };
}

/**
 * Dashboard stat-card declaration.
 */
export interface PageStatConfig {
  /** Entity to aggregate. */
  readonly entity: string;
  /** Aggregate function. */
  readonly aggregate: 'count' | 'sum' | 'avg' | 'min' | 'max';
  /** Optional field for non-count aggregates. */
  readonly field?: string;
  /** Display label. */
  readonly label: string;
  /** Optional aggregate filter. */
  readonly filter?: Readonly<Record<string, unknown>>;
  /** Optional opaque icon name. */
  readonly icon?: string;
}

/**
 * Dashboard chart declaration.
 */
export interface PageChartConfig {
  /** Entity to chart. */
  readonly entity: string;
  /** Renderer chart type. */
  readonly chartType: 'bar' | 'line' | 'pie' | 'area';
  /** Group/category field. */
  readonly categoryField: string;
  /** Value field. */
  readonly valueField: string;
  /** Aggregate function for the value field. */
  readonly aggregate: 'count' | 'sum' | 'avg';
  /** Optional chart label. */
  readonly label?: string;
}

/**
 * Aggregate/stats dashboard page.
 */
export interface EntityDashboardPageDeclaration extends PageDeclarationBase {
  readonly type: 'entity-dashboard';
  /** Stats shown at the top of the page. */
  readonly stats: readonly PageStatConfig[];
  /** Optional recent-activity feed. */
  readonly activity?: {
    readonly entity: string;
    readonly fields: readonly string[];
    readonly limit?: number;
    readonly sortField?: string;
  };
  /** Optional aggregate chart. */
  readonly chart?: PageChartConfig;
}

/**
 * Escape hatch for renderer-specific custom page rendering.
 */
export interface CustomPageDeclaration extends PageDeclarationBase {
  readonly type: 'custom';
  /** Handler ref to the route module or component provider. */
  readonly handler: SerializableHandlerRef;
}

/**
 * Discriminated union of all supported manifest page declarations.
 */
export type PageDeclaration =
  | EntityListPageDeclaration
  | EntityDetailPageDeclaration
  | EntityFormPageDeclaration
  | EntityDashboardPageDeclaration
  | CustomPageDeclaration;

/**
 * Navigation badge declaration.
 */
export interface NavigationBadgeConfig {
  /** Entity to count. */
  readonly entity: string;
  /** Supported aggregate. */
  readonly aggregate: 'count';
  /** Optional count filter. */
  readonly filter?: Readonly<Record<string, unknown>>;
}

/**
 * Single navigation item in the app shell.
 */
export interface NavigationItem {
  /** Display label. */
  readonly label: string;
  /** Destination path. */
  readonly path: string;
  /** Optional opaque icon name. */
  readonly icon?: string;
  /** Optional nested items. */
  readonly children?: readonly NavigationItem[];
  /** Optional auth visibility requirement. */
  readonly auth?: 'none' | 'userAuth' | 'bearer';
  /** Optional permission visibility requirement. */
  readonly permission?: string;
  /** Optional badge declaration. */
  readonly badge?: string | NavigationBadgeConfig;
}

/**
 * Renderer-agnostic shell/navigation configuration.
 */
export interface NavigationConfig {
  /** Shell layout type. */
  readonly shell: 'sidebar' | 'top-nav' | 'none';
  /** Optional app title. */
  readonly title?: string;
  /** Optional logo reference. */
  readonly logo?: string | SerializableHandlerRef;
  /** Primary navigation items. */
  readonly items: readonly NavigationItem[];
  /** Optional user-menu items. */
  readonly userMenu?: readonly NavigationItem[];
}

/**
 * Entity field metadata passed to renderers.
 */
export interface EntityFieldMeta {
  /** Field name. */
  readonly name: string;
  /** Field type token. */
  readonly type: FieldType;
  /** Whether the field is optional. */
  readonly optional: boolean;
  /** Whether the field is the primary key. */
  readonly primary: boolean;
  /** Whether the field is immutable. */
  readonly immutable: boolean;
  /** Enum values when the field type is `enum`. */
  readonly enumValues?: readonly string[];
}

/**
 * Entity metadata passed to renderers alongside loaded page data.
 */
export interface EntityMeta {
  /** Entity name. */
  readonly name: string;
  /** Optional namespace. */
  readonly namespace?: string;
  /** Field metadata keyed by field name. */
  readonly fields: Readonly<Record<string, EntityFieldMeta>>;
  /** Soft-delete configuration, when present. */
  readonly softDelete?: { readonly field: string };
}

/**
 * Result shape returned by page loaders.
 */
export type PageData =
  | {
      readonly type: 'list';
      readonly items: readonly Record<string, unknown>[];
      readonly total: number;
      readonly page: number;
      readonly pageSize: number;
    }
  | { readonly type: 'detail'; readonly item: Readonly<Record<string, unknown>> }
  | { readonly type: 'form-create'; readonly defaults: Readonly<Record<string, unknown>> }
  | { readonly type: 'form-edit'; readonly item: Readonly<Record<string, unknown>> }
  | {
      readonly type: 'dashboard';
      readonly stats: readonly { readonly label: string; readonly value: number }[];
      readonly activity?: readonly Record<string, unknown>[];
      readonly chart?: readonly Record<string, unknown>[];
    }
  | { readonly type: 'custom' };

/**
 * A page declaration after route-table compilation and entity resolution.
 */
export interface ResolvedPageDeclaration<T extends PageDeclaration = PageDeclaration> {
  /** Page key from the manifest. */
  readonly key: string;
  /** Frozen declaration payload. */
  readonly declaration: Readonly<T>;
  /** Resolved entity config, when the page is entity-bound. */
  readonly entityConfig: Readonly<ResolvedEntityConfig> | null;
  /** Compiled route-matching regex. */
  readonly pattern: RegExp;
  /** Param names extracted from `path`. */
  readonly paramNames: readonly string[];
}
