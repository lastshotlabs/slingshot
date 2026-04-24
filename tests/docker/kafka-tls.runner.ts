import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInProcessAdapter } from '@lastshotlabs/slingshot-core';
import {
  createKafkaAdapter,
  createKafkaConnectors,
  getKafkaAdapterIntrospectionOrNull,
} from '@lastshotlabs/slingshot-kafka';
import { Kafka, type KafkaMessage } from '../../packages/slingshot-kafka/node_modules/kafkajs';
import { createServerFromManifest } from '../../src/lib/createServerFromManifest';
import { createManifestHandlerRegistry } from '../../src/lib/manifestHandlerRegistry';
import { getServerContext } from '../../src/server';

const KAFKA_TLS_BROKER = 'localhost:39094';
const KAFKA_MTLS_BROKER = 'localhost:49095';
const TLS_CA_PATH = resolve(process.cwd(), 'tests/fixtures/redpanda-tls/ca.crt');
const TLS_BROKER_CERT_PATH = resolve(process.cwd(), 'tests/fixtures/redpanda-tls/broker.crt');
const TLS_CLIENT_CERT_PATH = resolve(process.cwd(), 'tests/fixtures/redpanda-tls/client.crt');
const TLS_CLIENT_KEY_PATH = resolve(process.cwd(), 'tests/fixtures/redpanda-tls/client.key');
const TLS_CA_PEM = readFileSync(TLS_CA_PATH, 'utf-8');
const TLS_BROKER_CERT_PEM = readFileSync(TLS_BROKER_CERT_PATH, 'utf-8');
const TLS_CLIENT_CERT_PEM = readFileSync(TLS_CLIENT_CERT_PATH, 'utf-8');
const TLS_CLIENT_KEY_PEM = readFileSync(TLS_CLIENT_KEY_PATH, 'utf-8');
const RUN_ID = Date.now();
const cleanup: Array<() => Promise<void>> = [];
const KAFKA_SECURITY_ENV_KEYS = [
  'KAFKA_BROKERS',
  'KAFKA_CLIENT_ID',
  'KAFKA_SSL',
  'KAFKA_SASL_USERNAME',
  'KAFKA_SASL_PASSWORD',
  'KAFKA_SASL_MECHANISM',
] as const;

type KafkaSslConfig =
  | true
  | {
      ca?: string;
      cert?: string;
      key?: string;
      rejectUnauthorized?: boolean;
    };

const TLS_MUTUAL_SSL: Exclude<KafkaSslConfig, true> = {
  ca: TLS_CA_PEM,
  cert: TLS_CLIENT_CERT_PEM,
  key: TLS_CLIENT_KEY_PEM,
};

type RunningServer = {
  port: number;
  stop(close?: boolean): void | Promise<void>;
};

type CollectedKafkaMessage = {
  topic: string;
  key: string | null;
  value: string | null;
  headers: Record<string, string>;
};

function uniqueName(label: string): string {
  return `${label}-${RUN_ID}-${Math.random().toString(36).slice(2, 8)}`;
}

function headersToStrings(headers: KafkaMessage['headers']): Record<string, string> {
  const result: Record<string, string> = {};
  if (!headers) return result;

  for (const [key, value] of Object.entries(headers)) {
    if (value == null) continue;
    result[key] = Buffer.isBuffer(value) ? value.toString() : String(value);
  }

  return result;
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(
  condition: () => boolean,
  ms = 15_000,
  message = 'waitFor timed out',
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error(message);
    }
    await sleep(50);
  }
}

function createTlsClient(
  clientIdLabel: string,
  ssl: KafkaSslConfig = true,
  broker = KAFKA_TLS_BROKER,
): Kafka {
  return new Kafka({
    clientId: uniqueName(clientIdLabel),
    brokers: [broker],
    ssl,
  });
}

async function createTlsAdmin(ssl: KafkaSslConfig = true, broker = KAFKA_TLS_BROKER) {
  const kafka = createTlsClient('docker-tls-admin', ssl, broker);
  const admin = kafka.admin();
  await admin.connect();
  cleanup.push(async () => {
    await admin.disconnect().catch(() => {});
  });
  return admin;
}

async function createTlsProducer(ssl: KafkaSslConfig = true, broker = KAFKA_TLS_BROKER) {
  const kafka = createTlsClient('docker-tls-producer', ssl, broker);
  const producer = kafka.producer();
  await producer.connect();
  cleanup.push(async () => {
    await producer.disconnect().catch(() => {});
  });
  return producer;
}

async function ensureTlsTopic(
  topic: string,
  numPartitions = 1,
  ssl: KafkaSslConfig = true,
  broker = KAFKA_TLS_BROKER,
): Promise<void> {
  const admin = await createTlsAdmin(ssl, broker);
  await admin.createTopics({
    waitForLeaders: true,
    topics: [{ topic, numPartitions, replicationFactor: 1 }],
  });
}

function captureKafkaSecurityEnv(): Record<
  (typeof KAFKA_SECURITY_ENV_KEYS)[number],
  string | undefined
> {
  return {
    KAFKA_BROKERS: process.env.KAFKA_BROKERS,
    KAFKA_CLIENT_ID: process.env.KAFKA_CLIENT_ID,
    KAFKA_SSL: process.env.KAFKA_SSL,
    KAFKA_SASL_USERNAME: process.env.KAFKA_SASL_USERNAME,
    KAFKA_SASL_PASSWORD: process.env.KAFKA_SASL_PASSWORD,
    KAFKA_SASL_MECHANISM: process.env.KAFKA_SASL_MECHANISM,
  };
}

function restoreKafkaSecurityEnv(previousEnv: Record<string, string | undefined>): void {
  for (const key of KAFKA_SECURITY_ENV_KEYS) {
    if (previousEnv[key] !== undefined) {
      process.env[key] = previousEnv[key];
    } else {
      delete process.env[key];
    }
  }
}

async function collectTlsMessages(
  topic: string,
  opts?: { fromBeginning?: boolean; groupId?: string; ssl?: KafkaSslConfig; broker?: string },
): Promise<CollectedKafkaMessage[]> {
  const kafka = createTlsClient('docker-tls-consumer', opts?.ssl ?? true, opts?.broker);
  const consumer = kafka.consumer({
    groupId: opts?.groupId ?? uniqueName(`collector.${topic}`),
  });
  const messages: CollectedKafkaMessage[] = [];

  await consumer.connect();
  await consumer.subscribe({
    topic,
    fromBeginning: opts?.fromBeginning ?? false,
  });
  await consumer.run({
    eachMessage: async payload => {
      messages.push({
        topic: payload.topic,
        key: payload.message.key?.toString() ?? null,
        value: payload.message.value?.toString() ?? null,
        headers: headersToStrings(payload.message.headers),
      });
    },
  });
  cleanup.push(async () => {
    await consumer.disconnect().catch(() => {});
  });

  await sleep(300);
  return messages;
}

async function createTempManifest(
  content: Record<string, unknown>,
): Promise<{ dir: string; path: string }> {
  const dir = join(process.cwd(), '.tmp', 'kafka-tls-docker', uniqueName('manifest')).replaceAll(
    '\\',
    '/',
  );
  mkdirSync(dir, { recursive: true });
  const path = `${dir}/app.manifest.json`;
  writeFileSync(path, JSON.stringify(content, null, 2), 'utf-8');
  cleanup.push(async () => {
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, path };
}

async function runPlaintextRejectedScenario(): Promise<void> {
  const kafka = new Kafka({
    clientId: uniqueName('docker-tls-no-ssl'),
    brokers: [KAFKA_TLS_BROKER],
    connectionTimeout: 1_000,
    requestTimeout: 1_000,
    retry: { retries: 0 },
  });
  const admin = kafka.admin();
  cleanup.push(async () => {
    await admin.disconnect().catch(() => {});
  });

  let rejected = false;
  try {
    await admin.connect();
  } catch {
    rejected = true;
  }

  if (!rejected) {
    throw new Error('Expected plaintext Kafka client to fail against the TLS listener');
  }
}

function certificateErrorLike(message: string): boolean {
  return /certificate|tls|ssl|verify|issuer|self signed/i.test(message);
}

function clientAuthRejectionLike(message: string): boolean {
  return certificateErrorLike(message) || /closed connection/i.test(message);
}

async function runBadCaRejectedScenario(): Promise<void> {
  const kafka = new Kafka({
    clientId: uniqueName('docker-tls-bad-ca'),
    brokers: [KAFKA_TLS_BROKER],
    ssl: { ca: TLS_BROKER_CERT_PEM },
    connectionTimeout: 1_000,
    requestTimeout: 1_000,
    retry: { retries: 0 },
  });
  const admin = kafka.admin();
  cleanup.push(async () => {
    await admin.disconnect().catch(() => {});
  });

  let errorMessage = '';
  try {
    await admin.connect();
    throw new Error('Expected Kafka TLS client to fail with an invalid CA bundle');
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
  }

  if (!certificateErrorLike(errorMessage)) {
    throw new Error(`Expected certificate validation failure, got: ${errorMessage}`);
  }
}

async function runMtlsRejectedWithoutClientCertScenario(): Promise<void> {
  const kafka = new Kafka({
    clientId: uniqueName('docker-mtls-no-client-cert'),
    brokers: [KAFKA_MTLS_BROKER],
    ssl: { ca: TLS_CA_PEM },
    connectionTimeout: 1_000,
    requestTimeout: 1_000,
    retry: { retries: 0 },
  });
  const admin = kafka.admin();
  cleanup.push(async () => {
    await admin.disconnect().catch(() => {});
  });

  let errorMessage = '';
  try {
    await admin.connect();
    throw new Error('Expected Kafka mTLS client to fail without a client certificate');
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
  }

  if (!clientAuthRejectionLike(errorMessage)) {
    throw new Error(`Expected client-certificate rejection, got: ${errorMessage}`);
  }
}

async function runAdapterRoundTripScenario(
  ssl: KafkaSslConfig = true,
  broker = KAFKA_TLS_BROKER,
): Promise<void> {
  const bus = createKafkaAdapter({
    brokers: [broker],
    ssl,
    topicPrefix: uniqueName('slingshot.tls.events'),
    groupPrefix: uniqueName('slingshot.tls.groups'),
    startFromBeginning: true,
  });
  cleanup.push(() => bus.shutdown?.() ?? Promise.resolve());

  const introspection = getKafkaAdapterIntrospectionOrNull(bus);
  if (!introspection) {
    throw new Error('Kafka adapter introspection missing');
  }

  const topic = introspection.topicNameForEvent('auth:login');
  await ensureTlsTopic(topic, 1, ssl, broker);
  const received: Array<{ userId: string; sessionId: string }> = [];

  bus.on(
    'auth:login',
    payload => {
      received.push(payload);
    },
    { durable: true, name: uniqueName('tls-worker') },
  );

  await waitFor(
    () => bus.health().consumers[0]?.connected === true,
    15_000,
    'TLS adapter durable consumer did not connect',
  );
  await sleep(1_500);

  const producer = await createTlsProducer(ssl, broker);
  await producer.send({
    topic,
    messages: [
      {
        key: 'tls-consume',
        value: Buffer.from(
          JSON.stringify({ userId: 'tls-consume-user', sessionId: 'tls-consume-session' }),
        ),
      },
    ],
  });

  await waitFor(
    () => received.length === 1,
    15_000,
    'TLS adapter durable consume did not complete',
  );

  const brokerMessages = await collectTlsMessages(topic, { ssl, broker });
  bus.emit('auth:login', { userId: 'tls-produce-user', sessionId: 'tls-produce-session' });

  await waitFor(
    () => brokerMessages.length === 1,
    15_000,
    'TLS adapter publish did not reach Kafka',
  );

  const produced = JSON.parse(brokerMessages[0]!.value ?? '{}');
  if (produced.userId !== 'tls-produce-user' || produced.sessionId !== 'tls-produce-session') {
    throw new Error(`Unexpected TLS adapter publish payload: ${JSON.stringify(produced)}`);
  }
}

async function runConnectorsBridgeScenario(
  ssl: KafkaSslConfig = true,
  broker = KAFKA_TLS_BROKER,
): Promise<void> {
  const bus = createInProcessAdapter();
  const topic = uniqueName('external.tls.users');
  const received: Array<{ userId: string; email?: string }> = [];

  const connectors = createKafkaConnectors({
    brokers: [broker],
    ssl,
    inbound: [
      {
        topic,
        groupId: uniqueName('tls-sync'),
        handler: payload => {
          received.push(payload as { userId: string; email?: string });
        },
      },
    ],
    outbound: [
      {
        event: 'auth:user.created',
        topic,
        autoCreateTopic: true,
      },
    ],
  });
  cleanup.push(() => connectors.stop());

  await connectors.start(bus);
  await sleep(500);

  bus.emit('auth:user.created', {
    userId: 'tls-connector-user',
    email: 'tls@example.com',
  });

  await waitFor(
    () => received.length === 1,
    15_000,
    'TLS connectors did not bridge the event through Kafka',
  );
}

async function runManifestBootstrapScenario(): Promise<void> {
  const previousEnv = captureKafkaSecurityEnv();
  process.env.KAFKA_BROKERS = KAFKA_TLS_BROKER;
  process.env.KAFKA_CLIENT_ID = uniqueName('manifest-tls');
  process.env.KAFKA_SSL = 'true';
  delete process.env.KAFKA_SASL_USERNAME;
  delete process.env.KAFKA_SASL_PASSWORD;
  delete process.env.KAFKA_SASL_MECHANISM;
  cleanup.push(async () => {
    restoreKafkaSecurityEnv(previousEnv);
  });

  const inboundTopic = uniqueName('manifest.tls.inbound');
  const outboundTopic = uniqueName('manifest.tls.outbound');
  await ensureTlsTopic(inboundTopic);
  await ensureTlsTopic(outboundTopic);
  const inboundPayloads: Array<{
    payload: unknown;
    metadata: Record<string, unknown>;
  }> = [];

  const registry = createManifestHandlerRegistry();
  registry.registerHandler('captureKafkaInbound', () => {
    return async (payload: unknown, metadata: Record<string, unknown>) => {
      inboundPayloads.push({ payload, metadata });
    };
  });

  const manifest = await createTempManifest({
    manifestVersion: 1,
    handlers: false,
    port: 0,
    meta: { name: 'Kafka TLS Docker Manifest', version: '1.0.0' },
    security: { rateLimit: false },
    db: {
      sqlite: `${process.cwd().replaceAll('\\', '/')}/.tmp/${uniqueName('manifest-tls-db')}.sqlite`,
      auth: 'sqlite',
      sessions: 'sqlite',
      redis: false,
    },
    eventBus: {
      type: 'kafka',
      config: {
        topicPrefix: uniqueName('manifest.tls.events'),
        groupPrefix: uniqueName('manifest.tls.groups'),
      },
    },
    kafkaConnectors: {
      inbound: [
        {
          topic: inboundTopic,
          groupId: uniqueName('manifest-tls-inbound'),
          handler: 'captureKafkaInbound',
        },
      ],
      outbound: [
        {
          event: 'auth:user.created',
          topic: outboundTopic,
        },
      ],
    },
  });

  const server = (await createServerFromManifest(
    manifest.path,
    registry,
  )) as unknown as RunningServer;
  cleanup.push(async () => {
    const ctx = getServerContext(server);
    await server.stop(true);
    await ctx?.destroy?.();
  });

  const ctx = getServerContext(server);
  if (!ctx) {
    throw new Error('Server context missing');
  }

  const outboundMessages = await collectTlsMessages(outboundTopic);
  ctx.bus.emit('auth:user.created', {
    userId: 'manifest-tls-user',
    email: 'manifest-tls@example.com',
  } as never);

  await waitFor(
    () => outboundMessages.length === 1,
    15_000,
    'Manifest TLS outbound connector did not publish to Kafka',
  );

  const producer = await createTlsProducer();
  await producer.send({
    topic: inboundTopic,
    messages: [
      { key: 'tls-inbound-1', value: Buffer.from(JSON.stringify({ id: 'tls-inbound-1' })) },
    ],
  });

  await waitFor(
    () => inboundPayloads.length === 1,
    15_000,
    'Manifest TLS inbound connector did not receive the Kafka message',
  );
}

async function runManifestMtlsScenario(): Promise<void> {
  const previousEnv = captureKafkaSecurityEnv();
  restoreKafkaSecurityEnv({});
  cleanup.push(async () => {
    restoreKafkaSecurityEnv(previousEnv);
  });

  const inboundTopic = uniqueName('manifest.mtls.inbound');
  const outboundTopic = uniqueName('manifest.mtls.outbound');
  await ensureTlsTopic(inboundTopic, 1, TLS_MUTUAL_SSL, KAFKA_MTLS_BROKER);
  await ensureTlsTopic(outboundTopic, 1, TLS_MUTUAL_SSL, KAFKA_MTLS_BROKER);
  const inboundPayloads: Array<{
    payload: unknown;
    metadata: Record<string, unknown>;
  }> = [];

  const registry = createManifestHandlerRegistry();
  registry.registerHandler('captureKafkaInbound', () => {
    return async (payload: unknown, metadata: Record<string, unknown>) => {
      inboundPayloads.push({ payload, metadata });
    };
  });

  const manifest = await createTempManifest({
    manifestVersion: 1,
    handlers: false,
    port: 0,
    meta: { name: 'Kafka mTLS Docker Manifest', version: '1.0.0' },
    security: { rateLimit: false },
    db: {
      sqlite: `${process.cwd().replaceAll('\\', '/')}/.tmp/${uniqueName('manifest-mtls-db')}.sqlite`,
      auth: 'sqlite',
      sessions: 'sqlite',
      redis: false,
    },
    eventBus: {
      type: 'kafka',
      config: {
        brokers: [KAFKA_MTLS_BROKER],
        ssl: TLS_MUTUAL_SSL,
        topicPrefix: uniqueName('manifest.mtls.events'),
        groupPrefix: uniqueName('manifest.mtls.groups'),
      },
    },
    kafkaConnectors: {
      brokers: [KAFKA_MTLS_BROKER],
      ssl: TLS_MUTUAL_SSL,
      inbound: [
        {
          topic: inboundTopic,
          groupId: uniqueName('manifest-mtls-inbound'),
          handler: 'captureKafkaInbound',
        },
      ],
      outbound: [
        {
          event: 'auth:user.created',
          topic: outboundTopic,
        },
      ],
    },
  });

  const server = (await createServerFromManifest(
    manifest.path,
    registry,
  )) as unknown as RunningServer;
  cleanup.push(async () => {
    const ctx = getServerContext(server);
    await server.stop(true);
    await ctx?.destroy?.();
  });

  const ctx = getServerContext(server);
  if (!ctx) {
    throw new Error('Server context missing');
  }

  const outboundMessages = await collectTlsMessages(outboundTopic, {
    ssl: TLS_MUTUAL_SSL,
    broker: KAFKA_MTLS_BROKER,
  });
  ctx.bus.emit('auth:user.created', {
    userId: 'manifest-mtls-user',
    email: 'manifest-mtls@example.com',
  } as never);

  await waitFor(
    () => outboundMessages.length === 1,
    15_000,
    'Manifest mTLS outbound connector did not publish to Kafka',
  );

  const producer = await createTlsProducer(TLS_MUTUAL_SSL, KAFKA_MTLS_BROKER);
  await producer.send({
    topic: inboundTopic,
    messages: [
      { key: 'mtls-inbound-1', value: Buffer.from(JSON.stringify({ id: 'mtls-inbound-1' })) },
    ],
  });

  await waitFor(
    () => inboundPayloads.length === 1,
    15_000,
    'Manifest mTLS inbound connector did not receive the Kafka message',
  );
}

async function main(): Promise<void> {
  const scenario = process.argv[2];
  try {
    switch (scenario) {
      case 'plaintext-rejected':
        await runPlaintextRejectedScenario();
        break;
      case 'adapter-roundtrip':
        await runAdapterRoundTripScenario();
        break;
      case 'adapter-roundtrip-explicit-ca':
        await runAdapterRoundTripScenario({ ca: TLS_CA_PEM });
        break;
      case 'adapter-roundtrip-mtls':
        await runAdapterRoundTripScenario(TLS_MUTUAL_SSL, KAFKA_MTLS_BROKER);
        break;
      case 'connectors-bridge':
        await runConnectorsBridgeScenario();
        break;
      case 'connectors-bridge-explicit-ca':
        await runConnectorsBridgeScenario({ ca: TLS_CA_PEM });
        break;
      case 'connectors-bridge-mtls':
        await runConnectorsBridgeScenario(TLS_MUTUAL_SSL, KAFKA_MTLS_BROKER);
        break;
      case 'bad-ca-rejected':
        await runBadCaRejectedScenario();
        break;
      case 'mtls-rejected-without-client-cert':
        await runMtlsRejectedWithoutClientCertScenario();
        break;
      case 'manifest-bootstrap':
        await runManifestBootstrapScenario();
        break;
      case 'manifest-bootstrap-mtls':
        await runManifestMtlsScenario();
        break;
      default:
        throw new Error(`Unknown TLS scenario: ${scenario ?? '(missing)'}`);
    }

    console.log(JSON.stringify({ ok: true, scenario }));
  } finally {
    while (cleanup.length > 0) {
      const fn = cleanup.pop();
      await fn?.().catch(() => {});
    }
  }
}

await main();
