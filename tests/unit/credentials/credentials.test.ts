import { describe, expect, it } from "vitest";

import { MemoryCredentialStore } from "../../../src/credentials/memory-store.js";
import { PlatformCredentialStore, type ProcessRequest, type ProcessRunner } from "../../../src/credentials/platform-store.js";
import { createRedactor, redactText } from "../../../src/credentials/redaction.js";

describe("credentials", () => {
  it("supports the credential lifecycle while metadata reveals no key fragment", async () => {
    const store = new MemoryCredentialStore(() => "2026-08-14T08:00:00.000Z");
    const secret = "opaque-value-4nY7q";

    await store.set("default", secret);

    expect(await store.get("default")).toBe(secret);
    expect(await store.metadata("default")).toEqual({ configured: true, updatedAt: "2026-08-14T08:00:00.000Z" });
    expect(JSON.stringify(await store.metadata("default"))).not.toContain(secret.slice(0, 6));
    expect(await store.delete("default")).toBe(true);
    expect(await store.metadata("default")).toEqual({ configured: false, updatedAt: null });
  });

  it("redacts exact values and common credential patterns recursively", () => {
    const secret = "opaque-value-4nY7q";
    const redact = createRedactor([secret]);
    const redacted = redact({
      message: `failed with ${secret}`,
      nested: [{ authorization: "Bearer sk-test-1234567890abcdef" }],
    });

    expect(JSON.stringify(redacted)).not.toContain(secret);
    expect(JSON.stringify(redacted)).not.toContain("sk-test-1234567890abcdef");
    expect(redactText(`token=${secret}`, [secret])).toBe("token=[REDACTED]");
  });

  it.each([
    ["win32", "powershell.exe"],
    ["linux", "secret-tool"],
  ] as const)("passes secrets to the %s backend only through stdin with shell disabled", async (platform, executable) => {
    const requests: ProcessRequest[] = [];
    const runner: ProcessRunner = {
      run: async (request) => {
        requests.push(request);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    const secret = "opaque-value-4nY7q";
    const store = new PlatformCredentialStore({ platform, runner, now: () => "2026-08-14T08:00:00.000Z" });

    await store.set("team", secret);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ executable, shell: false });
    expect(requests[0]!.args.join(" ")).not.toContain(secret);
    expect(requests[0]!.stdin).toContain(secret);
  });

  it("fails closed on macOS set without putting the secret in argv or an error", async () => {
    const requests: ProcessRequest[] = [];
    const runner: ProcessRunner = {
      run: async (request) => {
        requests.push(request);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    const secret = "opaque-value-4nY7q";
    const store = new PlatformCredentialStore({ platform: "darwin", runner });

    const error = await store.set("team", secret).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "CREDENTIAL_BACKEND_UNAVAILABLE" });
    expect(String(error)).toContain("macOS");
    expect(String(error)).not.toContain(secret);
    expect(requests.flatMap((request) => request.args).join(" ")).not.toContain(secret);
    expect(requests).toHaveLength(0);
  });

  it("keeps macOS credential lookup structured and free of secret arguments", async () => {
    const requests: ProcessRequest[] = [];
    const runner: ProcessRunner = {
      run: async (request) => {
        requests.push(request);
        return {
          exitCode: 0,
          stdout: JSON.stringify({ secret: "stored-value", updatedAt: "2026-08-14T08:00:00.000Z" }),
          stderr: "",
        };
      },
    };
    const store = new PlatformCredentialStore({ platform: "darwin", runner });

    expect(await store.metadata("team")).toEqual({ configured: true, updatedAt: "2026-08-14T08:00:00.000Z" });
    expect(requests[0]).toMatchObject({ executable: "security", shell: false, stdin: "" });
    expect(requests[0]!.args).toEqual(["find-generic-password", "-a", "team", "-s", "SentinelLoop", "-w"]);
  });

  it("turns a missing platform command into an actionable hard error without plaintext fallback", async () => {
    const runner: ProcessRunner = {
      run: async () => {
        const error = new Error("spawn secret-tool ENOENT") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      },
    };
    const store = new PlatformCredentialStore({ platform: "linux", runner });

    const error = await store.set("default", "opaque-value-4nY7q").catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "CREDENTIAL_BACKEND_UNAVAILABLE" });
    expect(String(error)).not.toContain("opaque-value-4nY7q");
  });
});
