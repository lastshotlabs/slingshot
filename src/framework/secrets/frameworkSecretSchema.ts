/**
 * Framework-level secret schema — declares all secrets the Slingshot
 * framework itself needs. All marked required: false because which
 * ones are actually needed depends on DbConfig (validated downstream
 * in connectRedis/connectMongo/etc.).
 *
 * App-specific secrets (OAuth client secrets, webhook signing keys, etc.)
 * are declared by plugins or user code via their own schemas.
 */
import type { SecretSchema } from '@lastshotlabs/slingshot-core';

export const frameworkSecretSchema = {
  // Signing & encryption
  jwtSecret: { path: 'JWT_SECRET', required: false },
  bearerToken: { path: 'BEARER_TOKEN', required: false },
  dataEncryptionKey: { path: 'SLINGSHOT_DATA_ENCRYPTION_KEY', required: false },

  // Redis
  redisHost: { path: 'REDIS_HOST', required: false },
  redisUser: { path: 'REDIS_USER', required: false },
  redisPassword: { path: 'REDIS_PASSWORD', required: false },

  // Kafka
  kafkaBrokers: { path: 'KAFKA_BROKERS', required: false },
  kafkaClientId: { path: 'KAFKA_CLIENT_ID', required: false },
  kafkaSaslUser: { path: 'KAFKA_SASL_USERNAME', required: false },
  kafkaSaslPass: { path: 'KAFKA_SASL_PASSWORD', required: false },
  kafkaSaslMech: { path: 'KAFKA_SASL_MECHANISM', required: false },
  kafkaSsl: { path: 'KAFKA_SSL', required: false },

  // Mongo (primary / single mode)
  mongoUrl: { path: 'MONGO_URL', required: false },
  mongoUser: { path: 'MONGO_USER', required: false },
  mongoPassword: { path: 'MONGO_PASSWORD', required: false },
  mongoHost: { path: 'MONGO_HOST', required: false },
  mongoDb: { path: 'MONGO_DB', required: false },

  // Mongo (auth — separate mode)
  mongoAuthUser: { path: 'MONGO_AUTH_USER', required: false },
  mongoAuthPassword: { path: 'MONGO_AUTH_PASSWORD', required: false },
  mongoAuthHost: { path: 'MONGO_AUTH_HOST', required: false },
  mongoAuthDb: { path: 'MONGO_AUTH_DB', required: false },
} as const satisfies SecretSchema;
