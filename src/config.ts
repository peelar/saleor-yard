import { homedir } from "node:os";
import { join } from "node:path";

export interface YardConfig {
  stateDirectory: string;
  defaultProvider: string;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): YardConfig {
  const base = environment.SALEOR_YARD_HOME ?? join(homedir(), ".local", "share", "saleor-yard");
  const requestedProvider = environment.SALEOR_YARD_PROVIDER ?? "local";
  const defaultProvider: string = requestedProvider;
  return { stateDirectory: join(base, "environments"), defaultProvider };
}
