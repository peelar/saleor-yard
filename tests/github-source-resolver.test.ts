import { describe, expect, it, vi } from "vitest";
import { FactoryError } from "../src/domain/errors.js";
import { GitHubSourceResolver } from "../src/source/github-source-resolver.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("GitHubSourceResolver", () => {
  it("resolves a release to an exact commit", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ sha: "a".repeat(40) }),
    );
    const resolver = new GitHubSourceResolver(fetcher, undefined);

    const result = await resolver.resolve({ kind: "release", value: "3.23.26" });

    expect(result).toMatchObject({
      requested: "release:3.23.26",
      commit: "a".repeat(40),
      cloneRepository: "saleor/saleor",
      versionLine: "3.23",
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.github.com/repos/saleor/saleor/commits/3.23.26",
      expect.objectContaining({ headers: expect.objectContaining({ "User-Agent": "saleor-factory" }) }),
    );
  });

  it("resolves a public fork pull request without passing credentials to the VM", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        number: 123,
        head: {
          sha: "b".repeat(40),
          ref: "fix-checkout",
          repo: {
            full_name: "contributor/saleor",
            clone_url: "https://github.com/contributor/saleor.git",
            private: false,
          },
        },
        base: { ref: "3.23" },
      }),
    );
    const resolver = new GitHubSourceResolver(fetcher, "control-side-token");

    const result = await resolver.resolve({ kind: "pull_request", value: 123 });

    expect(result).toMatchObject({
      requested: "pr:123",
      commit: "b".repeat(40),
      cloneRepository: "contributor/saleor",
      cloneUrl: "https://github.com/contributor/saleor.git",
      baseBranch: "3.23",
      versionLine: "3.23",
    });
    expect(result.cloneUrl).not.toContain("control-side-token");
  });

  it("rejects private pull request sources", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        number: 123,
        head: {
          sha: "b".repeat(40),
          ref: "private-work",
          repo: {
            full_name: "private/saleor",
            clone_url: "https://github.com/private/saleor.git",
            private: true,
          },
        },
        base: { ref: "main" },
      }),
    );

    await expect(
      new GitHubSourceResolver(fetcher, undefined).resolve({ kind: "pull_request", value: 123 }),
    ).rejects.toMatchObject<Partial<FactoryError>>({ code: "unsupported_private_source" });
  });

  it("returns a plain not-found error", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}, 404));

    await expect(
      new GitHubSourceResolver(fetcher, undefined).resolve({ kind: "branch", value: "missing" }),
    ).rejects.toMatchObject<Partial<FactoryError>>({ code: "source_not_found" });
  });
});
