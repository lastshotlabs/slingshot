import type {
  FrameworkSecretsLiteral,
  RegisteredSecretRepository,
  SecretStoreConfig,
} from '@framework/secrets';
import type { SecretRepository } from '@lastshotlabs/slingshot-core';

export type SecretsConfig =
  | FrameworkSecretsLiteral
  | SecretRepository
  | SecretStoreConfig
  | RegisteredSecretRepository;
