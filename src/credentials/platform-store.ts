/// <reference types="node" />

import { spawn } from "node:child_process";

import { SentinelError } from "../domain/error.js";
import { assertCredentialProfile, type CredentialMetadata, type CredentialStore } from "./types.js";

export interface ProcessRequest {
  executable: string;
  args: string[];
  stdin: string;
  shell: false;
  timeoutMs?: number;
}

export interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface ProcessRunner {
  run(request: ProcessRequest): Promise<ProcessResult>;
}

export class SpawnProcessRunner implements ProcessRunner {
  async run(request: ProcessRequest): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(request.executable, request.args, {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      const limit = 64 * 1024;
      const timeout = setTimeout(() => child.kill(), request.timeoutMs ?? 10_000);
      child.once("error", reject);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout = `${stdout}${chunk}`.slice(0, limit); });
      child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(0, limit); });
      child.once("close", (exitCode) => {
        clearTimeout(timeout);
        resolve({ exitCode, stdout, stderr });
      });
      child.stdin.end(request.stdin);
    });
  }
}

type SupportedPlatform = "win32" | "darwin" | "linux";

export interface PlatformCredentialStoreOptions {
  platform?: NodeJS.Platform;
  runner?: ProcessRunner;
  now?: () => string;
  service?: string;
}

interface SecureRecord {
  secret: string;
  updatedAt: string;
}

const windowsScript = [
  "param([string]$Operation,[string]$Profile,[string]$Resource)",
  "$vault = New-Object Windows.Security.Credentials.PasswordVault",
  "if ($Operation -eq 'set') {",
  "  $value = [Console]::In.ReadToEnd().TrimEnd([char]13,[char]10)",
  "  try { $old = $vault.Retrieve($Resource,$Profile); $vault.Remove($old) } catch {}",
  "  $vault.Add((New-Object Windows.Security.Credentials.PasswordCredential($Resource,$Profile,$value)))",
  "} elseif ($Operation -eq 'get') {",
  "  try { $item = $vault.Retrieve($Resource,$Profile); $item.RetrievePassword(); [Console]::Out.Write($item.Password) } catch { exit 1 }",
  "} elseif ($Operation -eq 'delete') {",
  "  try { $item = $vault.Retrieve($Resource,$Profile); $vault.Remove($item) } catch { exit 1 }",
  "}",
].join("; ");

export class PlatformCredentialStore implements CredentialStore {
  readonly #platform: SupportedPlatform;
  readonly #runner: ProcessRunner;
  readonly #now: () => string;
  readonly #service: string;

  constructor(options: PlatformCredentialStoreOptions = {}) {
    const platform = options.platform ?? process.platform;
    if (!isSupported(platform)) {
      throw backendError(`Platform ${platform} has no supported credential manager.`);
    }
    this.#platform = platform;
    this.#runner = options.runner ?? new SpawnProcessRunner();
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#service = options.service ?? "SentinelLoop";
  }

  async set(profile: string, secret: string): Promise<void> {
    this.#assertInput(profile, secret);
    if (this.#platform === "darwin") {
      throw backendError("macOS auth set is disabled because the security CLI accepts the password through argv; use an approved native Keychain integration and retry.");
    }
    const record = JSON.stringify({ secret, updatedAt: this.#now() } satisfies SecureRecord);
    const result = await this.#invoke("set", profile, `${record}\n`);
    if (result.exitCode !== 0) throw backendError(this.#recoveryMessage());
  }

  async get(profile: string): Promise<string | null> {
    const record = await this.#read(profile);
    return record?.secret ?? null;
  }

  async delete(profile: string): Promise<boolean> {
    this.#assertProfile(profile);
    const result = await this.#invoke("delete", profile, "");
    return result.exitCode === 0;
  }

  async metadata(profile: string): Promise<CredentialMetadata> {
    const record = await this.#read(profile);
    return record === null ? { configured: false, updatedAt: null } : { configured: true, updatedAt: record.updatedAt };
  }

  async #read(profile: string): Promise<SecureRecord | null> {
    this.#assertProfile(profile);
    const result = await this.#invoke("get", profile, "");
    if (result.exitCode !== 0 || result.stdout.trim().length === 0) return null;
    try {
      const value = JSON.parse(result.stdout.trim()) as Partial<SecureRecord>;
      if (typeof value.secret !== "string" || typeof value.updatedAt !== "string") throw new Error("Invalid credential record.");
      return { secret: value.secret, updatedAt: value.updatedAt };
    } catch (error) {
      throw backendError("The system credential entry is unreadable; clear it and run auth set again.", error);
    }
  }

  async #invoke(operation: "set" | "get" | "delete", profile: string, stdin: string): Promise<ProcessResult> {
    const request = commandFor(this.#platform, operation, profile, this.#service, stdin);
    try {
      return await this.#runner.run(request);
    } catch (error) {
      throw backendError(this.#recoveryMessage(), error);
    }
  }

  #assertInput(profile: string, secret: string): void {
    this.#assertProfile(profile);
    if (secret.length === 0) throw new SentinelError({ code: "INVALID_INPUT", message: "API key cannot be empty." });
  }

  #assertProfile(profile: string): void {
    try {
      assertCredentialProfile(profile);
    } catch (error) {
      throw new SentinelError({ code: "INVALID_INPUT", message: "Credential profile name is invalid.", cause: error });
    }
  }

  #recoveryMessage(): string {
    if (this.#platform === "linux") return "System credential storage is unavailable; install and unlock secret-tool/libsecret, then retry.";
    if (this.#platform === "darwin") return "macOS Keychain is unavailable; unlock the login keychain, then retry.";
    return "Windows PasswordVault is unavailable; verify the user credential service, then retry.";
  }
}

function commandFor(platform: SupportedPlatform, operation: "set" | "get" | "delete", profile: string, service: string, stdin: string): ProcessRequest {
  if (platform === "win32") {
    return { executable: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", windowsScript, operation, profile, service], stdin, shell: false };
  }
  if (platform === "darwin") {
    const verb = operation === "get" ? ["find-generic-password", "-a", profile, "-s", service, "-w"]
        : ["delete-generic-password", "-a", profile, "-s", service];
    return { executable: "security", args: verb, stdin, shell: false };
  }
  const attributes = ["service", service.toLowerCase(), "profile", profile];
  const args = operation === "set" ? ["store", "--label", service, ...attributes]
    : operation === "get" ? ["lookup", ...attributes]
      : ["clear", ...attributes];
  return { executable: "secret-tool", args, stdin, shell: false };
}

function isSupported(platform: NodeJS.Platform): platform is SupportedPlatform {
  return platform === "win32" || platform === "darwin" || platform === "linux";
}

function backendError(message: string, cause?: unknown): SentinelError {
  return new SentinelError({ code: "CREDENTIAL_BACKEND_UNAVAILABLE", message, cause });
}
