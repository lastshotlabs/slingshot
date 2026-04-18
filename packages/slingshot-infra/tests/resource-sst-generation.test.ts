import { describe, expect, it } from 'bun:test';
import {
  type ResourceProvisionEntry,
  generateResourceSstConfig,
} from '../src/resource/generateResourceSst';

const BASE_OPTS = { org: 'acme', region: 'us-east-1', stageName: 'production' };

// ---------------------------------------------------------------------------
// Shared structure
// ---------------------------------------------------------------------------

describe('generateResourceSstConfig: shared structure', () => {
  it('generates a valid sst.config.ts wrapper', () => {
    const out = generateResourceSstConfig([{ name: 'db', type: 'postgres' }], BASE_OPTS);
    expect(out).toContain('/// <reference path="./.sst/platform/config.d.ts" />');
    expect(out).toContain('export default $config({');
    expect(out).toContain('name: "acme-resources"');
    expect(out).toContain('region: "us-east-1"');
    expect(out).toContain('async run()');
  });

  it('always generates a VPC', () => {
    const out = generateResourceSstConfig([{ name: 'cache', type: 'redis' }], BASE_OPTS);
    expect(out).toContain('new sst.aws.Vpc("ResourceVpc"');
    expect(out).toContain('nat: "managed"');
    expect(out).toContain('az: 2');
  });

  it('wraps each resource in section markers', () => {
    const out = generateResourceSstConfig([{ name: 'db', type: 'postgres' }], BASE_OPTS);
    expect(out).toContain('// --- section:resource-db ---');
    expect(out).toContain('// --- end:resource-db ---');
  });

  it('contains a return block with output exports', () => {
    const out = generateResourceSstConfig([{ name: 'db', type: 'postgres' }], BASE_OPTS);
    expect(out).toContain('return {');
    expect(out).toContain('dbHost:');
  });
});

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

describe('generateResourceSstConfig: postgres', () => {
  it('generates sst.aws.Postgres component', () => {
    const out = generateResourceSstConfig([{ name: 'db', type: 'postgres' }], BASE_OPTS);
    expect(out).toContain('new sst.aws.Postgres("Db"');
    expect(out).toContain('vpc,');
    expect(out).toContain('scaling:');
  });

  it('maps db.t3.micro to 0.5-2 ACU', () => {
    const out = generateResourceSstConfig(
      [{ name: 'db', type: 'postgres', instanceClass: 'db.t3.micro' }],
      BASE_OPTS,
    );
    expect(out).toContain('"0.5 ACU"');
    expect(out).toContain('"2 ACU"');
  });

  it('maps db.r5.xlarge to 4-32 ACU', () => {
    const out = generateResourceSstConfig(
      [{ name: 'db', type: 'postgres', instanceClass: 'db.r5.xlarge' }],
      BASE_OPTS,
    );
    expect(out).toContain('"4 ACU"');
    expect(out).toContain('"32 ACU"');
  });

  it('falls back to 0.5-4 ACU for unknown instance class', () => {
    const out = generateResourceSstConfig(
      [{ name: 'db', type: 'postgres', instanceClass: 'db.z99.unknown' }],
      BASE_OPTS,
    );
    expect(out).toContain('"0.5 ACU"');
    expect(out).toContain('"4 ACU"');
  });

  it('exports host, port, username, password, database', () => {
    const out = generateResourceSstConfig([{ name: 'db', type: 'postgres' }], BASE_OPTS);
    expect(out).toContain('dbHost: db.host,');
    expect(out).toContain('dbPort: db.port,');
    expect(out).toContain('dbUsername: db.username,');
    expect(out).toContain('dbPassword: db.password,');
    expect(out).toContain('dbDatabase: db.database,');
  });
});

// ---------------------------------------------------------------------------
// Redis
// ---------------------------------------------------------------------------

describe('generateResourceSstConfig: redis', () => {
  it('generates sst.aws.Redis component', () => {
    const out = generateResourceSstConfig([{ name: 'cache', type: 'redis' }], BASE_OPTS);
    expect(out).toContain('new sst.aws.Redis("Cache"');
    expect(out).toContain('vpc,');
  });

  it('exports host and port', () => {
    const out = generateResourceSstConfig([{ name: 'cache', type: 'redis' }], BASE_OPTS);
    expect(out).toContain('cacheHost: cache.host,');
    expect(out).toContain('cachePort: cache.port,');
  });

  it('does not include scaling block (handled by SST)', () => {
    const out = generateResourceSstConfig([{ name: 'cache', type: 'redis' }], BASE_OPTS);
    // Redis block should not contain "scaling:"
    const redisSection = out.slice(
      out.indexOf('// --- section:resource-cache ---'),
      out.indexOf('// --- end:resource-cache ---'),
    );
    expect(redisSection).not.toContain('scaling:');
  });
});

// ---------------------------------------------------------------------------
// Kafka
// ---------------------------------------------------------------------------

describe('generateResourceSstConfig: kafka', () => {
  it('generates raw Pulumi aws.msk.Cluster', () => {
    const out = generateResourceSstConfig([{ name: 'events', type: 'kafka' }], BASE_OPTS);
    expect(out).toContain('new aws.msk.Cluster("Events"');
    expect(out).toContain('numberOfBrokerNodes: 2');
  });

  it('uses default engine version 3.5.1', () => {
    const out = generateResourceSstConfig([{ name: 'events', type: 'kafka' }], BASE_OPTS);
    expect(out).toContain('kafkaVersion: "3.5.1"');
  });

  it('uses custom engine version', () => {
    const out = generateResourceSstConfig(
      [{ name: 'events', type: 'kafka', engineVersion: '3.6.0' }],
      BASE_OPTS,
    );
    expect(out).toContain('kafkaVersion: "3.6.0"');
  });

  it('uses default storage of 100 GB', () => {
    const out = generateResourceSstConfig([{ name: 'events', type: 'kafka' }], BASE_OPTS);
    expect(out).toContain('volumeSize: 100');
  });

  it('uses custom storage', () => {
    const out = generateResourceSstConfig(
      [{ name: 'events', type: 'kafka', storageGb: 250 }],
      BASE_OPTS,
    );
    expect(out).toContain('volumeSize: 250');
  });

  it('maps db.t3.medium to kafka.m5.large', () => {
    const out = generateResourceSstConfig(
      [{ name: 'events', type: 'kafka', instanceClass: 'db.t3.medium' }],
      BASE_OPTS,
    );
    expect(out).toContain('instanceType: "kafka.m5.large"');
  });

  it('passes through kafka.* instance types', () => {
    const out = generateResourceSstConfig(
      [{ name: 'events', type: 'kafka', instanceClass: 'kafka.m5.2xlarge' }],
      BASE_OPTS,
    );
    expect(out).toContain('instanceType: "kafka.m5.2xlarge"');
  });

  it('exports brokers', () => {
    const out = generateResourceSstConfig([{ name: 'events', type: 'kafka' }], BASE_OPTS);
    expect(out).toContain('eventsBrokers: eventsCluster.bootstrapBrokers,');
  });
});

// ---------------------------------------------------------------------------
// Mongo (DocumentDB-backed)
// ---------------------------------------------------------------------------

describe('generateResourceSstConfig: mongo', () => {
  it('generates aws.docdb.Cluster and ClusterInstance', () => {
    const out = generateResourceSstConfig([{ name: 'docs', type: 'mongo' }], BASE_OPTS);
    expect(out).toContain('new aws.docdb.Cluster("Docs"');
    expect(out).toContain('new aws.docdb.ClusterInstance("DocsInstance"');
  });

  it('uses engine docdb with default version 5.0.0', () => {
    const out = generateResourceSstConfig([{ name: 'docs', type: 'mongo' }], BASE_OPTS);
    expect(out).toContain('engine: "docdb"');
    expect(out).toContain('engineVersion: "5.0.0"');
  });

  it('uses custom engine version', () => {
    const out = generateResourceSstConfig(
      [{ name: 'docs', type: 'mongo', engineVersion: '6.0.0' }],
      BASE_OPTS,
    );
    expect(out).toContain('engineVersion: "6.0.0"');
  });

  it('uses sst.Secret for master password', () => {
    const out = generateResourceSstConfig([{ name: 'docs', type: 'mongo' }], BASE_OPTS);
    expect(out).toContain('new sst.Secret("DocsPassword")');
  });

  it('exports endpoint and port', () => {
    const out = generateResourceSstConfig([{ name: 'docs', type: 'mongo' }], BASE_OPTS);
    expect(out).toContain('docsEndpoint: docsCluster.endpoint,');
    expect(out).toContain('docsPort: docsCluster.port,');
  });
});

// ---------------------------------------------------------------------------
// DocumentDB
// ---------------------------------------------------------------------------

describe('generateResourceSstConfig: documentdb', () => {
  it('generates sst.Secret, aws.docdb.Cluster, and ClusterInstance', () => {
    const out = generateResourceSstConfig([{ name: 'store', type: 'documentdb' }], BASE_OPTS);
    expect(out).toContain('new sst.Secret("StorePassword")');
    expect(out).toContain('new aws.docdb.Cluster("Store"');
    expect(out).toContain('new aws.docdb.ClusterInstance("StoreInstance"');
  });

  it('uses default instance class db.t3.medium', () => {
    const out = generateResourceSstConfig([{ name: 'store', type: 'documentdb' }], BASE_OPTS);
    expect(out).toContain('instanceClass: "db.t3.medium"');
  });

  it('uses custom instance class', () => {
    const out = generateResourceSstConfig(
      [{ name: 'store', type: 'documentdb', instanceClass: 'db.r5.large' }],
      BASE_OPTS,
    );
    expect(out).toContain('instanceClass: "db.r5.large"');
  });

  it('exports host, port, username, password, database', () => {
    const out = generateResourceSstConfig([{ name: 'store', type: 'documentdb' }], BASE_OPTS);
    expect(out).toContain('storeHost: storeCluster.endpoint,');
    expect(out).toContain('storePort: storeCluster.port,');
    expect(out).toContain('storeUsername: "admin",');
    expect(out).toContain('storePassword: storePassword.value,');
    expect(out).toContain('storeDatabase: "acme",');
  });

  it('uses org name as default database', () => {
    const out = generateResourceSstConfig([{ name: 'store', type: 'documentdb' }], {
      ...BASE_OPTS,
      org: 'myorg',
    });
    expect(out).toContain('storeDatabase: "myorg",');
  });
});

// ---------------------------------------------------------------------------
// Name sanitization
// ---------------------------------------------------------------------------

describe('generateResourceSstConfig: name sanitization', () => {
  it('strips hyphens from resource names', () => {
    const out = generateResourceSstConfig([{ name: 'my-db', type: 'postgres' }], BASE_OPTS);
    // Variable name should be "mydb", component name "Mydb"
    expect(out).toContain('const mydb = new sst.aws.Postgres("Mydb"');
    expect(out).toContain('mydbHost: mydb.host,');
  });

  it('strips underscores from resource names', () => {
    const out = generateResourceSstConfig([{ name: 'cache_01', type: 'redis' }], BASE_OPTS);
    expect(out).toContain('const cache01 = new sst.aws.Redis("Cache01"');
  });
});

// ---------------------------------------------------------------------------
// Multi-resource
// ---------------------------------------------------------------------------

describe('generateResourceSstConfig: multi-resource', () => {
  it('generates blocks for all resources', () => {
    const resources: ResourceProvisionEntry[] = [
      { name: 'db', type: 'postgres' },
      { name: 'cache', type: 'redis' },
      { name: 'events', type: 'kafka' },
    ];
    const out = generateResourceSstConfig(resources, BASE_OPTS);

    expect(out).toContain('new sst.aws.Postgres("Db"');
    expect(out).toContain('new sst.aws.Redis("Cache"');
    expect(out).toContain('new aws.msk.Cluster("Events"');
  });

  it('combines output exports from all resources', () => {
    const resources: ResourceProvisionEntry[] = [
      { name: 'db', type: 'postgres' },
      { name: 'cache', type: 'redis' },
    ];
    const out = generateResourceSstConfig(resources, BASE_OPTS);

    expect(out).toContain('dbHost:');
    expect(out).toContain('dbDatabase:');
    expect(out).toContain('cacheHost:');
    expect(out).toContain('cachePort:');
  });

  it('uses custom region', () => {
    const out = generateResourceSstConfig([{ name: 'db', type: 'postgres' }], {
      ...BASE_OPTS,
      region: 'eu-west-1',
    });
    expect(out).toContain('region: "eu-west-1"');
  });
});
