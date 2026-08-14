import { z } from "zod";

import { SentinelError } from "../domain/error.js";
import type { ValidatorName } from "../domain/validation.js";
import type { PackageManager } from "./package-manager.js";

export interface ValidationCommand {
  validator: ValidatorName;
  executable: string;
  args: string[];
  timeoutMs: number;
  enabled: boolean;
}

export type ValidationPlan = ValidationCommand[];

const validatorOrder = ["test", "typecheck", "lint", "build"] as const satisfies readonly ValidatorName[];
const defaultTimeoutMs = 300_000;

const PackageJsonSchema = z.object({
  scripts: z.record(z.string(), z.string()).optional(),
}).passthrough();

const CommandOverrideSchema = z.object({
  executable: z.string().min(1).refine((value) => !/\s/.test(value), "executable must not contain whitespace"),
  args: z.array(z.string()),
  timeoutMs: z.number().int().min(1_000).optional(),
  enabled: z.boolean().optional(),
}).strict();

const EnabledOverrideSchema = z.object({ enabled: z.boolean() }).strict();
const ValidatorOverrideSchema = z.union([CommandOverrideSchema, EnabledOverrideSchema]);
const ValidationOverridesSchema = z.object({
  test: ValidatorOverrideSchema.optional(),
  typecheck: ValidatorOverrideSchema.optional(),
  lint: ValidatorOverrideSchema.optional(),
  build: ValidatorOverrideSchema.optional(),
}).strict();

export type ValidationOverrides = z.input<typeof ValidationOverridesSchema>;

export function discoverValidationPlan(
  packageJson: unknown,
  overrides: unknown,
  packageManager: PackageManager,
): ValidationPlan {
  const parsedPackage = parsePackageJson(packageJson);
  const parsedOverrides = parseOverrides(overrides);
  const scripts = parsedPackage.scripts ?? {};
  const hasTestScript = typeof scripts.test === "string" && scripts.test.trim().length > 0;
  const hasTestCommandOverride = parsedOverrides.test !== undefined && "executable" in parsedOverrides.test;

  if (!hasTestScript && !hasTestCommandOverride) {
    throw new SentinelError({ code: "TEST_COMMAND_MISSING", message: "package.json must define a test script or test override." });
  }

  const commands: ValidationCommand[] = [];
  for (const validator of validatorOrder) {
    const override = parsedOverrides[validator];
    const hasScript = typeof scripts[validator] === "string" && scripts[validator].trim().length > 0;
    const hasCommandOverride = override !== undefined && "executable" in override;
    if (!hasScript && !hasCommandOverride) continue;

    const discovered = scriptCommand(packageManager, validator);
    const command = override !== undefined && "executable" in override
      ? {
          validator,
          executable: override.executable,
          args: [...override.args],
          timeoutMs: override.timeoutMs ?? defaultTimeoutMs,
          enabled: override.enabled ?? true,
        }
      : {
          ...discovered,
          validator,
          timeoutMs: defaultTimeoutMs,
          enabled: override?.enabled ?? true,
        };

    if (validator === "test" && !command.enabled) {
      throw new SentinelError({ code: "TEST_COMMAND_MISSING", message: "The required test validator cannot be disabled." });
    }
    commands.push(command);
  }

  return commands;
}

function parsePackageJson(value: unknown): z.infer<typeof PackageJsonSchema> {
  const result = PackageJsonSchema.safeParse(value);
  if (!result.success) {
    throw new SentinelError({ code: "INVALID_INPUT", message: "package.json has an invalid scripts object.", detail: { reason: result.error.message } });
  }
  return result.data;
}

function parseOverrides(value: unknown): z.infer<typeof ValidationOverridesSchema> {
  const result = ValidationOverridesSchema.safeParse(value ?? {});
  if (!result.success) {
    throw new SentinelError({ code: "INVALID_CONFIG", message: "Validation overrides are invalid.", detail: { reason: result.error.message } });
  }
  return result.data;
}

function scriptCommand(packageManager: PackageManager, validator: ValidatorName): Pick<ValidationCommand, "executable" | "args"> {
  return packageManager === "npm"
    ? { executable: "npm", args: ["run", validator] }
    : { executable: packageManager, args: [validator] };
}
