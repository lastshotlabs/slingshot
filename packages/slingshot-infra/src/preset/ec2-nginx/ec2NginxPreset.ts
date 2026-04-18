import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  DeployResult,
  GeneratedFile,
  PresetContext,
  PresetProvider,
  ProvisionResult,
} from '../../types/preset';
import { resolveDomain } from '../resolveDomain';
import { generateFluentdConfig } from '../shared/generateFluentdConfig';
import { generateCaddyfile } from './generators/caddy';
import { generateDockerCompose } from './generators/dockerCompose';
import { generateEc2Dockerfile } from './generators/dockerfile';
import { generateEc2GhaWorkflow } from './generators/gha';
import { generateNginxConfig } from './generators/nginx';

/**
 * Configuration options for the EC2/nginx (or Caddy) preset.
 */
export interface Ec2NginxPresetConfig {
  /**
   * Reverse proxy to use in front of the app container.
   * `'caddy'` auto-provisions TLS via Let's Encrypt; `'nginx'` requires
   * manual certbot or pre-existing certs. Default: `'caddy'`.
   */
  proxy?: 'caddy' | 'nginx';
  /** SSH user for the remote EC2 instance. Default: `'ubuntu'`. */
  sshUser?: string;
  /** SSL configuration for nginx. Ignored when proxy is 'caddy' (caddy auto-provisions). */
  ssl?: {
    /** Path to SSL certificate on the server. Default: '/etc/letsencrypt/live/{domain}/fullchain.pem' */
    certPath?: string;
    /** Path to SSL private key on the server. Default: '/etc/letsencrypt/live/{domain}/privkey.pem' */
    keyPath?: string;
    /** Enable automatic certbot provisioning via docker. Default: true */
    certbot?: boolean;
    /** Email for Let's Encrypt registration */
    email?: string;
  };
}

/**
 * Create an EC2/nginx (or Caddy) preset provider.
 *
 * Generates Dockerfiles, a docker-compose file, a reverse-proxy config
 * (Caddyfile or nginx.conf), and a GitHub Actions workflow. Deploy copies
 * files to the remote EC2 host via `scp`, then runs `docker compose pull && up`
 * over SSH. Local commands use `spawnSync` with array args. SSH commands pass a
 * single command string to the remote shell; all user-controlled values
 * (service names, email, domain) are shell-quoted via `shellQuote` to prevent
 * injection.
 *
 * @param config - Optional EC2/nginx preset configuration.
 * @returns A `PresetProvider` with name `'ec2-nginx'`.
 *
 * @remarks
 * **Deploy strategy limitation:** The EC2 preset only supports the `rolling`
 * deployment strategy. Blue/green and canary deployments require the ECS preset
 * because they depend on AWS CodeDeploy and weighted target group routing which
 * are not available in a standalone EC2 + docker-compose setup.
 *
 * The deploy host is resolved from (in order): stage registry outputs
 * `publicIp`, stack `_meta` stage outputs `publicIp`, or the env var
 * `DEPLOY_HOST_<STAGE>`.
 *
 * @throws {Error} If no deploy host can be resolved for the target stack/stage.
 *
 * @example
 * ```ts
 * import { createEc2NginxPreset } from '@lastshotlabs/slingshot-infra';
 *
 * const preset = createEc2NginxPreset({ proxy: 'caddy', sshUser: 'ubuntu' });
 * ```
 */
export function createEc2NginxPreset(config?: Ec2NginxPresetConfig): PresetProvider {
  const sshUser = config?.sshUser ?? 'ubuntu';
  const proxyType = config?.proxy ?? 'caddy';
  const sslConfig = config?.ssl;
  const certbotEnabled = proxyType === 'nginx' && sslConfig?.certbot !== false;

  return {
    name: 'ec2-nginx',

    generate(ctx: PresetContext): GeneratedFile[] {
      const files: GeneratedFile[] = [];

      if (ctx.infra.services) {
        for (const [name, service] of Object.entries(ctx.infra.services)) {
          const stacks = service.stacks ?? ctx.infra.stacks ?? [];
          if (!stacks.includes(ctx.stackName)) continue;
          files.push(generateEc2Dockerfile({ ...ctx, serviceName: name, service }));
        }
      } else {
        files.push(generateEc2Dockerfile(ctx));
      }

      if (proxyType === 'nginx') {
        files.push(generateDockerCompose(ctx, { nginx: true, certbot: certbotEnabled }));
        files.push(generateNginxConfig(ctx, sslConfig));
      } else {
        files.push(generateDockerCompose(ctx));
        files.push(generateCaddyfile(ctx));
      }
      files.push(generateEc2GhaWorkflow(ctx));

      if (ctx.infra.logging?.driver === 'fluentd') {
        files.push(generateFluentdConfig(ctx.infra.logging.fluentd, ctx.serviceName));
      }

      return files;
    },

    async deploy(ctx: PresetContext, files: GeneratedFile[]): Promise<DeployResult> {
      const { spawnSync } = await import('node:child_process');

      // Resolve host: stage-specific > _meta (from `stacks create --host`) > env var
      const stackData = Object.prototype.hasOwnProperty.call(ctx.registry.stacks, ctx.stackName)
        ? ctx.registry.stacks[ctx.stackName]
        : undefined;
      const stageData =
        stackData && Object.prototype.hasOwnProperty.call(stackData.stages, ctx.stageName)
          ? stackData.stages[ctx.stageName]
          : undefined;
      const metaData =
        stackData && Object.prototype.hasOwnProperty.call(stackData.stages, '_meta')
          ? stackData.stages._meta
          : undefined;
      const host =
        stageData?.outputs.publicIp ??
        metaData?.outputs.publicIp ??
        process.env[`DEPLOY_HOST_${ctx.stageName.toUpperCase()}`];

      if (!host) {
        return {
          success: false,
          error:
            `No deploy host found for stack "${ctx.stackName}" stage "${ctx.stageName}". ` +
            'Register a host with `slingshot stacks create --host <ip>`.',
        };
      }

      const sshTarget = `${sshUser}@${host}`;
      const sshOpts = ['-o', 'StrictHostKeyChecking=no'];
      const deployDir = ctx.tempDir ?? ctx.appRoot;

      try {
        // Build and push images — use spawnSync with array args to avoid shell injection
        const dockerfiles = files.filter(f => f.path.startsWith('Dockerfile'));

        for (const df of dockerfiles) {
          const svcName = df.path.replace('Dockerfile.', '');
          const imageUri = `${ctx.dockerRegistry}/${svcName}:${ctx.imageTag}`;
          const latestUri = `${ctx.dockerRegistry}/${svcName}:latest`;

          run(spawnSync, 'docker', [
            'build',
            '-f',
            join(deployDir, df.path),
            '-t',
            imageUri,
            '-t',
            latestUri,
            ctx.appRoot,
          ]);
          run(spawnSync, 'docker', ['push', imageUri]);
          run(spawnSync, 'docker', ['push', latestUri]);
        }

        // Upload config files via scp — write to temp then copy.
        // This avoids piping content through shell interpolation.
        const composeFile = files.find(f => f.path === 'docker-compose.yml');
        const caddyFile = files.find(f => f.path === 'Caddyfile');

        if (composeFile) {
          const localPath = join(deployDir, 'docker-compose.yml');
          writeFileSync(localPath, composeFile.content, 'utf-8');
          run(spawnSync, 'scp', [
            ...sshOpts,
            localPath,
            `${sshTarget}:/opt/apps/docker-compose.yml`,
          ]);
        }

        if (caddyFile) {
          const localPath = join(deployDir, 'Caddyfile');
          writeFileSync(localPath, caddyFile.content, 'utf-8');
          run(spawnSync, 'scp', [...sshOpts, localPath, `${sshTarget}:/opt/apps/Caddyfile`]);
        }

        const nginxFile = files.find(f => f.path === 'nginx.conf');
        if (nginxFile) {
          const localPath = join(deployDir, 'nginx.conf');
          writeFileSync(localPath, nginxFile.content, 'utf-8');
          run(spawnSync, 'scp', [...sshOpts, localPath, `${sshTarget}:/opt/apps/nginx.conf`]);
        }

        // Pull and restart services on remote host
        const serviceNames = ctx.infra.services
          ? Object.keys(ctx.infra.services)
          : [ctx.serviceName];

        run(spawnSync, 'ssh', [
          ...sshOpts,
          sshTarget,
          `cd /opt/apps && docker compose pull ${serviceNames.map(shellQuote).join(' ')} && docker compose up -d --no-deps ${serviceNames.map(shellQuote).join(' ')}`,
        ]);

        // Initial certbot cert provisioning (only when certbot is enabled)
        if (certbotEnabled && sslConfig?.email) {
          const domains = collectDomains(ctx);
          for (const domain of domains) {
            run(spawnSync, 'ssh', [
              ...sshOpts,
              sshTarget,
              `cd /opt/apps && docker compose run --rm certbot certonly --webroot --webroot-path=/var/www/certbot --email ${shellQuote(sslConfig.email)} --agree-tos --no-eff-email -d ${shellQuote(domain)}`,
            ]);
          }
          // Reload nginx to pick up new certs
          if (domains.length > 0) {
            run(spawnSync, 'ssh', [
              ...sshOpts,
              sshTarget,
              'cd /opt/apps && docker compose exec nginx nginx -s reload',
            ]);
          }
        }

        const baseDomain = ctx.service?.domain ?? ctx.infra.domain;
        const domainConfig = ctx.service
          ? (ctx.service.domains?.[ctx.serviceName] ?? ctx.infra.domains?.[ctx.serviceName])
          : ctx.infra.domains?.[ctx.serviceName];
        const serviceUrl = baseDomain
          ? resolveDomain(baseDomain, ctx.stageName, ctx.stage, domainConfig)
          : undefined;

        return { success: true, serviceUrl };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },

    provisionStack(): Promise<ProvisionResult> {
      return Promise.resolve({
        success: false,
        outputs: {},
        error:
          'EC2 provisioning via CLI not yet implemented. ' +
          'Create your instance manually and register it with `slingshot stacks create --host`.',
      });
    },

    destroyStack(): Promise<void> {
      return Promise.reject(
        new Error('EC2 destruction via CLI not yet implemented. Terminate the instance manually.'),
      );
    },

    defaultLogging() {
      return { driver: 'local', retentionDays: 14 };
    },
  };
}

/**
 * Collect all SSL-enabled domains from the preset context for certbot provisioning.
 *
 * When the infra config declares multiple services, iterates over each service
 * that belongs to the current stack and has a non-empty `domain` field. Services
 * whose `DomainConfig.ssl` is explicitly `false` are excluded. For a single-service
 * infra (no `services` map), includes the top-level domain if configured and SSL
 * is not explicitly disabled.
 *
 * @param ctx - The current `PresetContext` providing infra config, stack name, and stage.
 * @returns An array of fully-resolved domain strings that require TLS certificates.
 *
 * @remarks
 * The returned domains are passed directly to `certbot certonly` on the remote
 * host. Each domain must already resolve to the server's public IP for ACME
 * HTTP-01 validation to succeed.
 */
function collectDomains(ctx: PresetContext): string[] {
  const infra = ctx.infra;
  const domains: string[] = [];

  if (infra.services) {
    for (const [name, svc] of Object.entries(infra.services)) {
      const stacks = svc.stacks ?? infra.stacks ?? [];
      if (!stacks.includes(ctx.stackName)) continue;
      if (!svc.domain) continue;
      const domainConfig = svc.domains?.[name] ?? infra.domains?.[name];
      if (domainConfig?.ssl === false) continue;
      domains.push(resolveDomain(svc.domain, ctx.stageName, ctx.stage, domainConfig));
    }
  } else if (infra.domain) {
    const domainConfig = infra.domains?.[ctx.serviceName];
    if (domainConfig?.ssl !== false) {
      domains.push(resolveDomain(infra.domain, ctx.stageName, ctx.stage, domainConfig));
    }
  }

  return domains;
}

/**
 * Shell-quote a single string value for safe embedding in an SSH command.
 *
 * Wraps the value in single quotes and escapes any embedded single quotes using
 * the `'\''` pattern (end quote, literal single quote, re-open quote). This is
 * the canonical POSIX shell single-quote escaping technique.
 *
 * @param s - The raw string to quote (e.g. a service name, domain, or email address).
 * @returns The single-quoted string safe for inclusion in a shell command argument.
 *
 * @example
 * ```ts
 * shellQuote("my-service")         // "'my-service'"
 * shellQuote("it's a test")        // "'it'\\''s a test'"
 * ```
 *
 * @remarks
 * This is only used for the SSH command string passed to `spawnSync` where the
 * remote shell must interpret the argument. For local commands that use array
 * args, quoting is unnecessary and must not be applied.
 */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Execute a command synchronously via `spawnSync` with array arguments.
 *
 * Passes `stdio: 'inherit'` so the child process output streams directly to the
 * parent terminal. Throws if the process exits with a non-zero status code.
 *
 * @param spawnSync - The `spawnSync` function from `node:child_process` (passed in
 *   explicitly so the deploy method can obtain it via a dynamic import).
 * @param cmd - The executable to run (e.g. `'docker'`, `'scp'`, `'ssh'`).
 * @param args - Array of arguments passed to the executable. Never interpolated
 *   through a shell — no escaping required.
 *
 * @throws {Error} If the process exits with a non-zero status code, with the exit
 *   code and reconstructed command string in the message.
 *
 * @remarks
 * Using array args instead of a shell command string prevents shell injection when
 * user-controlled values (image tags, service names, host strings) appear in args.
 */
function run(
  spawnSync: typeof import('node:child_process').spawnSync,
  cmd: string,
  args: string[],
): void {
  const result = spawnSync(cmd, args, { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`Command failed (exit ${result.status}): ${cmd} ${args.join(' ')}`);
  }
}
