import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, mock, test } from 'bun:test';
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

process.env.KAFKAJS_NO_PARTITIONER_WARNING = '1';

const KAFKA_SASL_BROKER = 'localhost:29093';
type SupportedSaslConfig = {
  mechanism: 'plain' | 'scram-sha-256' | 'scram-sha-512';
  username: string;
  password: string;
};

const KAFKA_SASL: SupportedSaslConfig = {
  mechanism: 'scram-sha-256' as const,
  username: 'superuser',
  password: 'secretpassword',
};
const KAFKA_SASL_PLAIN: SupportedSaslConfig = {
  mechanism: 'plain',
  username: 'superuser',
  password: 'secretpassword',
};
const KAFKA_SASL_SCRAM_512: SupportedSaslConfig = {
  mechanism: 'scram-sha-512',
  username: 'plain512user',
  password: 'plain512password',
};
const RUN_ID = Date.now();
let extraSaslCoverageReady: Promise<void> | null = null;

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

const cleanup: Array<() => Promise<void>> = [];

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

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function runDocker(args: string[], opts?: { allowFailure?: boolean }): string {
  const proc = Bun.spawnSync({
    cmd: ['docker', ...args],
    cwd: process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = decode(proc.stdout);
  const stderr = decode(proc.stderr);

  if (proc.exitCode !== 0 && !opts?.allowFailure) {
    throw new Error(
      [
        `docker ${args.join(' ')} failed with exit code ${proc.exitCode}.`,
        stdout ? `stdout:\n${stdout}` : '',
        stderr ? `stderr:\n${stderr}` : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
    );
  }

  return stdout;
}

function resolveRedpandaSaslContainerId(): string {
  const stdout = runDocker([
    'ps',
    '--filter',
    'label=com.docker.compose.service=redpanda-sasl',
    '--format',
    '{{.ID}}',
  ]);
  const id = stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(Boolean);

  if (!id) {
    throw new Error('Could not find a running redpanda-sasl Docker container.');
  }

  return id;
}

function execInRedpandaSasl(args: string[], opts?: { allowFailure?: boolean }): string {
  return runDocker(['exec', resolveRedpandaSaslContainerId(), ...args], opts);
}

async function ensureExtraSaslCoverageConfigured(): Promise<void> {
  if (extraSaslCoverageReady) {
    await extraSaslCoverageReady;
    return;
  }

  extraSaslCoverageReady = (async () => {
    const adminArgs = [
      'rpk',
      '-X',
      'brokers=localhost:9092',
      '-X',
      'user=superuser',
      '-X',
      'pass=secretpassword',
      '-X',
      'sasl.mechanism=SCRAM-SHA-256',
    ];

    const mechanisms = execInRedpandaSasl([
      ...adminArgs,
      'cluster',
      'config',
      'get',
      'sasl_mechanisms',
    ]);
    if (!mechanisms.includes('PLAIN')) {
      execInRedpandaSasl([
        ...adminArgs,
        'cluster',
        'config',
        'set',
        'sasl_mechanisms',
        '[SCRAM,PLAIN]',
      ]);
    }

    const users = execInRedpandaSasl([...adminArgs, 'security', 'user', 'list']);
    if (!users.includes(KAFKA_SASL_SCRAM_512.username)) {
      execInRedpandaSasl([
        ...adminArgs,
        'security',
        'user',
        'create',
        KAFKA_SASL_SCRAM_512.username,
        '-p',
        KAFKA_SASL_SCRAM_512.password,
        '--mechanism',
        'SCRAM-SHA-512',
      ]);
    }
  })();

  await extraSaslCoverageReady;
}

function createRedpandaAdminArgs(): string[] {
  return [
    'rpk',
    '-X',
    'brokers=localhost:9092',
    '-X',
    'user=superuser',
    '-X',
    'pass=secretpassword',
    '-X',
    'sasl.mechanism=SCRAM-SHA-256',
  ];
}

async function grantScram512RoundTripAcl(prefixes: {
  topicPrefix: string;
  groupPrefix: string;
}): Promise<void> {
  await ensureExtraSaslCoverageConfigured();

  const adminArgs = createRedpandaAdminArgs();
  execInRedpandaSasl([
    ...adminArgs,
    'security',
    'acl',
    'create',
    '--allow-principal',
    KAFKA_SASL_SCRAM_512.username,
    '--operation',
    'read',
    '--operation',
    'write',
    '--operation',
    'describe',
    '--topic',
    prefixes.topicPrefix,
    '--resource-pattern-type',
    'prefixed',
  ]);
  execInRedpandaSasl([
    ...adminArgs,
    'security',
    'acl',
    'create',
    '--allow-principal',
    KAFKA_SASL_SCRAM_512.username,
    '--operation',
    'read',
    '--operation',
    'describe',
    '--group',
    prefixes.groupPrefix,
    '--resource-pattern-type',
    'prefixed',
  ]);
}

async function createSecureProducer(sasl: SupportedSaslConfig = KAFKA_SASL) {
  const kafka = new Kafka({
    clientId: uniqueName('docker-sasl-producer'),
    brokers: [KAFKA_SASL_BROKER],
    sasl,
  });
  const producer = kafka.producer();
  await producer.connect();
  cleanup.push(async () => {
    await producer.disconnect().catch(() => {});
  });
  return producer;
}

async function ensureSecureTopic(
  topic: string,
  numPartitions = 1,
  sasl: SupportedSaslConfig = KAFKA_SASL,
): Promise<void> {
  const kafka = new Kafka({
    clientId: uniqueName('docker-sasl-admin'),
    brokers: [KAFKA_SASL_BROKER],
    sasl,
  });
  const admin = kafka.admin();
  await admin.connect();
  cleanup.push(async () => {
    await admin.disconnect().catch(() => {});
  });

  await admin.createTopics({
    topics: [{ topic, numPartitions, replicationFactor: 1 }],
  });
}

async function collectSecureMessages(
  topic: string,
  opts?: { fromBeginning?: boolean; groupId?: string; sasl?: SupportedSaslConfig },
): Promise<CollectedKafkaMessage[]> {
  const kafka = new Kafka({
    clientId: uniqueName('docker-sasl-consumer'),
    brokers: [KAFKA_SASL_BROKER],
    sasl: opts?.sasl ?? KAFKA_SASL,
  });
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
  const dir = join(process.cwd(), '.tmp', 'kafka-sasl-docker', uniqueName('manifest')).replaceAll(
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

afterEach(async () => {
  while (cleanup.length > 0) {
    const fn = cleanup.pop();
    await fn?.().catch(() => {});
  }
});

describe('Kafka SASL runtime paths (Docker)', () => {
  test('Kafka adapter round-trips through the SCRAM-enabled broker and warns when SSL is absent', async () => {
    const warned = mock((_message: unknown) => {});
    const originalWarn = console.warn;
    console.warn = warned;

    try {
      const bus = createKafkaAdapter({
        brokers: [KAFKA_SASL_BROKER],
        sasl: KAFKA_SASL,
        topicPrefix: uniqueName('slingshot.sasl.events'),
        groupPrefix: uniqueName('slingshot.sasl.groups'),
        startFromBeginning: true,
      });
      cleanup.push(() => bus.shutdown?.() ?? Promise.resolve());

      const introspection = getKafkaAdapterIntrospectionOrNull(bus);
      if (!introspection) {
        throw new Error('Kafka adapter introspection missing');
      }

      const topic = introspection.topicNameForEvent('auth:login');
      await ensureSecureTopic(topic);
      const received: Array<{ userId: string; sessionId: string }> = [];

      bus.on(
        'auth:login',
        payload => {
          received.push(payload);
        },
        { durable: true, name: uniqueName('scram-worker') },
      );

      await waitFor(
        () => bus.health().consumers[0]?.connected === true,
        15_000,
        'SCRAM adapter durable consumer did not connect',
      );
      await sleep(1_500);

      const producer = await createSecureProducer();
      await producer.send({
        topic,
        messages: [
          {
            key: 'secure-consume',
            value: Buffer.from(
              JSON.stringify({
                userId: 'secure-consume-user',
                sessionId: 'secure-consume-session',
              }),
            ),
          },
        ],
      });

      await waitFor(
        () => received.length === 1,
        15_000,
        'SCRAM adapter durable consume did not complete',
      );
      expect(received).toEqual([
        { userId: 'secure-consume-user', sessionId: 'secure-consume-session' },
      ]);

      const brokerMessages = await collectSecureMessages(topic);
      bus.emit('auth:login', {
        userId: 'secure-produce-user',
        sessionId: 'secure-produce-session',
      });

      await waitFor(
        () => brokerMessages.length === 1,
        15_000,
        'SCRAM adapter publish did not reach Kafka',
      );

      expect(JSON.parse(brokerMessages[0]!.value ?? '{}')).toEqual({
        userId: 'secure-produce-user',
        sessionId: 'secure-produce-session',
      });
      expect(
        warned.mock.calls.some(call => String(call[0]).includes('SASL configured without SSL')),
      ).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });

  test('Kafka connectors bridge events through the SCRAM-enabled broker and warn when SSL is absent', async () => {
    const warned = mock((_message: unknown) => {});
    const originalWarn = console.warn;
    console.warn = warned;

    try {
      const bus = createInProcessAdapter();
      const topic = uniqueName('external.secure.users');
      const received: Array<{ userId: string; email?: string }> = [];

      const connectors = createKafkaConnectors({
        brokers: [KAFKA_SASL_BROKER],
        sasl: KAFKA_SASL,
        inbound: [
          {
            topic,
            groupId: uniqueName('secure-sync'),
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
        userId: 'secure-connector-user',
        email: 'secure@example.com',
      });

      await waitFor(
        () => received.length === 1,
        15_000,
        'SCRAM connectors did not bridge the event through Kafka',
      );

      expect(received).toEqual([{ userId: 'secure-connector-user', email: 'secure@example.com' }]);
      expect(
        warned.mock.calls.some(call => String(call[0]).includes('SASL configured without SSL')),
      ).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });

  test('Kafka adapter round-trips through the SASL-enabled broker using SCRAM-SHA-512', async () => {
    const topicPrefix = uniqueName('slingshot.sasl512.events');
    const groupPrefix = uniqueName('slingshot.sasl512.groups');
    await grantScram512RoundTripAcl({ topicPrefix, groupPrefix });

    const bus = createKafkaAdapter({
      brokers: [KAFKA_SASL_BROKER],
      sasl: KAFKA_SASL_SCRAM_512,
      topicPrefix,
      groupPrefix,
      autoCreateTopics: false,
      startFromBeginning: true,
    });
    cleanup.push(() => bus.shutdown?.() ?? Promise.resolve());

    const introspection = getKafkaAdapterIntrospectionOrNull(bus);
    if (!introspection) {
      throw new Error('Kafka adapter introspection missing');
    }

    const topic = introspection.topicNameForEvent('auth:login');
    await ensureSecureTopic(topic, 1, KAFKA_SASL);
    const received: Array<{ userId: string; sessionId: string }> = [];

    bus.on(
      'auth:login',
      payload => {
        received.push(payload);
      },
      { durable: true, name: uniqueName('scram512-worker') },
    );

    await waitFor(
      () => bus.health().consumers[0]?.connected === true,
      15_000,
      'SCRAM-SHA-512 adapter durable consumer did not connect',
    );
    await sleep(1_500);

    const producer = await createSecureProducer(KAFKA_SASL_SCRAM_512);
    await producer.send({
      topic,
      messages: [
        {
          key: 'scram512-consume',
          value: Buffer.from(
            JSON.stringify({
              userId: 'scram512-consume-user',
              sessionId: 'scram512-consume-session',
            }),
          ),
        },
      ],
    });

    await waitFor(
      () => received.length === 1,
      15_000,
      'SCRAM-SHA-512 adapter durable consume did not complete',
    );
    expect(received).toEqual([
      { userId: 'scram512-consume-user', sessionId: 'scram512-consume-session' },
    ]);

    const brokerMessages = await collectSecureMessages(topic, {
      sasl: KAFKA_SASL_SCRAM_512,
      groupId: `${groupPrefix}.collector`,
    });
    bus.emit('auth:login', {
      userId: 'scram512-produce-user',
      sessionId: 'scram512-produce-session',
    });

    await waitFor(
      () => brokerMessages.length === 1,
      15_000,
      'SCRAM-SHA-512 adapter publish did not reach Kafka',
    );

    expect(JSON.parse(brokerMessages[0]!.value ?? '{}')).toEqual({
      userId: 'scram512-produce-user',
      sessionId: 'scram512-produce-session',
    });
  });

  test('Kafka connectors bridge events through the SASL-enabled broker using PLAIN', async () => {
    await ensureExtraSaslCoverageConfigured();

    const bus = createInProcessAdapter();
    const topic = uniqueName('external.plain.users');
    const received: Array<{ userId: string; email?: string }> = [];

    const connectors = createKafkaConnectors({
      brokers: [KAFKA_SASL_BROKER],
      sasl: KAFKA_SASL_PLAIN,
      inbound: [
        {
          topic,
          groupId: uniqueName('plain-sync'),
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
      userId: 'plain-connector-user',
      email: 'plain@example.com',
    });

    await waitFor(
      () => received.length === 1,
      15_000,
      'PLAIN connectors did not bridge the event through Kafka',
    );

    expect(received).toEqual([{ userId: 'plain-connector-user', email: 'plain@example.com' }]);
  });

  test('Kafka connectors fail fast against the SCRAM-enabled broker when credentials are wrong', async () => {
    const connectors = createKafkaConnectors({
      brokers: [KAFKA_SASL_BROKER],
      sasl: {
        mechanism: 'scram-sha-256',
        username: 'superuser',
        password: 'wrong-password',
      },
      outbound: [
        {
          event: 'auth:user.created',
          topic: uniqueName('external.badcreds'),
        },
      ],
    });
    cleanup.push(() => connectors.stop());

    await expect(connectors.start(createInProcessAdapter())).rejects.toThrow();
  });

  test('manifest bootstrap connects to the SCRAM-enabled broker using Kafka secret env vars', async () => {
    const previousEnv = {
      KAFKA_BROKERS: process.env.KAFKA_BROKERS,
      KAFKA_CLIENT_ID: process.env.KAFKA_CLIENT_ID,
      KAFKA_SASL_USERNAME: process.env.KAFKA_SASL_USERNAME,
      KAFKA_SASL_PASSWORD: process.env.KAFKA_SASL_PASSWORD,
      KAFKA_SASL_MECHANISM: process.env.KAFKA_SASL_MECHANISM,
      KAFKA_SSL: process.env.KAFKA_SSL,
    };
    process.env.KAFKA_BROKERS = KAFKA_SASL_BROKER;
    process.env.KAFKA_CLIENT_ID = uniqueName('manifest-sasl');
    process.env.KAFKA_SASL_USERNAME = KAFKA_SASL.username;
    process.env.KAFKA_SASL_PASSWORD = KAFKA_SASL.password;
    process.env.KAFKA_SASL_MECHANISM = KAFKA_SASL.mechanism;
    delete process.env.KAFKA_SSL;

    cleanup.push(async () => {
      if (previousEnv.KAFKA_BROKERS !== undefined)
        process.env.KAFKA_BROKERS = previousEnv.KAFKA_BROKERS;
      else delete process.env.KAFKA_BROKERS;
      if (previousEnv.KAFKA_CLIENT_ID !== undefined)
        process.env.KAFKA_CLIENT_ID = previousEnv.KAFKA_CLIENT_ID;
      else delete process.env.KAFKA_CLIENT_ID;
      if (previousEnv.KAFKA_SASL_USERNAME !== undefined)
        process.env.KAFKA_SASL_USERNAME = previousEnv.KAFKA_SASL_USERNAME;
      else delete process.env.KAFKA_SASL_USERNAME;
      if (previousEnv.KAFKA_SASL_PASSWORD !== undefined)
        process.env.KAFKA_SASL_PASSWORD = previousEnv.KAFKA_SASL_PASSWORD;
      else delete process.env.KAFKA_SASL_PASSWORD;
      if (previousEnv.KAFKA_SASL_MECHANISM !== undefined)
        process.env.KAFKA_SASL_MECHANISM = previousEnv.KAFKA_SASL_MECHANISM;
      else delete process.env.KAFKA_SASL_MECHANISM;
      if (previousEnv.KAFKA_SSL !== undefined) process.env.KAFKA_SSL = previousEnv.KAFKA_SSL;
      else delete process.env.KAFKA_SSL;
    });

    const inboundTopic = uniqueName('manifest.sasl.inbound');
    const outboundTopic = uniqueName('manifest.sasl.outbound');
    await ensureSecureTopic(inboundTopic);
    await ensureSecureTopic(outboundTopic);
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

    const warned = mock((_message: unknown) => {});
    const originalWarn = console.warn;
    console.warn = warned;

    try {
      const manifest = await createTempManifest({
        manifestVersion: 1,
        handlers: false,
        port: 0,
        meta: { name: 'Kafka SASL Docker Manifest', version: '1.0.0' },
        security: { rateLimit: false },
        db: {
          sqlite: `${process.cwd().replaceAll('\\', '/')}/.tmp/${uniqueName('manifest-sasl-db')}.sqlite`,
          auth: 'sqlite',
          sessions: 'sqlite',
          redis: false,
        },
        eventBus: {
          type: 'kafka',
          config: {
            topicPrefix: uniqueName('manifest.sasl.events'),
            groupPrefix: uniqueName('manifest.sasl.groups'),
          },
        },
        kafkaConnectors: {
          inbound: [
            {
              topic: inboundTopic,
              groupId: uniqueName('manifest-sasl-inbound'),
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

      const outboundMessages = await collectSecureMessages(outboundTopic);

      ctx.bus.emit('auth:user.created', {
        userId: 'manifest-sasl-user',
        email: 'manifest-sasl@example.com',
      } as never);

      await waitFor(
        () => outboundMessages.length === 1,
        15_000,
        'Manifest SASL outbound connector did not publish to Kafka',
      );
      expect(JSON.parse(outboundMessages[0]!.value ?? '{}')).toEqual({
        userId: 'manifest-sasl-user',
        email: 'manifest-sasl@example.com',
      });

      const producer = await createSecureProducer();
      await producer.send({
        topic: inboundTopic,
        messages: [
          {
            key: 'secure-inbound-1',
            value: Buffer.from(JSON.stringify({ id: 'secure-inbound-1' })),
          },
        ],
      });

      await waitFor(
        () => inboundPayloads.length === 1,
        15_000,
        'Manifest SASL inbound connector did not receive the Kafka message',
      );
      expect(inboundPayloads[0]?.payload).toEqual({ id: 'secure-inbound-1' });
      expect(inboundPayloads[0]?.metadata['topic']).toBe(inboundTopic);
      expect(
        warned.mock.calls.some(call =>
          String(call[0]).includes('Kafka SASL credentials configured without SSL'),
        ),
      ).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });
});
