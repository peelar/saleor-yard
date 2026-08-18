# Usage

Saleor Factory is meant to feel like a small remote development machine that an
agent can control without learning Lima, exe.dev, or Docker Compose.

## Before the first run

Install Node.js 22 and pnpm 10, then install the project:

```bash
pnpm install
pnpm factory doctor
```

Choose a provider when you run Factory:

```bash
pnpm factory --provider local doctor
pnpm factory --provider exedev doctor
```

The local provider needs Lima 2.x and Docker. On macOS, install Lima with
`brew install lima`. Saleor runs inside a Linux VM, not directly on macOS.

The exe.dev provider checks the SSH connection to exe.dev. Saleor runs in a
remote VM.

The current VM image has only been built locally. A live creation also needs a
published image configured through `SALEOR_FACTORY_EXEDEV_IMAGE`.

## Create an environment

Start with a dry run. It resolves the source to an exact commit and shows what
would be created, but it does not create a VM.

```bash
pnpm factory --provider local create pr:19668 --ttl 30m --dry-run --json
```

For a real environment:

```bash
pnpm factory --provider local create pr:19668 --ttl 2h --wait --json
```

You can replace `pr:19668` with `release:3.23.26`, `branch:main`, or a full
`commit:` SHA.

Keep the returned environment ID. Every later command uses it.
Factory remembers which provider owns that ID, so later commands do not need a
provider option.

## Work with the environment

Check progress:

```bash
pnpm factory status env_abc123 --json
pnpm factory wait env_abc123 --timeout 30 --json
```

Read setup and service logs:

```bash
pnpm factory logs env_abc123 --phase provision
pnpm factory logs env_abc123 --service api --tail 200
pnpm factory logs env_abc123 --service worker --follow
```

Run a command in the Saleor API container:

```bash
pnpm factory exec env_abc123 -- python manage.py check
```

Make a GraphQL request without opening a browser or handling an HTTPS access
token:

```bash
pnpm factory http env_abc123 POST /graphql/ \
  --data '{"query":"{ shop { name } }"}' --json
```

## Browse it

For a local VM, the returned loopback URLs work immediately. Factory chooses a
free group of ports for each VM, so more than one environment can run at once.
Use `status` to print the exact URLs.

```bash
pnpm factory status env_abc123
```

Running `factory tunnel env_abc123` for a local VM only prints the same URLs;
there is no extra tunnel process to keep alive.

For exe.dev, the returned URL is private and may require an exe.dev browser
session. The predictable local path is an SSH tunnel:

```bash
pnpm factory tunnel env_abc123
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
pnpm factory destroy env_abc123 --json
```

Delete every locally known environment whose TTL has passed:

```bash
pnpm factory prune --json
```

The local CLI cannot run while your computer is asleep. Until the hosted
control plane has a permanent cleanup worker, run `prune` from a scheduler as a
safety net. Do not treat the recorded TTL alone as proof that a VM was deleted.
