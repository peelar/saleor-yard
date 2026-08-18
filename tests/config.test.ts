import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("uses the local provider by default", () => {
    expect(loadConfig({}).defaultProvider).toBe("local");
  });

  it("allows exe.dev to be selected", () => {
    expect(loadConfig({ SALEOR_SANDBOX_PROVIDER: "exedev" }).defaultProvider).toBe("exedev");
  });
});
