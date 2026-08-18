import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderName } from "./domain/types.js";

export interface FactoryConfig {
  stateDirectory: string;
  defaultProvider: ProviderName;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): FactoryConfig {
  const base = environment.SALEOR_FACTORY_HOME ?? join(homedir(), ".local", "share", "saleor-factory");
  const requestedProvider = environment.SALEOR_FACTORY_PROVIDER ?? "exedev";
  const defaultProvider: ProviderName = requestedProvider === "local" ? "local" : "exedev";
  return { stateDirectory: join(base, "environments"), defaultProvider };
}
