import { YardError } from "../domain/errors.js";
import type { ResolvedSource, SourceSelector } from "../domain/types.js";
import { formatSourceSelector } from "./source-selector.js";

const repository = "saleor/saleor" as const;
const githubApi = "https://api.github.com";

interface GitHubCommitResponse {
  sha: string;
}
interface GitHubPullResponse {
  number: number;
  head: {
    sha: string;
    ref: string;
    repo: {
      full_name: string;
      clone_url: string;
      private: boolean;
    } | null;
  };
  base: {
    ref: string;
  };
}

export type FetchLike = typeof fetch;

function versionLineFromRef(ref: string): string | undefined {
  const match = /^(\d+\.\d+)(?:\.|$)/.exec(ref);
  return match?.[1];
}

function assertCommit(value: string): string {
  if (!/^[a-f0-9]{40}$/i.test(value)) {
    throw new YardError("github_response_invalid", "GitHub returned an invalid commit SHA.");
  }
  return value.toLowerCase();
}

function assertPublicCloneUrl(value: string, fullName: string): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName)) {
    throw new YardError("github_response_invalid", "GitHub returned an invalid repository name.");
  }

  const expected = `https://github.com/${fullName}.git`;
  if (value !== expected) {
    throw new YardError("github_response_invalid", "GitHub returned an unexpected clone URL.");
  }
  return value;
}

export class GitHubSourceResolver {
  constructor(
    private readonly fetcher: FetchLike = fetch,
    private readonly token: string | undefined = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN,
  ) {}

  async resolve(selector: SourceSelector): Promise<ResolvedSource> {
    if (selector.kind === "pull_request") {
      return this.resolvePullRequest(selector.value);
    }

    const response = await this.get<GitHubCommitResponse>(
      `/repos/${repository}/commits/${encodeURIComponent(selector.value)}`,
    );
    const commit = assertCommit(response.sha);
    const resolvedAt = new Date().toISOString();
    const versionLine =
      selector.kind === "release" || selector.kind === "branch"
        ? versionLineFromRef(selector.value)
        : undefined;

    return {
      requested: formatSourceSelector(selector),
      kind: selector.kind,
      repository,
      cloneRepository: repository,
      cloneUrl: `https://github.com/${repository}.git`,
      commit,
      ref: selector.value,
      resolvedAt,
      ...(versionLine ? { versionLine } : {}),
    };
  }

  private async resolvePullRequest(number: number): Promise<ResolvedSource> {
    const response = await this.get<GitHubPullResponse>(`/repos/${repository}/pulls/${number}`);

    if (!response.head.repo || response.head.repo.private) {
      throw new YardError(
        "unsupported_private_source",
        "The MVP can only create environments from public pull request repositories.",
      );
    }

    const cloneUrl = assertPublicCloneUrl(response.head.repo.clone_url, response.head.repo.full_name);
    const versionLine = versionLineFromRef(response.base.ref);

    return {
      requested: `pr:${number}`,
      kind: "pull_request",
      repository,
      cloneRepository: response.head.repo.full_name,
      cloneUrl,
      commit: assertCommit(response.head.sha),
      ref: response.head.ref,
      pullRequest: response.number,
      baseBranch: response.base.ref,
      resolvedAt: new Date().toISOString(),
      ...(versionLine ? { versionLine } : {}),
    };
  }

  private async get<T>(path: string): Promise<T> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "saleor-yard",
      "X-GitHub-Api-Version": "2026-03-10",
    };
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }

    const response = await this.fetcher(`${githubApi}${path}`, { headers });
    if (!response.ok) {
      if (response.status === 404) {
        throw new YardError("source_not_found", "GitHub could not find that public Saleor source.");
      }
      throw new YardError(
        "github_request_failed",
        `GitHub source lookup failed with HTTP ${response.status}.`,
      );
    }

    return (await response.json()) as T;
  }
}
