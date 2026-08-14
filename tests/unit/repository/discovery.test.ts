import { describe, expect, it } from "vitest";

import { discoverPackageManager } from "../../../src/repository/package-manager.js";
import { discoverValidationPlan } from "../../../src/repository/validation-discovery.js";

describe("discoverPackageManager", () => {
  it.each([
    ["package-lock.json", "npm"],
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
  ] as const)("maps %s to %s", (lockfile, expected) => {
    expect(discoverPackageManager([lockfile])).toBe(expected);
  });

  it("rejects conflicting lockfiles", () => {
    expect(() => discoverPackageManager(["package-lock.json", "pnpm-lock.yaml"])).toThrowError(/conflicting/i);
  });

  it("rejects repositories without a supported lockfile", () => {
    expect(() => discoverPackageManager(["package.json", "src/index.ts"])).toThrowError(/lockfile/i);
  });
});

describe("discoverValidationPlan", () => {
  const scripts = {
    test: "vitest run",
    typecheck: "tsc --noEmit",
    lint: "eslint .",
    build: "tsc",
    deploy: "ignored",
  };

  it.each(["npm", "pnpm", "yarn"] as const)("discovers scripts in deterministic order for %s", (manager) => {
    expect(discoverValidationPlan({ scripts }, undefined, manager)).toEqual([
      { validator: "test", executable: manager, args: manager === "npm" ? ["run", "test"] : ["test"], timeoutMs: 300_000, enabled: true },
      { validator: "typecheck", executable: manager, args: manager === "npm" ? ["run", "typecheck"] : ["typecheck"], timeoutMs: 300_000, enabled: true },
      { validator: "lint", executable: manager, args: manager === "npm" ? ["run", "lint"] : ["lint"], timeoutMs: 300_000, enabled: true },
      { validator: "build", executable: manager, args: manager === "npm" ? ["run", "build"] : ["build"], timeoutMs: 300_000, enabled: true },
    ]);
  });

  it("requires a test script", () => {
    expect(() => discoverValidationPlan({ scripts: { lint: "eslint ." } }, undefined, "npm")).toThrowError(/test/i);
  });

  it.each([
    [{ scripts: { test: "" } }, undefined],
    [{ scripts: { lint: "eslint ." } }, { test: { enabled: true } }],
  ])("does not mistake an unusable test declaration for a command", (packageJson, override) => {
    expect(() => discoverValidationPlan(packageJson, override, "npm")).toThrowError(/test/i);
  });

  it("applies structured overrides without parsing shell strings", () => {
    expect(
      discoverValidationPlan(
        { scripts },
        { test: { executable: "node", args: ["./safe runner.mjs", "--ci"], timeoutMs: 12_345, enabled: true }, lint: { enabled: false } },
        "npm",
      ),
    ).toEqual([
      { validator: "test", executable: "node", args: ["./safe runner.mjs", "--ci"], timeoutMs: 12_345, enabled: true },
      { validator: "typecheck", executable: "npm", args: ["run", "typecheck"], timeoutMs: 300_000, enabled: true },
      { validator: "lint", executable: "npm", args: ["run", "lint"], timeoutMs: 300_000, enabled: false },
      { validator: "build", executable: "npm", args: ["run", "build"], timeoutMs: 300_000, enabled: true },
    ]);
  });

  it.each([
    { test: { executable: "npm test", args: [] } },
    { test: { executable: "npm", args: "test" } },
    { test: { executable: "npm", args: [], timeoutMs: 999 } },
    { unknown: { executable: "npm", args: ["test"] } },
  ])("rejects an invalid override: %j", (override) => {
    expect(() => discoverValidationPlan({ scripts }, override, "npm")).toThrowError();
  });
});
