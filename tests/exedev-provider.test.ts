import { describe, expect, it } from "vitest";
import type { EnvironmentRecord } from "../src/domain/types.js";
import type {
  CommandRunner,
  RunCommandOptions,
} from "../src/process/command-runner.js";
import { ExeDevProvider } from "../src/providers/exedev/exedev-provider.js";

interface QueuedResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

class FakeRunner implements CommandRunner {
  readonly calls: Array<{ command: string; args: string[]; options?: RunCommandOptions }> = [];

  constructor(private readonly results: QueuedResult[]) {}

  async run(command: string, args: string[], options?: RunCommandOptions) {
    this.calls.push({ command, args, ...(options ? { options } : {}) });
    const result = this.results.shift();
    if (!result) {
      throw new Error(`No fake result for ${command} ${args.join(" ")}`);
    }
    return result;
  }
}

function success(stdout = "{}\n"): QueuedResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function record(): EnvironmentRecord {
  return {
    schemaVersion: 1,
    id: "env_20260818120000_abc123",
    provider: "exedev",
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

describe("ExeDevProvider", () => {
  it("creates a VM from the Yard image and sends a structured job to yardd", async () => {
    const runner = new FakeRunner([
      success("[]"),
      success('{"vm_name":"sy-pr-123-abc123","ssh_dest":"sy-pr-123-abc123.exe.xyz","https_url":"https://sy-pr-123-abc123.exe.xyz"}'),
      success("[]"),
      success(),
      success(),
      success('{"state":"requested","phase":"requested","updatedAt":"2026-08-18T12:00:00Z"}'),
      success('{"state":"provisioning","phase":"allocating_environment","updatedAt":"2026-08-18T12:00:01Z"}'),
    ]);
    const provider = new ExeDevProvider(runner, { image: "ghcr.io/example/yard:v1" });

    const result = await provider.create(record());

    expect(result.environment).toMatchObject({
      provider: "exedev",
      privateUrl: "https://sy-pr-123-abc123.exe.xyz",
    });
    expect(result.access.graphql).toBe("https://sy-pr-123-abc123.exe.xyz/graphql/");
    expect(runner.calls[1]?.args).toContain("--image=ghcr.io/example/yard:v1");
    expect(runner.calls[1]?.args).toContain("--cpu=2");
    expect(runner.calls[1]?.args).toContain("--memory=4GB");
    expect(runner.calls[1]?.args).toContain("--disk=20GB");
    expect(runner.calls[1]?.args.some((argument) => argument.startsWith("--tag="))).toBe(false);
    expect(runner.calls[1]?.args.some((argument) => argument.includes("setup-script"))).toBe(false);
    const provisionCall = runner.calls.at(-1);
    expect(provisionCall?.options?.input).toBeDefined();
    expect(JSON.parse(provisionCall?.options?.input ?? "{}")).toMatchObject({
      environmentId: "env_20260818120000_abc123",
      cloneUrl: "https://github.com/contributor/saleor.git",
      commit: "a".repeat(40),
      dashboardTag: "3.23",
    });
    expect(provisionCall?.options?.input).not.toContain("token");
  });

  it("reports automatic integrations as an unsafe provider configuration", async () => {
    const runner = new FakeRunner([
      success('{"email":"developer@example.com"}'),
      success('[{"name":"github","type":"github","attachments":["auto:all"]}]'),
    ]);

    const report = await new ExeDevProvider(runner).doctor();

    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: "exe.dev integration isolation",
      ok: false,
      message: expect.stringContaining("auto:all"),
    }));
  });

  it("approves an account whose integrations cannot reach Yard VMs", async () => {
    const runner = new FakeRunner([
      success('{"email":"developer@example.com"}'),
      success('[{"name":"staging","type":"http-proxy","attachments":["tag:staging"]}]'),
    ]);

    const report = await new ExeDevProvider(runner).doctor();

    expect(report.ok).toBe(true);
    expect(report.checks).toContainEqual({
      name: "exe.dev integration isolation",
      ok: true,
      message: "No automatic integrations can reach Yard VMs.",
    });
  });

  it("refuses to allocate a VM when an integration follows every VM", async () => {
    const runner = new FakeRunner([
      success('[{"name":"cloud","type":"http-proxy","attachments":["auto:all"]}]'),
    ]);

    await expect(new ExeDevProvider(runner).create(record())).rejects.toMatchObject({
      code: "provider_trust_boundary_failed",
    });

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.args).toContain("integrations");
  });

  it("deletes a new VM if a direct integration appears before provisioning", async () => {
    const runner = new FakeRunner([
      success("[]"),
      success('{"vm_name":"sy-pr-123-abc123","ssh_dest":"sy-pr-123-abc123.exe.xyz","https_url":"https://sy-pr-123-abc123.exe.xyz"}'),
      success('[{"name":"github","type":"github","attachments":["vm:sy-pr-123-abc123"]}]'),
      success(),
    ]);

    await expect(new ExeDevProvider(runner).create(record())).rejects.toMatchObject({
      code: "provider_trust_boundary_failed",
    });

    expect(runner.calls.at(-1)?.args).toEqual(expect.arrayContaining([
      "exe.dev", "rm", "sy-pr-123-abc123", "--json",
    ]));
  });

  it("sends command arguments as JSON instead of interpolating them into SSH", async () => {
    const value = record();
    value.providerEnvironment = {
      provider: "exedev",
      providerId: "sy-pr-123-abc123",
      name: "sy-pr-123-abc123",
      sshDestination: "sy-pr-123-abc123.exe.xyz",
      privateUrl: "https://sy-pr-123-abc123.exe.xyz",
    };
    const runner = new FakeRunner([
      success('{"exitCode":0,"stdout":"safe","stderr":""}'),
    ]);
    const provider = new ExeDevProvider(runner);

    await provider.exec(value, ["python", "manage.py", "check; touch /tmp/unsafe"]);

    const remote = runner.calls[0]?.args.at(-1) ?? "";
    expect(remote).not.toContain("touch /tmp/unsafe");
    expect(JSON.parse(runner.calls[0]?.options?.input ?? "{}")).toEqual({
      service: "api",
      command: ["python", "manage.py", "check; touch /tmp/unsafe"],
    });
  });

  it("returns the guest runtime status", async () => {
    const value = record();
    value.providerEnvironment = {
      provider: "exedev",
      providerId: "sy-pr-123-abc123",
      name: "sy-pr-123-abc123",
      sshDestination: "sy-pr-123-abc123.exe.xyz",
      privateUrl: "https://sy-pr-123-abc123.exe.xyz",
    };
    const runner = new FakeRunner([
      success('{"state":"provisioning","phase":"building_core","updatedAt":"2026-08-18T12:01:00Z"}'),
    ]);

    await expect(new ExeDevProvider(runner).inspect(value)).resolves.toEqual({
      state: "provisioning",
      phase: "building_core",
      updatedAt: "2026-08-18T12:01:00Z",
    });
  });

  it("treats the guest's empty initial state as environment allocation", async () => {
    const value = record();
    value.providerEnvironment = {
      provider: "exedev",
      providerId: "sy-pr-123-abc123",
      name: "sy-pr-123-abc123",
      sshDestination: "sy-pr-123-abc123.exe.xyz",
      privateUrl: "https://sy-pr-123-abc123.exe.xyz",
    };
    const runner = new FakeRunner([
      success('{"state":"requested","phase":"requested","updatedAt":"2026-08-18T12:01:00Z"}'),
    ]);

    await expect(new ExeDevProvider(runner).inspect(value)).resolves.toEqual({
      state: "provisioning",
      phase: "allocating_environment",
      updatedAt: "2026-08-18T12:01:00Z",
    });
  });

  it("rejects a guest running a different commit", async () => {
    const value = record();
    value.providerEnvironment = {
      provider: "exedev",
      providerId: "sy-pr-123-abc123",
      name: "sy-pr-123-abc123",
      sshDestination: "sy-pr-123-abc123.exe.xyz",
      privateUrl: "https://sy-pr-123-abc123.exe.xyz",
    };
    const runner = new FakeRunner([
      success(`{"state":"ready","phase":"ready","updatedAt":"2026-08-18T12:01:00Z","commit":"${"b".repeat(40)}"}`),
    ]);

    await expect(new ExeDevProvider(runner).inspect(value)).rejects.toMatchObject({
      code: "guest_commit_mismatch",
    });
  });

  it("tunnels the combined gateway used by browser agents", async () => {
    const value = record();
    value.providerEnvironment = {
      provider: "exedev",
      providerId: "sy-pr-123-abc123",
      name: "sy-pr-123-abc123",
      sshDestination: "sy-pr-123-abc123.exe.xyz",
      privateUrl: "https://sy-pr-123-abc123.exe.xyz",
    };
    const runner = new FakeRunner([success("")]);

    await new ExeDevProvider(runner).tunnel(value);

    expect(runner.calls[0]?.args).toContain("18080:127.0.0.1:8080");
  });
});
