# PostgreSQL lock-table capacity

`max_locks_per_transaction=2048` is set with `command:` on the `postgres` service in
`deploy/docker-compose.yml` and on the restore test's disposable server in
`deploy/systemd/scripts/alldots-restore-test.sh` (`alldots-restore-test.test.sh` asserts the two
values are equal). `max_connections` stays at 100 and `max_prepared_transactions` at 0.

```
lock table total = max_locks_per_transaction × (max_connections + max_prepared_transactions)
```

`items` is one ordinary table (`backend/packages/data/src/db/migrations/0001_baseline.sql`), so a
statement on it locks the table and its five indexes whatever the number of tenants and
databases. No statement's lock count grows with the data; the widest transactions are the ones
that touch every tenant table once, such as the tenant export (`tenancy/tenantExportJob.ts`) and
the monthly restore test's row counts: every tenant table with its indexes.

2048 is headroom beyond what the schema needs: the image default of 64 (a 6,400-entry lock table
at 100 connections) also fits the widest transaction above.

## Shared-memory cost

Measured on PostgreSQL 16.15: `postgres -C shared_memory_size` reports 143 MB with the default
`max_locks_per_transaction=64` and 233 MB with 2048, so the setting costs about 90 MB of shared
memory.

## Watching use

```sql
SELECT count(*) FROM pg_locks;
```

## Operator step

`max_locks_per_transaction` is a postmaster-level setting: a changed value takes effect only when
the container is recreated.

1. In a maintenance window, recreate the container with the env file named in the
   `deploy/README.md` compose bullet:
   `docker compose --env-file /opt/alldots/shared/env/postgres.env -f deploy/docker-compose.yml up -d`
2. Confirm the value, using the container's own `POSTGRES_USER` (the host shell does not have it):
   `docker compose --env-file /opt/alldots/shared/env/postgres.env -f deploy/docker-compose.yml exec postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SHOW max_locks_per_transaction"'`
   It must return the value in the compose file.
3. Restart the four services if any of them logged connection errors while the container was down.
