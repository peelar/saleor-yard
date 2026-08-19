import type {
  CommandResult,
  CreatePlan,
  DoctorReport,
  EnvironmentHttpRequest,
  EnvironmentHttpResponse,
  EnvironmentAccess,
  EnvironmentRecord,
  LogOptions,
  ProviderEnvironment,
  ProviderName,
  ProviderStatus,
} from "../domain/types.js";

export interface EnvironmentProvider {
  readonly name: ProviderName;
  doctor(): Promise<DoctorReport>;
  plan(record: EnvironmentRecord): CreatePlan;
  create(record: EnvironmentRecord, signal?: AbortSignal): Promise<{
    environment: ProviderEnvironment;
    access: EnvironmentAccess;
  }>;
  inspect(record: EnvironmentRecord): Promise<ProviderStatus>;
  logs(record: EnvironmentRecord, options: LogOptions): Promise<CommandResult>;
  exec(record: EnvironmentRecord, command: string[]): Promise<CommandResult>;
  http(record: EnvironmentRecord, request: EnvironmentHttpRequest): Promise<EnvironmentHttpResponse>;
  tunnel(record: EnvironmentRecord): Promise<CommandResult>;
  destroy(record: EnvironmentRecord): Promise<void>;
  destroyOwnedOrphans(): Promise<{
    deleted: string[];
    failures: Array<{ providerId: string; message: string }>;
  }>;
}
