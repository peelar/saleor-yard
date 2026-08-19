import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("setup script", () => {
  it("explains the one-command setup without changing the machine", async () => {
    const result = await execFileAsync("sh", ["setup", "--help"]);

    expect(result.stdout).toContain("Set up Saleor Yard for its first run.");
    expect(result.stdout).toContain("./setup          Set up the local Lima provider");
    expect(result.stdout).toContain("./setup exedev   Set up the exe.dev provider");
    expect(result.stderr).toBe("");
  });
});
