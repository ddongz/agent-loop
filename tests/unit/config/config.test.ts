import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ConfigStore } from "../../../src/config/config-store.js";
import { UserConfigSchema } from "../../../src/config/schema.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryConfigPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "sentinelloop-config-"));
  temporaryDirectories.push(directory);
  return join(directory, "config.json");
}

function validConfig() {
  return {
    schemaVersion: 1 as const,
    profiles: {
      default: {
        baseUrl: "https://api.example.test/v1",
        model: "test-model",
        allowedHeaderNames: ["X-Tenant"],
        policies: { maxIterations: 6, maxDurationMs: 120_000 },
      },
    },
  };
}

describe("user configuration", () => {
  it("round-trips only schema-validated non-secret profile fields", async () => {
    const path = await temporaryConfigPath();
    const store = new ConfigStore(path);

    await store.save(validConfig());

    expect(await store.load()).toEqual(validConfig());
    const persisted = await readFile(path, "utf8");
    expect(persisted).not.toMatch(/api.?key|secret|authorization/i);
  });

  it("atomically replaces an existing configuration", async () => {
    const path = await temporaryConfigPath();
    const store = new ConfigStore(path);
    await store.save(validConfig());
    const updated = {
      ...validConfig(),
      profiles: { default: { ...validConfig().profiles.default, model: "updated-model" } },
    };

    await store.save(updated);

    expect(await store.load()).toEqual(updated);
  });

  it("rejects unknown fields instead of persisting credential-shaped data", () => {
    expect(() => UserConfigSchema.parse({
      ...validConfig(),
      profiles: { default: { ...validConfig().profiles.default, apiKey: "must-not-persist" } },
    })).toThrow();
  });

  it("rejects base URLs that embed credentials", () => {
    expect(() => UserConfigSchema.parse({
      ...validConfig(),
      profiles: {
        default: { ...validConfig().profiles.default, baseUrl: "https://api-key@example.test/v1" },
      },
    })).toThrow();
  });

  it.each(["Authorization", "proxy-authorization", "Cookie", "Bad Header", "X-Line\nBreak"])(
    "rejects unsafe allowed header name %s",
    (header) => {
      expect(() => UserConfigSchema.parse({
        ...validConfig(),
        profiles: { default: { ...validConfig().profiles.default, allowedHeaderNames: [header] } },
      })).toThrow();
    },
  );
});
