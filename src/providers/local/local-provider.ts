import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { SandboxError } from "../../domain/errors.js";
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

const platformCommit = "ab6315bd59c58b4815175df4c679107ff9695be4";
const defaultDashboardTag = "3.23";
const guestPorts = { gateway: 8080, core: 8000, mailpit: 8025, jaeger: 16686 } as const;
const services = new Set(["api", "worker", "db", "cache", "dashboard", "gateway", "mailpit", "jaeger"]);

const providerStatusSchema = z.object({
  state: z.enum(["requested", "provisioning", "ready", "failed", "deleting", "deleted"]),
  phase: z.enum([
    "requested", "resolving_source", "provisioning_vm", "building_core",
    "migrating_database", "seeding_database", "starting_services",
    "checking_readiness", "ready", "deleting", "deleted", "failed",
  ]),
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
  sandboxdBinary?: string;
}

function parseJson(output: string): unknown {
  try {
    return JSON.parse(output.trim());
  } catch (error) {
    throw new SandboxError("provider_response_invalid", "The local VM returned invalid JSON.", error);
  }
}

function requireLocalEnvironment(record: EnvironmentRecord): LocalProviderEnvironment {
  const environment = record.providerEnvironment;
  if (!environment || environment.provider !== "local") {
    throw new SandboxError("environment_not_provisioned", `Environment ${record.id} does not have a local VM yet.`);
  }
  return environment;
}

export class LocalProvider implements EnvironmentProvider {
  readonly name = "local" as const;
  private readonly cpu: number;
  private readonly memoryGb: number;
  private readonly diskGb: number;
  private readonly configuredPorts: LocalProviderEnvironment["ports"] | undefined;
  private readonly projectRoot: string;
  private readonly sandboxdBinary: string | undefined;

  constructor(private readonly runner: CommandRunner, options: LocalProviderOptions = {}) {
    this.cpu = options.cpu ?? 4;
    this.memoryGb = options.memoryGb ?? 8;
    this.diskGb = options.diskGb ?? 40;
    this.configuredPorts = options.ports;
    this.projectRoot = options.projectRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    this.sandboxdBinary = options.sandboxdBinary ?? process.env.SALEOR_SANDBOX_LOCAL_SANDBOXD;
  }

  async doctor(): Promise<DoctorReport> {
    const checks: DoctorCheck[] = [];
    checks.push(await this.commandCheck("Lima", "limactl", ["--version"]));
    if (!this.sandboxdBinary) {
      checks.push(await this.commandCheck("Docker builder", "docker", ["version", "--format", "{{.Server.Version}}"]));
    }
    return { ok: checks.every((check) => check.ok), provider: "local", checks };
  }

  plan(record: EnvironmentRecord): CreatePlan {
    return {
      environmentId: record.id,
      provider: "local",
      vmName: this.vmName(record),
      source: record.source,
      resources: { cpu: this.cpu, memoryGb: this.memoryGb, diskGb: this.diskGb },
      privateGatewayPort: guestPorts.gateway,
      expiresAt: record.expiresAt,
    };
  }

  async create(record: EnvironmentRecord): Promise<{ environment: LocalProviderEnvironment; access: EnvironmentAccess }> {
    const name = this.vmName(record);
    const ports = this.configuredPorts ?? await this.availablePortsFor(record);
    const create = await this.runner.run("limactl", [
      "create", "--tty=false", `--name=${name}`, `--cpus=${this.cpu}`,
      `--memory=${this.memoryGb}`, `--disk=${this.diskGb}`, "--mount-none",
      `--port-forward=${ports.gateway}:${guestPorts.gateway},static=true`,
      `--port-forward=${ports.core}:${guestPorts.core},static=true`,
      `--port-forward=${ports.mailpit}:${guestPorts.mailpit},static=true`,
      `--port-forward=${ports.jaeger}:${guestPorts.jaeger},static=true`,
      "template:docker-rootful",
    ], { timeoutMs: 600_000 });
    if (create.exitCode !== 0) {
      await this.runner.run("limactl", ["delete", "--force", name], { timeoutMs: 120_000 });
      throw new SandboxError("provider_create_failed", create.stderr.trim() || "Lima could not create the VM.");
    }

    try {
      await this.mustRun("limactl", ["start", "--tty=false", name], "Lima could not start the VM.", 600_000);
      const artifact = await this.prepareSandboxd();
      try {
        await this.mustRun("limactl", ["copy", artifact.path, `${name}:/tmp/sandboxd`], "Could not copy sandboxd into the VM.", 120_000);
        await this.mustRun("limactl", ["copy", join(this.projectRoot, "images", "sandboxd.service"), `${name}:/tmp/sandboxd.service`], "Could not copy the sandboxd service into the VM.", 120_000);
      } finally {
        await artifact.cleanup();
      }
      await this.guestMustRun(name, ["sudo", "install", "-m", "0755", "/tmp/sandboxd", "/usr/local/bin/sandboxd"], "Could not install sandboxd.");
      await this.guestMustRun(name, ["sudo", "install", "-m", "0644", "/tmp/sandboxd.service", "/etc/systemd/system/sandboxd.service"], "Could not install the sandboxd service.");
      await this.guestMustRun(name, ["sudo", "systemctl", "daemon-reload"], "Could not reload systemd.");
      await this.guestMustRun(name, ["sudo", "systemctl", "enable", "--now", "sandboxd.service"], "Could not start sandboxd.");
      await this.waitForSandboxd(name);

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
      await this.guestMustRun(name, ["sudo", "sandboxd", "provision", "--job", "-"], "sandboxd did not accept the provisioning job.", 30_000, job);

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
    const result = await this.runGuest(environment.name, ["sudo", "sandboxd", "status"], 20_000);
    if (result.exitCode !== 0) {
      return { state: "provisioning", phase: "provisioning_vm", updatedAt: new Date().toISOString() };
    }
    const parsed = providerStatusSchema.parse(parseJson(result.stdout));
    if (parsed.commit && parsed.commit !== record.source.commit) {
      throw new SandboxError("guest_commit_mismatch", `sandboxd reports ${parsed.commit}, but ${record.source.commit} was requested.`);
    }
    return parsed.state === "requested"
      ? { state: "provisioning", phase: "provisioning_vm", updatedAt: parsed.updatedAt }
      : parsed as ProviderStatus;
  }

  async logs(record: EnvironmentRecord, options: LogOptions): Promise<CommandResult> {
    const environment = requireLocalEnvironment(record);
    if (options.service && !services.has(options.service)) {
      throw new SandboxError("invalid_service", `Unknown Saleor service: ${options.service}.`);
    }
    return this.runner.run("limactl", [
      "shell", "--workdir=/tmp", environment.name, "sudo", "sandboxd", "logs",
      "--tail", String(options.tail),
      ...(options.follow ? ["--follow"] : []),
      ...(options.phase ? ["--phase", options.phase] : []),
      ...(options.service ? ["--service", options.service] : []),
    ], { inherit: options.follow });
  }

  async exec(record: EnvironmentRecord, command: string[]): Promise<CommandResult> {
    if (command.length === 0) throw new SandboxError("missing_command", "Provide a command after --.");
    const environment = requireLocalEnvironment(record);
    const result = await this.runGuest(environment.name, ["sudo", "sandboxd", "exec", "--request", "-"], undefined, JSON.stringify({ service: "api", command }));
    if (result.exitCode !== 0) throw new SandboxError("guest_exec_failed", result.stderr.trim() || "sandboxd could not run the command.");
    return commandResultSchema.parse(parseJson(result.stdout));
  }

  async http(record: EnvironmentRecord, request: EnvironmentHttpRequest): Promise<EnvironmentHttpResponse> {
    const environment = requireLocalEnvironment(record);
    const result = await this.runGuest(environment.name, ["sudo", "sandboxd", "http", "--request", "-"], 60_000, JSON.stringify(request));
    if (result.exitCode !== 0) throw new SandboxError("guest_http_failed", result.stderr.trim() || "sandboxd could not make the HTTP request.");
    return httpResponseSchema.parse(parseJson(result.stdout));
  }

  async tunnel(record: EnvironmentRecord): Promise<CommandResult> {
    const environment = requireLocalEnvironment(record);
    return { exitCode: 0, stdout: `Local VM ports are already forwarded for ${environment.name}.\n`, stderr: "" };
  }

  async destroy(record: EnvironmentRecord): Promise<void> {
    const environment = requireLocalEnvironment(record);
    const result = await this.runner.run("limactl", ["delete", "--force", environment.name], { timeoutMs: 120_000 });
    if (result.exitCode !== 0 && !/does not exist|not found/i.test(result.stderr)) {
      throw new SandboxError("provider_destroy_failed", result.stderr.trim() || `Lima could not delete ${environment.name}.`);
    }
  }

  private vmName(record: EnvironmentRecord): string {
    const source = record.source.kind === "pull_request" ? `pr-${record.source.pullRequest}` : record.source.kind;
    return `sf-${source}-${record.id.slice(-6).replaceAll("_", "")}`.slice(0, 40);
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
    throw new SandboxError("local_ports_unavailable", "Could not find four free local ports for the VM.");
  }

  private portIsAvailable(port: number): Promise<boolean> {
    return new Promise((resolvePromise) => {
      const server = createServer();
      server.once("error", () => resolvePromise(false));
      server.listen(port, "127.0.0.1", () => server.close(() => resolvePromise(true)));
    });
  }

  private async prepareSandboxd(): Promise<{ path: string; cleanup: () => Promise<void> }> {
    if (this.sandboxdBinary) return { path: this.sandboxdBinary, cleanup: async () => {} };
    const directory = await mkdtemp(join(tmpdir(), "saleor-sandbox-"));
    const result = await this.runner.run("docker", [
      "build", "--file", join(this.projectRoot, "images", "local", "Dockerfile"),
      "--output", `type=local,dest=${directory}`, this.projectRoot,
    ], { timeoutMs: 600_000 });
    if (result.exitCode !== 0) {
      await rm(directory, { recursive: true, force: true });
      throw new SandboxError("guest_build_failed", result.stderr.trim() || "Could not build sandboxd for the local VM.");
    }
    return { path: join(directory, "sandboxd"), cleanup: () => rm(directory, { recursive: true, force: true }) };
  }

  private runGuest(name: string, command: string[], timeoutMs?: number, input?: string): Promise<CommandResult> {
    return this.runner.run("limactl", ["shell", "--workdir=/tmp", name, ...command], { ...(timeoutMs ? { timeoutMs } : {}), ...(input !== undefined ? { input } : {}) });
  }

  private async guestMustRun(name: string, command: string[], message: string, timeoutMs = 60_000, input?: string): Promise<void> {
    const result = await this.runGuest(name, command, timeoutMs, input);
    if (result.exitCode !== 0) throw new SandboxError("guest_setup_failed", result.stderr.trim() || message);
  }

  private async mustRun(command: string, args: string[], message: string, timeoutMs: number): Promise<void> {
    const result = await this.runner.run(command, args, { timeoutMs });
    if (result.exitCode !== 0) throw new SandboxError("provider_create_failed", result.stderr.trim() || message);
  }

  private async waitForSandboxd(name: string): Promise<void> {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const result = await this.runGuest(name, ["sudo", "sandboxd", "status"], 20_000);
      if (result.exitCode === 0) return;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
    }
    throw new SandboxError("guest_unavailable", "The local VM started, but sandboxd did not become available.");
  }

  private async commandCheck(name: string, command: string, args: string[]): Promise<DoctorCheck> {
    try {
      const result = await this.runner.run(command, args, { timeoutMs: 20_000 });
      return result.exitCode === 0
        ? { name, ok: true, message: result.stdout.trim() || "Available." }
        : { name, ok: false, message: result.stderr.trim() || `${command} is not usable.` };
    } catch {
      return { name, ok: false, message: `${command} is not installed or is not on PATH.` };
    }
  }
}
