export const sourceKinds = ["release", "branch", "commit", "pull_request"] as const;

export type SourceKind = (typeof sourceKinds)[number];

export const providerNames = ["local"] as const;

export type ProviderName = (typeof providerNames)[number];

export type SourceSelector =
  | { kind: "release"; value: string }
  | { kind: "branch"; value: string }
  | { kind: "commit"; value: string }
  | { kind: "pull_request"; value: number };

export interface ResolvedSource {
  requested: string;
  kind: SourceKind;
  repository: "saleor/saleor";
  cloneRepository: string;
  cloneUrl: string;
  commit: string;
  ref: string;
  resolvedAt: string;
  pullRequest?: number;
  baseBranch?: string;
  versionLine?: string;
}

export const environmentStates = [
  "requested",
  "provisioning",
  "ready",
  "failed",
  "deleting",
  "deleted",
] as const;

export type EnvironmentState = (typeof environmentStates)[number];

export const environmentPhases = [
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
] as const;

export type EnvironmentPhase = (typeof environmentPhases)[number];

interface BaseProviderEnvironment {
  provider: ProviderName;
  providerId: string;
  name: string;
}

export interface LocalProviderEnvironment extends BaseProviderEnvironment {
  provider: "local";
  ports: {
    gateway: number;
    core: number;
    mailpit: number;
    jaeger: number;
  };
}

export type ProviderEnvironment = LocalProviderEnvironment;

export interface EnvironmentAccess {
  dashboard: string;
  graphql: string;
  rawGraphql?: string;
  mailpit?: string;
  jaeger?: string;
  sshDestination?: string;
}

export interface EnvironmentFailure {
  phase: EnvironmentPhase;
  message: string;
}

export interface EnvironmentRecord {
  schemaVersion: 1;
  id: string;
  provider: ProviderName;
  state: EnvironmentState;
  phase: EnvironmentPhase;
  source: ResolvedSource;
  providerEnvironment?: ProviderEnvironment;
  access?: EnvironmentAccess;
  failure?: EnvironmentFailure;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface ProviderStatus {
  state: EnvironmentState;
  phase: EnvironmentPhase;
  updatedAt: string;
  error?: string;
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  message: string;
}

export interface DoctorReport {
  ok: boolean;
  provider: ProviderName;
  checks: DoctorCheck[];
}

export interface CreatePlan {
  environmentId: string;
  provider: ProviderName;
  resourceName: string;
  source: ResolvedSource;
  resources: {
    cpu: number;
    memoryGb: number;
    diskGb: number;
  };
  privateGatewayPort: number;
  expiresAt: string;
}

export interface LogOptions {
  service?: string;
  phase?: "provision";
  follow: boolean;
  tail: number;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface EnvironmentHttpRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface EnvironmentHttpResponse {
  status: number;
  headers: Record<string, string[]>;
  body: string;
}

export interface PruneFailure {
  environmentId: string;
  message: string;
}

export interface PruneReport {
  checkedAt: string;
  deleted: string[];
  failures: PruneFailure[];
}
