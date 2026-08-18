# Usage

Saleor Sandbox is meant to feel like a small remote development machine that an
agent can control without learning Lima, exe.dev, or Docker Compose.

## Before the first run

Install Node.js 22, then run the one-command local setup:

```bash
./setup
```

The script installs the exact pnpm version and project dependencies, then checks
Lima and Docker. If one is missing, it tells you what to do next. It does not
install system tools or change credentials.

The local provider is the default. To use exe.dev instead, run:

```bash
./setup exedev
```

The local provider needs Lima 2.x and Docker. On macOS, install Lima with
`brew install lima`. Saleor runs inside a Linux VM, not directly on macOS.

The exe.dev provider checks the SSH connection to exe.dev. Saleor runs in a
remote VM.

The current VM image has only been built locally. A live creation also needs a
published image configured through `SALEOR_SANDBOX_EXEDEV_IMAGE`.

## Create an environment

Start with a dry run. It resolves the source to an exact commit and shows what
would be created, but it does not create a VM.

```bash
pnpm sandbox create pr:19668 --ttl 30m --dry-run --json
```

For a real environment:

```bash
pnpm sandbox create pr:19668 --ttl 2h --wait --json
```

While it works, Sandbox shows one live progress line with a spinner, lifecycle
percentage, current step, and elapsed time. Long steps such as building Core may
hold at one percentage for several minutes. The spinner and timer show that the
CLI is still waiting; the percentage advances only after a real setup milestone
passes. Progress goes to standard error, so `--json` output on standard output
stays valid. Use `--no-progress` when no progress output is wanted.

You can replace `pr:19668` with `release:3.23.26`, `branch:main`, or a full
`commit:` SHA.

Keep the returned environment ID. Every later command uses it.
Sandbox remembers which provider owns that ID, so later commands do not need a
provider option.

## Work with the environment

Check progress:

```bash
pnpm sandbox status env_abc123 --json
pnpm sandbox wait env_abc123 --timeout 30 --json
```

Read setup and service logs:

```bash
pnpm sandbox logs env_abc123 --phase provision
pnpm sandbox logs env_abc123 --service api --tail 200
pnpm sandbox logs env_abc123 --service worker --follow
```

Run a command in the Saleor API container:

```bash
pnpm sandbox exec env_abc123 -- python manage.py check
```

Make a GraphQL request without opening a browser or handling an HTTPS access
token:

```bash
pnpm sandbox http env_abc123 POST /graphql/ \
  --data '{"query":"{ shop { name } }"}' --json
```

## Browse it

For a local VM, the returned loopback URLs work immediately. Sandbox chooses a
free group of ports for each VM, so more than one environment can run at once.
Use `status` to print the exact URLs.

```bash
pnpm sandbox status env_abc123
```

Running `sandbox tunnel env_abc123` for a local VM only prints the same URLs;
there is no extra tunnel process to keep alive.

For exe.dev, the returned URL is private and may require an exe.dev browser
session. The predictable local path is an SSH tunnel:

```bash
pnpm sandbox tunnel env_abc123
```

Keep that command running. The agent can then open:

- Dashboard: `http://localhost:18080/`
- GraphQL: `http://localhost:18080/graphql/`
- Mailpit: `http://localhost:18025/`
- Jaeger: `http://localhost:16686/`

The exe.dev tunnel stops when the command stops. Its fixed ports mean only one
exe.dev tunnel can run at a time in the first version.

## Clean up

Delete one environment:

```bash
pnpm sandbox destroy env_abc123 --json
```

Delete every locally known environment whose TTL has passed:

```bash
pnpm sandbox prune --json
```

The local CLI cannot run while your computer is asleep. Until the hosted
control plane has a permanent cleanup worker, run `prune` from a scheduler as a
safety net. Do not treat the recorded TTL alone as proof that a VM was deleted.
