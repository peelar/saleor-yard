# Architecture

This document explains how Saleor Sandbox is built. Product behavior belongs in
`SPEC.md`.

## One engine, two ways in

```text
Local Codex --> CLI ---------+                              +--> Lima VM
                             +--> Environment engine --> Provider registry
Cloud agent --> private API -+                              +--> exe.dev VM
```

The CLI is not a temporary prototype that will later be thrown away. It calls
the same TypeScript engine that a future HTTP server will call.

## Main parts

### Source resolver

The source resolver accepts one explicit source selector. It asks GitHub for the
current source information and converts it into an exact commit.

No VM is created until resolution succeeds. The provider receives only
validated clone information and an immutable commit.

### Environment engine

The engine coordinates the work:

1. resolve source;
2. create the initial local record;
3. ask the provider to create an environment;
4. refresh status and logs;
5. execute commands or HTTP requests;
6. destroy expired or explicitly deleted environments.

It owns the environment state model. It does not know how Lima, exe.dev, SSH,
or port forwarding commands are formatted. Records keep their provider name,
so one CLI can safely manage local and remote VMs at the same time.

### Provider adapter

The provider adapter is a deliberately small boundary. It can:

- check whether it is usable;
- create an environment;
- inspect an environment;
- read provisioning or service logs;
- execute a non-interactive command;
- describe HTTP and tunnel access;
- destroy an environment.

The exe.dev adapter calls exe.dev's machine-readable commands over SSH. It reaches
the guest runtime through the VM's private SSH connection. SSH is transport
only; it does not contain the provisioning logic.

The local adapter calls Lima's non-interactive CLI. It creates a Linux VM from
Lima's rootful Docker template, copies in the same `sandboxd` binary, and forwards a
small set of VM ports to free loopback ports. Lima uses macOS native
virtualization by default. Local URLs work without a separate tunnel.

Both adapters return their own access details. The engine does not invent an
exe.dev URL or assume that every provider uses SSH. The first version did both;
building the local adapter exposed and removed those assumptions.

### Local state store

The local CLI needs to remember the connection between a Sandbox environment ID
and the provider VM ID. It stores small JSON records under
`$SALEOR_SANDBOX_HOME`, or an operating-system-specific user data directory by
default.

The store contains identifiers, source metadata, timestamps, and access
metadata. It must not contain provider private keys or long-lived secrets.

A deployed service will replace this store with a database without changing the
engine contract.

### Guest runtime

Each VM contains a small service named `sandboxd`. It has a local structured API
and a matching command-line client. The provider can ask it to provision,
report status, stream logs, execute commands, and make local HTTP requests.

`sandboxd`:

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

The guest runtime is a small static Go binary. It uses typed process arguments
when it must call Git or Docker Compose. There are no generated shell commands
and no large provisioning scripts.

### VM image and local guest artifact

The exe.dev VM starts from a versioned Sandbox image based on exeuntu. The image
contains Docker, Compose, `sandboxd`, the systemd unit, and stable templates.
Dynamic Saleor source code is never baked into this base image.

Release automation publishes the image to GHCR. Production-like runs use a
version tag or registry digest. Moving tags are not reproducible and are not the
normal contract.

For Lima, Sandbox builds the same static Go binary on the host with Docker,
copies it into the VM, and installs the shared systemd unit. A later release
can ship signed binaries or a baked Lima image without changing the provider
or guest contracts.

## HTTP access

The VM runs one small reverse proxy in front of Dashboard and Core. exe.dev
exposes it through private HTTPS. Lima exposes it on a loopback-only forwarded
port.

This gives browser-capable agents one URL and avoids teaching callers about
container ports. Raw ports remain available through an optional SSH tunnel.

The guest accepts only those two URL forms.

## Logs and execution

Sandbox uses `sandboxd` through a provider-owned transport:

- provisioning logs come from the guest runtime event stream;
- service logs are streamed by the guest runtime;
- commands run in a selected service with typed arguments;
- exe.dev tunnels use SSH port forwarding;
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

The engine owns expiry decisions through `pruneExpired`. The local CLI exposes
that as `sandbox prune`. A deployed control plane must call the same operation
from a permanent cleanup worker. A timestamp by itself does not delete a VM.

## Security boundary

Pull request code runs inside the created VM and must be treated as untrusted.
The VM does not receive the credentials used to create it. Public GitHub sources
are cloned without authentication.

The control side validates repository names, commit SHAs, VM names, service
names, ports, and command input. Provider calls use argument arrays rather than
local shell interpolation.

This is a development tool, but private-by-default access and credential
separation are MVP requirements.
