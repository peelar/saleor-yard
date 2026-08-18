<div align="center">
  <img src="docs/assets/saleor-sandbox-logo.png" width="184" alt="Saleor Sandbox logo">
</div>

<h1 align="center">Saleor Sandbox</h1>

<p align="center"><strong>One source. One exact commit. One disposable Saleor environment.</strong></p>

<p align="center">
  <img alt="Status: early preview" src="https://img.shields.io/badge/status-early_preview-ff6846">
  <img alt="Node.js 22" src="https://img.shields.io/badge/Node.js-22-1f2937">
  <img alt="pnpm 10" src="https://img.shields.io/badge/pnpm-10-f69220">
</p>

Saleor Sandbox creates a temporary, private Saleor environment from a public
release, branch, commit, or pull request. Use it when a human developer or a
coding agent needs to reproduce a bug, review a pull request, test a change, or
explore a specific Saleor version without touching a shared development or
production environment.

Give it a source such as `pr:19668`. It resolves that source to one exact commit,
starts a fresh Saleor stack, and gives you Dashboard, GraphQL, logs, remote
commands, and a clear way to delete everything when you are done.

```bash
pnpm sandbox --provider local create pr:19668 --ttl 2h --wait
```

## Why use it?

For humans, Saleor Sandbox is a clean place to investigate a bug, compare
versions, or try a pull request without rebuilding a local setup by hand.

For coding agents, it is a stable tool with structured JSON output. An agent can
create an environment, wait for it to become ready, call GraphQL, read logs, run
commands, and destroy the environment without learning Docker Compose, Lima,
exe.dev, or SSH port forwarding.

Every sandbox includes:

- the exact requested Saleor Core commit;
- Saleor Dashboard, Core, worker, Postgres, and cache;
- sample data and completed database migrations;
- Mailpit and Jaeger for debugging;
- private or loopback-only access;
- provisioning and service logs;
- an expiry time and explicit cleanup commands.

Pull request code is treated as untrusted. Provider credentials are never copied
into the created environment, and a sandbox is not reported as ready until its
readiness checks pass.

## Quick start

You need Node.js 22 and one supported VM provider:

- **Local:** Lima 2.x and Docker on macOS.
- **Remote:** SSH access to [exe.dev](https://exe.dev).

```bash
./setup
pnpm sandbox create pr:19668 --ttl 2h --wait
```

`./setup` installs the exact pnpm version and project dependencies, then checks
Lima and Docker. If a system tool is missing, it prints the next step. It does
not install system tools or change credentials. For the remote provider, use
`./setup exedev`.

You can create a sandbox from any supported source:

```bash
pnpm sandbox create release:3.23.26 --ttl 2h --wait
pnpm sandbox create branch:main --ttl 2h --wait
pnpm sandbox create commit:eaaf809e91802745618e8b5390afccc80812d4f9 --ttl 2h --wait
pnpm sandbox create pr:19668 --ttl 2h --wait
```

Add `--dry-run` to resolve the source and inspect the plan without creating a VM.
Add `--json` for stable machine-readable output. Progress always goes to standard
error, so it never breaks JSON written to standard output.

## Work with a sandbox

Every create command returns an environment ID. Use that ID for later commands:

```bash
pnpm sandbox status env_abc123 --json
pnpm sandbox logs env_abc123 --service api
pnpm sandbox exec env_abc123 -- python manage.py check
pnpm sandbox http env_abc123 POST /graphql/ \
  --data '{"query":"{ shop { name } }"}' --json
pnpm sandbox tunnel env_abc123
pnpm sandbox destroy env_abc123
```

The same commands work with both providers. Local sandboxes run in a Linux VM on
your Mac. Remote sandboxes run in a private exe.dev VM. The environment engine
stays the same, so a future private HTTP API can offer the same behavior to cloud
agents.

## Project status

Saleor Sandbox is an early preview. The local Lima flow has completed one live
proof. Publishing the immutable exe.dev image and completing the first live
exe.dev proof are still on the current roadmap.

The product contract is in [`SPEC.md`](SPEC.md). More detail is available in:

- [`docs/USAGE.md`](docs/USAGE.md) — the complete command workflow;
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — code boundaries and security;
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — current scope and next milestones;
- [`docs/FUTURE-PROOFING.md`](docs/FUTURE-PROOFING.md) — the path to a private API.

## Development

```bash
./setup
pnpm check
pnpm sandbox create pr:19668 --ttl 30m --dry-run --json
```

The local provider is the default. Set `SALEOR_SANDBOX_PROVIDER=exedev` to use
the remote provider by default.

Release tags publish the exe.dev VM image as
`ghcr.io/saleor/saleor-sandbox-exedev:<version>`. The image contains the small
`sandboxd` guest runtime, but it does not contain Saleor source or provider
credentials.
