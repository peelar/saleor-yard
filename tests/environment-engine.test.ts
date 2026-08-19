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
  readonly name = "local" as const;
  createCalls = 0;
  doctorCalls = 0;
  destroyCalls = 0;
  destroyFailure?: Error;
  orphanedResources: string[] = [];
  createFailure?: Error;
  inspectFailure?: Error;
  doctorReport: DoctorReport = { ok: true, provider: "local", checks: [] };
  status: ProviderStatus = {
    state: "ready",
    phase: "ready",
    updatedAt: "2026-08-18T12:10:00.000Z",
  };

  async doctor(): Promise<DoctorReport> {
    this.doctorCalls += 1;
    return this.doctorReport;
  }

  plan(record: EnvironmentRecord): CreatePlan {
    return {
      environmentId: record.id,
      provider: "local",
      resourceName: "sy-test",
      source: record.source,
      resources: { cpu: 4, memoryGb: 8, diskGb: 40 },
      privateGatewayPort: 8080,
      expiresAt: record.expiresAt,
    };
  }

  async create(): Promise<{ environment: ProviderEnvironment; access: { dashboard: string; graphql: string } }> {
    this.createCalls += 1;
    if (this.createFailure) throw this.createFailure;
    return {
      environment: {
        provider: "local",
        providerId: "sy-test",
        name: "sy-test",
        ports: { gateway: 28080, core: 28000, mailpit: 28025, jaeger: 28686 },
      },
      access: {
        dashboard: "http://127.0.0.1:28080/",
        graphql: "http://127.0.0.1:28080/graphql/",
      },
    };
  }

  async inspect(): Promise<ProviderStatus> {
    if (this.inspectFailure) throw this.inspectFailure;
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
    if (this.destroyFailure) throw this.destroyFailure;
  }

  async destroyOwnedOrphans() {
    return { deleted: this.orphanedResources, failures: [] };
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

    const result = await engine.create("pr:123", { ttlMinutes: 30, dryRun: true, provider: "local" });

    expect("resources" in result).toBe(true);
    expect(provider.createCalls).toBe(0);
    expect(repository.records.size).toBe(0);
  });

  it("stops before source resolution when the provider preflight fails", async () => {
    const { engine, provider, resolver, repository } = setup();
    provider.doctorReport = {
      ok: false,
      provider: "local",
      checks: [{
        name: "Docker builder",
        ok: false,
        message: "The Docker daemon is not running. Start your Docker-compatible runtime, verify it with `docker info`, then retry.",
      }],
    };

    await expect(engine.create(
      "pr:123",
      { ttlMinutes: 30, dryRun: false, provider: "local" },
    )).rejects.toMatchObject({ code: "provider_preflight_failed" });

    expect(provider.doctorCalls).toBe(1);
    expect(provider.createCalls).toBe(0);
    expect(resolver.calls).toHaveLength(0);
    expect(repository.records.size).toBe(0);
  });

  it("prunes expired environments before checking the provider", async () => {
    const { engine, provider, repository } = setup();
    const expired: EnvironmentRecord = {
      schemaVersion: 1,
      id: "env_20260818090000_exp001",
      provider: "local",
      state: "failed",
      phase: "failed",
      source: resolvedSource,
      createdAt: "2026-08-18T09:00:00.000Z",
      updatedAt: "2026-08-18T09:00:00.000Z",
      expiresAt: "2026-08-18T09:30:00.000Z",
    };
    await repository.save(expired);

    await engine.create("pr:123", { ttlMinutes: 30, dryRun: false, provider: "local" });

    expect(provider.destroyCalls).toBe(1);
    expect(provider.doctorCalls).toBe(1);
    expect((await repository.get(expired.id)).state).toBe("deleted");
  });

  it("does not allocate another environment when automatic cleanup fails", async () => {
    const { engine, provider, repository } = setup();
    provider.destroyFailure = new Error("Lima could not delete the expired environment");
    await repository.save({
      schemaVersion: 1,
      id: "env_20260818090000_exp002",
      provider: "local",
      state: "failed",
      phase: "failed",
      source: resolvedSource,
      createdAt: "2026-08-18T09:00:00.000Z",
      updatedAt: "2026-08-18T09:00:00.000Z",
      expiresAt: "2026-08-18T09:30:00.000Z",
    });

    await expect(engine.create(
      "pr:123",
      { ttlMinutes: 30, dryRun: false, provider: "local" },
    )).rejects.toMatchObject({ code: "automatic_prune_failed" });

    expect(provider.doctorCalls).toBe(0);
    expect(provider.createCalls).toBe(0);
  });

  it("stores the environment and its stable access details", async () => {
    const { engine, provider, repository } = setup();

    const result = await engine.create("pr:123", { ttlMinutes: 30, dryRun: false, provider: "local" });

    expect(provider.createCalls).toBe(1);
    expect("access" in result && result.access?.graphql).toBe("http://127.0.0.1:28080/graphql/");
    expect(repository.records.size).toBe(1);
  });

  it("reports when provider provisioning starts", async () => {
    const { engine } = setup();
    const updates: Array<{ state: EnvironmentRecord["state"]; phase: EnvironmentRecord["phase"] }> = [];

    await engine.create(
      "pr:123",
      { ttlMinutes: 30, dryRun: false, provider: "local" },
      ({ state, phase }) => updates.push({ state, phase }),
    );

    expect(updates).toEqual([
      { state: "provisioning", phase: "allocating_environment" },
    ]);
  });

  it("records a terminal failure when creation fails", async () => {
    const { engine, provider, repository } = setup();
    provider.createFailure = new Error("provider unavailable");

    await expect(engine.create("pr:123", { ttlMinutes: 30, dryRun: false, provider: "local" })).rejects.toThrow(
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
    await expect(engine.create("pr:123", { ttlMinutes: 30, dryRun: false, provider: "local" })).rejects.toThrow();
    const [failed] = await repository.list();
    if (!failed) throw new Error("Expected failed record");

    const result = await engine.get(failed.id, true);

    expect(result.state).toBe("failed");
  });

  it("fails a wait after three consecutive provider inspection errors", async () => {
    const { engine, provider } = setup();
    const created = await engine.create("pr:123", { ttlMinutes: 30, dryRun: false, provider: "local" });
    if ("resources" in created) throw new Error("Expected an environment");
    provider.inspectFailure = new Error("VM control channel is unavailable");

    const result = await engine.wait(created.id, 1, 1);

    expect(result.state).toBe("failed");
    expect(result.failure?.message).toContain("after 3 attempts");
  });

  it("stops waiting on cancellation without deleting the accepted environment", async () => {
    const { engine, provider } = setup();
    const created = await engine.create("pr:123", { ttlMinutes: 30, dryRun: false, provider: "local" });
    if ("resources" in created) throw new Error("Expected an environment");
    const controller = new AbortController();
    controller.abort();

    await expect(engine.wait(created.id, 1, 1, undefined, controller.signal)).rejects.toMatchObject({
      code: "wait_cancelled",
      details: { environmentId: created.id },
    });
    expect(provider.destroyCalls).toBe(0);
  });

  it("deletes expired environments and leaves active ones alone", async () => {
    const { engine, repository, provider } = setup();
    const expired = await engine.create("pr:123", { ttlMinutes: 30, dryRun: false, provider: "local" });
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

  it("derives and deletes the provider resource for an interrupted record", async () => {
    const { engine, provider, repository } = setup();
    provider.createFailure = new Error("Environment allocation failed");
    await expect(engine.create("pr:123", { ttlMinutes: 30, dryRun: false, provider: "local" })).rejects.toThrow();
    const [failed] = await repository.list();
    if (!failed) throw new Error("Expected failed record");

    const deleted = await engine.destroy(failed.id);

    expect(deleted.state).toBe("deleted");
    expect(provider.destroyCalls).toBe(1);
    expect(deleted.providerResourceId).toBe("sy-test");
  });

  it("deletes every saved environment and remaining owned provider resource", async () => {
    const { engine, provider } = setup();
    provider.orphanedResources = ["sy-release-orphan"];
    await engine.create("pr:123", { ttlMinutes: 30, dryRun: false, provider: "local" });

    const report = await engine.destroyAll();

    expect(report.deleted).toHaveLength(1);
    expect(report.orphanedResources).toEqual(["sy-release-orphan"]);
    expect(provider.destroyCalls).toBe(1);
  });
});
