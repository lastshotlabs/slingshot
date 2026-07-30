export interface TenantConfig {
  [key: string]: unknown;
}

interface MultiTenancyOptions {
  /** Header name when resolution is "header". Default: "x-tenant-id". */
  readonly headerName?: string;
  /** Path segment index when resolution is "path". Default: 0. */
  readonly pathSegment?: number;
  readonly listEndpoint?: string;
  readonly cacheTtlMs?: number;
  readonly cacheMaxSize?: number;
  readonly exemptPaths?: string[];
  readonly rejectionStatus?: 403 | 404;
}

export type AppTenancyConfig =
  | {
      readonly mode: 'single';
      readonly tenantId: string;
    }
  | (MultiTenancyOptions & {
      readonly mode: 'multi';
      readonly resolution: 'header' | 'subdomain' | 'path';
      readonly onResolve: (tenantId: string) => Promise<TenantConfig | null>;
    });

/**
 * Legacy development-only multi-tenant shape. Production bootstrap rejects it;
 * use an explicit `mode` in new applications.
 */
export type LegacyTenancyConfig = MultiTenancyOptions & {
  readonly mode?: undefined;
  readonly resolution: 'header' | 'subdomain' | 'path';
  readonly onResolve?: (tenantId: string) => Promise<TenantConfig | null>;
};

export type TenancyConfig = AppTenancyConfig | LegacyTenancyConfig;
