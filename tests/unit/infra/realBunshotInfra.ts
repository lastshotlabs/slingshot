/**
 * Re-exports the real (non-mocked) implementations from slingshot-infra source files.
 *
 * Used by CLI command test files that need to mock @lastshotlabs/slingshot-infra for their
 * own command-under-test while still providing real implementations for all other functions
 * so that source-level unit tests in the same bun test run are not polluted.
 *
 * Import this with a direct path inside mock.module factories:
 *   const real = await import('./realBunshotInfra');
 *   mock.module('@lastshotlabs/slingshot-infra', async () => ({
 *     ...real,
 *     specificFn: mockFn,  // override only what this test file needs
 *   }));
 */

// Config factories
export { definePlatform } from '../../../packages/slingshot-infra/src/config/platformSchema';
export { defineInfra } from '../../../packages/slingshot-infra/src/config/infraSchema';
export { resolvePlatformConfig } from '../../../packages/slingshot-infra/src/config/resolvePlatformConfig';

// App config analysis
export {
  deriveUsesFromAppConfig,
  compareInfraResources,
} from '../../../packages/slingshot-infra/src/config/deriveUsesFromApp';

// WebSocket scaling diagnostics
export { auditWebsocketScaling } from '../../../packages/slingshot-infra/src/config/websocketScalingAudit';

// Scaffold templates
export { generatePlatformTemplate } from '../../../packages/slingshot-infra/src/scaffold/platformTemplate';
export { generateInfraTemplate } from '../../../packages/slingshot-infra/src/scaffold/infraTemplate';

// Config loaders
export { loadPlatformConfig } from '../../../packages/slingshot-infra/src/loader/loadPlatformConfig';
export { loadInfraConfig } from '../../../packages/slingshot-infra/src/loader/loadInfraConfig';

// Registry factories
export { createS3Registry } from '../../../packages/slingshot-infra/src/registry/s3Registry';
export { createLocalRegistry } from '../../../packages/slingshot-infra/src/registry/localRegistry';
export { createRegistryFromConfig } from '../../../packages/slingshot-infra/src/registry/createRegistryFromConfig';
export { parseRegistryUrl } from '../../../packages/slingshot-infra/src/registry/parseRegistryUrl';

// App registry
export {
  registerApp,
  listApps,
  getAppsByStack,
  getAppsByResource,
  deregisterApp,
} from '../../../packages/slingshot-infra/src/registry/appRegistry';

// Preset factories
export { createEcsPreset } from '../../../packages/slingshot-infra/src/preset/ecs/ecsPreset';
export { createEc2NginxPreset } from '../../../packages/slingshot-infra/src/preset/ec2-nginx/ec2NginxPreset';
export { createPresetRegistry } from '../../../packages/slingshot-infra/src/preset/presetRegistry';

// Resource provisioners
export { createProvisionerRegistry } from '../../../packages/slingshot-infra/src/resource/provisionerRegistry';
export { createPostgresProvisioner } from '../../../packages/slingshot-infra/src/resource/provisioners/postgres';
export { createRedisProvisioner } from '../../../packages/slingshot-infra/src/resource/provisioners/redis';
export { createKafkaProvisioner } from '../../../packages/slingshot-infra/src/resource/provisioners/kafka';
export { createMongoProvisioner } from '../../../packages/slingshot-infra/src/resource/provisioners/mongo';
export { createDocumentDbProvisioner } from '../../../packages/slingshot-infra/src/resource/provisioners/documentdb';

// Resource destroy pipeline
export { destroyResources } from '../../../packages/slingshot-infra/src/resource/destroyResources';

// SST resource provisioning
export {
  provisionViaSst,
  destroyViaSst,
} from '../../../packages/slingshot-infra/src/resource/provisionViaSst';
export { generateResourceSstConfig } from '../../../packages/slingshot-infra/src/resource/generateResourceSst';

// DNS
export { createCloudflareClient } from '../../../packages/slingshot-infra/src/dns/cloudflare';
export { createDnsManager } from '../../../packages/slingshot-infra/src/dns/manager';

// Deploy pipeline
export { runDeployPipeline } from '../../../packages/slingshot-infra/src/deploy/pipeline';
export { resolveEnvironment } from '../../../packages/slingshot-infra/src/deploy/resolveEnv';
export { computeDeployPlan } from '../../../packages/slingshot-infra/src/deploy/plan';
export { formatDeployPlan } from '../../../packages/slingshot-infra/src/deploy/formatPlan';

// Rollback
export { runRollback } from '../../../packages/slingshot-infra/src/deploy/rollback';

// Secrets
export { createSecretsManager } from '../../../packages/slingshot-infra/src/secrets/secretsManager';
export { resolveRequiredKeys } from '../../../packages/slingshot-infra/src/secrets/resolveRequiredKeys';

// Override resolution
export {
  resolveOverride,
  deepMerge,
} from '../../../packages/slingshot-infra/src/override/resolveOverrides';

// Values from types
export { SIZE_PRESETS } from '../../../packages/slingshot-infra/src/types/infra';
export { getServiceEnv } from '../../../packages/slingshot-infra/src/types/preset';
export { RESOURCE_ENV_KEYS } from '../../../packages/slingshot-infra/src/types/resource';
export { createEmptyRegistryDocument } from '../../../packages/slingshot-infra/src/types/registry';
