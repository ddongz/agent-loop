import { z } from "zod";

const forbiddenHeaders = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
]);

const HeaderNameSchema = z.string().min(1).max(128).refine(
  (name) => /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) && !forbiddenHeaders.has(name.toLowerCase()),
  "Header name is unsafe or reserved for credentials.",
);

export const ConfigProfileSchema = z.object({
  baseUrl: z.url().superRefine((value, context) => {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      context.addIssue({ code: "custom", message: "Base URL must use HTTP(S)." });
    }
    if (url.username.length > 0 || url.password.length > 0) {
      context.addIssue({ code: "custom", message: "Base URL cannot embed credentials." });
    }
  }),
  model: z.string().trim().min(1).max(256),
  allowedHeaderNames: z.array(HeaderNameSchema).max(32).superRefine((names, context) => {
    const normalized = names.map((name) => name.toLowerCase());
    if (new Set(normalized).size !== normalized.length) {
      context.addIssue({ code: "custom", message: "Allowed header names must be unique case-insensitively." });
    }
  }),
  policies: z.object({
    maxIterations: z.number().int().min(1).max(32),
    maxDurationMs: z.number().int().min(1_000),
  }).strict(),
}).strict();
export type ConfigProfile = z.infer<typeof ConfigProfileSchema>;

export const UserConfigSchema = z.object({
  schemaVersion: z.literal(1),
  profiles: z.record(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/), ConfigProfileSchema),
}).strict();
export type UserConfig = z.infer<typeof UserConfigSchema>;

export const EmptyUserConfig: UserConfig = { schemaVersion: 1, profiles: {} };
