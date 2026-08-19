import type { EnvironmentPhase, EnvironmentRecord, EnvironmentState } from "../domain/types.js";

const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

const phaseDetails: Record<EnvironmentPhase, { label: string; percent: number }> = {
  requested: { label: "Queued", percent: 0 },
  resolving_source: { label: "Resolving source", percent: 0 },
  allocating_environment: { label: "Allocating environment", percent: 10 },
  building_core: { label: "Building Saleor Core", percent: 25 },
  migrating_database: { label: "Applying database migrations", percent: 60 },
  seeding_database: { label: "Loading sample data", percent: 75 },
  starting_services: { label: "Starting services", percent: 85 },
  checking_readiness: { label: "Checking readiness", percent: 92 },
  ready: { label: "Environment ready", percent: 100 },
  deleting: { label: "Deleting environment", percent: 0 },
  deleted: { label: "Environment deleted", percent: 100 },
  failed: { label: "Environment failed", percent: 0 },
};

interface ProgressStream {
  readonly isTTY?: boolean;
  readonly columns?: number;
  write(text: string): unknown;
}

export interface ProgressUpdate {
  environmentId?: string;
  failurePhase?: EnvironmentPhase;
  phase: EnvironmentPhase;
  state?: EnvironmentState;
}

export function progressPercent(phase: EnvironmentPhase): number {
  return phaseDetails[phase].percent;
}

export function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

export function formatProgressLine(
  update: ProgressUpdate,
  elapsedMs: number,
  frame = 0,
  barWidth = 20,
): string {
  const measuredPhase = update.state === "failed" && update.failurePhase
    ? update.failurePhase
    : update.phase;
  const { label, percent } = phaseDetails[measuredPhase];
  const filled = Math.round((percent / 100) * barWidth);
  const bar = `${"█".repeat(filled)}${"░".repeat(barWidth - filled)}`;
  const status = update.state === "failed"
    ? `Failed during ${label.toLowerCase()}`
    : label;
  const marker = update.state === "failed"
    ? "✗"
    : update.phase === "ready" || update.phase === "deleted"
      ? "✓"
      : spinnerFrames[frame % spinnerFrames.length];

  return `${marker} [${bar}] ${String(percent).padStart(3, " ")}%  ${status} · ${formatElapsed(elapsedMs)}`;
}

export class CliProgress {
  private active = false;
  private current: ProgressUpdate | undefined;
  private frame = 0;
  private lastPrintedKey = "";
  private startedAt = 0;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly output: ProgressStream,
    private readonly enabled = true,
    private readonly now: () => number = Date.now,
  ) {}

  start(update: ProgressUpdate): void {
    if (!this.enabled) return;
    this.active = true;
    this.startedAt = this.now();
    this.current = update;
    this.writeUpdate();
    if (this.output.isTTY) {
      this.timer = setInterval(() => {
        this.frame += 1;
        this.writeInteractiveLine();
      }, 80);
      this.timer.unref();
    }
  }

  update(record: EnvironmentRecord): void {
    this.set({
      environmentId: record.id,
      phase: record.phase,
      state: record.state,
      ...(record.failure ? { failurePhase: record.failure.phase } : {}),
    });
  }

  set(update: ProgressUpdate): void {
    if (!this.enabled) return;
    if (!this.active) {
      this.start(update);
      return;
    }
    this.current = update;
    this.writeUpdate();
  }

  stop(): void {
    if (!this.active) return;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.output.isTTY) {
      this.output.write("\n");
    }
    this.active = false;
  }

  private writeUpdate(): void {
    if (this.output.isTTY) {
      this.writeInteractiveLine();
      return;
    }
    if (!this.current) return;
    const key = [this.current.environmentId, this.current.phase, this.current.state].join(":");
    if (key === this.lastPrintedKey) return;
    this.lastPrintedKey = key;
    const id = this.current.environmentId ? `${this.current.environmentId}: ` : "";
    this.output.write(`${id}${formatProgressLine(this.current, this.now() - this.startedAt)}\n`);
  }

  private writeInteractiveLine(): void {
    if (!this.current) return;
    const line = formatProgressLine(this.current, this.now() - this.startedAt, this.frame);
    const availableWidth = Math.max(20, (this.output.columns ?? 100) - 1);
    this.output.write(`\r\u001B[2K${line.slice(0, availableWidth)}`);
  }
}
