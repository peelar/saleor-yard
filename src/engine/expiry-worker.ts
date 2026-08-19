import type { PruneReport } from "../domain/types.js";

export interface ExpiryPruner {
  pruneExpired(): Promise<PruneReport>;
}

export interface ExpiryWorkerOptions {
  intervalMs: number;
  signal: AbortSignal;
  onReport: (report: PruneReport) => void;
  onError: (error: unknown) => void;
}

export async function runExpiryWorker(
  pruner: ExpiryPruner,
  options: ExpiryWorkerOptions,
): Promise<void> {
  if (!Number.isFinite(options.intervalMs) || options.intervalMs < 1) {
    throw new Error("The expiry worker interval must be positive.");
  }

  while (!options.signal.aborted) {
    try {
      options.onReport(await pruner.pruneExpired());
    } catch (error) {
      options.onError(error);
    }

    await waitForNextCheck(options.intervalMs, options.signal);
  }
}

function waitForNextCheck(intervalMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timeout = setTimeout(finish, intervalMs);
    signal.addEventListener("abort", finish, { once: true });
  });
}
