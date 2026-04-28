// packages/slingshot-ssg/src/constants.ts

/**
 * Upper bound on `concurrency` for the SSG renderer.
 *
 * Picked to leave headroom under typical FD ulimits — most Linux/macOS systems
 * default to 1024 file descriptors per process and SSG renders may open
 * multiple files per route (route module + asset reads + output stream).
 * Keeping concurrency well below the ulimit prevents EMFILE during large
 * crawls. Override in custom forks if you have raised your ulimit.
 *
 * Enforced both by the Zod schema (`ssgConfigSchema.concurrency`) for
 * programmatic callers and by the CLI clamp (`parsePositiveIntArg`) for
 * `--concurrency`. Both must reference this constant so they cannot drift.
 *
 * @internal
 */
export const MAX_CONCURRENCY = 256;
