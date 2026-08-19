---
name: saleor-yard
description: Use Saleor Yard to create and control disposable Saleor environments for reproducing bugs, testing releases or branches, reviewing pull requests, and exploring exact Saleor Core revisions. Apply when a task needs an isolated Saleor environment, its Dashboard or GraphQL API, environment logs, commands inside the environment, or safe cleanup after the work.
---

# Saleor Yard

Use Saleor Yard as a disposable Saleor development environment. Keep the
coding agent outside the environment and control it through the Saleor Yard CLI.

## Build the right mental model

- A **source** is the Saleor Core revision to test. Yard resolves it to an
  exact commit before it creates infrastructure. Use the resolved commit when
  reporting what was tested.
- An **environment** is one isolated, temporary Saleor stack. Its ID is the
  handle for later work.
- A **provider** owns the isolated environment. Provider details are transport;
  use Yard instead of reaching around it during normal work.
- The **lifecycle** separates requested, provisioning, ready, failed, deleting,
  and deleted work. A failed environment stays useful for diagnosis until it is
  deleted or expires.
- **Readiness** is a contract, not a guess. A reachable URL or running process
  is not enough. Only call an environment ready when Yard reports it ready.
- A **lifetime** records when an environment should expire. The timestamp alone
  does not prove cleanup happened; deletion still needs a cleanup process and
  verification.

## Discover the live CLI

Treat the installed CLI as the source of truth for commands, flags, defaults,
providers, supported source forms, and output fields.

1. Find the `saleor-yard` executable. In the Saleor Yard source repository, inspect the
   package scripts and project docs for the repository-local launcher.
2. Read the top-level help before choosing an operation.
3. Read that operation's help before running it.
4. Do not invent syntax from memory. Do not keep a copied command reference in
   plans, code, or documentation.

If the executable is missing, explain which prerequisite is missing. Do not
install system tools, change credentials, or switch providers unless the user
asked for that setup work.

## Follow the environment workflow

1. Confirm the intended source, purpose, lifetime, and any provider constraint.
   Prefer an exact commit when repeatability matters.
2. Check that the chosen provider is usable. Preview creation without allocating
   resources when the live CLI offers that option.
3. Create the environment and keep its ID, resolved commit, provider, expiry,
   and current state.
4. Wait for the ready or failed state when the task needs a usable environment.
   Do not start verification while provisioning is incomplete.
5. Use the environment through Yard: inspect state, read setup or service
   logs, make HTTP or GraphQL requests, run non-interactive commands, and obtain
   browser access as the task requires.
6. If setup fails, report the failed phase and short error, then inspect the
   relevant logs. Keep the failed environment until the evidence is collected.
7. Delete the exact environment when the work is finished, unless the user
   wants it kept for a stated period. Verify cleanup instead of relying only on
   its expiry time.

## Use capabilities by intent

- Use lifecycle inspection to learn what exists and whether it is usable.
- Use setup logs for provisioning failures and service logs for runtime faults.
- Use the built-in HTTP path for API work so provider access details and tokens
  stay hidden behind Yard.
- Use non-interactive execution for checks inside Saleor services.
- Use browser or tunnel access only when the task needs a visual or raw-port
  workflow.
- Use explicit deletion for known environments and expiry cleanup for abandoned
  ones.

Ask the live help how to perform each action. This skill intentionally does not
duplicate the CLI surface.

## Handle output safely

- Use machine-readable output when the live help offers it.
- Parse standard output as the result. Treat standard error as progress or
  diagnostics and do not mix it into JSON.
- Branch on structured state and error fields, not human wording.
- Preserve the full environment ID and resolved commit in task notes.
- When following logs, use a bounded read first. Follow continuously only when
  the task needs live observation.

## Keep the trust boundary intact

- Treat source code inside every environment, especially pull request code, as
  untrusted.
- Never copy provider credentials, agent credentials, SSH keys, or unrelated
  host secrets into an environment.
- Do not use a shared development or production system as a substitute for a
  disposable environment.
- Do not bypass Yard to change provider resources unless diagnosing the
  provider itself and the user has placed that work in scope.
- Confirm the exact environment ID before deletion. Do not delete other saved
  environments as incidental cleanup.

## Report honestly

At handoff, state the requested source, resolved commit, environment state,
what was actually checked, and whether the environment was deleted or kept.
Distinguish a dry run, a provisioning environment, a ready environment, and a
completed product check. Never compress them into "done."
