import type { DomainConfig } from '../types/infra';
import type { StageConfig } from '../types/platform';

/**
 * Resolve a domain for a given stage.
 *
 * Priority:
 * 1. Stage-specific domain from DomainConfig (e.g. `domains.api.stages.prod`).
 * 2. Base domain with stage `domainSuffix` applied (when the stage declares one).
 * 3. Base domain as-is (when no suffix or stage-specific mapping is configured).
 */
export function resolveDomain(
  baseDomain: string,
  stageName: string,
  stage: StageConfig,
  domainConfig?: DomainConfig,
): string {
  // Check stage-specific domain mapping first
  if (domainConfig?.stages[stageName]) {
    return domainConfig.stages[stageName];
  }

  if (stageName === 'prod') {
    return baseDomain;
  }

  // Apply domainSuffix when the stage declares one.
  // Production stages typically omit domainSuffix so the base domain is used as-is.
  if (stage.domainSuffix) {
    // e.g. api.myapp.com + suffix ".dev.myapp.com" -> api.dev.myapp.com
    // Extract subdomain, apply suffix
    const dotIdx = baseDomain.indexOf('.');
    if (dotIdx !== -1) {
      const subdomain = baseDomain.slice(0, dotIdx);
      return `${subdomain}${stage.domainSuffix}`;
    }
    return `${baseDomain}${stage.domainSuffix}`;
  }

  return baseDomain;
}
