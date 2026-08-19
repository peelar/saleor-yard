# Usage

Saleor Yard is meant to feel like a small remote development machine that an
agent can control without learning Lima or Docker Compose.

## Before the first run

Install Node.js 22, then run the one-command local setup:

```bash
./setup
```

The script installs the exact pnpm version and project dependencies, then checks
Lima and Docker. If one is missing, it tells you what to do next. It does not
install system tools or change credentials.

The local provider needs Lima 2.x and Docker. On macOS, install Lima with
`brew install lima`. Saleor runs inside a Linux VM, not directly on macOS.

## Create an environment

Start with a dry run. It resolves the source to an exact commit and shows what
would be created, but it does not allocate an environment.

```bash
pnpm saleor-yard create pr:19668 --ttl 30m --dry-run --json
```

The local provider uses a small default environment: 2 CPUs, 4 GB of
memory, and a 20 GB disk. It is meant for small catalogs, simple queries, and
issue reproduction, not production traffic or load testing.

For a real environment:

```bash
pnpm saleor-yard create pr:19668 --ttl 2h --json
```

While it works, Yard shows one live progress line with a spinner, lifecycle
percentage, current step, and elapsed time. Long steps such as building Core may
hold at one percentage for several minutes. The spinner and timer show that the
CLI is still waiting; the percentage advances only after a real setup milestone
passes. Progress goes to standard error, so `--json` output on standard output
stays valid. Use `--no-progress` when no progress output is wanted. Creation
waits for a ready environment by default; use `--no-wait` to return while it is
still provisioning.

You can replace `pr:19668` with `release:3.23.26`, `branch:main`, or a full
`commit:` SHA.

Keep the returned environment ID. Every later command uses it.
Yard remembers which provider owns that ID, so later commands do not need a
provider option.

## Work with the environment

Check progress:

```bash
pnpm saleor-yard status env_abc123 --json
pnpm saleor-yard wait env_abc123 --timeout 30 --json
```

Read setup and service logs:

```bash
pnpm saleor-yard logs env_abc123 --setup
pnpm saleor-yard logs env_abc123 --service api --tail 200
pnpm saleor-yard logs env_abc123 --service worker --follow
```

Run a command in the Saleor API container:

```bash
pnpm saleor-yard exec env_abc123 -- python manage.py check
```

Make a GraphQL request without opening a browser:

```bash
pnpm saleor-yard http env_abc123 POST /graphql/ \
  --data '{"query":"{ shop { name } }"}' --json
```

## Browse it

For a local environment, the returned loopback URLs work immediately. Yard
chooses a free group of ports for each environment, so more than one can run at
once.
Use `status` to print the exact URLs.

```bash
pnpm saleor-yard status env_abc123
```

Running `saleor-yard tunnel env_abc123` for a local environment only prints the
same URLs; there is no extra tunnel process to keep alive.

Use `--json` when a script needs the access URLs as one machine-readable value.

## Clean up

Delete one environment:

```bash
pnpm saleor-yard destroy env_abc123 --json
```

Delete every Saleor Yard environment, including safely identified orphaned
provider resources:

```bash
pnpm saleor-yard destroy --all --json
```

Delete every saved environment whose lifetime has passed:

```bash
pnpm saleor-yard prune --json
```

`create` runs this expiry cleanup automatically before allocating a new
environment. If cleanup fails, creation stops and reports the environments that
could not be removed.

Run cleanup continuously:

```bash
pnpm saleor-yard expiry-worker --interval 1m
```

With `--json`, it writes one JSON object per check. Normal progress and failures
go to standard error.

The worker cannot run while your computer is asleep. The future hosted control
plane must keep the same worker running on an always-on machine. Do not treat
the recorded lifetime alone as proof that an environment was deleted.
