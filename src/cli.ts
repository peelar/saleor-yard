#!/usr/bin/env node

import { Command, CommanderError } from "commander";
import { loadConfig } from "./config.js";
import { toFactoryError, FactoryError } from "./domain/errors.js";
import type {
  CommandResult,
  CreatePlan,
  DoctorReport,
  EnvironmentRecord,
  ProviderName,
  PruneReport,
} from "./domain/types.js";
import { EnvironmentEngine } from "./engine/environment-engine.js";
import { SpawnCommandRunner } from "./process/command-runner.js";
import { ExeDevProvider } from "./providers/exedev/exedev-provider.js";
import { LocalProvider } from "./providers/local/local-provider.js";
import { GitHubSourceResolver } from "./source/github-source-resolver.js";
import { EnvironmentStore } from "./state/environment-store.js";

function createEngine(): EnvironmentEngine {
  const config = loadConfig();
  const runner = new SpawnCommandRunner();
  return new EnvironmentEngine(
    new GitHubSourceResolver(),
    [new ExeDevProvider(runner), new LocalProvider(runner)],
    new EnvironmentStore(config.stateDirectory),
  );
}

function parseProvider(value: string): ProviderName {
  if (value !== "exedev" && value !== "local") {
    throw new FactoryError("invalid_provider", "Provider must be exedev or local.");
  }
  return value;
}

function parseDuration(value: string): number {
  const match = /^(\d+)(m|h)$/.exec(value);
  if (!match) {
    throw new FactoryError("invalid_duration", "Duration must look like 30m or 2h.");
  }
  const amount = Number(match[1]);
  return match[2] === "h" ? amount * 60 : amount;
}

function parsePositiveInteger(value: string, label: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new FactoryError("invalid_number", `${label} must be a positive integer.`);
  }
  return Number(value);
}

function parseHttpMethod(value: string): "GET" | "POST" | "PUT" | "PATCH" | "DELETE" {
  const method = value.toUpperCase();
  if (!new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]).has(method)) {
    throw new FactoryError("invalid_http_method", "Method must be GET, POST, PUT, PATCH, or DELETE.");
  }
  return method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printEnvironment(record: EnvironmentRecord): void {
  process.stdout.write(`${record.id}  ${record.state}  ${record.source.requested}\n`);
  process.stdout.write(`Commit: ${record.source.commit}\n`);
  process.stdout.write(`Phase: ${record.phase}\n`);
  process.stdout.write(`Expires: ${record.expiresAt}\n`);
  if (record.access) {
    process.stdout.write(`Dashboard: ${record.access.dashboard}\n`);
    process.stdout.write(`GraphQL: ${record.access.graphql}\n`);
    if (record.access.mailpit) process.stdout.write(`Mailpit: ${record.access.mailpit}\n`);
    if (record.access.jaeger) process.stdout.write(`Jaeger: ${record.access.jaeger}\n`);
  }
  if (record.failure) {
    process.stdout.write(`Failure: ${record.failure.message}\n`);
  }
}

function printPlan(plan: CreatePlan): void {
  process.stdout.write(`Dry run for ${plan.source.requested}\n`);
  process.stdout.write(`Resolved commit: ${plan.source.commit}\n`);
  process.stdout.write(`VM: ${plan.vmName}\n`);
  process.stdout.write(
    `Resources: ${plan.resources.cpu} CPU, ${plan.resources.memoryGb} GB memory, ${plan.resources.diskGb} GB disk\n`,
  );
  process.stdout.write(`Expires: ${plan.expiresAt}\n`);
}

function printDoctor(report: DoctorReport): void {
  for (const check of report.checks) {
    process.stdout.write(`${check.ok ? "ok" : "failed"}  ${check.name}: ${check.message}\n`);
  }
}

function outputCommandResult(result: CommandResult, json: boolean): void {
  if (json) {
    writeJson(result);
    return;
  }
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
}

function printPruneReport(report: PruneReport): void {
  process.stdout.write(`Deleted ${report.deleted.length} expired environment(s).\n`);
  for (const failure of report.failures) {
    process.stderr.write(`${failure.environmentId}: ${failure.message}\n`);
  }
}

const engine = createEngine();
const config = loadConfig();
const program = new Command();

program
  .name("factory")
  .description("Create disposable Saleor environments for coding agents.")
  .version("0.0.1")
  .option("--provider <name>", "VM provider: exedev or local", config.defaultProvider)
  .showHelpAfterError()
  .exitOverride();

program
  .command("doctor")
  .description("Check whether the selected VM provider is usable.")
  .option("--json", "write machine-readable JSON")
  .action(async (options: { json?: boolean }) => {
    const report = await engine.doctor(parseProvider(program.opts<{ provider: string }>().provider));
    options.json ? writeJson(report) : printDoctor(report);
    if (!report.ok) {
      process.exitCode = 1;
    }
  });

program
  .command("create")
  .description("Create a Saleor environment from one public source.")
  .argument("<source>", "release:, branch:, commit:, or pr: selector")
  .option("--ttl <duration>", "environment lifetime", "2h")
  .option("--wait", "wait until the environment is ready")
  .option("--wait-timeout <minutes>", "maximum wait time", "30")
  .option("--dry-run", "resolve and show the plan without creating a VM")
  .option("--json", "write machine-readable JSON")
  .action(
    async (
      source: string,
      options: {
        ttl: string;
        wait?: boolean;
        waitTimeout: string;
        dryRun?: boolean;
        json?: boolean;
      },
    ) => {
      if (!options.json) {
        process.stderr.write(`Resolving ${source}...\n`);
      }
      const result = await engine.create(source, {
        ttlMinutes: parseDuration(options.ttl),
        dryRun: options.dryRun ?? false,
        provider: parseProvider(program.opts<{ provider: string }>().provider),
      });

      if ("resources" in result) {
        options.json ? writeJson(result) : printPlan(result);
        return;
      }

      let record = result;
      if (options.wait) {
        let previousPhase = "";
        record = await engine.wait(
          record.id,
          parsePositiveInteger(options.waitTimeout, "Wait timeout"),
          5_000,
          (updated) => {
            if (!options.json && updated.phase !== previousPhase) {
              process.stderr.write(`${updated.id}: ${updated.phase}\n`);
              previousPhase = updated.phase;
            }
          },
        );
      }
      options.json ? writeJson(record) : printEnvironment(record);
      if (record.state === "failed") {
        process.exitCode = 1;
      }
    },
  );

program
  .command("list")
  .description("List locally known environments.")
  .option("--refresh", "refresh each environment from its VM provider")
  .option("--json", "write machine-readable JSON")
  .action(async (options: { refresh?: boolean; json?: boolean }) => {
    const records = await engine.list(options.refresh ?? false);
    if (options.json) {
      writeJson(records);
      return;
    }
    if (records.length === 0) {
      process.stdout.write("No environments.\n");
      return;
    }
    for (const record of records) {
      process.stdout.write(
        `${record.id}  ${record.state.padEnd(12)}  ${record.source.requested.padEnd(20)}  ${record.expiresAt}\n`,
      );
    }
  });

program
  .command("status")
  .description("Show one environment and refresh its state.")
  .argument("<environment>")
  .option("--no-refresh", "use only the local record")
  .option("--json", "write machine-readable JSON")
  .action(async (id: string, options: { refresh: boolean; json?: boolean }) => {
    const record = await engine.get(id, options.refresh);
    options.json ? writeJson(record) : printEnvironment(record);
    if (record.state === "failed") {
      process.exitCode = 1;
    }
  });

program
  .command("wait")
  .description("Wait until an environment is ready or failed.")
  .argument("<environment>")
  .option("--timeout <minutes>", "maximum wait time", "30")
  .option("--json", "write machine-readable JSON")
  .action(async (id: string, options: { timeout: string; json?: boolean }) => {
    let previousPhase = "";
    const record = await engine.wait(
      id,
      parsePositiveInteger(options.timeout, "Timeout"),
      5_000,
      (updated) => {
        if (!options.json && updated.phase !== previousPhase) {
          process.stderr.write(`${updated.id}: ${updated.phase}\n`);
          previousPhase = updated.phase;
        }
      },
    );
    options.json ? writeJson(record) : printEnvironment(record);
    if (record.state !== "ready") {
      process.exitCode = 1;
    }
  });

program
  .command("logs")
  .description("Read provisioning or Saleor service logs.")
  .argument("<environment>")
  .option("--service <name>", "api, worker, db, cache, dashboard, gateway, mailpit, or jaeger")
  .option("--phase <name>", "use provision for VM setup logs")
  .option("--tail <lines>", "number of existing lines", "200")
  .option("--follow", "follow new lines")
  .option("--json", "write a structured command result")
  .action(
    async (
      id: string,
      options: { service?: string; phase?: string; tail: string; follow?: boolean; json?: boolean },
    ) => {
      if (options.service && options.phase) {
        throw new FactoryError("invalid_log_target", "Choose either --service or --phase, not both.");
      }
      if (options.phase && options.phase !== "provision") {
        throw new FactoryError("invalid_log_target", "The only setup log phase is provision.");
      }
      if (options.follow && options.json) {
        throw new FactoryError("invalid_output", "Following logs cannot be returned as one JSON value.");
      }
      const result = await engine.logs(id, {
        ...(options.service ? { service: options.service } : {}),
        ...(options.phase === "provision" ? { phase: "provision" as const } : {}),
        follow: options.follow ?? false,
        tail: parsePositiveInteger(options.tail, "Tail"),
      });
      if (!options.follow) {
        outputCommandResult(result, options.json ?? false);
      }
      if (result.exitCode !== 0) {
        process.exitCode = result.exitCode;
      }
    },
  );

program
  .command("exec")
  .description("Run a non-interactive command inside the Saleor API service.")
  .argument("<environment>")
  .argument("<command...>")
  .option("--json", "write machine-readable JSON")
  .action(async (id: string, command: string[], options: { json?: boolean }) => {
    const result = await engine.exec(id, command);
    outputCommandResult(result, options.json ?? false);
    if (result.exitCode !== 0) {
      process.exitCode = result.exitCode;
    }
  });

program
  .command("http")
  .description("Make an HTTP request through the environment's private gateway.")
  .argument("<environment>")
  .argument("<method>")
  .argument("<path>")
  .option("--data <body>", "request body")
  .option("--content-type <type>", "request content type", "application/json")
  .option("--json", "write the full machine-readable response")
  .action(
    async (
      id: string,
      method: string,
      path: string,
      options: { data?: string; contentType: string; json?: boolean },
    ) => {
      const response = await engine.http(id, {
        method: parseHttpMethod(method),
        path,
        headers: { "Content-Type": options.contentType },
        ...(options.data !== undefined ? { body: options.data } : {}),
      });
      if (options.json) {
        writeJson(response);
      } else {
        process.stdout.write(response.body);
        if (!response.body.endsWith("\n")) {
          process.stdout.write("\n");
        }
        process.stderr.write(`HTTP ${response.status}\n`);
      }
      if (response.status >= 400) {
        process.exitCode = 1;
      }
    },
  );

program
  .command("tunnel")
  .description("Open local ports for direct Saleor service access.")
  .argument("<environment>")
  .action(async (id: string) => {
    const record = await engine.get(id, false);
    const access = record.access;
    process.stderr.write(
      [
        record.provider === "local" ? "Local VM access:" : "Tunnel open until this command stops:",
        `  Dashboard: ${access?.dashboard ?? "http://localhost:18080/"}`,
        `  GraphQL:  ${access?.graphql ?? "http://localhost:18080/graphql/"}`,
        `  Raw Core: ${access?.rawGraphql ?? "http://localhost:18000/graphql/"}`,
        `  Mailpit:   ${access?.mailpit ?? "http://localhost:18025/"}`,
        `  Jaeger:    ${access?.jaeger ?? "http://localhost:16686/"}`,
        "",
      ].join("\n"),
    );
    const result = await engine.tunnel(id);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.exitCode !== 0) {
      process.stderr.write(result.stderr);
      process.exitCode = result.exitCode;
    }
  });

program
  .command("prune")
  .description("Delete environments whose lifetime has expired.")
  .option("--json", "write machine-readable JSON")
  .action(async (options: { json?: boolean }) => {
    const report = await engine.pruneExpired();
    options.json ? writeJson(report) : printPruneReport(report);
    if (report.failures.length > 0) {
      process.exitCode = 1;
    }
  });

program
  .command("destroy")
  .description("Delete an environment and its VM.")
  .argument("<environment>")
  .option("--json", "write machine-readable JSON")
  .action(async (id: string, options: { json?: boolean }) => {
    const record = await engine.destroy(id);
    options.json ? writeJson(record) : printEnvironment(record);
  });

const jsonRequested = process.argv.includes("--json");

try {
  await program.parseAsync(process.argv);
} catch (error) {
  if (error instanceof CommanderError) {
    if (error.code === "commander.helpDisplayed" || error.code === "commander.version") {
      process.exitCode = 0;
    } else {
      process.exitCode = error.exitCode;
    }
  } else {
    const failure = toFactoryError(error);
    if (jsonRequested) {
      writeJson({ error: { code: failure.code, message: failure.message, details: failure.details } });
    } else {
      process.stderr.write(`Error: ${failure.message}\n`);
    }
    process.exitCode = 1;
  }
}
