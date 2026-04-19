/**
 * Optional endpoint mounting — extracted from createApp().
 *
 * Mounts the jobs status endpoint, /metrics endpoint, and upload presigned-URL
 * endpoint when each is enabled in the app config.
 */
import type { JobsConfig } from '@config/types/jobs';
import type { MetricsConfig } from '@config/types/metrics';
import type { PresignedUrlConfig, UploadConfig } from '@config/types/upload';
import type { MetricsState } from '@framework/metrics/registry';
import { createJobsRouter } from '@framework/routes/jobs';
import { createMetricsRouter } from '@framework/routes/metrics';
import { createUploadsRouter } from '@framework/routes/uploads';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { type QueueFactory, createQueueFactory } from '@lib/queue';
import type { AppEnv, PostgresBundle } from '@lastshotlabs/slingshot-core';

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Mount optional framework endpoints onto the app router.
 *
 * Conditionally mounts up to three endpoint groups based on the provided config:
 *
 * 1. **Jobs status endpoint** (`jobs.statusEndpoint`) — exposes BullMQ queue status
 *    via a `/jobs` route. The queue factory is created lazily (deferred until first
 *    request) to avoid a Redis validation error at startup when Redis is not yet ready.
 *    Requires `jobs.auth` to be configured in production, or `unsafePublic: true`
 *    with `auth: 'none'` for explicit opt-out. Throws on startup in production if
 *    neither condition is met.
 *
 * 2. **Metrics endpoint** (`metrics.enabled`) — exposes Prometheus-compatible
 *    metrics via a `/metrics` route. Optionally includes queue metrics when
 *    `metrics.queues` is configured (shares the lazy queue factory with jobs).
 *
 * 3. **Presigned URL endpoint** (`upload.presignedUrls`) — mounts the upload
 *    presigned-URL helper routes for client-side S3/R2/GCS direct uploads.
 *    Authorization and allowed-key filtering are forwarded from `upload.authorization`
 *    and `upload.allowExternalKeys`.
 *
 * All three groups are skipped entirely when their respective config sections are
 * absent or disabled — no routes are registered and no infrastructure is initialised.
 *
 * The queue factory (`QueueFactory`) is shared between jobs and metrics to avoid
 * creating two separate BullMQ connections. It is only instantiated when at least
 * one of those features is enabled.
 *
 * This function is called once per `createApp()` invocation during the late
 * startup phase, after all plugins have completed `setupPost`.
 *
 * @param app - The Hono/OpenAPIHono app instance to mount routes on.
 * @param jobs - Jobs config from `CreateServerConfig`, or `undefined` to skip.
 * @param metrics - Metrics config from `CreateServerConfig`, or `undefined` to skip.
 * @param upload - Upload config from `CreateServerConfig`, or `undefined` to skip.
 * @param metricsState - Live metrics state object shared with the metrics router.
 * @param resolvedSecrets - Redis credentials from the resolved secret bundle.
 *   Used to construct the lazy queue factory. Only `redisHost` is required; the
 *   rest are optional.
 * @param isProd - Whether the app is running in production mode. Controls the
 *   strictness of the jobs and metrics auth security checks.
 * @returns Resolves once all enabled route groups have been mounted.
 * @throws If `jobs.statusEndpoint` is enabled in production with `auth: 'none'`
 *   and without `unsafePublic: true`.
 * @throws If the queue factory is needed but `redisHost` is absent from the secret bundle.
 *
 * @example
 * ```ts
 * // Called internally by createApp() — not typically called directly:
 * await mountOptionalEndpoints(
 *   app,
 *   config.jobs, config.metrics, config.upload,
 *   metricsState, { redisHost, redisUser, redisPassword },
 * );
 * ```
 */
export function mountOptionalEndpoints(
  app: OpenAPIHono<AppEnv>,
  jobs: JobsConfig | undefined,
  metrics: MetricsConfig | undefined,
  upload: UploadConfig | undefined,
  metricsState: MetricsState,
  resolvedSecrets: {
    redisHost?: string;
    redisUser?: string;
    redisPassword?: string;
  },
  isProd: boolean,
  postgres?: PostgresBundle | null,
): void {
  // Security validation runs before infrastructure creation so config errors
  // take priority over missing infrastructure (Redis) errors.
  if (jobs?.statusEndpoint) {
    const jobsAuth = jobs.auth ?? 'none';
    if (jobsAuth === 'none' && !jobs.unsafePublic) {
      if (isProd) {
        throw new Error(
          '[security] jobs.auth is required in production. Set jobs.auth or explicitly set unsafePublic: true with auth: "none".',
        );
      }
      console.warn('[security] /jobs is enabled without auth. Configure jobs.auth for production.');
    }
  }

  // Queue factory is created lazily — defers Redis validation to first use
  // so the app can start without Redis when using the jobs/metrics endpoints.
  const needsQueueFactory = !!jobs?.statusEndpoint || !!metrics?.queues?.length;
  let _cachedFactory: QueueFactory | undefined;
  function getLazyFactory(): QueueFactory {
    if (!_cachedFactory) {
      if (!resolvedSecrets.redisHost) {
        throw new Error(
          '[queue] Jobs/metrics queue helpers require REDIS_HOST via the Slingshot secret bundle at startup.',
        );
      }
      _cachedFactory = createQueueFactory({
        host: resolvedSecrets.redisHost,
        user: resolvedSecrets.redisUser,
        password: resolvedSecrets.redisPassword,
      });
    }
    return _cachedFactory;
  }
  const queueFactory: QueueFactory | undefined = needsQueueFactory
    ? {
        createQueue: (...args) => getLazyFactory().createQueue(...args),
        createWorker: (...args) => getLazyFactory().createWorker(...args),
        createCronWorker: (...args) => getLazyFactory().createCronWorker(...args),
        cleanupStaleSchedulers: (...args) => getLazyFactory().cleanupStaleSchedulers(...args),
        createDLQHandler: (...args) => getLazyFactory().createDLQHandler(...args),
      }
    : undefined;

  if (jobs?.statusEndpoint) {
    if (!queueFactory)
      throw new Error('[queue] queueFactory is required when jobs.statusEndpoint is enabled');
    app.route('/', createJobsRouter(jobs, queueFactory, isProd));
  }

  if (metrics?.enabled) {
    app.route(
      '/',
      createMetricsRouter(
        {
          auth: metrics.auth,
          isProd,
          queues: metrics.queues,
          unsafePublic: metrics.unsafePublic,
        },
        metricsState,
        queueFactory,
        postgres,
      ),
    );
  }

  if (upload?.presignedUrls) {
    const presignConfig: PresignedUrlConfig =
      upload.presignedUrls === true ? {} : upload.presignedUrls;
    app.route(
      '/',
      createUploadsRouter({
        ...presignConfig,
        authorization: upload.authorization,
        allowExternalKeys: upload.allowExternalKeys,
      }),
    );
  }

  // Silently absorb browser service-worker probes. Without this, every
  // page load in a PWA-capable browser triggers a 404 for /sw.js, which
  // pollutes request logs and can confuse error-tracking tools. The empty
  // response tells the browser there is no service worker to install.
  app.get('/sw.js', c => c.body('', 200, { 'Content-Type': 'application/javascript' }));
}
