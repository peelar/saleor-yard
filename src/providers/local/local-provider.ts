import { existsSync } from "node:fs";
import { mkdtemp, rm, statfs } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { YardError } from "../../domain/errors.js";
import type {
  CommandResult,
  CreatePlan,
  DoctorCheck,
  DoctorReport,
  EnvironmentAccess,
  EnvironmentHttpRequest,
  EnvironmentHttpResponse,
  EnvironmentRecord,
  LocalProviderEnvironment,
  LogOptions,
  ProviderStatus,
} from "../../domain/types.js";
import type { CommandRunner } from "../../process/command-runner.js";
import type { EnvironmentProvider } from "../environment-provider.js";
import { defaultResourceProfile } from "../default-resource-profile.js";

const platformCommit = "ab6315bd59c58b4815175df4c679107ff9695be4";
const defaultDashboardTag = "3.23";
const guestPorts = { gateway: 8080, core: 8000, mailpit: 8025, jaeger: 16686 } as const;
const services = new Set(["api", "worker", "db", "cache", "dashboard", "gateway", "mailpit", "jaeger"]);
const ownedResourceName = /^sy-(?:release|branch|commit|pr-[1-9][0-9]*)-[a-f0-9]{6}$/;
const maxProvisioningStatusAgeMs = 90_000;
const limaInstanceSchema = z.object({ name: z.string() });
const providerPhaseSchema = z.preprocess(
  (value) => value === "provisioning_vm" ? "allocating_environment" : value,
  z.enum([
    "requested", "resolving_source", "allocating_environment", "building_core",
    "migrating_database", "seeding_database", "starting_services",
    "checking_readiness", "ready", "deleting", "deleted", "failed",
  ]),
);

const providerStatusSchema = z.object({
  state: z.enum(["requested", "provisioning", "ready", "failed", "deleting", "deleted"]),
  phase: providerPhaseSchema,
  updatedAt: z.string(),
  commit: z.string().regex(/^[a-f0-9]{40}$/).optional(),
  error: z.string().optional(),
});
const commandResultSchema = z.object({ exitCode: z.number().int(), stdout: z.string(), stderr: z.string() });
const httpResponseSchema = z.object({
  status: z.number().int(),
  headers: z.record(z.string(), z.array(z.string())),
  body: z.string(),
});

export interface LocalProviderOptions {
  cpu?: number;
  memoryGb?: number;
  diskGb?: number;
  ports?: LocalProviderEnvironment["ports"];
  projectRoot?: string;
  yarddBinary?: string;
  freeDiskBytes?: () => Promise<number>;
}

function parseJson(output: string): unknown {
  try {
    return JSON.parse(output.trim());
  } catch (error) {
    throw new YardError("provider_response_invalid", "The local VM returned invalid JSON.", error);
  }
}

// The CLI runs from layouts with different depths: src/providers/local in
// development, dist/cli.cjs when bundled, node_modules/saleor-yard/dist when
// installed from a package. A fixed "../../.." only fits one of them, so walk
// up until the repository marker files appear.
export function findProjectRoot(start: string): string | undefined {
  let directory = start;
  for (;;) {
    if (
      existsSync(join(directory, "images", "yardd.service"))
      && existsSync(join(directory, "images", "local", "Dockerfile"))
    ) {
      return directory;
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function requireLocalEnvironment(record: EnvironmentRecord): LocalProviderEnvironment {
  const environment = record.providerEnvironment;
  if (!environment || environment.provider !== "local") {
    throw new YardError("environment_not_provisioned", `Environment ${record.id} does not have a local VM yet.`);
  }
  return environment;
}

function localResourceName(record: EnvironmentRecord): string {
  const name = record.providerEnvironment?.providerId ?? record.providerResourceId;
  if (!name || !ownedResourceName.test(name)) {
    throw new YardError("environment_not_provisioned", `Environment ${record.id} does not have a safe local resource name.`);
  }
  return name;
}

export class LocalProvider implements EnvironmentProvider {
  readonly name = "local" as const;
  private readonly cpu: number;
  private readonly memoryGb: number;
  private readonly diskGb: number;
  private readonly configuredPorts: LocalProviderEnvironment["ports"] | undefined;
  private readonly projectRoot: string;
  private readonly yarddBinary: string | undefined;
  private readonly freeDiskBytes: () => Promise<number>;

  constructor(private readonly runner: CommandRunner, options: LocalProviderOptions = {}) {
    this.cpu = options.cpu ?? defaultResourceProfile.cpu;
    this.memoryGb = options.memoryGb ?? defaultResourceProfile.memoryGb;
    this.diskGb = options.diskGb ?? defaultResourceProfile.diskGb;
    this.configuredPorts = options.ports;
    const moduleDirectory = dirname(fileURLToPath(import.meta.url));
    this.projectRoot = options.projectRoot
      ?? process.env.SALEOR_YARD_PROJECT_ROOT
      ?? findProjectRoot(moduleDirectory)
      ?? resolve(moduleDirectory, "../../..");
    this.yarddBinary = options.yarddBinary ?? process.env.SALEOR_YARD_LOCAL_YARDD;
    this.freeDiskBytes = options.freeDiskBytes ?? (async () => {
      const stats = await statfs(tmpdir(), { bigint: true });
      return Number(stats.bavail * stats.bsize);
    });
  }

  async doctor(): Promise<DoctorReport> {
    const checks: DoctorCheck[] = [];
    checks.push(await this.commandCheck("Lima", "limactl", ["--version"]));
    if (!this.yarddBinary) {
      checks.push(await this.commandCheck("Docker builder", "docker", ["version", "--format", "{{.Server.Version}}"]));
    }
    checks.push(await this.diskSpaceCheck());
    return { ok: checks.every((check) => check.ok), provider: "local", checks };
  }

  plan(record: EnvironmentRecord): CreatePlan {
    return {
      environmentId: record.id,
      provider: "local",
      resourceName: this.vmName(record),
      source: record.source,
      resources: { cpu: this.cpu, memoryGb: this.memoryGb, diskGb: this.diskGb },
      privateGatewayPort: guestPorts.gateway,
      expiresAt: record.expiresAt,
    };
  }

  async create(record: EnvironmentRecord, signal?: AbortSignal): Promise<{ environment: LocalProviderEnvironment; access: EnvironmentAccess }> {
    this.requireProjectFiles();
    if (!this.yarddBinary) {
      await this.requireDockerBuilder(signal);
    }

    const name = this.vmName(record);
    const ports = this.configuredPorts ?? await this.availablePortsFor(record);
    let create: CommandResult;
    try {
      create = await this.runner.run("limactl", [
        "create", "--tty=false", `--name=${name}`, `--cpus=${this.cpu}`,
        `--memory=${this.memoryGb}`, `--disk=${this.diskGb}`, "--mount-none",
        `--port-forward=${ports.gateway}:${guestPorts.gateway},static=true`,
        `--port-forward=${ports.core}:${guestPorts.core},static=true`,
        `--port-forward=${ports.mailpit}:${guestPorts.mailpit},static=true`,
        `--port-forward=${ports.jaeger}:${guestPorts.jaeger},static=true`,
        "template:docker-rootful",
      ], { timeoutMs: 600_000, ...(signal ? { signal } : {}) });
    } catch (error) {
      await this.runner.run("limactl", ["delete", "--force", name], { timeoutMs: 120_000 });
      throw error;
    }
    if (create.exitCode !== 0) {
      await this.runner.run("limactl", ["delete", "--force", name], { timeoutMs: 120_000 });
      throw new YardError("provider_create_failed", create.stderr.trim() || "Lima could not create the VM.");
    }

    try {
      await this.mustRun("limactl", ["start", "--tty=false", name], "Lima could not start the VM.", 600_000, signal);
      const artifact = await this.prepareYardd(signal);
      try {
        await this.mustRun("limactl", ["copy", artifact.path, `${name}:/tmp/yardd`], "Could not copy yardd into the VM.", 120_000, signal);
        await this.mustRun("limactl", ["copy", join(this.projectRoot, "images", "yardd.service"), `${name}:/tmp/yardd.service`], "Could not copy the yardd service into the VM.", 120_000, signal);
      } finally {
        await artifact.cleanup();
      }
      await this.guestMustRun(name, ["sudo", "install", "-m", "0755", "/tmp/yardd", "/usr/local/bin/yardd"], "Could not install yardd.", 60_000, undefined, signal);
      await this.guestMustRun(name, ["sudo", "install", "-m", "0644", "/tmp/yardd.service", "/etc/systemd/system/yardd.service"], "Could not install the yardd service.", 60_000, undefined, signal);
      await this.guestMustRun(name, ["sudo", "systemctl", "daemon-reload"], "Could not reload systemd.", 60_000, undefined, signal);
      await this.guestMustRun(name, ["sudo", "systemctl", "enable", "--now", "yardd.service"], "Could not start yardd.", 60_000, undefined, signal);
      await this.waitForYardd(name, signal);

      const gatewayUrl = `http://127.0.0.1:${ports.gateway}`;
      const job = JSON.stringify({
        environmentId: record.id,
        cloneUrl: record.source.cloneUrl,
        sourceRef: record.source.ref,
        commit: record.source.commit,
        platformCommit,
        dashboardTag: record.source.versionLine ?? defaultDashboardTag,
        privateUrl: gatewayUrl,
      });
      await this.guestMustRun(name, ["sudo", "yardd", "provision", "--job", "-"], "yardd did not accept the provisioning job.", 30_000, job, signal);

      return {
        environment: { provider: "local", providerId: name, name, ports },
        access: {
          dashboard: `${gatewayUrl}/`,
          graphql: `${gatewayUrl}/graphql/`,
          rawGraphql: `http://127.0.0.1:${ports.core}/graphql/`,
          mailpit: `http://127.0.0.1:${ports.mailpit}/`,
          jaeger: `http://127.0.0.1:${ports.jaeger}/`,
        },
      };
    } catch (error) {
      await this.runner.run("limactl", ["delete", "--force", name], { timeoutMs: 120_000 });
      throw error;
    }
  }

  async inspect(record: EnvironmentRecord): Promise<ProviderStatus> {
    const environment = requireLocalEnvironment(record);
    const result = await this.runGuest(environment.name, ["sudo", "yardd", "status"], 20_000);
    if (result.exitCode !== 0) {
      throw new YardError(
        "provider_inspect_failed",
        result.stderr.trim() || `Could not read status from local environment ${record.id}.`,
      );
    }
    const parsed = providerStatusSchema.parse(parseJson(result.stdout));
    if (parsed.commit && parsed.commit !== record.source.commit) {
      throw new YardError("guest_commit_mismatch", `yardd reports ${parsed.commit}, but ${record.source.commit} was requested.`);
    }
    if (
      parsed.state === "provisioning"
      && Date.now() - new Date(parsed.updatedAt).getTime() > maxProvisioningStatusAgeMs
    ) {
      throw new YardError(
        "provider_status_stale",
        `Environment ${record.id} has not reported progress for more than 90 seconds.`,
      );
    }
    return parsed.state === "requested"
      ? { state: "provisioning", phase: "allocating_environment", updatedAt: parsed.updatedAt }
      : parsed as ProviderStatus;
  }

  async logs(record: EnvironmentRecord, options: LogOptions): Promise<CommandResult> {
    const environment = requireLocalEnvironment(record);
    if (options.service && !services.has(options.service)) {
      throw new YardError("invalid_service", `Unknown Saleor service: ${options.service}.`);
    }
    return this.runner.run("limactl", [
      "shell", "--workdir=/tmp", environment.name, "sudo", "yardd", "logs",
      "--tail", String(options.tail),
      ...(options.follow ? ["--follow"] : []),
      ...(options.phase ? ["--phase", options.phase] : []),
      ...(options.service ? ["--service", options.service] : []),
    ], { inherit: options.follow });
  }

  async exec(record: EnvironmentRecord, command: string[]): Promise<CommandResult> {
    if (command.length === 0) throw new YardError("missing_command", "Provide a command after --.");
    const environment = requireLocalEnvironment(record);
    const result = await this.runGuest(environment.name, ["sudo", "yardd", "exec", "--request", "-"], undefined, JSON.stringify({ service: "api", command }));
    if (result.exitCode !== 0) throw new YardError("guest_exec_failed", result.stderr.trim() || "yardd could not run the command.");
    return commandResultSchema.parse(parseJson(result.stdout));
  }

  async http(record: EnvironmentRecord, request: EnvironmentHttpRequest): Promise<EnvironmentHttpResponse> {
    const environment = requireLocalEnvironment(record);
    const result = await this.runGuest(environment.name, ["sudo", "yardd", "http", "--request", "-"], 60_000, JSON.stringify(request));
    if (result.exitCode !== 0) throw new YardError("guest_http_failed", result.stderr.trim() || "yardd could not make the HTTP request.");
    return httpResponseSchema.parse(parseJson(result.stdout));
  }

  async tunnel(record: EnvironmentRecord): Promise<CommandResult> {
    const environment = requireLocalEnvironment(record);
    return { exitCode: 0, stdout: `Local VM ports are already forwarded for ${environment.name}.\n`, stderr: "" };
  }

  async destroy(record: EnvironmentRecord): Promise<void> {
    const name = record.providerResourceId ? localResourceName(record) : this.vmName(record);
    const result = await this.runner.run("limactl", ["delete", "--force", name], { timeoutMs: 120_000 });
    if (result.exitCode !== 0 && !/does not exist|not found/i.test(result.stderr)) {
      throw new YardError("provider_destroy_failed", result.stderr.trim() || `Lima could not delete ${name}.`);
    }
  }

  async destroyOwnedOrphans(): Promise<{
    deleted: string[];
    failures: Array<{ providerId: string; message: string }>;
  }> {
    const listed = await this.runner.run("limactl", ["list", "--json"], { timeoutMs: 20_000 });
    if (listed.exitCode !== 0) {
      throw new YardError("provider_list_failed", listed.stderr.trim() || "Lima could not list local environments.");
    }

    const names = listed.stdout.split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => limaInstanceSchema.parse(parseJson(line)).name)
      .filter((name) => ownedResourceName.test(name));
    const report = { deleted: [] as string[], failures: [] as Array<{ providerId: string; message: string }> };
    for (const name of names) {
      const result = await this.runner.run("limactl", ["delete", "--force", name], { timeoutMs: 120_000 });
      if (result.exitCode === 0 || /does not exist|not found/i.test(result.stderr)) {
        report.deleted.push(name);
      } else {
        report.failures.push({ providerId: name, message: result.stderr.trim() || `Lima could not delete ${name}.` });
      }
    }
    return report;
  }

  private requireProjectFiles(): void {
    if (
      !existsSync(join(this.projectRoot, "images", "yardd.service"))
      || !existsSync(join(this.projectRoot, "images", "local", "Dockerfile"))
    ) {
      throw new YardError(
        "project_files_missing",
        "Saleor Yard could not find its repository files (images/). Run it from a full checkout or set SALEOR_YARD_PROJECT_ROOT.",
      );
    }
  }

  private vmName(record: EnvironmentRecord): string {
    const source = record.source.kind === "pull_request" ? `pr-${record.source.pullRequest}` : record.source.kind;
    return `sy-${source}-${record.id.slice(-6).replaceAll("_", "")}`.slice(0, 40);
  }

  private portsFor(record: EnvironmentRecord): LocalProviderEnvironment["ports"] {
    const seed = Number.parseInt(record.id.slice(-6), 16);
    const base = 20000 + (Number.isNaN(seed) ? 0 : seed % 5000) * 4;
    return { gateway: base, core: base + 1, mailpit: base + 2, jaeger: base + 3 };
  }

  private async availablePortsFor(record: EnvironmentRecord): Promise<LocalProviderEnvironment["ports"]> {
    const initial = this.portsFor(record).gateway;
    for (let offset = 0; offset < 5000; offset += 1) {
      const base = 20000 + ((initial - 20000 + offset * 4) % 20000);
      const ports = { gateway: base, core: base + 1, mailpit: base + 2, jaeger: base + 3 };
      if ((await Promise.all(Object.values(ports).map((port) => this.portIsAvailable(port)))).every(Boolean)) {
        return ports;
      }
    }
    throw new YardError("local_ports_unavailable", "Could not find four free local ports for the VM.");
  }

  private portIsAvailable(port: number): Promise<boolean> {
    return new Promise((resolvePromise) => {
      const server = createServer();
      server.once("error", () => resolvePromise(false));
      server.listen(port, "127.0.0.1", () => server.close(() => resolvePromise(true)));
    });
  }

  private async requireDockerBuilder(signal?: AbortSignal): Promise<void> {
    let result: CommandResult;
    try {
      result = await this.runner.run("docker", ["version", "--format", "{{.Server.Version}}"], { timeoutMs: 20_000, ...(signal ? { signal } : {}) });
    } catch (error) {
      throw new YardError(
        "docker_unavailable",
        "Docker is not installed or is not on PATH. Install a Docker-compatible runtime, then retry.",
        error,
      );
    }
    if (result.exitCode === 0) return;

    const detail = result.stderr.trim();
    const message = /\.orbstack\/run\/docker\.sock|orbstack/i.test(detail)
      ? "Docker is unavailable because OrbStack is not running. Start OrbStack, verify it with `docker info`, then retry."
      : "The Docker daemon is not running. Start your Docker-compatible runtime, verify it with `docker info`, then retry.";
    throw new YardError("docker_unavailable", message, detail ? { detail } : undefined);
  }

  private async prepareYardd(signal?: AbortSignal): Promise<{ path: string; cleanup: () => Promise<void> }> {
    if (this.yarddBinary) return { path: this.yarddBinary, cleanup: async () => {} };
    const directory = await mkdtemp(join(tmpdir(), "saleor-yard-"));
    let result: CommandResult;
    try {
      result = await this.runner.run("docker", [
        "build", "--file", join(this.projectRoot, "images", "local", "Dockerfile"),
        "--output", `type=local,dest=${directory}`, this.projectRoot,
      ], { timeoutMs: 600_000, ...(signal ? { signal } : {}) });
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    if (result.exitCode !== 0) {
      await rm(directory, { recursive: true, force: true });
      throw new YardError("guest_build_failed", result.stderr.trim() || "Could not build yardd for the local VM.");
    }
    return { path: join(directory, "yardd"), cleanup: () => rm(directory, { recursive: true, force: true }) };
  }

  private runGuest(name: string, command: string[], timeoutMs?: number, input?: string, signal?: AbortSignal): Promise<CommandResult> {
    return this.runner.run("limactl", ["shell", "--workdir=/tmp", name, ...command], { ...(timeoutMs ? { timeoutMs } : {}), ...(input !== undefined ? { input } : {}), ...(signal ? { signal } : {}) });
  }

  private async guestMustRun(name: string, command: string[], message: string, timeoutMs = 60_000, input?: string, signal?: AbortSignal): Promise<void> {
    const result = await this.runGuest(name, command, timeoutMs, input, signal);
    if (result.exitCode !== 0) throw new YardError("guest_setup_failed", result.stderr.trim() || message);
  }

  private async mustRun(command: string, args: string[], message: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    const result = await this.runner.run(command, args, { timeoutMs, ...(signal ? { signal } : {}) });
    if (result.exitCode !== 0) throw new YardError("provider_create_failed", result.stderr.trim() || message);
  }

  private async waitForYardd(name: string, signal?: AbortSignal): Promise<void> {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (signal?.aborted) throw new YardError("create_cancelled", "Creation was cancelled.");
      const result = await this.runGuest(name, ["sudo", "yardd", "status"], 20_000, undefined, signal);
      if (result.exitCode === 0) return;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
    }
    throw new YardError("guest_unavailable", "The local VM started, but yardd did not become available.");
  }

  private async commandCheck(name: string, command: string, args: string[]): Promise<DoctorCheck> {
    try {
      const result = await this.runner.run(command, args, { timeoutMs: 20_000 });
      if (result.exitCode === 0) {
        return { name, ok: true, message: result.stdout.trim() || "Available." };
      }
      if (command === "docker") {
        const detail = result.stderr.trim();
        const message = /\.orbstack\/run\/docker\.sock|orbstack/i.test(detail)
          ? "Docker is unavailable because OrbStack is not running. Start OrbStack, verify it with `docker info`, then retry."
          : "The Docker daemon is not running. Start your Docker-compatible runtime, verify it with `docker info`, then retry.";
        return { name, ok: false, message };
      }
      return { name, ok: false, message: result.stderr.trim() || `${command} is not usable.` };
    } catch {
      const message = command === "docker"
        ? "Docker is not installed or is not on PATH. Install a Docker-compatible runtime, then retry."
        : `${command} is not installed or is not on PATH.`;
      return { name, ok: false, message };
    }
  }

  private async diskSpaceCheck(): Promise<DoctorCheck> {
    const requiredGb = this.diskGb + 5;
    try {
      const availableGb = await this.freeDiskBytes() / 1024 ** 3;
      return availableGb >= requiredGb
        ? { name: "Host disk space", ok: true, message: `${availableGb.toFixed(1)} GB available.` }
        : {
            name: "Host disk space",
            ok: false,
            message: `Only ${availableGb.toFixed(1)} GB is available. At least ${requiredGb} GB must be available before creating an environment.`,
          };
    } catch {
      return { name: "Host disk space", ok: false, message: "Could not check available host disk space." };
    }
  }
}
