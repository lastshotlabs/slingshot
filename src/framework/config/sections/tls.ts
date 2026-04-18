import { z } from 'zod';

/**
 * Zod schema for the `tls` section of `CreateServerConfig`.
 *
 * Configures TLS termination directly in the Bun HTTP server. When this
 * section is present the server listens on HTTPS/HTTP2 without a reverse proxy.
 * All fields map directly to Bun's `TLSOptions`.
 *
 * This section is server-only (not available in `CreateAppConfig`).
 *
 * @remarks
 * **Fields:**
 * - `key` — Private key material. Accepts a string (PEM), `Buffer`, `BunFile`,
 *   or array of any of the above for multiple virtual hosts.
 * - `cert` — Certificate or certificate chain. Same accepted types as `key`.
 * - `ca` — Certificate Authority bundle for client-certificate verification.
 *   Same accepted types as `key`. Required when `requestCert` is `true`.
 * - `passphrase` — Passphrase for encrypted private keys.
 * - `serverName` — SNI server name used when the server acts as a TLS client
 *   (e.g. for upstream mTLS connections). Not typically needed for inbound TLS.
 * - `dhParamsFile` — Path to a Diffie-Hellman parameters file (PEM) for
 *   DHE cipher suites. Omit to use Bun's built-in defaults.
 * - `lowMemoryMode` — When `true`, BoringSSL reduces its internal buffer sizes
 *   at the cost of throughput. Useful for memory-constrained environments.
 *   Defaults to `false`.
 * - `secureOptions` — Bitmask of `crypto.constants` SSL options passed directly
 *   to BoringSSL. Use only when a specific cipher or protocol control is
 *   required that has no higher-level option.
 * - `rejectUnauthorized` — When `true`, the server rejects TLS connections from
 *   clients with invalid or self-signed certificates. Meaningful only when
 *   `requestCert` is also `true`. Defaults to `true`.
 * - `requestCert` — When `true`, the server requests a client certificate
 *   during the TLS handshake (mTLS). Defaults to `false`.
 *
 * **Usage note:** At minimum, `key` and `cert` must both be supplied for TLS to
 * activate. Providing only one of the two will cause Bun to throw at startup.
 *
 * @example
 * ```ts
 * // In CreateServerConfig:
 * tls: {
 *   key: Bun.file('./certs/server.key'),
 *   cert: Bun.file('./certs/server.crt'),
 *   lowMemoryMode: false,
 * }
 * ```
 */
export const tlsSchema = z.object({
  key: z.any().optional(),
  cert: z.any().optional(),
  ca: z.any().optional(),
  passphrase: z.string().optional(),
  serverName: z.string().optional(),
  dhParamsFile: z.string().optional(),
  lowMemoryMode: z.boolean().optional(),
  secureOptions: z.number().optional(),
  rejectUnauthorized: z.boolean().optional(),
  requestCert: z.boolean().optional(),
});
