import { homedir } from "node:os";
import { join } from "node:path";

export interface SandboxConfig {
  stateDirectory: string;
  defaultProvider: string;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): SandboxConfig {
  const base = environment.SALEOR_SANDBOX_HOME ?? join(homedir(), ".local", "share", "saleor-sandbox");
  const requestedProvider = environment.SALEOR_SANDBOX_PROVIDER ?? "local";
  const defaultProvider: string = requestedProvider;
  return { stateDirectory: join(base, "environments"), defaultProvider };
}
