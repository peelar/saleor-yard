<div align="center">
  <img src="docs/assets/saleor-yard-logo.png" width="184" alt="Saleor Yard logo">
</div>

<h1 align="center">Saleor Yard</h1>

<p align="center"><strong>One source. One exact commit. One disposable Saleor environment.</strong></p>

<p align="center">
  <img alt="Status: early preview" src="https://img.shields.io/badge/status-early_preview-ff6846">
  <img alt="Node.js 22" src="https://img.shields.io/badge/Node.js-22-1f2937">
  <img alt="pnpm 10" src="https://img.shields.io/badge/pnpm-10-f69220">
</p>

Saleor Yard creates a temporary, private Saleor environment from a public
release, branch, commit, or pull request. Use it when a human developer or a
coding agent needs to reproduce a bug, review a pull request, test a change, or
explore a specific Saleor version without touching a shared development or
production environment.

Give it a source such as `pr:19668`. It resolves that source to one exact commit,
starts a fresh Saleor stack, and gives you Dashboard, GraphQL, logs, remote
commands, and a clear way to delete everything when you are done.

```bash
pnpm saleor-yard create pr:19668 --ttl 2h
```

## Why use it?

For humans, Saleor Yard is a clean place to debug an issue, compare
versions, or try a pull request without rebuilding a local setup by hand.

For coding agents, it is a stable tool with structured JSON output. An agent can
create an environment, wait for it to become ready, call GraphQL, read logs, run
commands, and destroy the environment without learning Docker Compose, Lima,
exe.dev, or SSH port forwarding.

Every environment includes:

- the exact requested Saleor Core commit;
- Saleor Dashboard, Core, worker, Postgres, and cache;
- sample data and completed database migrations;
- Mailpit and Jaeger for debugging;
- private or loopback-only access;
- provisioning and service logs;
- an expiry time and explicit cleanup commands.

Pull request code is treated as untrusted. Provider credentials are never copied
into the created environment, and an environment is not reported as ready until
its readiness checks pass.

The default environment is intentionally small: 2 CPUs, 4 GB of memory, and a
20 GB disk. It is sized for development, not production Saleor traffic.

### Trust boundary

An exe.dev integration is a credential even when its secret stays outside the
VM. It can give untrusted code access to GitHub, cloud services, paid models, or
other private systems. Yard refuses to use exe.dev when an integration is
attached through `auto:all` or the new VM name. It does not add a shared VM tag,
so tag-based integrations do not apply. Yard checks before creating the VM
and again before sending source code into it.

Use a dedicated exe.dev account with no automatic integrations for remote
environments. Do not attach an integration while an environment is running. You
can inspect the relevant account settings without printing integration secrets:

```bash
ssh exe.dev integrations list --json | jq \
  '[.[] | {name, type, attachments}]'
```

Changing an `auto:all` rule affects other VMs on the account. Review those VMs
before detaching anything. The local Lima provider does not use exe.dev
integrations.

## Quick start

You need Node.js 22 and one supported environment provider:

- **Local:** Lima 2.x and Docker on macOS.
- **Remote:** SSH access to [exe.dev](https://exe.dev).

```bash
./setup
pnpm saleor-yard create pr:19668 --ttl 2h
```

`./setup` installs the exact pnpm version and project dependencies, then checks
Lima and Docker. If a system tool is missing, it prints the next step. It does
not install system tools or change credentials. For the remote provider, use
`./setup exedev`.

You can create an environment from any supported source:

```bash
pnpm saleor-yard create release:3.23.26 --ttl 2h
pnpm saleor-yard create branch:main --ttl 2h
pnpm saleor-yard create commit:eaaf809e91802745618e8b5390afccc80812d4f9 --ttl 2h
pnpm saleor-yard create pr:19668 --ttl 2h
```

Add `--dry-run` to resolve the source and inspect the plan without allocating an
environment. Add `--json` for stable machine-readable output. Progress always
goes to standard error, so it never breaks JSON written to standard output.
Creation waits for a ready environment by default. Use `--no-wait` when you
want to return while it is still provisioning.

## Work with an environment

Every create command returns an environment ID. Use that ID for later commands:

```bash
pnpm saleor-yard status env_abc123 --json
pnpm saleor-yard logs env_abc123 --service api
pnpm saleor-yard logs env_abc123 --setup
pnpm saleor-yard exec env_abc123 -- python manage.py check
pnpm saleor-yard http env_abc123 POST /graphql/ \
  --data '{"query":"{ shop { name } }"}' --json
pnpm saleor-yard tunnel env_abc123
pnpm saleor-yard destroy env_abc123
```

For continuous expiry cleanup, run `pnpm saleor-yard expiry-worker --interval 1m`
under a process manager. The future private service will run the same worker.

The same commands work with both providers. Local environments run in a Linux VM
on your Mac. Remote environments run in a private exe.dev VM. The environment
engine stays the same, so a future private HTTP API can offer the same behavior to
cloud agents.

## Agent skill

Install the base Saleor Yard skill in a coding-agent project:

```bash
npx skills add peelar/saleor-yard --skill saleor-yard
```

The skill explains the environment model, capabilities, safe workflow, and
readiness rules. It tells the agent to read the installed CLI's current help
instead of carrying a command reference that can go stale.

## Project status

Saleor Yard is an early preview. The local Lima flow has completed one live
proof. Publishing the immutable exe.dev image and completing the first live
exe.dev proof are still on the current roadmap.

The product contract is in [`SPEC.md`](SPEC.md). More detail is available in:

- [`docs/USAGE.md`](docs/USAGE.md) — the complete command workflow;
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — code boundaries and security;
- [`docs/ISOLATION.md`](docs/ISOLATION.md) — why Dev Containers do not replace
  isolation;
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — current scope and next milestones;
- [`docs/FUTURE-PROOFING.md`](docs/FUTURE-PROOFING.md) — the path to a private API.

## Development

```bash
./setup
pnpm check
pnpm saleor-yard create pr:19668 --ttl 30m --dry-run --json
```

The local provider is the default. Set `SALEOR_YARD_PROVIDER=exedev` to use
the remote provider by default.

Release tags publish the exe.dev VM image as
`ghcr.io/saleor/saleor-yard-exedev:<version>`. The image contains the small
`yardd` guest runtime, but it does not contain Saleor source or provider
credentials.
