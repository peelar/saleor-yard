import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

async function runCli(args: string[], env: NodeJS.ProcessEnv = {}) {
  try {
    const result = await execFileAsync(
      "pnpm",
      ["exec", "tsx", "src/cli.ts", ...args],
      { env: { ...process.env, SALEOR_YARD_HOME: "/tmp/saleor-yard-cli-test", ...env } },
    );
    return { ...result, exitCode: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", exitCode: failure.code ?? 1 };
  }
}

describe("CLI output contract", () => {
  it("uses the saleor-yard executable name", async () => {
    const result = await runCli(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: saleor-yard [options] [command]");
    expect(result.stderr).toBe("");
  });

  it("rejects the hosted provider on the local-only branch", async () => {
    const result = await runCli(["doctor", "--json"], { SALEOR_YARD_PROVIDER: "exedev" });

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: {
        code: "invalid_provider",
        message: 'Unknown provider "exedev". Choose local.',
      },
    });
    expect(result.stderr).toBe("");
  });

  it("keeps missing-argument errors as JSON", async () => {
    const result = await runCli(["create", "--json"]);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: { code: "commander.missingArgument" },
    });
    expect(result.stderr).toBe("");
  });
});
