import type { GeneratedFile, PresetContext } from '../../../types/preset';
import { generateServiceDockerfile } from '../../sharedDockerfile';

const BASE_IMAGE = 'oven/bun:1-alpine';

/**
 * Generate a `Dockerfile.<serviceName>` for EC2/docker-compose deployments.
 *
 * Uses `oven/bun:1-alpine` as the base image (Alpine-based, smaller footprint
 * than the Debian image used by the ECS preset). Delegates to
 * `generateServiceDockerfile()` from `sharedDockerfile.ts`, which wraps each
 * stage in `# --- section:* ---` markers for user override support.
 *
 * @param ctx - The current `PresetContext` with `serviceName`, optional `service`
 *   (for path and port), and `infra` config.
 * @returns A `GeneratedFile` with:
 *   - `path`: `'Dockerfile.<serviceName>'`
 *   - `content`: the Dockerfile text.
 *   - `ephemeral: true`.
 *
 * @remarks
 * For multi-service EC2 infra configs, `createEc2NginxPreset()` calls this
 * function once per service, passing the service name and declaration via the
 * extended context. Only the primary service entry point is supported; sibling
 * services use pre-built images rather than generating Dockerfiles.
 */
export function generateEc2Dockerfile(ctx: PresetContext): GeneratedFile {
  return generateServiceDockerfile({
    serviceName: ctx.serviceName,
    servicePath: ctx.service?.path ?? '.',
    port: ctx.service?.port ?? ctx.infra.port ?? 3000,
    baseImage: BASE_IMAGE,
  });
}
