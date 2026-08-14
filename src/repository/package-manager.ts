import { SentinelError } from "../domain/error.js";

export type PackageManager = "npm" | "pnpm" | "yarn";

const packageManagerByLockfile = {
  "package-lock.json": "npm",
  "pnpm-lock.yaml": "pnpm",
  "yarn.lock": "yarn",
} as const satisfies Record<string, PackageManager>;

export function discoverPackageManager(files: readonly string[]): PackageManager {
  const discovered = Object.entries(packageManagerByLockfile).filter(([lockfile]) => files.includes(lockfile));

  if (discovered.length > 1) {
    throw new SentinelError({
      code: "PACKAGE_MANAGER_CONFLICT",
      message: `Conflicting package-manager lockfiles: ${discovered.map(([lockfile]) => lockfile).join(", ")}.`,
      detail: { lockfiles: discovered.map(([lockfile]) => lockfile) },
    });
  }

  if (discovered.length === 0) {
    throw new SentinelError({
      code: "INVALID_INPUT",
      message: "No supported package-manager lockfile was found (package-lock.json, pnpm-lock.yaml, or yarn.lock).",
    });
  }

  return discovered[0]![1];
}
