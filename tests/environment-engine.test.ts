import { describe, expect, it } from "vitest";
import type {
  CommandResult,
  CreatePlan,
  DoctorReport,
  EnvironmentHttpRequest,
  EnvironmentHttpResponse,
  EnvironmentRecord,
  LogOptions,
  ProviderEnvironment,
  ProviderStatus,
  ResolvedSource,
  SourceSelector,
} from "../src/domain/types.js";
import { EnvironmentEngine } from "../src/engine/environment-engine.js";
import type { EnvironmentProvider } from "../src/providers/environment-provider.js";
import type { SourceResolver } from "../src/source/source-resolver.js";
import type { EnvironmentRepository } from "../src/state/environment-repository.js";

const resolvedSource: ResolvedSource = {
  requested: "pr:123",
  kind: "pull_request",
  repository: "saleor/saleor",
  cloneRepository: "saleor/saleor",
  cloneUrl: "https://github.com/saleor/saleor.git",
  commit: "a".repeat(40),
  ref: "feature",
  pullRequest: 123,
  baseBranch: "3.23",
  versionLine: "3.23",
  resolvedAt: "2026-08-18T12:00:00.000Z",
};

function copy(record: EnvironmentRecord): EnvironmentRecord {
  return structuredClone(record);
}

class FakeRepository implements EnvironmentRepository {
  readonly records = new Map<string, EnvironmentRecord>();

  async save(record: EnvironmentRecord): Promise<void> {
    this.records.set(record.id, copy(record));
  }

  async get(id: string): Promise<EnvironmentRecord> {
    const record = this.records.get(id);
    if (!record) throw new Error(`Missing record ${id}`);
    return copy(record);
  }

  async list(): Promise<EnvironmentRecord[]> {
    return [...this.records.values()].map(copy);
  }
}

class FakeResolver implements SourceResolver {
  calls: SourceSelector[] = [];

  async resolve(selector: SourceSelector): Promise<ResolvedSource> {
    this.calls.push(selector);
    return resolvedSource;
  }
}

class FakeProvider implements EnvironmentProvider {
  readonly name = "exedev" as const;
  createCalls = 0;
  destroyCalls = 0;
  createFailure?: Error;
  status: ProviderStatus = {
    state: "ready",
    phase: "ready",
    updatedAt: "2026-08-18T12:10:00.000Z",
  };

  async doctor(): Promise<DoctorReport> {
    return { ok: true, provider: "exedev", checks: [] };
  }

  plan(record: EnvironmentRecord): CreatePlan {
    return {
      environmentId: record.id,
      provider: "exedev",
      resourceName: "sf-test",
      source: record.source,
      resources: { cpu: 4, memoryGb: 8, diskGb: 40 },
      privateGatewayPort: 8080,
      expiresAt: record.expiresAt,
    };
  }

  async create(): Promise<{ environment: ProviderEnvironment; access: { dashboard: string; graphql: string; sshDestination: string } }> {
    this.createCalls += 1;
    if (this.createFailure) throw this.createFailure;
    return {
      environment: {
        provider: "exedev",
        providerId: "sf-test",
        name: "sf-test",
        sshDestination: "sf-test.exe.xyz",
        privateUrl: "https://sf-test.exe.xyz",
      },
      access: {
        dashboard: "https://sf-test.exe.xyz/",
        graphql: "https://sf-test.exe.xyz/graphql/",
        sshDestination: "sf-test.exe.xyz",
      },
    };
  }

  async inspect(): Promise<ProviderStatus> {
    return this.status;
  }

  async logs(_record: EnvironmentRecord, _options: LogOptions): Promise<CommandResult> {
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  async exec(_record: EnvironmentRecord, _command: string[]): Promise<CommandResult> {
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  async http(
    _record: EnvironmentRecord,
    _request: EnvironmentHttpRequest,
  ): Promise<EnvironmentHttpResponse> {
    return { status: 200, headers: {}, body: "" };
  }

  async tunnel(): Promise<CommandResult> {
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  async destroy(): Promise<void> {
    this.destroyCalls += 1;
  }
}

function setup() {
  const resolver = new FakeResolver();
  const provider = new FakeProvider();
  const repository = new FakeRepository();
  return {
    resolver,
    provider,
    repository,
    engine: new EnvironmentEngine(resolver, [provider], repository),
  };
}

describe("EnvironmentEngine", () => {
  it("plans a dry run without creating or saving anything", async () => {
    const { engine, provider, repository } = setup();

    const result = await engine.create("pr:123", { ttlMinutes: 30, dryRun: true, provider: "exedev" });

    expect("resources" in result).toBe(true);
    expect(provider.createCalls).toBe(0);
    expect(repository.records.size).toBe(0);
  });

  it("stores the environment and its stable access details", async () => {
    const { engine, provider, repository } = setup();

    const result = await engine.create("pr:123", { ttlMinutes: 30, dryRun: false, provider: "exedev" });

    expect(provider.createCalls).toBe(1);
    expect("access" in result && result.access?.graphql).toBe("https://sf-test.exe.xyz/graphql/");
    expect(repository.records.size).toBe(1);
  });

  it("reports when provider provisioning starts", async () => {
    const { engine } = setup();
    const updates: Array<{ state: EnvironmentRecord["state"]; phase: EnvironmentRecord["phase"] }> = [];

    await engine.create(
      "pr:123",
      { ttlMinutes: 30, dryRun: false, provider: "exedev" },
      ({ state, phase }) => updates.push({ state, phase }),
    );

    expect(updates).toEqual([
      { state: "provisioning", phase: "allocating_environment" },
    ]);
  });

  it("records a terminal failure when creation fails", async () => {
    const { engine, provider, repository } = setup();
    provider.createFailure = new Error("provider unavailable");

    await expect(engine.create("pr:123", { ttlMinutes: 30, dryRun: false, provider: "exedev" })).rejects.toThrow(
      "provider unavailable",
    );

    const [record] = await repository.list();
    expect(record).toMatchObject({
      state: "failed",
      phase: "failed",
      failure: { message: "provider unavailable" },
    });
  });

  it("does not move a failed environment back into provisioning", async () => {
    const { engine, repository, provider } = setup();
    provider.createFailure = new Error("build failed");
    await expect(engine.create("pr:123", { ttlMinutes: 30, dryRun: false, provider: "exedev" })).rejects.toThrow();
    const [failed] = await repository.list();
    if (!failed) throw new Error("Expected failed record");

    const result = await engine.get(failed.id, true);

    expect(result.state).toBe("failed");
  });

  it("deletes expired environments and leaves active ones alone", async () => {
    const { engine, repository, provider } = setup();
    const expired = await engine.create("pr:123", { ttlMinutes: 30, dryRun: false, provider: "exedev" });
    if ("resources" in expired) throw new Error("Expected an environment");
    expired.expiresAt = "2026-08-18T12:00:00.000Z";
    await repository.save(expired);
    const active = copy(expired);
    active.id = `${expired.id}_active`;
    active.expiresAt = "2026-08-18T14:00:00.000Z";
    await repository.save(active);

    const report = await engine.pruneExpired(new Date("2026-08-18T13:00:00.000Z"));

    expect(report.deleted).toEqual([expired.id]);
    expect(provider.destroyCalls).toBe(1);
    expect((await repository.get(active.id)).state).not.toBe("deleted");
  });

  it("can delete a failed record when no provider resource was created", async () => {
    const { engine, provider, repository } = setup();
    provider.createFailure = new Error("Environment allocation failed");
    await expect(engine.create("pr:123", { ttlMinutes: 30, dryRun: false, provider: "exedev" })).rejects.toThrow();
    const [failed] = await repository.list();
    if (!failed) throw new Error("Expected failed record");

    const deleted = await engine.destroy(failed.id);

    expect(deleted.state).toBe("deleted");
    expect(provider.destroyCalls).toBe(0);
  });
});
