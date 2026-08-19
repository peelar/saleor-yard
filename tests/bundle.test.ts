import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

// These tests prove that the bundled CLI runs on its own, with no
// node_modules next to it. That property is why the bundle exists.
describe("bundled CLI", () => {
  let work: string;
  let standalone: string;

  beforeAll(async () => {
    await execFileAsync("pnpm", ["build"]);
    work = await mkdtemp(join(tmpdir(), "saleor-yard-bundle-"));
    standalone = join(work, "saleor-yard");
    await copyFile("dist/cli.cjs", standalone);
  }, 120_000);

  afterAll(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it("prints the package version", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { version: string };
    const result = await execFileAsync("node", [standalone, "--version"]);

    expect(result.stdout.trim()).toBe(packageJson.version);
    expect(result.stderr).toBe("");
  });

  it("runs without node_modules and writes JSON to standard output", async () => {
    const result = await execFileAsync("node", [standalone, "list", "--json"], {
      cwd: work,
      env: { ...process.env, SALEOR_YARD_HOME: join(work, "state") },
    });

    expect(JSON.parse(result.stdout)).toEqual([]);
    expect(result.stderr).toBe("");
  });

  it("reports errors as JSON on standard error contract", async () => {
    await expect(
      execFileAsync("node", [standalone, "status", "env_missing", "--json"], {
        cwd: work,
        env: { ...process.env, SALEOR_YARD_HOME: join(work, "state") },
      }),
    ).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining('"error"'),
    });
  });
});
