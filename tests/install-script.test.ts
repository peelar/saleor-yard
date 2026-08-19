import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("install script", () => {
  it("explains the installation without changing the machine", async () => {
    const result = await execFileAsync("sh", ["install", "--help"]);

    expect(result.stdout).toContain("Install Saleor Yard so the saleor-yard command is on your PATH.");
    expect(result.stdout).toContain("./install          Install or update Saleor Yard");
    expect(result.stderr).toBe("");
  });

  it("rejects unknown arguments before changing the machine", async () => {
    await expect(execFileAsync("sh", ["install", "nightly"])).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("Unknown argument: nightly"),
    });
  });
});
