import { spawn } from "node:child_process";
import type { CommandResult } from "../domain/types.js";

export interface RunCommandOptions {
  input?: string;
  timeoutMs?: number;
  inherit?: boolean;
  signal?: AbortSignal;
}
export interface CommandRunner {
  run(command: string, args: string[], options?: RunCommandOptions): Promise<CommandResult>;
}

export class SpawnCommandRunner implements CommandRunner {
  async run(
    command: string,
    args: string[],
    options: RunCommandOptions = {},
  ): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        stdio: options.inherit ? ["inherit", "inherit", "inherit"] : "pipe",
        ...(options.signal ? { signal: options.signal } : {}),
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      if (!options.inherit) {
        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => {
          stdout += chunk;
        });
        child.stderr?.on("data", (chunk: string) => {
          stderr += chunk;
        });
      }

      child.on("error", reject);

      const timeout = options.timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
          }, options.timeoutMs)
        : undefined;

      child.on("close", (code) => {
        if (timeout) {
          clearTimeout(timeout);
        }
        resolve({
          exitCode: timedOut ? 124 : (code ?? 1),
          stdout,
          stderr: timedOut ? `${stderr}\nCommand timed out.`.trim() : stderr,
        });
      });

      if (!options.inherit && child.stdin) {
        if (options.input !== undefined) {
          child.stdin.end(options.input);
        } else {
          child.stdin.end();
        }
      }
    });
  }
}
