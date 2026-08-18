# Saleor Factory

Saleor Factory turns a public `saleor/saleor` release, branch, commit, or pull
request into a disposable Saleor development environment for coding agents.

The project is under active construction. `SPEC.md` is the product contract.

## Intended usage

```bash
factory create pr:19668 --ttl 2h --wait --json
factory status env_abc123 --json
factory logs env_abc123 --service api
factory exec env_abc123 -- python manage.py check
factory http env_abc123 POST /graphql/ --data '{"query":"{ shop { name } }"}'
factory tunnel env_abc123
factory destroy env_abc123
```

Choose where the VM runs with one global option:

```bash
factory --provider local create pr:19668 --ttl 2h --wait --json
factory --provider exedev create pr:19668 --ttl 2h --wait --json
```

The CLI can create a local Lima VM or a private VM through exe.dev. A future
private HTTP API will use the same environment engine.

With the local provider, Saleor runs inside a Linux VM on the laptop. It does
not run directly on macOS. With exe.dev, it runs in a remote VM. Status, logs,
exec, HTTP, and cleanup work the same way for both.

## Development

Requirements:

- Node.js 22
- pnpm 10
- SSH access to exe.dev for live use
- Lima 2.x for local VMs (`brew install lima` on macOS)
- Docker on the host to build the small `factoryd` guest binary

```bash
pnpm install
pnpm check
pnpm factory doctor
pnpm factory --provider local doctor
pnpm factory create pr:19668 --ttl 30m --dry-run --json
```

`SALEOR_FACTORY_PROVIDER=local` makes local the default if you do not want to
pass `--provider local` each time.

Commands that would create infrastructure support `--dry-run` while the first
provider is being developed.

## VM image

Each VM starts from a versioned image containing the small `factoryd` guest
runtime. Build it locally with:

```bash
pnpm build:image
```

Release tags publish `ghcr.io/saleor/saleor-factory-exedev:<version>`. The CLI
defaults to `0.1.0`; use `SALEOR_FACTORY_EXEDEV_IMAGE` to test another immutable
tag or digest. Do not use a moving `latest` tag for repeatable verification.

exe.dev must be able to pull the image. The first GHCR package therefore needs
public read access unless exe.dev registry authentication is configured.

The image contains no Saleor source. `factoryd` receives an immutable job after
the VM starts and builds the requested commit inside that VM.

## Documentation

- `SPEC.md` — product behavior and acceptance contract.
- `docs/USAGE.md` — the agent workflow in simple commands.
- `docs/ARCHITECTURE.md` — how the code is separated and why.
- `docs/FUTURE-PROOFING.md` — what can be reused by a private API and what it
  still needs.
- `docs/ROADMAP.md` — implementation order and current scope.
- `AGENTS.md` — rules for coding agents working in this repository.
