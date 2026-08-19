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

  it("deletes an interrupted Lima instance from its saved resource name", async () => {
    const runner = new FakeRunner([success()]);
    const provider = new LocalProvider(runner, { ports, yarddBinary: "/artifacts/yardd" });
    const interrupted = record();
    interrupted.providerResourceId = "sy-pr-123-abc123";

    await provider.destroy(interrupted);

    expect(runner.calls[0]?.args).toEqual(["delete", "--force", "sy-pr-123-abc123"]);
  });

  it("deletes only provider-owned orphan names", async () => {
    const runner = new FakeRunner([
      success([
        '{"name":"sy-release-abc123"}',
        '{"name":"personal-vm"}',
        '{"name":"sy-release-nothex"}',
      ].join("\n")),
      success(),
    ]);
    const provider = new LocalProvider(runner, { ports, yarddBinary: "/artifacts/yardd" });

    const report = await provider.destroyOwnedOrphans();

    expect(report.deleted).toEqual(["sy-release-abc123"]);
    expect(runner.calls.at(-1)?.args).toEqual(["delete", "--force", "sy-release-abc123"]);
  });

  it("fails inspection when the guest control channel is unavailable", async () => {
    const runner = new FakeRunner([{ exitCode: 1, stdout: "", stderr: "VM is stopped" }]);
    const provider = new LocalProvider(runner, { ports, yarddBinary: "/artifacts/yardd" });

    await expect(provider.inspect(provisionedRecord())).rejects.toMatchObject({
      code: "provider_inspect_failed",
      message: "VM is stopped",
    });
  });

  it("rejects stale provisioning status", async () => {
    const runner = new FakeRunner([success(JSON.stringify({
      state: "provisioning",
      phase: "building_core",
      updatedAt: "2026-08-18T12:00:00Z",
      commit: "a".repeat(40),
    }))]);
    const provider = new LocalProvider(runner, { ports, yarddBinary: "/artifacts/yardd" });

    await expect(provider.inspect(provisionedRecord())).rejects.toMatchObject({
      code: "provider_status_stale",
    });
  });

  it("reports insufficient host disk space during provider checks", async () => {
    const runner = new FakeRunner([success("lima version")]);
    const provider = new LocalProvider(runner, {
      ports,
      yarddBinary: "/artifacts/yardd",
      freeDiskBytes: async () => 8 * 1024 ** 3,
    });

    const report = await provider.doctor();

    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: "Host disk space",
      ok: false,
    }));
  });

  it("reports when OrbStack is not running before creating a Lima instance", async () => {
    const runner = new FakeRunner([{
      exitCode: 1,
      stdout: "",
      stderr: "failed to connect to unix:///Users/test/.orbstack/run/docker.sock: no such file or directory",
    }]);
    const provider = new LocalProvider(runner, { ports, projectRoot: "/project" });

    await expect(provider.create(record())).rejects.toMatchObject({
      code: "docker_unavailable",
      message: "Docker is unavailable because OrbStack is not running. Start OrbStack, verify it with `docker info`, then retry.",
    });

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]).toMatchObject({
      command: "docker",
      args: ["version", "--format", "{{.Server.Version}}"],
    });
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

  it("cleans up a partial Lima instance when creation is cancelled", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push({ command, args });
        if (calls.length === 1) throw new Error("The operation was aborted");
        return success();
      },
    };
    const provider = new LocalProvider(runner, { ports, yarddBinary: "/artifacts/yardd" });
    const controller = new AbortController();

    await expect(provider.create(record(), controller.signal)).rejects.toThrow("aborted");

    expect(calls[1]?.args).toEqual(["delete", "--force", "sy-pr-123-abc123"]);
  });
});
