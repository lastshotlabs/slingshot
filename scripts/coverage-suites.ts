export interface CoverageSuite {
  name: string;
  coverageDir: string;
  command: string[];
}

const coverageReporterArgs = ['--coverage-reporter', 'text', '--coverage-reporter', 'lcov'];

export const coverageSuites: CoverageSuite[] = [
  {
    name: 'root',
    coverageDir: 'coverage/root',
    command: ['scripts/run-root-coverage.ts'],
  },
  {
    name: 'slingshot-core',
    coverageDir: 'coverage/slingshot-core',
    command: [
      'test',
      '--coverage',
      ...coverageReporterArgs,
      '--coverage-dir',
      'coverage/slingshot-core',
      '--config',
      'packages/slingshot-core/bunfig.toml',
      'packages/slingshot-core/tests',
    ],
  },
  {
    name: 'slingshot-permissions',
    coverageDir: 'coverage/slingshot-permissions',
    command: [
      'test',
      '--coverage',
      ...coverageReporterArgs,
      '--coverage-dir',
      'coverage/slingshot-permissions',
      '--config',
      'packages/slingshot-permissions/bunfig.toml',
      'packages/slingshot-permissions/tests',
    ],
  },
  {
    name: 'slingshot-notifications',
    coverageDir: 'coverage/slingshot-notifications',
    command: [
      'test',
      '--coverage',
      ...coverageReporterArgs,
      '--coverage-dir',
      'coverage/slingshot-notifications',
      'packages/slingshot-notifications/tests',
    ],
  },
  {
    name: 'slingshot-interactions',
    coverageDir: 'coverage/slingshot-interactions',
    command: [
      'test',
      '--coverage',
      ...coverageReporterArgs,
      '--coverage-dir',
      'coverage/slingshot-interactions',
      'packages/slingshot-interactions/tests',
    ],
  },
  {
    name: 'slingshot-embeds',
    coverageDir: 'coverage/slingshot-embeds',
    command: [
      'test',
      '--coverage',
      ...coverageReporterArgs,
      '--coverage-dir',
      'coverage/slingshot-embeds',
      'packages/slingshot-embeds/tests',
    ],
  },
  {
    name: 'slingshot-gifs',
    coverageDir: 'coverage/slingshot-gifs',
    command: [
      'test',
      '--coverage',
      ...coverageReporterArgs,
      '--coverage-dir',
      'coverage/slingshot-gifs',
      'packages/slingshot-gifs/tests',
    ],
  },
  {
    name: 'slingshot-emoji',
    coverageDir: 'coverage/slingshot-emoji',
    command: [
      'test',
      '--coverage',
      ...coverageReporterArgs,
      '--coverage-dir',
      'coverage/slingshot-emoji',
      'packages/slingshot-emoji/tests',
    ],
  },
  {
    name: 'runtime-bun',
    coverageDir: 'coverage/runtime-bun',
    command: [
      'test',
      '--coverage',
      ...coverageReporterArgs,
      '--coverage-dir',
      'coverage/runtime-bun',
      'packages/runtime-bun/tests',
    ],
  },
  {
    name: 'slingshot-oidc',
    coverageDir: 'coverage/slingshot-oidc',
    command: [
      'test',
      '--coverage',
      ...coverageReporterArgs,
      '--coverage-dir',
      'coverage/slingshot-oidc',
      '--config',
      'packages/slingshot-oidc/bunfig.toml',
      'packages/slingshot-oidc/tests',
    ],
  },
  {
    name: 'slingshot-scim',
    coverageDir: 'coverage/slingshot-scim',
    command: [
      'test',
      '--coverage',
      ...coverageReporterArgs,
      '--coverage-dir',
      'coverage/slingshot-scim',
      '--config',
      'packages/slingshot-scim/bunfig.toml',
      'packages/slingshot-scim/tests',
    ],
  },
  {
    name: 'slingshot-m2m',
    coverageDir: 'coverage/slingshot-m2m',
    command: [
      'test',
      '--coverage',
      ...coverageReporterArgs,
      '--coverage-dir',
      'coverage/slingshot-m2m',
      '--config',
      'packages/slingshot-m2m/bunfig.toml',
      'packages/slingshot-m2m/tests',
    ],
  },
];

export function coverageArtifactPath(suite: CoverageSuite): string {
  return `${suite.coverageDir}/lcov.info`;
}
