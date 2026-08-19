import { randomBytes } from "node:crypto";
import { YardError } from "../domain/errors.js";
import type {
  CommandResult,
  CreatePlan,
  DestroyAllReport,
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
  signal?: AbortSignal;
}

const maxConsecutiveInspectionFailures = 3;

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
    onPrune?: (report: PruneReport) => void,
  ): Promise<EnvironmentRecord | CreatePlan> {
    if (!Number.isInteger(options.ttlMinutes) || options.ttlMinutes < 15 || options.ttlMinutes > 24 * 60) {
      throw new YardError("invalid_ttl", "Lifetime must be between 15 minutes and 24 hours.");
    }

    const selector = parseSourceSelector(sourceInput);

    if (!options.dryRun) {
      const pruneReport = await this.pruneExpired();
      onPrune?.(pruneReport);
      if (pruneReport.failures.length > 0) {
        throw new YardError(
          "automatic_prune_failed",
          `Could not remove ${pruneReport.failures.length} expired environment(s). Fix cleanup before creating another environment.`,
          pruneReport,
        );
      }
      const report = await this.providerFor(options.provider).doctor();
      if (!report.ok) {
        const failures = report.checks
          .filter((check) => !check.ok)
          .map((check) => `${check.name}: ${check.message}`)
          .join(" ");
        throw new YardError(
          "provider_preflight_failed",
          failures || `Provider ${options.provider} is not usable. Run saleor-yard doctor for details.`,
        );
      }
    }

    const source = await this.resolver.resolve(selector);
    const now = new Date();
    const id = this.createId();
    const record: EnvironmentRecord = {
      schemaVersion: 1,
      id,
      provider: options.provider,
      state: "requested",
      phase: "resolving_source",
      source,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + options.ttlMinutes * 60_000).toISOString(),
    };
    record.providerResourceId = this.providerFor(record.provider).plan(record).resourceName;

    if (options.dryRun) {
      return this.providerFor(record.provider).plan(record);
    }

    await this.store.save(record);
    record.state = "provisioning";
    record.phase = "allocating_environment";
    record.updatedAt = new Date().toISOString();
    await this.store.save(record);
    onUpdate?.(record);
    try {
      const created = await this.providerFor(record.provider).create(record, options.signal);
      record.providerEnvironment = created.environment;
      record.access = created.access;
      record.updatedAt = new Date().toISOString();
      await this.store.save(record);
      return record;
    } catch (error) {
      const failure = options.signal?.aborted
        ? new YardError("create_cancelled", "Creation was cancelled. Yard attempted to remove partial provider resources.")
        : error instanceof YardError
        ? error
        : new YardError("environment_create_failed", error instanceof Error ? error.message : "Environment allocation failed.");
      record.state = "failed";
      record.phase = "failed";
      record.failure = {
        phase: "allocating_environment",
        message: failure.message,
      };
      record.updatedAt = new Date().toISOString();
      await this.store.save(record);
      onUpdate?.(record);
      throw new YardError(failure.code, failure.message, {
        ...(failure.details && typeof failure.details === "object" ? failure.details : {}),
        environmentId: record.id,
        expiresAt: record.expiresAt,
      });
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
    signal?: AbortSignal,
  ): Promise<EnvironmentRecord> {
    const deadline = Date.now() + timeoutMinutes * 60_000;
    let inspectionFailures = 0;
    while (Date.now() < deadline) {
      if (signal?.aborted) {
        throw new YardError("wait_cancelled", `Stopped waiting for environment ${id}. Provisioning continues.`, {
          environmentId: id,
        });
      }
      let record: EnvironmentRecord;
      try {
        record = await this.get(id, true);
        inspectionFailures = 0;
      } catch (error) {
        inspectionFailures += 1;
        if (inspectionFailures < maxConsecutiveInspectionFailures) {
          await new Promise((resolve) => setTimeout(resolve, intervalMs));
          continue;
        }
        record = await this.store.get(id);
        record.state = "failed";
        record.failure = {
          phase: record.phase,
          message: `Lost contact with the environment after ${inspectionFailures} attempts: ${error instanceof Error ? error.message : "Provider inspection failed."}`,
        };
        record.updatedAt = new Date().toISOString();
        await this.store.save(record);
      }
      onUpdate?.(record);
      if (record.state === "ready") {
        return record;
      }
      if (record.state === "failed" || record.state === "deleted") {
        return record;
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new YardError("wait_timeout", `Environment ${id} did not become ready in time.`, {
      environmentId: id,
    });
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
    record.providerResourceId ??= this.providerFor(record.provider).plan(record).resourceName;
    await this.store.save(record);

    await this.providerFor(record.provider).destroy(record);
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

  async destroyAll(): Promise<DestroyAllReport> {
    const records = await this.store.list();
    const report: DestroyAllReport = {
      checkedAt: new Date().toISOString(),
      deleted: [],
      orphanedResources: [],
      failures: [],
    };

    for (const record of records) {
      if (record.state === "deleted") continue;
      try {
        await this.destroy(record.id);
        report.deleted.push(record.id);
      } catch (error) {
        report.failures.push({
          environmentId: record.id,
          message: error instanceof Error ? error.message : "Could not delete environment.",
        });
      }
    }

    for (const provider of this.providers.values()) {
      try {
        const orphanReport = await provider.destroyOwnedOrphans();
        report.orphanedResources.push(...orphanReport.deleted);
        report.failures.push(...orphanReport.failures.map((failure) => ({
          environmentId: failure.providerId,
          message: failure.message,
        })));
      } catch (error) {
        report.failures.push({
          environmentId: `provider:${provider.name}`,
          message: error instanceof Error ? error.message : "Could not inspect provider resources.",
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
      throw new YardError("provider_unavailable", `Provider ${name} is not configured.`);
    }
    return provider;
  }
}
