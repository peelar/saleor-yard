# Saleor Sandbox Specification

## 1. Purpose

Saleor Sandbox creates a disposable Saleor development environment from a
public `saleor/saleor` release, branch, commit, or pull request.

The first user is a local coding agent such as Codex. The same environment
engine should later be deployable behind a private HTTP API for cloud agents.

The product creates and controls **disposable Saleor environments**. It is not a
VM manager. Current providers use VMs, but a provider may use another safe
isolation method later.

## 2. Product Promise

Give Saleor Sandbox one source. It returns a private, observable, controllable
Saleor environment running the exact resolved commit.

```text
Agent
  |
  |-- HTTP gateway --> Dashboard and GraphQL
  |-- sandbox logs --> provisioning and service logs
  |-- sandbox exec --> commands inside the environment
  `-- sandbox destroy
                         |
                Provider-owned environment
```

The agent should not need to understand Docker Compose, SSH port forwarding,
isolation setup, or provider commands during normal use.

## 3. MVP Scope

### Included

- Public `saleor/saleor` sources only.
- One source selector per environment:
  - release, such as `release:3.23.26`;
  - branch, such as `branch:main`;
  - commit, such as `commit:eaaf809e...`;
  - pull request, such as `pr:19668`.
- Resolve every source to an exact commit before provisioning.
- One fresh Saleor development environment per request.
- Saleor Core, worker, Postgres, cache, Dashboard, Mailpit, and Jaeger.
- Database migrations and sample data.
- Private HTTP access to GraphQL and Dashboard.
- Provisioning and Docker Compose logs.
- Non-interactive remote command execution.
- Recorded TTL, explicit destruction, and an expiry cleanup operation.
- Human-readable output and stable JSON output.

### Default resource profile

The current local and exe.dev providers start with 2 CPUs, 4 GB of memory, and
a 20 GB disk. This default profile supports a small catalog and simple queries.
It is not production sizing.

The profile must still pass the complete readiness contract. If future Saleor
versions need more room, change the shared profile from measured evidence
rather than changing one provider alone.

### Not Included

- Private repositories or private forks.
- Dashboard pull requests or mixed Core and Dashboard sources.
- Local uncommitted changes.
- Production hosting or persistent customer data.
- A web interface.
- GitHub webhooks, PR comments, or automatic verification.
- Hosted providers other than exe.dev.
- Snapshot pools or cold-start optimization.
- Installing or running a coding agent inside the environment.

## 4. Source Contract

Release, branch, commit, and pull request are mutually exclusive ways to select
the Saleor Core source. The caller never supplies both a version and a branch.

Examples:

```bash
sandbox create release:3.23.26
sandbox create branch:main
sandbox create commit:eaaf809e91802745618e8b5390afccc80812d4f9
sandbox create pr:19668
```

Before creating infrastructure, Sandbox resolves the selector through GitHub
and records:

- the requested selector;
- the exact commit SHA;
- the source repository used for cloning;
- the pull request base branch, when applicable;
- the inferred Saleor release line, when known.

The resolved commit appears in status, logs, and final output. This prevents an
environment from silently changing when a branch receives another commit.

## 5. Agent Experience

### 5.1 Create and wait

```bash
sandbox create pr:19668 --ttl 2h --json
```

The HTTP API will eventually express the same operation:

```http
POST /v1/environments
```

```json
{
  "source": {
    "type": "pull_request",
    "repository": "saleor/saleor",
    "number": 19668
  },
  "ttl": "2h"
}
```

Creation is asynchronous. The API returns an environment ID immediately. The
CLI waits by default and shows progress to feel synchronous; `--no-wait` returns
the provisioning record immediately. Interactive CLI progress
shows a spinner, elapsed time, and a 0-100% lifecycle bar. The percentage moves
only when Sandbox reaches a real lifecycle milestone; it is not a time estimate.
When standard error is not interactive, Sandbox writes one line per milestone
instead of terminal animation. `--no-progress` disables both forms.

### 5.2 Inspect

```bash
sandbox status env_abc123 --json
```

Ready output contains the stable environment contract:

```json
{
  "id": "env_abc123",
  "state": "ready",
  "phase": "ready",
  "source": {
    "requested": "pr:19668",
    "commit": "eaaf809e91802745618e8b5390afccc80812d4f9"
  },
  "access": {
    "dashboard": "https://example.invalid/",
    "graphql": "https://example.invalid/graphql/"
  },
  "expiresAt": "2026-08-18T18:00:00Z"
}
```

### 5.3 Browse and make HTTP requests

The normal environment has one private HTTPS gateway:

- `/` serves Dashboard;
- `/graphql/` reaches Saleor Core;
- required media and API paths also reach Core.

A browser-capable local agent gets a loopback URL for a local Lima VM. For an
exe.dev VM it can use `sandbox tunnel`, or open the private URL when its browser
has an exe.dev session. A command-line agent can make a request through the
provider control channel without handling an HTTPS access token itself:

```bash
sandbox http env_abc123 \
  POST /graphql/ \
  --data '{"query":"{ shop { name } }"}' \
  --json
```

### 5.4 Read logs

Logs are part of the product, not an implementation escape hatch.

```bash
sandbox logs env_abc123
sandbox logs env_abc123 --service api
sandbox logs env_abc123 --service worker --follow
sandbox logs env_abc123 --setup
```

Provisioning logs cover environment preparation, cloning, image building,
migrations, sample data, startup, and readiness checks. Service logs come from
the running Saleor stack.

If creation fails, status includes the failed phase and a short error. The
relevant logs remain available until the environment is destroyed or expires.

### 5.5 Run commands

Normal automation uses non-interactive commands:

```bash
sandbox exec env_abc123 -- python manage.py check
```

The result has an exit code, standard output, and standard error. An interactive
SSH command may exist for humans, but it is not the main agent interface.

### 5.6 Open an optional local tunnel

The private HTTPS gateway covers normal use. A local tunnel is an escape hatch
for raw service ports:

```bash
sandbox tunnel env_abc123
```

Expected local endpoints:

- Dashboard: `http://localhost:18080/`
- GraphQL: `http://localhost:18080/graphql/`
- raw Core: `http://localhost:18000/graphql/`
- Mailpit: `http://localhost:18025/`
- Jaeger: `http://localhost:16686/`

Sandbox owns the SSH forwarding process and reports how to stop it. Local Lima
environments forward separate loopback ports when they start, so this command
only prints their existing URLs.

### 5.7 Destroy

```bash
sandbox destroy env_abc123
```

Explicit destroy should be idempotent. `sandbox prune` deletes expired
environments known to the local CLI. `sandbox expiry-worker` runs the same
cleanup continuously. A deployed control plane must keep that worker running;
recording a TTL alone does not delete an environment.

## 6. Lifecycle

```text
requested
    |
resolving_source
    |
allocating_environment
    |
building_core
    |
migrating_database
    |
seeding_database
    |
starting_services
    |
checking_readiness
    |------------------- failure at any phase ---> failed
    |
  ready
    |
  deleting
    |
  deleted
```

Every state change records a timestamp. `failed` is terminal for provisioning
but the environment remains inspectable. `deleted` is terminal for the whole
environment.

## 7. Readiness Contract

An environment is `ready` only when:

1. The exact resolved commit is checked out.
2. The Core image was built from that checkout.
3. Database migrations completed.
4. Sample data and a test administrator exist.
5. API and worker services are running.
6. A real GraphQL smoke query succeeds.
7. Dashboard responds through the private gateway.
8. Logs and remote command execution work.

Allocating a provider resource or starting containers alone does not mean ready.

## 8. Access and Security

- Environments are private by default.
- Pull request code is untrusted.
- Provider, GitHub, and cloud credentials are never copied into the environment.
- Provider integrations count as credentials because they give the environment an
  authenticated capability even when the underlying secret stays elsewhere.
- The exe.dev provider refuses to create or provision a VM when an integration
  is attached through `auto:all` or the new VM name. It does not add a shared VM
  tag. Operators must not attach an integration while an environment is running.
- Public sources are cloned without a GitHub token.
- The exe.dev HTTPS URL uses exe.dev's private access control. Local CLI HTTP,
  logs, and command execution use the developer's SSH identity.
- Lima exposes services only on forwarded loopback ports. It copies no provider
  or GitHub credentials into the VM.
- Short-lived environment-scoped access credentials are required before cloud
  agents can receive browser access; they do not exist in the local MVP.
- The created environment cannot create, resize, or delete other environments.
- Inputs used in provider commands are validated and never interpolated into a
  shell command without safe quoting.
- No production Saleor secrets or customer data are used.
- Destruction removes the provider resource and its development data.

For the local CLI, provider credentials stay on the developer machine. For the
future private service, provider credentials stay in the control plane.

## 9. Local CLI Contract

The CLI is designed for agents first:

- no prompts in normal commands;
- `create` waits for a ready environment by default; `--no-wait` opts into the
  asynchronous form;
- the local provider is used when no provider is selected;
- stable exit codes;
- `--json` on every command that returns data;
- errors on standard error;
- progress on standard error when JSON is written to standard output;
- commands can be safely retried where stated;
- environment IDs are accepted consistently across commands.

Initial command surface:

```text
sandbox create <source>
sandbox list
sandbox status <environment>
sandbox wait <environment>
sandbox logs <environment>
sandbox exec <environment> -- <command>
sandbox http <environment> <method> <path>
sandbox tunnel <environment>
sandbox prune
sandbox expiry-worker
sandbox destroy <environment>
sandbox doctor
```

## 10. Future Private API

The CLI and HTTP API are two transports over the same environment engine.

```text
Local agent --> CLI ---------+
                             +--> Environment engine --> Provider adapter
Cloud agent --> private API -+
```

Expected API surface:

```text
POST   /v1/environments
GET    /v1/environments
GET    /v1/environments/:id
GET    /v1/environments/:id/logs
POST   /v1/environments/:id/commands
POST   /v1/environments/:id/http
POST   /v1/environments/:id/access-links
DELETE /v1/environments/:id
```

The API should add authentication, authorization, ownership, quotas,
idempotency keys, audit events, and streaming. These concerns must not leak
into the provider adapter or change the environment contract.

## 11. Architecture Boundaries

The implementation has five main parts:

1. **Source resolver** converts the public source selector into an immutable
   GitHub commit and safe clone information.
2. **Environment engine** owns lifecycle rules, state, expiry, and the stable
   contract used by both transports.
3. **Provider adapter** allocates the environment, talks to the guest runtime,
   provides access, and destroys the provider resource.
4. **Transport** turns CLI or HTTP input into engine calls and formats results.

5. **Guest runtime (`sandboxd`)** runs inside the environment. It owns Saleor
   setup, readiness, service logs, and command execution through a small
   structured API.

Saleor services belong in versioned Compose templates. Provider-specific
commands do not belong in source resolution, CLI formatting, lifecycle rules,
or the guest runtime.

See `docs/ARCHITECTURE.md` for the implementation design.

## 12. First Providers

The hosted provider is exe.dev because it offers full VMs, root access,
persistent disks, private HTTPS, custom images, and machine-readable commands.

The local provider is Lima because it offers real Linux VMs, native macOS
virtualization, non-interactive commands, and port forwarding.

Both are practical choices, not part of the product promise. Every provider
must implement the same small adapter contract.

## 13. Failure Experience

A failure must answer:

- What environment failed?
- Which exact commit was being prepared?
- During which phase did it fail?
- What can the caller inspect next?
- Is the environment still running and billable?
- When will it expire?

Bad:

```text
Provisioning failed.
```

Good:

```text
env_abc123 failed while migrating_database.
The environment is still available until 18:00 UTC.
Run: sandbox logs env_abc123 --setup
Destroy it with: sandbox destroy env_abc123
```

## 14. First Milestone

The first milestone is complete when a local agent can:

1. Create an environment from one current public `saleor/saleor` pull request.
2. Wait for a trustworthy ready state.
3. run a GraphQL query;
4. read API and provisioning logs;
5. run a non-interactive command;
6. destroy the environment;
7. perform the entire workflow using stable JSON output.

Local unit tests and mocked provider tests are necessary, but they do not prove
this milestone. At least one real environment must complete the workflow.

## 15. Later Work

- Private GitHub sources with short-lived, read-only credentials.
- Dashboard and multi-repository environments.
- Uploading a patch or local working tree.
- Snapshot and warm-pool startup optimization.
- Pause and resume.
- GitHub webhook automation and PR status reporting.
- More providers.
- Deployed control plane with a private API.
- Per-team policy, quotas, and cost reporting.
- Reusable verification recipes and captured artifacts.
