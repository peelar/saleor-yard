import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

async function runCli(args: string[], env: NodeJS.ProcessEnv = {}) {
  try {
    const result = await execFileAsync(
      "pnpm",
      ["exec", "tsx", "src/cli.ts", ...args],
      { env: { ...process.env, SALEOR_SANDBOX_HOME: "/tmp/saleor-sandbox-cli-test", ...env } },
    );
    return { ...result, exitCode: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", exitCode: failure.code ?? 1 };
  }
}

describe("CLI output contract", () => {
  it("reports an invalid provider instead of switching providers", async () => {
    const result = await runCli(["doctor", "--json"], { SALEOR_SANDBOX_PROVIDER: "typo" });

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: {
        code: "invalid_provider",
        message: 'Unknown provider "typo". Choose local or exedev.',
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
