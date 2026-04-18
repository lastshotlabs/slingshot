import type { GeneratedFile } from '../types/preset';

/**
 * Generate a single `Dockerfile.<serviceName>` for a Bun service.
 *
 * Both ECS and EC2 presets use this shared template. The only difference
 * between presets is the `baseImage` argument (Debian vs Alpine Bun image).
 *
 * The generated Dockerfile has four stages, each wrapped in section markers
 * for user override support:
 * - `# --- section:base ---` — `FROM <baseImage>` + `WORKDIR /app`.
 * - `# --- section:install ---` — copies `package.json`, `bun.lock*`, and
 *   `packages/`, then runs `bun install --frozen-lockfile --production`.
 * - `# --- section:build ---` — copies the full repository context.
 * - `# --- section:run ---` — exposes the port, sets `ENV PORT`, and sets
 *   the `CMD` to `bun run <entryPoint>`.
 *
 * The entry point is `src/index.ts` for root services (`servicePath === '.'`)
 * and `<servicePath>/index.ts` for sub-package services.
 *
 * @param opts.serviceName - Service name used as the Dockerfile file suffix
 *   (e.g. `'api'` → `'Dockerfile.api'`).
 * @param opts.servicePath - Relative path to the service within the monorepo.
 *   Use `'.'` for the root service.
 * @param opts.port - Port the service listens on; injected as `EXPOSE` and `ENV PORT`.
 * @param opts.baseImage - Docker base image string (e.g. `'oven/bun:1-alpine'`).
 * @returns A `GeneratedFile` with:
 *   - `path`: `'Dockerfile.<serviceName>'`
 *   - `content`: the Dockerfile text with section markers.
 *   - `ephemeral: true`.
 */
export function generateServiceDockerfile(opts: {
  serviceName: string;
  servicePath: string;
  port: number;
  baseImage: string;
}): GeneratedFile {
  const { serviceName, servicePath, port, baseImage } = opts;
  const entryPoint = servicePath === '.' ? 'src/index.ts' : `${servicePath}/index.ts`;

  const content = `# --- section:base ---
FROM ${baseImage}
WORKDIR /app
# --- end:base ---

# --- section:install ---
COPY package.json bun.lock* ./
${servicePath !== '.' ? `COPY ${servicePath}/package.json ./${servicePath}/` : ''}
COPY packages/ ./packages/
RUN bun install --frozen-lockfile --production
# --- end:install ---

# --- section:build ---
COPY . .
# --- end:build ---

# --- section:run ---
EXPOSE ${port}
ENV PORT=${port}
CMD ["bun", "run", "${entryPoint}"]
# --- end:run ---
`;

  return {
    path: `Dockerfile.${serviceName}`,
    content,
    ephemeral: true,
  };
}
