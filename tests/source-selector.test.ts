import { describe, expect, it } from "vitest";
import { SandboxError } from "../src/domain/errors.js";
import { formatSourceSelector, parseSourceSelector } from "../src/source/source-selector.js";

describe("source selectors", () => {
  it.each([
    ["release:3.23.26", { kind: "release", value: "3.23.26" }],
    ["branch:main", { kind: "branch", value: "main" }],
    ["branch:3.23", { kind: "branch", value: "3.23" }],
    ["commit:eaaf809e", { kind: "commit", value: "eaaf809e" }],
    ["pr:19668", { kind: "pull_request", value: 19668 }],
  ] as const)("parses %s", (input, expected) => {
    expect(parseSourceSelector(input)).toEqual(expected);
  });

  it.each([
    "main",
    "tag:3.23.26",
    "pr:0",
    "pr:not-a-number",
    "branch:../secret",
    "branch:main@{1}",
    "commit:not-a-sha",
    "release:latest",
  ])("rejects unsafe or ambiguous input %s", (input) => {
    expect(() => parseSourceSelector(input)).toThrow(SandboxError);
  });

  it("formats pull requests using the public shorthand", () => {
    expect(formatSourceSelector({ kind: "pull_request", value: 42 })).toBe("pr:42");
  });
});
