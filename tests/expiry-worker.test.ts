import { describe, expect, it, vi } from "vitest";
import type { PruneReport } from "../src/domain/types.js";
import { runExpiryWorker } from "../src/engine/expiry-worker.js";

const report: PruneReport = {
  checkedAt: "2026-08-19T12:00:00.000Z",
  deleted: ["env_expired"],
  failures: [],
};

describe("runExpiryWorker", () => {
  it("checks immediately and stops when asked", async () => {
    const controller = new AbortController();
    const onReport = vi.fn(() => controller.abort());
    const pruneExpired = vi.fn().mockResolvedValue(report);

    await runExpiryWorker(
      { pruneExpired },
      { intervalMs: 60_000, signal: controller.signal, onReport, onError: vi.fn() },
    );

    expect(pruneExpired).toHaveBeenCalledTimes(1);
    expect(onReport).toHaveBeenCalledWith(report);
  });

  it("reports a failed check and keeps running", async () => {
    const controller = new AbortController();
    const failure = new Error("state store unavailable");
    const pruneExpired = vi.fn()
      .mockRejectedValueOnce(failure)
      .mockImplementationOnce(async () => {
        controller.abort();
        return report;
      });
    const onError = vi.fn();

    vi.useFakeTimers();
    const worker = runExpiryWorker(
      { pruneExpired },
      { intervalMs: 1_000, signal: controller.signal, onReport: vi.fn(), onError },
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await worker;
    vi.useRealTimers();

    expect(pruneExpired).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith(failure);
  });
});
