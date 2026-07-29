/** One checksum-versioned package-owned SQL migration. */
export interface EventReliabilityMigration {
  readonly version: number;
  readonly checksum: string;
  readonly statements: readonly string[];
}
