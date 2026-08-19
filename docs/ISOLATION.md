# Environment isolation

Saleor Sandbox runs code from releases and pull requests. Pull request code is
untrusted, so every environment needs a strong isolation boundary.

## VMs and Dev Containers

A Dev Container describes development tools, files, and setup commands. It can
make an investigation workspace easier to use, but it is not a security
boundary. By itself, it does not provide Factory's private access, expiry,
cleanup, or Saleor readiness contract.

The current providers use one isolated VM per environment. Lima provides it
locally and exe.dev provides it remotely. A future provider may use a microVM or
a hardened container runtime such as gVisor or Kata, as long as it keeps the
same security and environment contract.

Do not run untrusted code on a shared Docker daemon. Do not mount a host Docker
socket or developer credentials into an environment. Do not trust a pull
request's own Dev Container configuration.

A Sandbox-owned Dev Container configuration may be added later as a workspace
feature inside the isolated environment. It does not replace the isolation
boundary.

## Decision

- The product creates environments, not VMs.
- Providers choose how each environment is isolated.
- Untrusted work needs VM, microVM, or equivalent isolation.
- Dev Containers are an optional workspace format, not a provider.
- The coding agent stays outside and uses Sandbox commands or the future API.
