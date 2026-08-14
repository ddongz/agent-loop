export interface CredentialMetadata {
  configured: boolean;
  updatedAt: string | null;
}

export interface CredentialStore {
  set(profile: string, secret: string): Promise<void>;
  get(profile: string): Promise<string | null>;
  delete(profile: string): Promise<boolean>;
  metadata(profile: string): Promise<CredentialMetadata>;
}

export function assertCredentialProfile(profile: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profile)) {
    throw new Error("Credential profile must be a safe name between 1 and 64 characters.");
  }
}
