import { SentinelError } from "../domain/error.js";
import { assertCredentialProfile, type CredentialMetadata, type CredentialStore } from "./types.js";

interface CredentialRecord {
  secret: string;
  updatedAt: string;
}

export class MemoryCredentialStore implements CredentialStore {
  readonly #records = new Map<string, CredentialRecord>();

  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  async set(profile: string, secret: string): Promise<void> {
    assertProfile(profile);
    if (secret.length === 0) throw new SentinelError({ code: "INVALID_INPUT", message: "API key cannot be empty." });
    this.#records.set(profile, { secret, updatedAt: this.now() });
  }

  async get(profile: string): Promise<string | null> {
    assertProfile(profile);
    return this.#records.get(profile)?.secret ?? null;
  }

  async delete(profile: string): Promise<boolean> {
    assertProfile(profile);
    return this.#records.delete(profile);
  }

  async metadata(profile: string): Promise<CredentialMetadata> {
    assertProfile(profile);
    const record = this.#records.get(profile);
    return record === undefined ? { configured: false, updatedAt: null } : { configured: true, updatedAt: record.updatedAt };
  }
}

function assertProfile(profile: string): void {
  try {
    assertCredentialProfile(profile);
  } catch (error) {
    throw new SentinelError({ code: "INVALID_INPUT", message: "Credential profile name is invalid.", cause: error });
  }
}
