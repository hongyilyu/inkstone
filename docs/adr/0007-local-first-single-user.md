# Local-first, single-user

Inkstone runs on the user's machine and serves exactly one human per install. Multi-user, multi-tenant, and shared-server models are out of scope and will not be designed for. Going multi-tenant requires a new ADR that supersedes this one.

## What this means concretely

- **Single user per install.** Not "per Workspace" — per install. Multiple Workspaces in one install are fine; multiple humans sharing a Workspace is not supported.
- **Local-first by default.** Everything Inkstone owns runs on the user's machine: Core, Worker, SQLite. LLM providers are a controlled exception — the LLM call has to leave the machine — but no other Inkstone component requires a remote service.
- **Network exposure is loopback-only by default.** When Core listens for Clients (Web, TUI, etc.), it binds to localhost. Reaching Inkstone from another device on the LAN, or from outside, is not in scope until an explicit decision opens it.
- **No human auth flow.** "It's my machine" is the authentication. There is no login, no user table, no session token for the human user. (LLM provider credentials are a separate concern with their own handling.)

## Authenticated remote ingress override

Inkstone may be exposed at one operator-configured public origin through a reverse proxy. The proxy owns public DNS, TLS termination, human authentication, and forwarding of the complete Core surface: the embedded Web Client, `/ws`, and `/media/*`. Core does not gain a user table, login flow, proxy-specific integration, or trusted identity headers.

Core continues binding only to `127.0.0.1`. The reverse proxy must run where it can reach that listener, and no network path may bypass the proxy to Core. This preserves Core's single-writer Workspace authority and keeps the remote-access mechanism outside the application.

### Browser WebSocket origin policy

`INKSTONE_PUBLIC_ORIGIN` names the one exact browser origin allowed to open Core's WebSocket remotely — an `https` origin, including any non-default port, with no path. For example:

```text
INKSTONE_PUBLIC_ORIGIN=https://inkstone.hongy.io
```

The WebSocket handshake follows these rules before upgrade:

- A browser `Origin` exactly matching `INKSTONE_PUBLIC_ORIGIN` is accepted. The configured origin must be `https`; a non-https value never matches and fails closed.
- A same-host loopback HTTP origin is accepted for direct local use and Vite development.
- A missing `Origin` is accepted because non-browser Clients do not necessarily send one.
- Every other present `Origin`, including malformed and opaque origins, is rejected with HTTP 403.

The public origin is explicit rather than inferred solely from the request `Host`. An attacker controlling a DNS-rebinding origin can make `Origin` and `Host` agree while both name the attacker's domain; comparing those two values alone would therefore leave loopback Core exposed to cross-site WebSocket requests.

When `INKSTONE_PUBLIC_ORIGIN` is unset, remote browser origins remain closed and the loopback/non-browser behavior stands.

### Consequences

- Remote access remains single-user and does not introduce Workspace synchronization or multi-tenancy.
- The reverse proxy's authentication gate must cover `/`, `/ws`, and `/media/*`; authenticating only the HTML route is insufficient.
- WebSocket upgrade forwarding and long-lived connection timeouts are deployment concerns.
- Provider OAuth login keeps its existing host-local callback. Connecting a provider remotely is not enabled by this decision.
- A typo in `INKSTONE_PUBLIC_ORIGIN` fails closed by rejecting the remote WebSocket.

## Why explicit rejection rather than "may revisit"

A "may revisit later" framing gives every future feature an excuse to half-design for multi-user "just in case" — a `created_by` column here, a tenant-scoped query there. Each one feels harmless individually; together they erode the constraint without any single decision having recorded the change.

Naming the rejection makes those moments visible: any PR that adds multi-user scaffolding contradicts this ADR and has to either argue against it or supersede it.

## Why not skip the ADR

The constraint is implicit in the current architecture, but the temptation to drift is concrete and recurring (sharing with a partner, accessing from a phone over the LAN, multi-device sync). Without an explicit anchor, those conversations have to re-derive the trade-off each time.

## Considered and rejected

- **Multi-tenant from day one.** Cost in schema, auth, secrets isolation, and network exposure is significant; benefit is hypothetical for a personal project.
- **Single-user but with multi-user-friendly schema.** Half-measures collect cost without delivering capability; if multi-user is needed later, the rewrite is justifiable on its own merits at that point.
- **Built-in Core login.** Rejected: the deployment already has SSO, and duplicating human identity/session state inside a single-user application widens Core's interface without improving Workspace authority.
- **Trust `Origin` when it matches `Host`.** Rejected: it does not stop DNS rebinding when both headers carry the attacker-controlled host.
- **Configurable origin list.** Rejected: one install has one public hostname. A list adds configuration surface without a current consumer.
- **Require `Origin` on every connection.** Rejected: TUI, CLI, capture, and test Clients are not browsers and may omit it.
