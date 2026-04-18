export interface TenantConfig {
  [key: string]: unknown;
}

export interface TenancyConfig {
  /** How tenant is identified. */
  resolution: 'header' | 'subdomain' | 'path';
  /** Header name when resolution is "header". Default: "x-tenant-id". */
  headerName?: string;
  /** Path segment index when resolution is "path". Default: 0. */
  pathSegment?: number;
  /** Optional tenant discovery endpoint for frontend tenant pickers. */
  listEndpoint?: string;
  /** Callback to validate/load tenant. Return null to reject. */
  onResolve?: (tenantId: string) => Promise<TenantConfig | null>;
  /** TTL in ms for caching onResolve results (LRU cache). Default: 60_000. Set 0 to disable. */
  cacheTtlMs?: number;
  /** Max entries in tenant resolution cache. Default: 500. */
  cacheMaxSize?: number;
  /** Paths that skip tenant resolution. Uses startsWith matching. Default: ["/health", "/docs", "/openapi.json"]. */
  exemptPaths?: string[];
  /** HTTP status when onResolve returns null. Default: 403. */
  rejectionStatus?: 403 | 404;
}
