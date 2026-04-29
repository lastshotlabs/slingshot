import { resolve } from 'node:path';
import { describe, expect, test } from 'bun:test';

const TLS_CA_PATH = resolve(process.cwd(), 'tests/fixtures/redpanda-tls/ca.crt');
const RUNNER_PATH = resolve(process.cwd(), 'tests/docker/kafka-tls.runner.ts');
const TLS_TEST_TIMEOUT_MS = 90_000;
const TRANSIENT_DOCKER_KAFKA_FAILURE =
  /ECONNREFUSED|Client network socket disconnected before secure TLS connection was established/;

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function runTlsScenarioOnce(
  scenario:
    | 'plaintext-rejected'
    | 'adapter-roundtrip'
    | 'adapter-roundtrip-explicit-ca'
    | 'adapter-roundtrip-mtls'
    | 'connectors-bridge'
    | 'connectors-bridge-explicit-ca'
    | 'connectors-bridge-mtls'
    | 'bad-ca-rejected'
    | 'mtls-rejected-without-client-cert'
    | 'manifest-bootstrap'
    | 'manifest-bootstrap-mtls',
  opts?: { trustCa?: boolean },
): { exitCode: number | null; stdout: string; stderr: string } {
  const proc = Bun.spawnSync({
    cmd: [process.execPath, RUNNER_PATH, scenario],
    cwd: process.cwd(),
    env: (() => {
      const env = { ...process.env };
      delete env.KAFKA_SASL_USERNAME;
      delete env.KAFKA_SASL_PASSWORD;
      delete env.KAFKA_SASL_MECHANISM;
      return {
        ...env,
        KAFKAJS_NO_PARTITIONER_WARNING: '1',
        ...(opts?.trustCa ? { NODE_EXTRA_CA_CERTS: TLS_CA_PATH } : {}),
      };
    })(),
    stdout: 'pipe',
    stderr: 'pipe',
  });

  return {
    exitCode: proc.exitCode,
    stdout: decode(proc.stdout),
    stderr: decode(proc.stderr),
  };
}

function runTlsScenario(
  scenario:
    | 'plaintext-rejected'
    | 'adapter-roundtrip'
    | 'adapter-roundtrip-explicit-ca'
    | 'adapter-roundtrip-mtls'
    | 'connectors-bridge'
    | 'connectors-bridge-explicit-ca'
    | 'connectors-bridge-mtls'
    | 'bad-ca-rejected'
    | 'mtls-rejected-without-client-cert'
    | 'manifest-bootstrap'
    | 'manifest-bootstrap-mtls',
  opts?: { trustCa?: boolean },
): string {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { exitCode, stdout, stderr } = runTlsScenarioOnce(scenario, opts);
    if (exitCode === 0) {
      return stdout;
    }

    const combinedOutput = `${stdout}\n${stderr}`;
    if (attempt === 0 && TRANSIENT_DOCKER_KAFKA_FAILURE.test(combinedOutput)) {
      sleepSync(1_000);
      continue;
    }

    throw new Error(
      [
        `TLS scenario "${scenario}" failed with exit code ${exitCode}.`,
        stdout ? `stdout:\n${stdout}` : '',
        stderr ? `stderr:\n${stderr}` : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
    );
  }

  throw new Error(`TLS scenario "${scenario}" did not complete`);
}

describe('Kafka TLS runtime paths (Docker)', () => {
  test(
    'the external TLS listener rejects plaintext clients',
    () => {
      const stdout = runTlsScenario('plaintext-rejected');
      expect(stdout).toContain('"ok":true');
    },
    TLS_TEST_TIMEOUT_MS,
  );

  test(
    'Kafka adapter round-trips through the TLS-enabled broker using ssl: true',
    () => {
      const stdout = runTlsScenario('adapter-roundtrip', { trustCa: true });
      expect(stdout).toContain('"ok":true');
    },
    TLS_TEST_TIMEOUT_MS,
  );

  test(
    'Kafka adapter round-trips through the TLS-enabled broker using an explicit CA bundle',
    () => {
      const stdout = runTlsScenario('adapter-roundtrip-explicit-ca');
      expect(stdout).toContain('"ok":true');
    },
    TLS_TEST_TIMEOUT_MS,
  );

  test(
    'Kafka adapter round-trips through the mTLS listener using a client certificate bundle',
    () => {
      const stdout = runTlsScenario('adapter-roundtrip-mtls');
      expect(stdout).toContain('"ok":true');
    },
    TLS_TEST_TIMEOUT_MS,
  );

  test(
    'Kafka connectors bridge events through the TLS-enabled broker using ssl: true',
    () => {
      const stdout = runTlsScenario('connectors-bridge', { trustCa: true });
      expect(stdout).toContain('"ok":true');
    },
    TLS_TEST_TIMEOUT_MS,
  );

  test(
    'Kafka connectors bridge events through the TLS-enabled broker using an explicit CA bundle',
    () => {
      const stdout = runTlsScenario('connectors-bridge-explicit-ca');
      expect(stdout).toContain('"ok":true');
    },
    TLS_TEST_TIMEOUT_MS,
  );

  test(
    'Kafka clients reject the TLS listener when the configured CA is wrong',
    () => {
      const stdout = runTlsScenario('bad-ca-rejected');
      expect(stdout).toContain('"ok":true');
    },
    TLS_TEST_TIMEOUT_MS,
  );

  test(
    'Kafka clients reject the mTLS listener when no client certificate is configured',
    () => {
      const stdout = runTlsScenario('mtls-rejected-without-client-cert');
      expect(stdout).toContain('"ok":true');
    },
    TLS_TEST_TIMEOUT_MS,
  );

  test(
    'Kafka connectors bridge events through the mTLS listener using a client certificate bundle',
    () => {
      const stdout = runTlsScenario('connectors-bridge-mtls');
      expect(stdout).toContain('"ok":true');
    },
    TLS_TEST_TIMEOUT_MS,
  );

  test(
    'manifest bootstrap connects to the TLS-enabled broker when KAFKA_SSL=true',
    () => {
      const stdout = runTlsScenario('manifest-bootstrap', { trustCa: true });
      expect(stdout).toContain('"ok":true');
    },
    TLS_TEST_TIMEOUT_MS,
  );

  test(
    'manifest bootstrap connects to the mTLS listener using Kafka ssl cert/key config',
    () => {
      const stdout = runTlsScenario('manifest-bootstrap-mtls');
      expect(stdout).toContain('"ok":true');
    },
    TLS_TEST_TIMEOUT_MS,
  );
});
