---
status: accepted
date: 2026-11-03
area: [backend]
supersedes: []
superseded-by: null
---

# Own restore execs on a dedicated authenticated loopback bridge

## Context

The owned Docker probe required by
[[2026-11-03-offline-compatible-tenant-key-restore]] created an internal network
and requested loopback publication, but the running container had no effective
port mapping. This observation does not establish a universal Docker cause.
The parent subsequently observed effective loopback publication, a real host
query and wrong-password refusal using a dedicated non-internal bridge with
IP masquerade disabled. All probe containers, networks and private password
files were removed. This is a local topology proof, not a production restore.

The same corrective implementation identified a second ownership seam: killing
or losing the Docker CLI transport does not prove a daemon-side exec finished.
The restore owner must retain the actual operation, not only a host wrapper PID.
Corrective issue `sp-94a5c71d-4663-4014-9256-db63e179346e` owns both seams.

## Decision

For the monthly disposable restore and its controlled PostgreSQL16 fixtures,
replace only the earlier internal-network prerequisite with a fresh dedicated
user-defined bridge, configured with
`com.docker.network.bridge.enable_ip_masquerade=false`. Attach only the owned
restore PostgreSQL container, publish a random host port explicitly on
127.0.0.1, validate the effective mapping, and prove actual password-authenticated
host connectivity before import. Wait for TCP readiness, not the image's
temporary Unix-socket initialization server. Keep generated private credentials,
the narrow target role, instance identity, FK/RLS, offline prerequisites and
exact resource cleanup from the earlier decision.

Do not alter a default/shared network or any host firewall, route, production
service, port, image daemon setting or real credential. This bridge is not
Docker's internal-network isolation: disabling masquerade and observing local
authentication do not prove absence of every outbound route. No internet
request is required or authorized by this test. The offline PostgreSQL server
and selected backup provenance remain trusted operational inputs; malicious
privileged dump execution was not sandboxed by the earlier contract either.
The narrower authenticated private test topology is accepted with that explicit
limit, not advertised as equivalent to an internal network.

The private restore tool owner may use the local Docker Engine API over the
Unix socket selected by the existing local Docker context. Validate a local
unix endpoint and bounded version/JSON responses; refuse remote TCP endpoints
or an unsupported context instead of introducing another transport. No Docker
socket is mounted into a new container and no public control endpoint is added.

Create each restore exec through the supported Engine exec-create operation,
capture its exact returned ID before starting it, and retain that ID through
start/output/error/terminal inspection. Negotiate the supported API version
from the local engine rather than guessing a version. Restrict this private
adapter to version discovery, the explicitly selected offline container's
identity, exec creation/start, and inspection of IDs created by this owner.
It is not a general Docker SDK or permission to list or control other resources.

Stream the bounded archive and drain bounded multiplexed stdout/stderr without
logging raw payloads, credentials or arbitrary errors. A lost start response,
HTTP stream or wrapper does not discard the created exec ID. Inspect that exact
ID until its daemon operation settles; unknown state or continued Running
retains ownership and blocks success/cleanup. Do not infer settlement merely
from stdin closure, a client timeout, a missing SQL backend or DROP success.
Do not blindly repeat an ambiguously started exec. If cancellation uses a
database backend, first capture and revalidate the exact owned PID,
backend_start, stage and phase; never kill by name or terminate an unrelated
connection. No universal wall-clock bound is claimed for a nonsettling daemon.

After all owned execs and SQL participants settle, perform the earlier stage
DROP and independent absence check, then let the script remove its exact
container, network and protected files. Preserve primary and secondary failure
identities internally and project only fixed safe diagnostics. Provide finite
real controls for start/output interruption with a held exec, pending cleanup
until release, exact terminal state and final absence. These controls prove the
implemented ownership seam, not arbitrary-crash recovery.

## Consequences

This is a scoped topology/transport exception to the earlier key-restore
decision. Its target isolation, key eligibility, no older-key fallback,
retention and failure requirements remain unchanged. No historical accepted
body is edited. The private adapter stays in the already selected
restorePostgresTools module. Parent-selected source scope, one source writer,
the remaining single focused review, and the production security gate remain
in force.
