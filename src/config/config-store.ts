/// <reference types="node" />

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { SentinelError } from "../domain/error.js";
import { EmptyUserConfig, UserConfigSchema, type UserConfig } from "./schema.js";

export class ConfigStore {
  constructor(private readonly path: string) {}

  async load(): Promise<UserConfig> {
    try {
      return UserConfigSchema.parse(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return structuredClone(EmptyUserConfig);
      throw new SentinelError({
        code: "INVALID_CONFIG",
        message: "User configuration is missing required fields or contains unsafe values.",
        detail: { path: this.path },
        cause: error,
      });
    }
  }

  async save(value: unknown): Promise<void> {
    let config: UserConfig;
    try {
      config = UserConfigSchema.parse(value);
    } catch (error) {
      throw new SentinelError({ code: "INVALID_CONFIG", message: "Refusing to persist invalid user configuration.", cause: error });
    }

    const temporaryPath = `${this.path}.tmp`;
    try {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, this.path);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw new SentinelError({
        code: "INVALID_CONFIG",
        message: "Could not persist user configuration.",
        detail: { path: this.path },
        cause: error,
      });
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
