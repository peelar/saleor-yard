import { SandboxError } from "../domain/errors.js";
import type { SourceSelector } from "../domain/types.js";

const safeRef = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const releaseRef = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-.][A-Za-z0-9.-]+)?$/;
const commitRef = /^[a-fA-F0-9]{7,40}$/;

function validateGitRef(value: string, label: string): void {
  const unsafe =
    !safeRef.test(value) ||
    value.includes("..") ||
    value.includes("@{") ||
    value.endsWith("/") ||
    value.endsWith(".lock");

  if (unsafe) {
    throw new SandboxError(
      "invalid_source",
      `${label} contains characters that Saleor Sandbox does not accept.`,
    );
  }
}
export function parseSourceSelector(input: string): SourceSelector {
  const separator = input.indexOf(":");
  if (separator < 1) {
    throw new SandboxError(
      "invalid_source",
      "Source must start with release:, branch:, commit:, or pr:.",
    );
  }

  const kind = input.slice(0, separator);
  const value = input.slice(separator + 1);

  if (kind === "release") {
    if (!releaseRef.test(value)) {
      throw new SandboxError("invalid_source", "Release must look like release:3.23.26.");
    }
    return { kind: "release", value };
  }

  if (kind === "branch") {
    validateGitRef(value, "Branch");
    return { kind: "branch", value };
  }

  if (kind === "commit") {
    if (!commitRef.test(value)) {
      throw new SandboxError("invalid_source", "Commit must contain 7 to 40 hexadecimal characters.");
    }
    return { kind: "commit", value: value.toLowerCase() };
  }

  if (kind === "pr") {
    if (!/^[1-9][0-9]*$/.test(value)) {
      throw new SandboxError("invalid_source", "Pull request must look like pr:19668.");
    }
    return { kind: "pull_request", value: Number(value) };
  }

  throw new SandboxError(
    "invalid_source",
    "Source must start with release:, branch:, commit:, or pr:.",
  );
}

export function formatSourceSelector(selector: SourceSelector): string {
  if (selector.kind === "pull_request") {
    return `pr:${selector.value}`;
  }
  return `${selector.kind}:${selector.value}`;
}
