/// <reference types="node" />

import type { ReadStream, WriteStream } from "node:tty";

import { SentinelError } from "../domain/error.js";
import type { CliIO } from "./program.js";

export class NodeCliIO implements CliIO {
  constructor(
    private readonly input: ReadStream = process.stdin,
    private readonly output: WriteStream = process.stdout,
    private readonly errorOutput: WriteStream = process.stderr,
  ) {}

  writeOut(text: string): void {
    this.output.write(text.endsWith("\n") ? text : `${text}\n`);
  }

  writeError(text: string): void {
    this.errorOutput.write(text.endsWith("\n") ? text : `${text}\n`);
  }

  async readSecret(prompt: string): Promise<string> {
    if (!this.input.isTTY || typeof this.input.setRawMode !== "function") {
      throw new SentinelError({ code: "INVALID_INPUT", message: "auth set requires an interactive TTY for hidden input." });
    }
    this.errorOutput.write(prompt);
    const priorRawMode = this.input.isRaw;
    this.input.setRawMode(true);
    this.input.resume();

    return new Promise((resolve, reject) => {
      let value = "";
      const cleanup = (): void => {
        this.input.off("data", onData);
        this.input.setRawMode(Boolean(priorRawMode));
        this.errorOutput.write("\n");
      };
      const onData = (data: Buffer): void => {
        for (const byte of data) {
          if (byte === 3) {
            cleanup();
            const error = new Error("User interrupted hidden input.");
            error.name = "AbortError";
            reject(error);
            return;
          }
          if (byte === 13 || byte === 10) {
            cleanup();
            resolve(value);
            return;
          }
          if (byte === 8 || byte === 127) value = value.slice(0, -1);
          else if (byte >= 32 && byte <= 126) value += String.fromCharCode(byte);
        }
      };
      this.input.on("data", onData);
    });
  }
}
