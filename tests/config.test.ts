import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("uses the local provider by default", () => {
    expect(loadConfig({}).defaultProvider).toBe("local");
  });

  it("allows exe.dev to be selected", () => {
    expect(loadConfig({ SALEOR_YARD_PROVIDER: "exedev" }).defaultProvider).toBe("exedev");
  });

  it("preserves an invalid provider so the CLI can report it", () => {
    expect(loadConfig({ SALEOR_YARD_PROVIDER: "typo" }).defaultProvider).toBe("typo");
  });
});
