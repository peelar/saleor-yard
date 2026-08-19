import { z } from "zod";
import { SandboxError } from "../../domain/errors.js";
import type {
  CommandResult,
  CreatePlan,
  DoctorCheck,
  DoctorReport,
  EnvironmentHttpRequest,
  EnvironmentHttpResponse,
  EnvironmentAccess,
  EnvironmentRecord,
  ExeDevProviderEnvironment,
  LogOptions,
  ProviderStatus,
} from "../../domain/types.js";
import type { CommandRunner } from "../../process/command-runner.js";
import type { EnvironmentProvider } from "../environment-provider.js";
import { investigationResources } from "../investigation-resources.js";

const platformCommit = "ab6315bd59c58b4815175df4c679107ff9695be4";
const defaultDashboardTag = "3.23";
const defaultImage = "ghcr.io/saleor/saleor-sandbox-exedev:0.1.0";
const sshOptions = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15"];

const providerStatusSchema = z.object({
  state: z.enum(["requested", "provisioning", "ready", "failed", "deleting", "deleted"]),
  phase: z.preprocess(
    (value) => value === "provisioning_vm" ? "allocating_environment" : value,
    z.enum([
      "requested",
      "resolving_source",
      "allocating_environment",
      "building_core",
      "migrating_database",
      "seeding_database",
      "starting_services",
      "checking_readiness",
      "ready",
      "deleting",
      "deleted",
      "failed",
    ]),
  ),
  updatedAt: z.string(),
  commit: z.string().regex(/^[a-f0-9]{40}$/).optional(),
  error: z.string().optional(),
});

const commandResultSchema = z.object({
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
});

const httpResponseSchema = z.object({
  status: z.number().int(),
  headers: z.record(z.string(), z.array(z.string())),
  body: z.string(),
});

const integrationListSchema = z.array(
  z.object({
    attachments: z.array(z.string()),
  }),
);

export interface ExeDevProviderOptions {
  cpu?: number;
  memoryGb?: number;
  diskGb?: number;
  gatewayPort?: number;
  image?: string;
}

function parseJsonOutput(output: string): unknown {
  const trimmed = output.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const lines = trimmed.split("\n").reverse();
    for (const line of lines) {
      try {
        return JSON.parse(line);
      } catch {
        // exe.dev may print progress before the final JSON object.
      }
    }
  }
  throw new SandboxError("provider_response_invalid", "exe.dev returned output that was not JSON.");
}

function findString(object: unknown, keys: string[]): string | undefined {
  if (!object || typeof object !== "object") {
    return undefined;
  }
  const record = object as Record<string, unknown>;
  for (const key of keys) {
    if (typeof record[key] === "string") {
      return record[key];
    }
  }
  if (record.vm && typeof record.vm === "object") {
    return findString(record.vm, keys);
  }
  return undefined;
}

function quoteRemoteArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function remoteCommand(arguments_: string[]): string {
  return arguments_.map(quoteRemoteArgument).join(" ");
}

function requireProviderEnvironment(record: EnvironmentRecord): ExeDevProviderEnvironment {
  if (!record.providerEnvironment || record.providerEnvironment.provider !== "exedev") {
    throw new SandboxError(
      "environment_not_provisioned",
      `Environment ${record.id} does not have an exe.dev VM yet.`,
    );
  }
  return record.providerEnvironment;
}

function validateService(service: string): void {
  const allowed = new Set(["api", "worker", "db", "cache", "dashboard", "gateway", "mailpit", "jaeger"]);
  if (!allowed.has(service)) {
    throw new SandboxError("invalid_service", `Unknown Saleor service: ${service}.`);
  }
}

export class ExeDevProvider implements EnvironmentProvider {
  readonly name = "exedev" as const;
  private readonly cpu: number;
  private readonly memoryGb: number;
  private readonly diskGb: number;
  private readonly gatewayPort: number;
  private readonly image: string;

  constructor(
    private readonly runner: CommandRunner,
    options: ExeDevProviderOptions = {},
  ) {
    this.cpu = options.cpu ?? investigationResources.cpu;
    this.memoryGb = options.memoryGb ?? investigationResources.memoryGb;
    this.diskGb = options.diskGb ?? investigationResources.diskGb;
    this.gatewayPort = options.gatewayPort ?? 8080;
    this.image = options.image ?? process.env.SALEOR_SANDBOX_EXEDEV_IMAGE ?? defaultImage;
  }

  async doctor(): Promise<DoctorReport> {
    const checks: DoctorCheck[] = [];
    const ssh = await this.runner.run("ssh", [
      ...sshOptions,
      "exe.dev",
      "whoami",
      "--json",
    ], { timeoutMs: 20_000 });

    if (ssh.exitCode === 0) {
      const result = parseJsonOutput(ssh.stdout) as Record<string, unknown>;
      const email = typeof result.email === "string" ? result.email : "authenticated user";
      checks.push({ name: "exe.dev authentication", ok: true, message: `Connected as ${email}.` });
      checks.push(await this.integrationPolicyCheck());
    } else {
      checks.push({
        name: "exe.dev authentication",
        ok: false,
        message: ssh.stderr.trim() || "Could not connect to exe.dev over SSH.",
      });
    }

    return { ok: checks.every((check) => check.ok), provider: "exedev", checks };
  }

  plan(record: EnvironmentRecord): CreatePlan {
    return {
      environmentId: record.id,
      provider: "exedev",
      resourceName: this.vmName(record),
      source: record.source,
      resources: { cpu: this.cpu, memoryGb: this.memoryGb, diskGb: this.diskGb },
      privateGatewayPort: this.gatewayPort,
      expiresAt: record.expiresAt,
    };
  }

  async create(record: EnvironmentRecord): Promise<{
    environment: ExeDevProviderEnvironment;
    access: EnvironmentAccess;
  }> {
    await this.assertCleanIntegrationPolicy();
    const plan = this.plan(record);
    const privateUrl = `https://${plan.resourceName}.exe.xyz`;
    const dashboardTag = record.source.versionLine ?? defaultDashboardTag;

    const args = [
      ...sshOptions,
      "exe.dev",
      "new",
      `--name=${plan.resourceName}`,
      `--cpu=${this.cpu}`,
      `--memory=${this.memoryGb}GB`,
      `--disk=${this.diskGb}GB`,
      `--image=${this.image}`,
      `--comment=${record.source.requested} at ${record.source.commit.slice(0, 12)}`,
      "--no-email",
      "--json",
    ];

    const creation = await this.runner.run("ssh", args, { timeoutMs: 120_000 });
    if (creation.exitCode !== 0) {
      throw new SandboxError(
        "provider_create_failed",
        creation.stderr.trim() || "exe.dev could not create the VM.",
      );
    }

    const response = parseJsonOutput(creation.stdout);
    const name = findString(response, ["vm_name", "name"]) ?? plan.resourceName;
    const sshDestination = findString(response, ["ssh_dest", "ssh_destination"]) ?? `${name}.exe.xyz`;
    const returnedUrl = findString(response, ["https_url", "url"]) ?? `https://${name}.exe.xyz`;

    try {
      await this.assertCleanIntegrationPolicy(name);
      await this.configurePrivateGateway(name);
      await this.waitForSandboxd(sshDestination);
      const job = JSON.stringify({
        environmentId: record.id,
        cloneUrl: record.source.cloneUrl,
        sourceRef: record.source.ref,
        commit: record.source.commit,
        platformCommit,
        dashboardTag,
        privateUrl,
      });
      const provision = await this.runner.run(
        "ssh",
        [
          ...sshOptions,
          sshDestination,
          remoteCommand(["sudo", "sandboxd", "provision", "--job", "-"]),
        ],
        { input: job, timeoutMs: 30_000 },
      );
      if (provision.exitCode !== 0) {
        throw new SandboxError(
          "guest_provision_failed",
          provision.stderr.trim() || "sandboxd did not accept the provisioning job.",
        );
      }
    } catch (error) {
      await this.runner.run("ssh", [...sshOptions, "exe.dev", "rm", name, "--json"], {
        timeoutMs: 60_000,
      });
      throw error;
    }

    return {
      environment: {
        provider: "exedev",
        providerId: name,
        name,
        sshDestination,
        privateUrl: returnedUrl,
      },
      access: {
        dashboard: `${returnedUrl}/`,
        graphql: `${returnedUrl}/graphql/`,
        sshDestination,
      },
    };
  }

  async inspect(record: EnvironmentRecord): Promise<ProviderStatus> {
    const environment = requireProviderEnvironment(record);
    const result = await this.runner.run(
      "ssh",
      [
        ...sshOptions,
        environment.sshDestination,
        remoteCommand(["sudo", "sandboxd", "status"]),
      ],
      { timeoutMs: 20_000 },
    );
    if (result.exitCode !== 0) {
      return {
        state: "provisioning",
        phase: "allocating_environment",
        updatedAt: new Date().toISOString(),
      };
    }
    const parsed = providerStatusSchema.parse(parseJsonOutput(result.stdout));
    if (parsed.commit && parsed.commit !== record.source.commit) {
      throw new SandboxError(
        "guest_commit_mismatch",
        `sandboxd reports ${parsed.commit}, but ${record.source.commit} was requested.`,
      );
    }
    if (parsed.state === "requested") {
      return {
        state: "provisioning",
        phase: "allocating_environment",
        updatedAt: parsed.updatedAt,
      };
    }
    return parsed as ProviderStatus;
  }

  async logs(record: EnvironmentRecord, options: LogOptions): Promise<CommandResult> {
    const environment = requireProviderEnvironment(record);
    if (options.service) {
      validateService(options.service);
    }
    const sandboxdCommand = [
      "sudo",
      "sandboxd",
      "logs",
      "--tail",
      String(options.tail),
      ...(options.follow ? ["--follow"] : []),
      ...(options.phase === "provision" ? ["--phase", "provision"] : []),
      ...(options.service ? ["--service", options.service] : []),
    ];
    return this.runner.run(
      "ssh",
      [...sshOptions, environment.sshDestination, remoteCommand(sandboxdCommand)],
      { inherit: options.follow },
    );
  }

  async exec(record: EnvironmentRecord, command: string[]): Promise<CommandResult> {
    const environment = requireProviderEnvironment(record);
    if (command.length === 0) {
      throw new SandboxError("missing_command", "Provide a command after --.");
    }
    const remote = ["sudo", "sandboxd", "exec", "--request", "-"];
    const result = await this.runner.run(
      "ssh",
      [...sshOptions, environment.sshDestination, remoteCommand(remote)],
      { input: JSON.stringify({ service: "api", command }) },
    );
    if (result.exitCode !== 0) {
      throw new SandboxError(
        "guest_exec_failed",
        result.stderr.trim() || "sandboxd could not run the command.",
      );
    }
    return commandResultSchema.parse(parseJsonOutput(result.stdout));
  }

  async http(
    record: EnvironmentRecord,
    request: EnvironmentHttpRequest,
  ): Promise<EnvironmentHttpResponse> {
    const environment = requireProviderEnvironment(record);
    const result = await this.runner.run(
      "ssh",
      [
        ...sshOptions,
        environment.sshDestination,
        remoteCommand(["sudo", "sandboxd", "http", "--request", "-"]),
      ],
      { input: JSON.stringify(request), timeoutMs: 60_000 },
    );
    if (result.exitCode !== 0) {
      throw new SandboxError(
        "guest_http_failed",
        result.stderr.trim() || "sandboxd could not make the HTTP request.",
      );
    }
    return httpResponseSchema.parse(parseJsonOutput(result.stdout));
  }

  async tunnel(record: EnvironmentRecord): Promise<CommandResult> {
    const environment = requireProviderEnvironment(record);
    return this.runner.run(
      "ssh",
      [
        ...sshOptions,
        "-o",
        "ExitOnForwardFailure=yes",
        "-N",
        "-L",
        "18080:127.0.0.1:8080",
        "-L",
        "18000:127.0.0.1:8000",
        "-L",
        "18025:127.0.0.1:8025",
        "-L",
        "16686:127.0.0.1:16686",
        environment.sshDestination,
      ],
      { inherit: true },
    );
  }

  async destroy(record: EnvironmentRecord): Promise<void> {
    const environment = requireProviderEnvironment(record);
    const result = await this.runner.run(
      "ssh",
      [...sshOptions, "exe.dev", "rm", environment.name, "--json"],
      { timeoutMs: 60_000 },
    );
    if (result.exitCode !== 0 && !/not found|does not exist/i.test(result.stderr)) {
      throw new SandboxError(
        "provider_destroy_failed",
        result.stderr.trim() || `exe.dev could not delete ${environment.name}.`,
      );
    }
  }

  private vmName(record: EnvironmentRecord): string {
    const source =
      record.source.kind === "pull_request"
        ? `pr-${record.source.pullRequest}`
        : record.source.kind;
    const suffix = record.id.slice(-6).replaceAll("_", "");
    return `sf-${source}-${suffix}`.slice(0, 40);
  }

  private async configurePrivateGateway(name: string): Promise<void> {
    const port = await this.runner.run(
      "ssh",
      [...sshOptions, "exe.dev", "share", "port", name, String(this.gatewayPort), "--json"],
      { timeoutMs: 30_000 },
    );
    if (port.exitCode !== 0) {
      throw new SandboxError(
        "provider_gateway_failed",
        port.stderr.trim() || "exe.dev could not configure the private gateway port.",
      );
    }

    const privacy = await this.runner.run(
      "ssh",
      [...sshOptions, "exe.dev", "share", "set-private", name, "--json"],
      { timeoutMs: 30_000 },
    );
    if (privacy.exitCode !== 0) {
      throw new SandboxError(
        "provider_gateway_failed",
        privacy.stderr.trim() || "exe.dev could not make the gateway private.",
      );
    }
  }

  private async integrationPolicyCheck(vmName?: string): Promise<DoctorCheck> {
    try {
      const blockedAttachments = await this.blockedIntegrationAttachments(vmName);
      if (blockedAttachments.length === 0) {
        return {
          name: "exe.dev integration isolation",
          ok: true,
          message: "No automatic integrations can reach Sandbox VMs.",
        };
      }
      return {
        name: "exe.dev integration isolation",
        ok: false,
        message: this.integrationPolicyMessage(blockedAttachments),
      };
    } catch (error) {
      return {
        name: "exe.dev integration isolation",
        ok: false,
        message: error instanceof Error
          ? `Could not verify exe.dev integrations: ${error.message}`
          : "Could not verify exe.dev integrations.",
      };
    }
  }

  private async assertCleanIntegrationPolicy(vmName?: string): Promise<void> {
    const blockedAttachments = await this.blockedIntegrationAttachments(vmName);
    if (blockedAttachments.length > 0) {
      throw new SandboxError(
        "provider_trust_boundary_failed",
        this.integrationPolicyMessage(blockedAttachments),
      );
    }
  }

  private async blockedIntegrationAttachments(vmName?: string): Promise<string[]> {
    const result = await this.runner.run(
      "ssh",
      [...sshOptions, "exe.dev", "integrations", "list", "--json"],
      { timeoutMs: 20_000 },
    );
    if (result.exitCode !== 0) {
      throw new SandboxError(
        "provider_trust_boundary_check_failed",
        result.stderr.trim() || "exe.dev integrations could not be inspected.",
      );
    }

    const integrations = integrationListSchema.parse(parseJsonOutput(result.stdout));
    const blockedScopes = new Set([
      "auto:all",
      ...(vmName ? [`vm:${vmName}`] : []),
    ]);
    return [
      ...new Set(
        integrations.flatMap(({ attachments }) =>
          attachments.filter((attachment) => blockedScopes.has(attachment)),
        ),
      ),
    ].sort();
  }

  private integrationPolicyMessage(blockedAttachments: string[]): string {
    return [
      `exe.dev integrations are attached through ${blockedAttachments.join(", ")}.`,
      "Untrusted pull request code must not receive provider integrations.",
      "Use a dedicated exe.dev account with no automatic integrations, or remove those attachment rules before creating an environment.",
    ].join(" ");
  }

  private async waitForSandboxd(sshDestination: string): Promise<void> {
    for (let attempt = 1; attempt <= 30; attempt += 1) {
      const result = await this.runner.run(
        "ssh",
        [
          ...sshOptions,
          sshDestination,
          remoteCommand(["sudo", "sandboxd", "status"]),
        ],
        { timeoutMs: 20_000 },
      );
      if (result.exitCode === 0) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    throw new SandboxError(
      "guest_unavailable",
      "The VM started, but the sandboxd guest runtime did not become available.",
    );
  }
}
