---
status: accepted
date: 2026-10-17
area: [backend, cross-cutting]
supersedes: []
superseded-by: null
---

# stdio MCP servers run in a socket-activated sandbox under their own uid

## Context

The connection factory (`backend/packages/data/src/mcp/mcpConnectionFactory.ts`) used to start a
`stdio` MCP server through the SDK's `StdioClientTransport`, which spawns it as a child of the
connecting service: `semprec-api` (tool sync and approval replays) or `semprec-agents` (tool
calls). The child therefore ran as uid `semprec`. That uid can read the parent's
`/proc/<pid>/environ` (the `semprec_data` URL and `CREDENTIALS_MASTER_KEY`), the APNs key under
`/opt/semprec/shared` and every tenant's blobs under `/opt/semprec/data`. It can also reach
Postgres and the gateway on loopback, which [[2026-10-03-host-egress-filtered-by-service-uid]]
deliberately allows for `semprec`.

[[2026-10-16-stdio-mcp-confined-to-admin-tenants]] restricts who may store a `stdio` config, and
issue #1033 re-checks that at spawn and gives the child an allowlisted environment. Neither
changes which uid the process runs as, what it can read, or where it can connect.
[[2026-10-03-host-egress-filtered-by-service-uid]] left "stricter rules for a sandbox uid" to a
separate decision. This ADR is that decision.

## Decision

A `stdio` server runs as system user `semprec-mcp`, started by systemd for one connection to a
UNIX socket. It is never a child of the service that uses it.

- **User.** `semprec-mcp` has its own group and is not a member of `semprec`. Its home is
  `/var/lib/semprec-mcp`, created as the unit's `StateDirectory` (mode `0700`).
- **Socket.** `semprec-mcp-launch.socket` listens on `/run/semprec-mcp-launch.sock`
  (`root:semprec`, `0660`, `Accept=yes`, at most 16 connections). Each accepted connection
  starts an instance of `semprec-mcp-launch@.service`, with the connection as its stdin and
  stdout.
- **Launcher protocol.** `/usr/local/libexec/semprec-mcp-launch` (`deploy/bin/`) reads exactly one
  header line, at most 65536 bytes and nothing past its newline:
  `{"command": string, "args": string[], "env": {NAME: string}}` encoded as JSON. Anything else
  is refused with exit 64, running nothing. That means it refuses when:
  - it is not running as `semprec-mcp`;
  - the header is longer than 65536 bytes, has no newline, or contains a raw NUL byte;
  - the line is not exactly one JSON value, or that value is not an object;
  - the object has a field other than `command`, `args` and `env`, or lacks one of them;
  - `command` is not a string, is empty, or contains `=` or a NUL;
  - `args` is not an array of strings, or any element contains a NUL;
  - `env` is not an object of strings, a value contains a NUL, or a name does not match
    `^[A-Za-z_][A-Za-z0-9_]*$`.

  The connection is simply closed on a refusal, so the client sees the same `handshake_failed` as
  for any other server that closes without answering. `mcpConnectionConfig`'s schema does not
  refuse a `command` containing `=` or a NUL, nor a config whose header with the credential exceeds
  65536 bytes, so such a stored config reaches the launcher and fails there; the refusal reason is
  only in the journal.

  Otherwise it `exec`s `command` with `args` in `/var/lib/semprec-mcp`. The environment is exactly
  `PATH`, `HOME`, `LANG`, `USER` and `LOGNAME`, overlaid by the header's `env`. Every byte after
  the header is the server's stdin. The header can carry a credential, so no refusal message
  includes it.
- **Unit sandbox.** The instance runs with `NoNewPrivileges=`, `ProtectSystem=strict`,
  `ProtectHome=`, `PrivateTmp=`, `PrivateDevices=` and `ProtectProc=invisible`, so it cannot see
  the services' processes. It has no capabilities, and the address families are limited to
  `AF_UNIX`, `AF_INET` and `AF_INET6`. `InaccessiblePaths=` hides `/opt/semprec/shared`,
  `/opt/semprec/data`, `/var/backups/semprec` and `/etc/caddy`. The limits are
  `RuntimeMaxSec=300`, `MemoryMax=1G` and `TasksMax=64`. There is no `MemoryDenyWriteExecute=`,
  because Node-based servers JIT.
- **Egress.** `deploy/nftables.conf` jumps `meta skuid "semprec-mcp"` to `semprec_mcp_egress`. That
  chain accepts established/related traffic and TCP/UDP port 53 to any destination, then logs and
  rejects everything in the same blocked sets as `semprec_egress`. Unlike `semprec_egress`, it has
  no loopback exception for Postgres or the gateway, so those ports are unreachable. Port 53 is
  accepted before the blocked sets, so it stays open on loopback and private addresses too, which
  lets a server use the host's or the network's resolver.
- **Client.** `SandboxedStdioClientTransport` (`backend/packages/data/src/mcp/sandboxedStdioTransport.ts`)
  connects to the socket, writes the header, drops its reference to it, and then speaks the
  SDK's newline-delimited JSON-RPC framing. The header's `env` is the config's `env` plus the
  decrypted credential under `credentialEnvVar`, and nothing from the service's own environment.
- **Factory choice.** For `stdio`, after the spawn-time tenant check:
  - when `SEMPREC_MCP_LAUNCH_SOCKET` is non-empty, the factory uses the socket transport;
  - otherwise, under `NODE_ENV=test`, it keeps the in-process spawn, so the test suites need no
    launcher;
  - otherwise it refuses with `McpConnectionError("stdio_sandbox_unavailable")` before decrypting
    the credential.

  The `semprec-api` and `semprec-agents` units set the variable and order themselves after the
  socket.

### Rejected alternatives

- **`sudo` to a second uid.** The service would exec a setuid binary, which
  `NoNewPrivileges=` forbids. The api and agents units could then never set it. With a socket,
  they only connect.
- **bubblewrap (or another namespace sandbox) under the service's uid.** The server keeps uid
  `semprec`, so nftables' `meta skuid` cannot tell it from the services. It would inherit their
  loopback exception to Postgres and the gateway.
- **Spawning as `semprec`.** This is the previous behaviour and the leak described in Context.

## Consequences

- A host without the socket (any `NODE_ENV` other than `test`, including local development)
  cannot run `stdio` servers. Connects fail with `stdio_sandbox_unavailable`, and `sse`/`http` are
  unaffected.
- A `stdio` connection lives at most 300 seconds, after which systemd stops the instance and the
  client sees the connection close. At most 16 run at once on a host, shared by `semprec-api` and
  `semprec-agents`. A connection beyond that is accepted and closed at once by systemd, so the
  client's `start()` succeeds and the connect then fails with the same `handshake_failed` as a
  server that closes without answering; nothing tells the caller that the cap was the reason, and
  only systemd's journal records it.
- Every `stdio` server shares the one uid `semprec-mcp`. Nothing isolates two servers from each
  other. That is acceptable only because [[2026-10-16-stdio-mcp-confined-to-admin-tenants]]
  confines `stdio` to an admin's tenant.
- Over IP, a `stdio` server can reach only public addresses, plus port 53 on any address. A server
  that needs another port on a private or loopback address cannot run here.
- `AF_UNIX` stays allowed and nftables does not filter UNIX sockets, so a server can connect to any
  filesystem socket whose permissions admit uid `semprec-mcp` (or any other user) and to any
  abstract-namespace socket in the host's network namespace, since the unit has no
  `PrivateNetwork=`. The services must not rely on such sockets being unreachable from it.
- The launcher depends on `jq`, which `provision.sh` installs.
- Hardening the api and agents units themselves is left to issue #1071. They only need to connect
  to a UNIX socket for this decision, so that issue can give them `NoNewPrivileges=`.
