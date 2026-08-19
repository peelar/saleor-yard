# Architecture

This document explains how Saleor Yard is built. Product behavior belongs in
`SPEC.md`.

## One engine, two ways in

```text
Local Codex --> CLI ---------+                         +--> Lima environment
                             +--> Environment engine --+
Cloud agent --> private API -+                         +--> future provider
```

The CLI is not a temporary prototype that will later be thrown away. It calls
the same TypeScript engine that a future HTTP server will call.

## Main parts

### Source resolver

The source resolver accepts one explicit source selector. It asks GitHub for the
current source information and converts it into an exact commit.

No provider resource is allocated until resolution succeeds. The provider
receives only validated clone information and an immutable commit.

### Environment engine

The engine coordinates the work:

1. resolve source;
2. create the initial local record;
3. ask the provider to create an environment;
4. refresh status and logs;
5. execute commands or HTTP requests;
6. destroy expired or explicitly deleted environments.

It owns the environment state model. It does not know how Lima or port
forwarding commands are formatted. Records keep their provider name so another
provider can be added without changing the lifecycle model.

### Provider adapter

The provider adapter is a deliberately small boundary. It can:

- check whether it is usable;
- create an environment;
- inspect an environment;
- read provisioning or service logs;
- execute a non-interactive command;
- describe HTTP and tunnel access;
- destroy an environment.

The local adapter calls Lima's non-interactive CLI. It creates a Linux VM from
Lima's rootful Docker template, copies in the same `yardd` binary, and forwards a
small set of VM ports to free loopback ports. Lima uses macOS native
virtualization by default. Local URLs work without a separate tunnel.

The adapter returns its own access details. The engine does not invent URLs or
assume that every provider uses Lima.

The default resource profile is 2 CPUs, 4 GB of memory, and a 20 GB disk. The
value lives at the provider boundary so a future provider can use the same
measured starting point.

### Local state store

The local CLI needs to remember the connection between a Yard environment ID
and the provider resource ID. It stores small JSON records under
`$SALEOR_YARD_HOME`, or an operating-system-specific user data directory by
default.

The store contains identifiers, source metadata, timestamps, and access
metadata. It must not contain provider private keys or long-lived secrets.

The intended provider resource name is saved before allocation starts. This is
important for crash recovery: cleanup can still find a partially created
resource when the CLI was interrupted before the provider returned access
details.

A deployed service will replace this store with a database without changing the
engine contract.

### Guest runtime

Each environment contains a small service named `yardd`. It has a local
structured API and a matching command-line client. The provider can
ask it to provision, report status, stream logs, execute commands, and make
local HTTP requests.

`yardd`:

1. validates the job description received through the provider control channel;
2. verifies required system tools;
3. clones Saleor at the resolved commit;
4. clones the pinned Saleor Platform definition;
5. builds a Core image from the checkout;
6. writes the versioned Compose and gateway templates;
7. runs migrations and sample-data setup;
8. starts services;
9. checks GraphQL and Dashboard readiness;
10. records structured events and full logs.

The guest keeps its latest status in memory as well as on disk. If a full or
read-only disk prevents persistence, the live control channel can still report
the failure. Long operations refresh a heartbeat, and the complete provisioning
run has a bounded deadline.

After the Core image is built, the guest removes unused Docker build cache. The
cache is not useful in today's one-build disposable environment. The Saleor
worker has a concurrency of one because this environment is meant for
development, not production traffic.

The guest runtime is a small static Go binary. It uses typed process arguments
when it must call Git or Docker Compose. There are no generated shell commands
and no large provisioning scripts.

### Local guest artifact

For Lima, Yard builds the same static Go binary on the host with Docker,
copies it into the VM, and installs the shared systemd unit. A later release
can ship signed binaries or a baked Lima image without changing the provider
or guest contracts.

## HTTP access

The environment runs one small reverse proxy in front of Dashboard and Core.
Lima exposes it on a loopback-only forwarded port.

This gives browser-capable agents one URL and avoids teaching callers about
container ports. Raw services use their own loopback-only forwarded ports.

The guest accepts only loopback HTTP origins with an explicit port.

## Logs and execution

Yard uses `yardd` through a provider-owned transport:

- provisioning logs come from the guest runtime event stream;
- service logs are streamed by the guest runtime;
- commands run in a selected service with typed arguments;
- Lima uses its own guest command and port-forwarding features.

Transport details are hidden behind CLI commands. The future API will use the
same provider operations and stream results over HTTP.

## Keeping the private API possible

The engine takes normal data objects and returns normal data objects. It does
not print, read process arguments, or exit the process. Those are transport
jobs.

Environment records include absolute expiry timestamps. The future API will add
an operation context for cancellation, audit information, request ownership,
and idempotency; those fields are not pretended into the local model today.

### Expiry

The engine owns expiry decisions through `pruneExpired`. The CLI exposes a
single check as `saleor-yard prune`. The reusable expiry worker calls the same
engine operation continuously. A deployed control plane must supervise that
worker. A timestamp by itself does not delete an environment.

The engine also runs `pruneExpired` before every real create operation. The
provider can remove resources in Saleor Yard's reserved namespace during an
explicit `destroy --all`; this reconciles resources left behind by an
interrupted controller process without exposing provider commands to users.

## Security boundary

Pull request code runs inside the created environment and must be treated as
untrusted. The environment does not receive the credentials used to create it.
Public GitHub sources are cloned without authentication.

The control side validates repository names, commit SHAs, VM names, service
names, ports, and command input. Provider calls use argument arrays rather than
local shell interpolation.

This is a development tool, but private-by-default access and credential
separation are MVP requirements.

See `docs/ISOLATION.md` for the decision about VMs and Dev Containers.
