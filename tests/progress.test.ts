import { describe, expect, it } from "vitest";
import type { EnvironmentRecord } from "../src/domain/types.js";
import { CliProgress, formatElapsed, formatProgressLine, progressPercent } from "../src/cli/progress.js";

function record(phase: EnvironmentRecord["phase"]): EnvironmentRecord {
  return {
    schemaVersion: 1,
    id: "env_20260818120000_abc123",
    provider: "local",
    state: phase === "ready" ? "ready" : "provisioning",
    phase,
    source: {
      requested: "pr:123",
      kind: "pull_request",
      repository: "saleor/saleor",
      cloneRepository: "saleor/saleor",
      cloneUrl: "https://github.com/saleor/saleor.git",
      commit: "a".repeat(40),
      ref: "feature",
      resolvedAt: "2026-08-18T12:00:00Z",
    },
    createdAt: "2026-08-18T12:00:00Z",
    updatedAt: "2026-08-18T12:00:00Z",
    expiresAt: "2026-08-18T14:00:00Z",
  };
}

describe("CLI progress", () => {
  it("uses milestone percentages and plain phase names", () => {
    expect(progressPercent("building_core")).toBe(25);
    expect(progressPercent("migrating_database")).toBe(60);
    expect(progressPercent("ready")).toBe(100);
    expect(formatProgressLine({ phase: "building_core" }, 312_000)).toContain(
      "25%  Building Saleor Core · 5m 12s",
    );
  });

  it("formats short and long elapsed times", () => {
    expect(formatElapsed(9_900)).toBe("9s");
    expect(formatElapsed(65_000)).toBe("1m 05s");
    expect(formatElapsed(3_720_000)).toBe("1h 02m");
  });

  it("prints only real phase changes when stderr is not interactive", () => {
    let output = "";
    const stream = { isTTY: false, write: (text: string) => { output += text; } };
    const progress = new CliProgress(stream, true, () => 10_000);

    progress.start({ phase: "resolving_source", state: "requested" });
    progress.update(record("building_core"));
    progress.update(record("building_core"));
    progress.update(record("migrating_database"));
    progress.stop();

    expect(output.match(/Building Saleor Core/g)).toHaveLength(1);
    expect(output).toContain("env_20260818120000_abc123:");
    expect(output).toContain("60%  Applying database migrations");
  });
});
