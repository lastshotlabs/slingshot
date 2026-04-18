import type { GeneratedFile, PresetContext } from '../../../types/preset';
import { generateServiceDockerfile } from '../../sharedDockerfile';

const BASE_IMAGE = 'oven/bun:1';

/**
 * Generate one `Dockerfile.<serviceName>` per service declared in the infra config.
 *
 * Uses `oven/bun:1` as the base image (full Debian-based Bun image, suitable for
 * ECS tasks that may require system libraries). For multi-service infra configs,
 * only services whose `stacks` list includes the current `ctx.stackName` are
 * included. For single-service configs, a single Dockerfile is generated using
 * `ctx.serviceName`.
 *
 * @param ctx - The current `PresetContext` containing infra config, service map, and stack name.
 * @returns An array of `GeneratedFile` objects, one per included service.
 *   Each file has `path: 'Dockerfile.<serviceName>'` and `ephemeral: true`.
 *
 * @remarks
 * Delegates to `generateServiceDockerfile()` from `sharedDockerfile.ts`, which
 * adds `# --- section:* ---` markers for per-section user overrides.
 */
export function generateDockerfiles(ctx: PresetContext): GeneratedFile[] {
  if (ctx.infra.services) {
    return Object.entries(ctx.infra.services)
      .filter(([, svc]) => {
        const stacks = svc.stacks ?? ctx.infra.stacks ?? [];
        return stacks.includes(ctx.stackName);
      })
      .map(([name, service]) =>
        generateServiceDockerfile({
          serviceName: name,
          servicePath: service.path,
          port: service.port ?? ctx.infra.port ?? 3000,
          baseImage: BASE_IMAGE,
        }),
      );
  }

  return [
    generateServiceDockerfile({
      serviceName: ctx.serviceName,
      servicePath: ctx.service?.path ?? '.',
      port: ctx.service?.port ?? ctx.infra.port ?? 3000,
      baseImage: BASE_IMAGE,
    }),
  ];
}
