---
status: accepted
date: 2026-11-03
area: [backend]
supersedes: []
superseded-by: null
---

# Import compatible wrapped keys through an isolated offline restore owner

## Context

The newest independent key dump can contain a key for a tenant absent from an
older main snapshot. Direct restoration then fails the target FK. A later key
dump can also legitimately omit an erased key: the earlier assertion that
sequential dumps preserve every credential's key is not generally true.
Corrective issue `sp-94a5c71d-4663-4014-9256-db63e179346e` owns this operational
correction to gh-1064. Neither historical records nor accepted ADR bodies change.

[[2026-10-05-per-tenant-envelope-encryption]] keeps keys outside long-retention
main snapshots. Recovering an erased key from an older artifact would defeat
that boundary. Disabling the restored target's FK, rewriting arbitrary dump
SQL, or inventing a pg_restore row filter is not an acceptable import.

## Decision

Introduce a private data-layer operational owner and native CLI, with no public
barrel export, application endpoint, or general table-restoration API. The
operator explicitly selects the latest key artifact. The owner never searches
older snapshots, decrypts, rewraps, or requires a master key. Protected backup
provenance and the privileged offline operator are trusted boundaries; archive
selection is not a sandbox for malicious PostgreSQL payloads.

The target is a main snapshot with schema already restored, no tenant-key rows,
and no application or worker access. Use an admin connection only for offline
catalog checks and owned staging infrastructure. Import target rows through a
separate non-owner, non-superuser, non-BYPASSRLS role under `runInTenant` and
`withTransaction`; assert effective row security. Keep target FK, RLS, policies,
triggers, and key immutability unchanged. A conditional tenant existence check
in the actual INSERT plus the FK decides eligibility; do not require an UPDATE
grant on tenants solely to obtain a separate key-share precheck.

Create a fresh, prechecked, unpredictable staging database on that same offline
PostgreSQL instance. Revoke PUBLIC connection privileges before importing data.
It contains only `public.tenant_keys` with the five exact column types and a
tenant-id primary key, not tenant stubs, target RLS, application tables, or
credentials. Its absence of a tenant FK is confined to staging; the target
retains the real FK. Validate a bounded pg_restore TOC and require exactly the
expected table-data entry, rejecting extra, duplicate, or unknown restorable
entries. Use the supported list-selection/data-only interfaces, not dump-SQL
rewriting. Explicitly reject an empty selection even if pg_restore exits zero.

The supported tool profile is `docker exec` of the PostgreSQL client inside the
specific offline PostgreSQL container. Stream the protected host archive on
stdin, place only a protected owned selection list in the container, and remove
that list. Check that the container's database system identifier matches the
admin connection before mutation. Commands receive no database password or URL
in argv and emit no raw archive, row, or stderr content. Host pg_restore is not
required. The configured deploy major is PostgreSQL 16; incompatible archive or
client versions fail closed. A parent-owned network-none synthetic probe
observed pg_restore 16.15 and a real one-entry custom-archive TOC; that is tool
feasibility evidence, not an implemented import or production recovery.

Validate staged external rows in deterministic batches: canonical UUID,
48-byte wrapped key, 24-byte nonce, positive smallint master-key version, and
finite original PostgreSQL timestamp text. Preserve timestamp microseconds and
all wrapped bytes. Bound the archive to 64 MiB, TOC to 1 MiB, batches to 100,
and total staged rows to 250,000; exceeding a bound fails rather than truncates.
Import only rows whose tenant exists in the restored main, with explicit tenant
scope, checked affected rows and no overwrite/upsert. An import error can leave
earlier per-tenant transactions committed in an offline target: report failure,
keep services offline, and recreate the target from the main snapshot before
retrying. Never call that partial state an atomic complete restore. Missing
keys remain unavailable credentials requiring reconnection; report that limit
without recovering older keys or claiming credential availability.

Own CREATE attempts before dispatch and capture the exact connection PID and
backend_start. Observe actual operation/child settlement and that exact backend's
disappearance before cleanup or outcome claims. Close owned stage connections,
remove the stage with a separately identified connection, await DROP settlement,
and independently verify absence. Never use a name-pattern kill or forced DROP
that terminates unowned backends. Retain body and cleanup failures, including
undefined/non-Error values, internally; project only fixed safe diagnostics.
An elapsed deadline is not cancellation or absence proof. Unsettled work or
uncertain cleanup keeps the owner/readiness blocked, with a restricted operator
record of the exact owned stage identity. No universal cleanup wall time or
arbitrary-crash recovery is promised.

## Monthly isolated topology

The monthly script owns its disposable PostgreSQL container and internal Docker
network. To run the native host Node owner, publish only a randomly allocated
loopback port, discover and validate the actual mapping, and prove connectivity
to that owned instance. Once a host port is published, do not retain trust host
authentication. Generate a per-run synthetic password in a protected 0600 env
file inside the owned 0700 work directory; configure password authentication and
pass URLs only through the owner's private environment. Never log the password,
file contents, URL, key data, or raw child errors. No production port, network,
credential, or host service is changed.

Because the restored dump intentionally omits ownership/grants, the monthly
fixture alone prepares a dedicated NOLOGIN, nonprivileged import role with
exact SELECT on tenants, SELECT/INSERT on tenant_keys, and required scope-helper
execution. Ledger validation additionally needs SELECT on tenant_deletions.
The host owner may SET ROLE to this narrow role, verifying effective RLS before
target writes. This role exists only in the owned disposable cluster. A real
offline recovery must explicitly supply a suitable existing non-owner target
role; the CLI does not alter live runtime roles, grants, schema, or policies to
make them fit. Confirm the same instance and target database across admin,
target, and tool connections.

## Consequences

This is a narrow restore-authority exception to ordinary runtime key creation,
not a new credential writer for requests or jobs. Target scoped transactions
follow [[2026-09-29-withtransaction-is-the-sole-transaction-opener]] and isolation
follows [[2026-10-03-tenant-isolation-through-row-level-security]]. Retention
remains 14 daily/8 weekly/12 monthly main and 7-day separate key snapshots, with
its existing backup/prune availability limits. Protected temporary material and
stage cleanup are part of success. Only actual owned PostgreSQL evidence can
validate the implemented protocol. Activation still requires successful replay
under [[2026-11-03-restored-services-wait-for-successful-deletion-replay]].
