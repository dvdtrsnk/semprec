# PostgreSQL lock-table capacity

Issue #995. Every database has its own `items` partition
(`backend/packages/data/src/chokePoint/databasesStore.ts`), and every tenant owns its system
databases plus the user's own: about 25 partitions per tenant. Each partition has two indexes,
the primary key and `items_props_gin` (`0001_core_schema.sql`).

A statement on `items` that the planner cannot prune locks the parent, every partition and
every partition's indexes until its transaction ends. Examples are an id-only lookup, an
RLS-filtered scan (the policy filters on `tenant_id`, not on the partition key `database_id`)
and `count(*)` over the whole table, as the monthly restore test runs.

## Formula

```
entries per unpruned statement = tenants × partitions per tenant × (1 + indexes per partition)
lock table total               = max_locks_per_transaction × (max_connections + max_prepared_transactions)
```

## Chosen numbers

`max_locks_per_transaction=2048`, set with `command:` on the `postgres` service in
`deploy/docker-compose.yml` and on the restore test's disposable server in
`deploy/systemd/scripts/semprec-restore-test.sh` (`semprec-restore-test.test.sh` asserts the two
values are equal). `max_connections` stays at 100 and `max_prepared_transactions` at 0.

| | Value |
| --- | --- |
| Entries per unpruned statement at 200 tenants × 25 partitions × 3 relations | 15,000 |
| Lock table with the image defaults, 64 × (100 + 0) | 6,400 (one such statement fails) |
| Lock table with 2048 × (100 + 0) | 204,800 |
| Headroom | about 13 concurrent unpruned `items` statements |

## Shared-memory cost

Measured on PostgreSQL 16.15 started with `-c max_locks_per_transaction=2048`:

```sql
SELECT name, pg_size_pretty(allocated_size) FROM pg_shmem_allocations
WHERE name IN ('LOCK hash', 'PROCLOCK hash');
```

| name | allocated_size |
| --- | --- |
| LOCK hash | 9088 bytes |
| PROCLOCK hash | 17 kB |

These two rows are only the hash directories; the entries themselves are allocated from the
shared-memory pool that the server total accounts for. `postgres -C shared_memory_size` on the
same server reports 143 MB with the default `max_locks_per_transaction=64` and 233 MB with 2048,
so the setting costs about 90 MB of shared memory.

## Watching growth

```sql
SELECT count(*) FROM pg_inherits WHERE inhparent = 'public.items'::regclass;
```

Project the per-statement entries as tenants × partitions per tenant × 3 and compare them with
the total above. Raise `max_locks_per_transaction` again when the projection exceeds about a
tenth of the total (20,480 entries at the chosen value, roughly 270 tenants at 25 partitions
each), and keep the compose file and the restore test in step.

## Operator step

`max_locks_per_transaction` is a postmaster-level setting: it takes effect only when the
container is recreated.

1. In a maintenance window, recreate the container with the env file named in the
   `deploy/README.md` compose bullet:
   `docker compose --env-file /opt/semprec/shared/env/postgres.env -f deploy/docker-compose.yml up -d`
2. Confirm the value, using the container's own `POSTGRES_USER` (the host shell does not have it):
   `docker compose --env-file /opt/semprec/shared/env/postgres.env -f deploy/docker-compose.yml exec postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SHOW max_locks_per_transaction"'`
   It must return `2048`.
3. Restart the four services if any of them logged connection errors while the container was down.
