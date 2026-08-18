import { randomBytes } from "node:crypto";
import { SandboxError } from "../domain/errors.js";
import type {
  CommandResult,
  CreatePlan,
  DoctorReport,
  EnvironmentHttpRequest,
  EnvironmentHttpResponse,
  EnvironmentRecord,
  LogOptions,
  ProviderName,
  PruneReport,
} from "../domain/types.js";
import type { EnvironmentProvider } from "../providers/environment-provider.js";
import { parseSourceSelector } from "../source/source-selector.js";
import type { SourceResolver } from "../source/source-resolver.js";
import type { EnvironmentRepository } from "../state/environment-repository.js";

export interface CreateOptions {
  ttlMinutes: number;
  dryRun: boolean;
  provider: ProviderName;
}

export class EnvironmentEngine {
  constructor(
    private readonly resolver: SourceResolver,
    providers: EnvironmentProvider[],
    private readonly store: EnvironmentRepository,
  ) {
    this.providers = new Map(providers.map((provider) => [provider.name, provider]));
  }

  private readonly providers: Map<ProviderName, EnvironmentProvider>;

  async doctor(providerName: ProviderName): Promise<DoctorReport> {
    return this.providerFor(providerName).doctor();
  }

  async create(
    sourceInput: string,
    options: CreateOptions,
    onUpdate?: (record: EnvironmentRecord) => void,
  ): Promise<EnvironmentRecord | CreatePlan> {
    if (!Number.isInteger(options.ttlMinutes) || options.ttlMinutes < 15 || options.ttlMinutes > 24 * 60) {
      throw new SandboxError("invalid_ttl", "TTL must be between 15 minutes and 24 hours.");
    }

    const source = await this.resolver.resolve(parseSourceSelector(sourceInput));
    const now = new Date();
    const record: EnvironmentRecord = {
      schemaVersion: 1,
      id: this.createId(),
      provider: options.provider,
      state: "requested",
      phase: "resolving_source",
      source,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + options.ttlMinutes * 60_000).toISOString(),
    };

    if (options.dryRun) {
      return this.providerFor(record.provider).plan(record);
    }

    await this.store.save(record);
    record.state = "provisioning";
    record.phase = "provisioning_vm";
    record.updatedAt = new Date().toISOString();
    await this.store.save(record);
    onUpdate?.(record);
    try {
      const created = await this.providerFor(record.provider).create(record);
      record.providerEnvironment = created.environment;
      record.access = created.access;
      record.updatedAt = new Date().toISOString();
      await this.store.save(record);
      return record;
    } catch (error) {
      record.state = "failed";
      record.phase = "failed";
      record.failure = {
        phase: "provisioning_vm",
        message: error instanceof Error ? error.message : "VM provisioning failed.",
      };
      record.updatedAt = new Date().toISOString();
      await this.store.save(record);
      onUpdate?.(record);
      throw error;
    }
  }

  async get(id: string, refresh = true): Promise<EnvironmentRecord> {
    const record = await this.store.get(id);
    if (
      !refresh ||
      !record.providerEnvironment ||
      record.state === "failed" ||
      record.state === "deleted"
    ) {
      return record;
    }

    const status = await this.providerFor(record.provider).inspect(record);
    record.state = status.state;
    record.phase = status.phase;
    record.updatedAt = status.updatedAt;
    if (status.error) {
      record.failure = { phase: status.phase, message: status.error };
    }
    await this.store.save(record);
    return record;
  }

  async list(refresh = false): Promise<EnvironmentRecord[]> {
    const records = await this.store.list();
    if (!refresh) {
      return records;
    }
    return Promise.all(records.map((record) => this.get(record.id, true)));
  }

  async wait(
    id: string,
    timeoutMinutes: number,
    intervalMs = 5_000,
    onUpdate?: (record: EnvironmentRecord) => void,
  ): Promise<EnvironmentRecord> {
    const deadline = Date.now() + timeoutMinutes * 60_000;
    while (Date.now() < deadline) {
      const record = await this.get(id, true);
      onUpdate?.(record);
      if (record.state === "ready") {
        return record;
      }
      if (record.state === "failed" || record.state === "deleted") {
        return record;
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new SandboxError("wait_timeout", `Environment ${id} did not become ready in time.`);
  }

  async logs(id: string, options: LogOptions): Promise<CommandResult> {
    const record = await this.store.get(id);
    return this.providerFor(record.provider).logs(record, options);
  }

  async exec(id: string, command: string[]): Promise<CommandResult> {
    const record = await this.store.get(id);
    return this.providerFor(record.provider).exec(record, command);
  }

  async http(id: string, request: EnvironmentHttpRequest): Promise<EnvironmentHttpResponse> {
    const record = await this.store.get(id);
    return this.providerFor(record.provider).http(record, request);
  }

  async tunnel(id: string): Promise<CommandResult> {
    const record = await this.store.get(id);
    return this.providerFor(record.provider).tunnel(record);
  }

  async destroy(id: string): Promise<EnvironmentRecord> {
    const record = await this.store.get(id);
    if (record.state === "deleted") {
      return record;
    }
    record.state = "deleting";
    record.phase = "deleting";
    record.updatedAt = new Date().toISOString();
    await this.store.save(record);

    if (record.providerEnvironment) {
      await this.providerFor(record.provider).destroy(record);
    }
    record.state = "deleted";
    record.phase = "deleted";
    record.updatedAt = new Date().toISOString();
    await this.store.save(record);
    return record;
  }

  async pruneExpired(now = new Date()): Promise<PruneReport> {
    const records = await this.store.list();
    const report: PruneReport = {
      checkedAt: now.toISOString(),
      deleted: [],
      failures: [],
    };

    for (const record of records) {
      if (record.state === "deleted" || new Date(record.expiresAt).getTime() > now.getTime()) {
        continue;
      }
      try {
        await this.destroy(record.id);
        report.deleted.push(record.id);
      } catch (error) {
        report.failures.push({
          environmentId: record.id,
          message: error instanceof Error ? error.message : "Could not delete expired environment.",
        });
      }
    }
    return report;
  }

  private createId(): string {
    const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14).toLowerCase();
    return `env_${timestamp}_${randomBytes(3).toString("hex")}`;
  }

  private providerFor(name: ProviderName): EnvironmentProvider {
    const provider = this.providers.get(name);
    if (!provider) {
      throw new SandboxError("provider_unavailable", `Provider ${name} is not configured.`);
    }
    return provider;
  }
}
