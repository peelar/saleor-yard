import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { YardError } from "../domain/errors.js";
import {
  environmentPhases,
  environmentStates,
  providerNames,
  sourceKinds,
  type EnvironmentRecord,
} from "../domain/types.js";

const resolvedSourceSchema = z.object({
  requested: z.string(),
  kind: z.enum(sourceKinds),
  repository: z.literal("saleor/saleor"),
  cloneRepository: z.string(),
  cloneUrl: z.string().url(),
  commit: z.string().regex(/^[a-f0-9]{40}$/),
  ref: z.string(),
  resolvedAt: z.string(),
  pullRequest: z.number().int().positive().optional(),
  baseBranch: z.string().optional(),
  versionLine: z.string().optional(),
});

const environmentPhaseSchema = z.preprocess(
  (value) => value === "provisioning_vm" ? "allocating_environment" : value,
  z.enum(environmentPhases),
);

const environmentRecordSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  provider: z.enum(providerNames),
  state: z.enum(environmentStates),
  phase: environmentPhaseSchema,
  source: resolvedSourceSchema,
  providerEnvironment: z.object({
    provider: z.literal("local"),
    providerId: z.string(),
    name: z.string(),
    ports: z.object({
      gateway: z.number().int().positive(),
      core: z.number().int().positive(),
      mailpit: z.number().int().positive(),
      jaeger: z.number().int().positive(),
    }),
  }).optional(),
  access: z
    .object({
      dashboard: z.string().url(),
      graphql: z.string().url(),
      rawGraphql: z.string().url().optional(),
      mailpit: z.string().url().optional(),
      jaeger: z.string().url().optional(),
      sshDestination: z.string().optional(),
    })
    .optional(),
  failure: z
    .object({
      phase: environmentPhaseSchema,
      message: z.string(),
    })
    .optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  expiresAt: z.string(),
});

export class EnvironmentStore {
  constructor(private readonly root: string) {}

  async save(record: EnvironmentRecord): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const destination = this.pathFor(record.id);
    const temporary = `${destination}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, destination);
  }

  async get(id: string): Promise<EnvironmentRecord> {
    this.validateId(id);
    try {
      const contents = await readFile(this.pathFor(id), "utf8");
      return environmentRecordSchema.parse(JSON.parse(contents)) as EnvironmentRecord;
    } catch (error) {
      if (error instanceof YardError) {
        throw error;
      }
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new YardError("environment_not_found", `Environment ${id} was not found locally.`);
      }
      throw new YardError("state_read_failed", `Could not read environment ${id}.`, error);
    }
  }

  async list(): Promise<EnvironmentRecord[]> {
    try {
      const names = await readdir(this.root);
      const records = await Promise.all(
        names.filter((name) => name.endsWith(".json")).map((name) => this.get(name.slice(0, -5))),
      );
      return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  private pathFor(id: string): string {
    return join(this.root, `${id}.json`);
  }

  private validateId(id: string): void {
    if (!/^env_[a-z0-9_]+$/.test(id)) {
      throw new YardError("invalid_environment_id", "Environment ID is not valid.");
    }
  }
}
