export interface SamlProfile {
  nameId: string;
  nameIdFormat?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  displayName?: string;
  groups?: string[];
  attributes: Record<string, string | string[]>;
}
