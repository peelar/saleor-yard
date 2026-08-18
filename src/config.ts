import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderName } from "./domain/types.js";

export interface SandboxConfig {
  stateDirectory: string;
  defaultProvider: ProviderName;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): SandboxConfig {
  const base = environment.SALEOR_SANDBOX_HOME ?? join(homedir(), ".local", "share", "saleor-sandbox");
  const requestedProvider = environment.SALEOR_SANDBOX_PROVIDER ?? "local";
  const defaultProvider: ProviderName = requestedProvider === "local" ? "local" : "exedev";
  return { stateDirectory: join(base, "environments"), defaultProvider };
}
