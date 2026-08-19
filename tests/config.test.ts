import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("uses the local provider by default", () => {
    expect(loadConfig({}).defaultProvider).toBe("local");
  });

  it("preserves an invalid provider so the CLI can report it", () => {
    expect(loadConfig({ SALEOR_YARD_PROVIDER: "typo" }).defaultProvider).toBe("typo");
  });
});
