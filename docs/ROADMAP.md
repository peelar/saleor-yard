# Roadmap

## Current appetite

Build one honest vertical slice for public `saleor/saleor` pull requests. Prefer
clear behavior and inspectable failures over fast startup or broad provider
support.

## Milestone 1: One real pull request environment

Done when a local coding agent can create, inspect, use, debug, and destroy one
real environment using JSON commands.

Work order:

1. [x] Define the product contract in `SPEC.md`.
2. [x] Add the environment model, source resolver, state store, and CLI shell.
3. [x] Add the `yardd` guest runtime and versioned VM image.
4. [x] Add an exe.dev provider with a safe dry-run path.
5. [x] Provision the Saleor development stack and report phases.
6. [x] Add status, wait, logs, exec, HTTP access, tunnel, prune, and destroy.
7. [x] Run local tests and build the complete VM image.
8. [x] Add a Lima provider to prove the design is not tied to exe.dev.
9. [x] Complete the first live local environment proof.
10. [x] Prove a smaller default resource profile under a real workload.
11. [ ] Publish an immutable exe.dev VM image.
12. [ ] Complete one live exe.dev environment proof.

## Later

- Deployed private API.
- Private GitHub sources.
- Dashboard and multi-repository sources.
- Local patch upload.
- Snapshots, warm pools, pause, and resume.
- GitHub webhook automation.
- More hosted environment providers.
- Team policy, quotas, audit history, and cost visibility.
