import { describe, expect, it } from "vitest";
import type { EnvironmentRecord } from "../src/domain/types.js";
import type { CommandRunner, RunCommandOptions } from "../src/process/command-runner.js";
import { LocalProvider } from "../src/providers/local/local-provider.js";

interface QueuedResult { exitCode: number; stdout: string; stderr: string }

class FakeRunner implements CommandRunner {
  readonly calls: Array<{ command: string; args: string[]; options?: RunCommandOptions }> = [];
  constructor(private readonly results: QueuedResult[]) {}
  async run(command: string, args: string[], options?: RunCommandOptions) {
    this.calls.push({ command, args, ...(options ? { options } : {}) });
    const result = this.results.shift();
    if (!result) throw new Error(`No fake result for ${command} ${args.join(" ")}`);
    return result;
  }
}

const success = (stdout = ""): QueuedResult => ({ exitCode: 0, stdout, stderr: "" });
const ports = { gateway: 28080, core: 28000, mailpit: 28025, jaeger: 28686 };

function record(): EnvironmentRecord {
  return {
    schemaVersion: 1,
    id: "env_20260818120000_abc123",
    provider: "local",
    state: "provisioning",
    phase: "allocating_environment",
    source: {
      requested: "pr:123",
      kind: "pull_request",
      repository: "saleor/saleor",
      cloneRepository: "contributor/saleor",
      cloneUrl: "https://github.com/contributor/saleor.git",
      commit: "a".repeat(40),
      ref: "fix-checkout",
      pullRequest: 123,
      baseBranch: "3.23",
      versionLine: "3.23",
      resolvedAt: "2026-08-18T12:00:00Z",
    },
    createdAt: "2026-08-18T12:00:00Z",
    updatedAt: "2026-08-18T12:00:00Z",
    expiresAt: "2026-08-18T14:00:00Z",
  };
}

function provisionedRecord(): EnvironmentRecord {
  const value = record();
  value.providerEnvironment = {
    provider: "local",
    providerId: "sy-pr-123-abc123",
    name: "sy-pr-123-abc123",
    ports,
  };
  return value;
}

describe("LocalProvider", () => {
  it("creates a Lima VM, installs yardd, and submits the same structured job", async () => {
    const runner = new FakeRunner([
      success(), success(), success(), success(), success(), success(), success(), success(),
      success('{"state":"requested","phase":"requested","updatedAt":"2026-08-18T12:00:00Z"}'),
      success('{"state":"provisioning","phase":"allocating_environment","updatedAt":"2026-08-18T12:00:01Z"}'),
    ]);
    const provider = new LocalProvider(runner, {
      ports,
      yarddBinary: "/artifacts/yardd",
      projectRoot: "/project",
    });

    const result = await provider.create(record());

    expect(runner.calls[0]).toMatchObject({ command: "limactl" });
    expect(runner.calls[0]?.args).toContain("template:docker-rootful");
    expect(runner.calls[0]?.args).toContain("--cpus=2");
    expect(runner.calls[0]?.args).toContain("--memory=4");
    expect(runner.calls[0]?.args).toContain("--disk=20");
    expect(runner.calls[0]?.args).toContain("--port-forward=28080:8080,static=true");
    expect(runner.calls[2]?.args).toEqual(["copy", "/artifacts/yardd", "sy-pr-123-abc123:/tmp/yardd"]);
    const provision = runner.calls.at(-1);
    expect(provision?.args).toEqual([
      "shell", "--workdir=/tmp", "sy-pr-123-abc123", "sudo", "yardd", "provision", "--job", "-",
    ]);
    expect(JSON.parse(provision?.options?.input ?? "{}")).toMatchObject({
      environmentId: record().id,
      commit: "a".repeat(40),
      privateUrl: "http://127.0.0.1:28080",
    });
    expect(result.environment.provider).toBe("local");
    expect(result.access.graphql).toBe("http://127.0.0.1:28080/graphql/");
    expect(result.access.mailpit).toBe("http://127.0.0.1:28025/");
  });

  it("passes exec arguments as JSON rather than guest command arguments", async () => {
    const runner = new FakeRunner([success('{"exitCode":0,"stdout":"safe","stderr":""}')]);
    const provider = new LocalProvider(runner, { ports, yarddBinary: "/artifacts/yardd" });

    await provider.exec(provisionedRecord(), ["python", "manage.py", "check; touch /tmp/unsafe"]);

    expect(runner.calls[0]?.args).not.toContain("check; touch /tmp/unsafe");
    expect(JSON.parse(runner.calls[0]?.options?.input ?? "{}")).toEqual({
      service: "api",
      command: ["python", "manage.py", "check; touch /tmp/unsafe"],
    });
  });

  it("uses existing forwarded ports instead of opening another tunnel", async () => {
    const provider = new LocalProvider(new FakeRunner([]), { ports, yarddBinary: "/artifacts/yardd" });
    await expect(provider.tunnel(provisionedRecord())).resolves.toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining("already forwarded"),
    });
  });

  it("deletes only its own Lima instance", async () => {
    const runner = new FakeRunner([success()]);
    const provider = new LocalProvider(runner, { ports, yarddBinary: "/artifacts/yardd" });

    await provider.destroy(provisionedRecord());

    expect(runner.calls[0]).toEqual(expect.objectContaining({
      command: "limactl",
      args: ["delete", "--force", "sy-pr-123-abc123"],
    }));
  });

  it("cleans up a partial Lima instance when creation times out", async () => {
    const runner = new FakeRunner([
      { exitCode: 124, stdout: "", stderr: "Command timed out." },
      success(),
    ]);
    const provider = new LocalProvider(runner, { ports, yarddBinary: "/artifacts/yardd" });

    await expect(provider.create(record())).rejects.toMatchObject({ code: "provider_create_failed" });

    expect(runner.calls[1]?.args).toEqual(["delete", "--force", "sy-pr-123-abc123"]);
  });
});
