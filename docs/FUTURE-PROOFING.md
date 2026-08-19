# Future-proofing

Future-proofing here means keeping today's useful parts when the tool moves
from one developer's laptop to a private service. It does not mean building the
whole cloud service now.

## What remains the same

The environment engine, source resolver, lifecycle, provider interface, and
`yardd` guest runtime do not depend on Commander or a web framework. A
future HTTP handler can call the same engine methods as the CLI.

Source selectors are resolved to full commits before a provider allocates an
environment. Stored jobs therefore remain understandable after a branch or pull
request changes.

Lima and exe.dev live behind one provider interface. Adding Lima exposed two
bad assumptions in the first design: shared records named only exe.dev, and the
guest accepted only exe.dev URLs. Both are now provider-neutral. What an agent
means by create, status, logs, exec, HTTP, or destroy stays the same.

## What the private service must add

The hosted service will need work that is deliberately outside this first
slice:

- a durable database instead of local JSON files;
- authenticated owners and access checks;
- a queue and workers so create returns quickly;
- idempotency keys so retries do not create extra environments;
- a process manager that keeps the existing expiry worker running;
- quotas, audit events, and cost limits;
- short-lived environment access links for cloud browsers;
- streaming logs with backpressure and cancellation.

These belong around the engine. They should not be implemented as special
cases inside the exe.dev adapter.

## Current seams to preserve

- The CLI only parses input and prints output.
- The engine works with plain TypeScript objects and repository interfaces.
- Each provider owns its resource, transport, and access details.
- The environment owns Saleor setup and runtime operations through `yardd`.
- Provider images and the Saleor Platform revision are versioned and pinned.

## Known first-version limits

- Public GitHub sources only.
- One fixed compatibility profile for the current Saleor line.
- One exe.dev tunnel at a time because its tunnel ports are fixed. Local
  environments receive separate forwarded ports.
- No deployed control plane keeps the expiry worker running yet.
- No environment-scoped browser token yet; local agents use SSH-backed commands
  or a local tunnel.

Those are explicit limits, not contracts other code should depend on.
