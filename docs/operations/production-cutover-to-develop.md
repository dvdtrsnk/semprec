# Production cutover from the v0.1.x hotfix line to develop

Production moves off the v0.1.x releases built from the hotfix line and onto a release built from
`develop`. This page is the runbook for that move and the record of its preconditions. The
procedure is run by the owner. Nothing in it has been run against production. Every statement about
production below is an expectation the owner confirms before the window, not an observed fact.

**Status: NO-GO.** The owner has not given a go (see [Go/no-go](#gono-go)). Against a database
built by v0.1.12 the dry run reports no seed delta and no differing definition once the develop
seed has reconciled the carried tenant (see [What is lost](#what-is-lost-or-must-be-redone)).

## Production facts to verify

These come from operations notes. Confirm each one on the host before the dry run and record the
result in the go/no-go table.

| #   | Expected                                                                                                                        | How to confirm                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 1   | The running release is a v0.1.x tag of the hotfix line `hotfix/v0.1.1-mail-sync`; the newest is `v0.1.12`                       | `readlink /opt/semprec/current`, `ls /opt/semprec/releases`                        |
| 2   | The host is a Debian VPS that deploys with `deploy/deploy.sh` from a checkout whose `origin` is a bare repository on the server | `git -C <operator checkout> remote -v`, `git -C <bare repo> branch -a`, `git tag`  |
| 3   | The schema is the v0.1.x one: `items` is partitioned per database (`items_p_<hex>`) and has no `version` column                 | `\d+ items` in the production database                                             |
| 4   | Postgres runs with `jit=off`                                                                                                    | `SHOW jit`                                                                         |
| 5   | Postgres is the `postgres:16-alpine` container of `deploy/docker-compose.yml`                                                   | `docker compose -f deploy/docker-compose.yml ps`, `SELECT version()`               |
| 6   | `POSTGRES_USER` and `POSTGRES_DB` of `/opt/semprec/shared/env/postgres.env` (the dump's object owner and database)              | read the file as root; note both names                                             |
| 7   | Mail credentials are sealed per tenant (`external_credentials.scheme = 'tenant'`) and are not in tenant exports                 | `SELECT scheme, credential_type, count(*) FROM external_credentials GROUP BY 1, 2` |
| 8   | Exactly one tenant exists, and its users are known                                                                              | `SELECT id, status FROM tenants`, `SELECT tenant_id, email, role FROM users`       |
| 9   | The daily backup runs and restic holds recent main and key snapshots                                                            | `systemctl list-timers semprec-backup.timer`, `restic snapshots`                   |
| 10  | The Czech Hunspell files are installed in the container (`cs_cz.dict`, `cs_cz.affix`)                                           | `SELECT dictname FROM pg_ts_dict WHERE dictname = 'czech_hunspell'`                |
| 11  | The blob directories are `/opt/semprec/data/files` and `/opt/semprec/data/mail-attachments`                                     | `FILES_STORAGE_DIR`, `MAIL_ATTACHMENTS_DIR` in `settings.env`                      |
| 12  | The secrets are the per-group files under `/opt/semprec/shared/env/`, not the legacy single `.env`                              | `ls /opt/semprec/shared/env/`                                                      |

If any row differs, stop and update this page before continuing.

## What the code says

Checked against the code of `v0.1.12` and of the branch this page was written on (the develop
line plus the internet-accounts epic).

**Develop cannot import a v0.1.x tenant export.** The tenant export
(`backend/packages/data/src/tenancy/tenantExportJob.ts`, format version 1, the same in `v0.1.12`)
writes a zip with `account.json`, one `tables/<table>.jsonl` per tenant table and the blob bytes.
Develop has no importer for it: no code reads that archive. The export is therefore an archive for
the user, not a carry path.

**Develop's migrations do not upgrade a v0.1.x database in place.** v0.1.x ran 177 migrations
(`0001_core_schema.sql` to `0177_side_role_cannot_mint_actors.sql`). Develop replaced them with one
baseline, `0001_baseline.sql`, which is edited in place until the first develop release
([migrations](migrations.md)). On a v0.1.x database `runMigrations` sees `0001_baseline.sql` as not
applied and runs it, which fails at once (observed: `function "activate_czech_hunspell_search"
already exists`). Even a database whose ledger lists the baseline can lack columns added to the
baseline later; the dry run compares the result with a fresh develop database to catch that.

**Develop's seed does not upgrade system databases.** `seedSystem` returns `already-seeded` when the
tenant's System settings database exists ([seeding](seeding.md)). A carried tenant keeps the
system database shape v0.1.x gave it.

**So the data is carried by copying tables.** The carry restores the backup into a scratch
database, migrates a fresh develop baseline next to it, and copies the rows of every table both
schemas have into the baseline, keeping every id. This is what `deploy/scripts/cutover-dry-run.sh`
does:

1. Restore the dump into `<name>_src` (`pg_restore --no-owner --no-privileges`).
2. Migrate and seed `<name>_ref`, a fresh develop database, as the reference.
3. Copy `<name>_src` to `<name>_inplace`, run the develop migrations on it and report whether they
   accept it and whether the result matches `<name>_ref`.
4. Migrate `<name>_dst` (develop migrations only, no seed), then in one transaction delete the
   baseline's own tenant row and its AI budget and load the carried tables with
   `pg_dump --data-only --load-via-partition-root` (the partitioned `items` lands in develop's
   single `items`; `items.version` takes its default `1`).
5. Check every foreign key for rows naming a missing parent, run the develop seed and
   `verifyTenancyCli`. Each carried tenant answers `already seeded`; the seed then reconciles it:
   it creates the system properties and relation definitions the develop seed defines and the
   tenant lacks, appends to existing system select properties the options the develop seed defines
   and they lack, and reports existing definitions that otherwise differ, without changing them
   ([reconcile](../architecture/migrations-and-seeding.md#reconcile-of-already-seeded-tenants)).
6. Report items per database (live/trashed) before and after, rows per carried table before and
   after the load, the rows the seed added, and the seed delta after the seed: system databases
   and properties `<name>_ref` has and `<name>_dst` lacks, or the reverse, followed by the
   differing definitions the seed reported.

### What is carried

Every table that exists in both schemas, except the exclusions below, with all rows of all
tenants: tenants, users, databases, properties, relation definitions, items (live and trashed),
item relations, views, docs and their history, blobs rows, Inbox, mail messages, threads and sync
state, agent runs, Semp threads and problems, notifications, push subscriptions, audit log and the
tenant deletion ledger. Sequences of carried tables keep their values. Blob files are not in the
database; they stay in the blob directories of the same host (fact 11), which the cutover does not
touch.

### What is lost or must be redone

| Not carried                                                                    | Why                                                                                               | Consequence                                                                                            |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `external_credentials`                                                         | excluded by the tenant export; the owner decided not to carry them                                | every mail account signs in again (see [Reconnect](#reconnect-mail-accounts))                          |
| `tenant_keys`                                                                  | excluded by the export, and its data is not in the main backup dump                               | a new tenant key is made when the first credential is sealed again                                     |
| `tenant_exports`                                                               | excluded by the export                                                                            | the in-app list of earlier exports is empty; their zip files stay in the files directory, unreferenced |
| `mail_oauth_states`, `idempotent_responses`                                    | excluded by the export; short-lived                                                               | an OAuth sign-in in flight during the window must be started again                                     |
| `sessions`, `login_attempts`, `password_reset_tokens`                          | auth state of the old release                                                                     | every user signs in again; an unused reset link stops working                                          |
| `process_heartbeats`, `schema_migrations`                                      | belong to the old processes and the old migration ledger                                          | none                                                                                                   |
| `module_migrations`, `module_migration_progress`                               | v0.1.x module data-migration machinery; develop has no such tables                                | none expected; the dry run prints their row counts                                                     |
| the `graphile_worker` schema (queued jobs)                                     | develop installs its own queue schema                                                             | queued jobs (sync passes, reminders, exports) are not run; the dry run prints how many were queued     |
| **differing definitions**: carried system properties develop defines otherwise | the seed's reconcile only adds what is missing (properties, relation definitions, select options) | the features that need the develop definition do not work on carried data (below)                      |

The develop seed adds what an older seed lacks. On a database built by `v0.1.12`, against this
branch's build, the dry run's seed reconciled the carried tenant with 11 properties, 1 relation
definition and 1 select option, after which the seed delta is empty:

- `mailboxes`: `mailEnabled` (checkbox), `calendarsEnabled` (checkbox), `calendars` (relation);
- `calendars`: `account` (relation, the other side of `mailboxes.calendars`), `readOnly`
  (checkbox), `remoteColor` (color), `remoteName` (text);
- `events`: `exceptionDates` (json), `recurrenceId` (text), `recurrenceRule` (text), `timeZone` (text);
- the option `account` of `calendars.kind`, which v0.1.12 seeded with `own`, `system` and
  `subscription`; it is appended after them.

Carried items keep their values; a missing value reads as the seed default (`mailEnabled` on,
`calendarsEnabled` off, the new Calendar and Event fields empty).

Of the seed-delta options (1. an additive reconcile, 2. accept the delta, 3. reseed), option 1 was
taken; it is the reconcile above.

The same run reports no carried definition that differs from develop's. On the carried database
the calendar sync of the develop build created a Calendars item with `kind: account` for a new
internet account.

Every system definition `develop` adds or changes before the cutover changes this list. Rerun the
dry run with the build of the exact release commit.

## Procedure

### 0. Preconditions

The owner attests each of these in the go/no-go table. An agent cannot.

- every production fact above is confirmed;
- a backup of the production database was taken in the window and restored successfully into a
  scratch cluster (step 1);
- the dry run of step 3 passed against that backup with the build of the release commit;
- the dry run reports no seed delta (or the owner accepted it), and every differing definition it
  lists was reviewed and resolved or accepted;
- a develop release tag exists and the server's deploy origin can serve it (step 4.6);
- the rollback in [Rollback](#rollback) was read and its target `v0.1.12` is on disk;
- users were told about the downtime and that they must sign in and reconnect mail again.

### 1. Backup and restore test

1. Run the backup now instead of waiting for 03:30: `sudo systemctl start semprec-backup.service`,
   then `journalctl -u semprec-backup.service -n 50`. It must end without error.
2. `restic snapshots --path /var/backups/semprec/postgres.dump` shows the new snapshot.
3. Run the restore test: `sudo systemctl start semprec-restore-test.service` and read its journal
   (it restores the newest snapshot into a disposable container,
   [deploy/README.md](../../deploy/README.md#monthly-restore-test-issue-178)). It must pass. If the
   hotfix line's host does not have this unit, restore the dump into a scratch cluster by hand
   (step 3 does this as well) and record that.
4. Copy `/var/backups/semprec/postgres.dump` to where the dry run will run, readable only by the
   operator. It holds all user data.

### 2. Tenant export (archive for the users)

On the running v0.1.x release each user exports their account (`POST /api/account/exports`, then
`GET /api/account/exports/<id>/download` once it is ready) and keeps the zip. Note the row counts in
its `manifest.json`; the dry run's table counts of the same tables must not be lower. The archive
is not imported: it is the user's own copy if the cutover has to be abandoned after the old database
is gone.

### 3. Dry run

Run it on a disposable PostgreSQL cluster of the production major version (16), never on the
production cluster. The script refuses a cluster that holds any database other than `postgres`, the
templates and `cutover_scratch_*`, a non-superuser, client tools of another major version than the
server, and a `--name` that does not start with `cutover_scratch_`.

```sh
# A develop checkout at the release commit, built.
git -C <develop checkout> checkout <release commit>
(cd <develop checkout>/backend && pnpm install --frozen-lockfile && pnpm -r run build)

# A scratch cluster with the production superuser name (fact 6), so the emitted dump keeps the owners
# production expects, and the Hunspell files if production has them (fact 10; see provision.sh).
work="$(mktemp -d)"   # under a path the container can mount
docker run -d --name cutover-scratch -e POSTGRES_USER=<POSTGRES_USER> -e POSTGRES_PASSWORD=<scratch password> \
  -e POSTGRES_DB=postgres -v "$work:$work" -p 127.0.0.1:55432:5432 \
  postgres:16-alpine postgres -c max_locks_per_transaction=2048 -c jit=off

export CUTOVER_SCRATCH_ADMIN_URL='postgres://<POSTGRES_USER>:<scratch password>@127.0.0.1:55432/postgres'
export PG_BIN_DIR=<directory with psql, pg_dump and pg_restore of PostgreSQL 16>
export TMPDIR="$work"
deploy/scripts/cutover-dry-run.sh --dump "$work/postgres.dump" --backend <develop checkout>/backend \
  --name cutover_scratch_prod | tee "$work/dry-run.txt"
```

Where no PostgreSQL 16 client is installed, `PG_BIN_DIR` can hold one wrapper per tool that runs
the scratch container's own copy; the work directory must then be mounted at the same path:

```sh
#!/usr/bin/env bash
exec docker exec -i -e PGUSER -e PGPASSWORD -e PGDATABASE -e PGHOST=127.0.0.1 -e PGPORT=5432 \
  -w "$PWD" cutover-scratch pg_dump "$@"
```

Exit status: `0` PASS, `3` GAP (everything carried and verified, seed delta not empty after the
seed's reconcile), `1` FAIL, `2` refused or wrong usage. Differing definitions are listed but do not
change the exit status. The run drops its four databases at the start and at the end (`--keep`
leaves them for inspection), so it can be repeated with the same `--name`.

Read the report. A run is good when:

- `in-place` says the develop migrations refuse the database (expected for v0.1.x);
- every carried table and every database has the same counts before and after;
- `foreign keys: every carried row names an existing parent` and `tenancy: verified`;
- the excluded and dropped rows are the ones in [What is lost](#what-is-lost-or-must-be-redone),
  and the number of sealed credentials matches the accounts to reconnect;
- `reconcile created …` lists what the seed added to each carried tenant, and
  `rows the develop seed added` matches it (`properties`, `relation_definitions`); the
  `appended options …` lines name the select options it appended (they change no row count);
- the seed delta is empty, or is exactly what the owner accepted;
- every line under `existing definitions that differ from the develop seed` is resolved or
  accepted.

Remove the container and the work directory afterwards: `docker rm -f cutover-scratch`, `rm -rf "$work"`.

### 4. Cutover window

1. Stop the writers and the timers that would touch the database or alert:
   `sudo systemctl stop semprec-api semprec-agents semprec-transcribe semprec-ai-gateway`,
   `sudo systemctl stop semprec-backup.timer semprec-restore-test.timer semprec-trash-purge.timer semprec-dead-man.timer`.
   Pause the external health check so it does not page.
2. Take the final backup (step 1.1) and copy its `postgres.dump` (step 1.4).
3. Run the dry run of step 3 on that dump, adding `--emit-dump "$work/carried.dump"` (and
   `--allow-seed-delta` only if the owner accepted the delta). It writes the carried database only
   when the run passes. Copy `carried.dump` to the host, for example to
   `/var/backups/semprec/carried.dump`, mode `0600`.
4. Restore it next to the old database in the production cluster, keeping owners and privileges:

   ```sh
   cd <operator checkout>
   dc() { sudo docker compose --env-file /opt/semprec/shared/env/postgres.env -f deploy/docker-compose.yml "$@"; }
   dc exec -T postgres createdb --username=<POSTGRES_USER> semprec_develop
   dc exec -T postgres pg_restore --username=<POSTGRES_USER> --exit-on-error --dbname=semprec_develop \
     < /var/backups/semprec/carried.dump
   ```

5. Swap the names, so every file that names `POSTGRES_DB` or a database URL (backup, restore test,
   the role and migrate URLs) keeps working unchanged:

   ```sh
   dc exec -T postgres psql --username=<POSTGRES_USER> --dbname=postgres --set=ON_ERROR_STOP=1 \
     -c 'ALTER DATABASE <POSTGRES_DB> RENAME TO semprec_v01' \
     -c 'ALTER DATABASE semprec_develop RENAME TO <POSTGRES_DB>'
   ```

6. Make the release tag deployable: `deploy.sh` fetches the tag and `main` from the operator
   checkout's `origin` and refuses a tag that is not on its `main` (fact 2). Push the promoted `main`
   and the annotated tag ([releases](releases.md)) to that origin. How the server's bare repository
   tracks the hotfix line today must be confirmed first; its `main` has to move to the develop line.
7. Rerun `sudo deploy/provision.sh` from the develop checkout (the units and templates barely differ
   from `v0.1.12`; rerunning installs the develop copies), then `sudo deploy/deploy.sh <tag>`. Its
   migration step finds the baseline applied, the seed answers `already seeded` per tenant, and the
   tenancy verifier must print `tenancy: verified` before `current` moves. A failure before
   activation leaves `current` on `v0.1.12`; go to [Rollback](#rollback), case A.
8. Run the [verification checklist](#verification-checklist).
9. Start the timers again (`sudo systemctl start semprec-backup.timer semprec-restore-test.timer
semprec-trash-purge.timer semprec-dead-man.timer`) and resume the external health check.
10. Run a backup now (step 1.1) so the first snapshot of the develop database exists.

### Reconnect mail accounts

No credential was carried, so every mail account's sync fails with "no stored credential" until it
signs in again. The dry run's count of sealed credentials is the number of accounts.

- Google and Microsoft accounts: sign in again from the account (`POST
/api/mail/mailboxes/:id/reauthorize`). This replaces the credential of the existing Mailboxes item,
  so its mail, folders and threads stay. Confirm on the first one that the reauthorization accepts
  an account that has no credential at all, not only an expired one; if it does not, remove and add
  the account as below. To turn Calendars on, the OAuth clients must also list the calendar scopes
  (`deploy/shared/env/api.env.example`).
- iCloud and other password accounts: develop has no route that replaces only the password. Remove
  the account and add it again; the removal trashes its mail and the new account downloads it again.

### Verification checklist

- [ ] `deploy.sh` printed `tenancy: verified` and every service reports the new `APP_VERSION`.
- [ ] `curl -fsS https://<domain>/healthz` answers `{"status":"ok"}`.
- [ ] Items per database in the new database equal the dry run's "after" column: run the query of
      `database_counts` in `deploy/scripts/cutover-dry-run.sh` with `psql` in the production
      container against `<POSTGRES_DB>`.
- [ ] Each user signs in, sees their databases, opens items in Tasks, Projects and a user database,
      opens a page with blocks and a file, and finds a known item through search.
- [ ] Creating, editing and trashing an item works (the carried `items.version` starts at 1).
- [ ] Each mail account is reconnected and its sync status turns ok; a new message arrives.
- [ ] Push notifications reach a registered device.
- [ ] `journalctl -u semprec-api -u semprec-agents --since -15min` shows no repeated errors.
- [ ] The first backup of the new database succeeded (step 4.10).

## Rollback

The old database is kept as `semprec_v01` and the `v0.1.12` release stays on disk, so rollback
needs no restore. Writes made after the cutover are lost by a rollback; decide early.

- **Case A, the deploy failed before `current` moved.** Swap the names back (step 4.5 with the names
  exchanged: `<POSTGRES_DB>` to `semprec_develop`, `semprec_v01` to `<POSTGRES_DB>`) and start the
  services and timers again. `current` still names `v0.1.12`.
- **Case B, the develop release is active.** Stop the services, swap the names back as in case A,
  then `sudo deploy/deploy.sh --rollback v0.1.12`, which is accepted only while `v0.1.12` is the
  release directly before the newest one on disk and `current` names that newest one. Start the
  timers and the health check again. Rerun `provision.sh` from a `v0.1.12` checkout if the develop
  units were installed. The old database still holds its own credentials; an account whose provider
  revoked the old token when it signed in again on develop must sign in again on v0.1.x.

Never run `v0.1.12` against the develop database: its schema differs (`items` is not partitioned),
and `deploy.sh --rollback` does not change the schema.

Drop `semprec_v01` only after the owner closes the rollback window; it is also in every restic
snapshot taken before the cutover (12 monthly snapshots are kept).

## Go/no-go

Filled in by the owner. An agent does not fill in or change this table.

| Precondition                                             | Result | Date and evidence |
| -------------------------------------------------------- | ------ | ----------------- |
| Production facts 1–12 confirmed                          |        |                   |
| Backup taken in the window and restored into scratch     |        |                   |
| Dry run against that backup with the release build       |        |                   |
| Seed delta empty after the reconcile (option 1)          |        |                   |
| Differing definitions resolved or accepted               |        |                   |
| Release tag deployable from the server's origin          |        |                   |
| Rollback target `v0.1.12` on disk, procedure read        |        |                   |
| Users informed (downtime, sign in again, reconnect mail) |        |                   |
| **Go / no-go**                                           |        |                   |

## How the dry run was tested

Locally only, on disposable `postgres:16-alpine` containers with `jit=off`, with the build of the
internet-accounts branch as "develop" and PostgreSQL 16.15 tools. No production data or host was
used.

- A v0.1.x-shaped dump: a database migrated and seeded by a `v0.1.12` build, filled through the
  v0.1.12 choke point (a user database with 5 items, one trashed, tasks, projects, people, 4 task to
  project relations) plus a user and one sealed-credential row, then dumped as the backup job dumps
  (`--format=custom --exclude-table-data=public.tenant_keys`). The run reported the in-place refusal,
  72 carried tables with equal counts, 29 databases with equal live/trashed counts, no orphaned
  foreign keys, `already seeded`, `tenancy: verified`, the exclusions above and, with a seed that
  did not yet reconcile carried tenants, the 11 missing properties above as the seed delta, and
  exited 3. With `--emit-dump --allow-seed-delta` it wrote the dump; restoring that with owners
  into a new database and running the develop migrations, seed and tenancy verifier succeeded, the
  router functions kept `semprec_router` as owner, and the develop choke point created an item,
  updated a carried task (version 1 to 2) and listed its relation.
- With the seed's reconcile: a new dump of the same shape (a `v0.1.12` database filled through its
  choke point with a user, a project and three related tasks, a person, a mailbox and an event).
  The run printed `reconcile created 11 properties, 1 relation definitions` and
  `conflict config calendars.kind`, 72 carried tables with equal counts after the load,
  `properties 303 -> 314` and `relation_definitions 54 -> 55` as rows the seed added, 28 databases
  with equal live/trashed counts, `tenancy: verified`, no seed delta, `calendars.kind` under the
  differing definitions, and exited 0. On the kept `_dst` database a second seed run created
  nothing, and `runSeedCli.js --strict` exited 1 on the `calendars.kind` conflict.
- With the select-option append: a new dump of the same shape (a `v0.1.12` database filled through
  its choke point with a user, a project, three tasks, a person, a mailbox and an event). The run
  printed `reconcile created 11 properties, 1 relation definitions, appended 1 select options` and
  `appended options calendars.kind account`, no differing definition, 72 carried tables with equal
  counts after the load, `properties 303 -> 314` and `relation_definitions 54 -> 55` as rows the
  seed added, 28 databases with equal live/trashed counts, `tenancy: verified`, no seed delta, and
  exited 0. On the kept `_dst` database `calendars.kind` listed `own`, `system`, `subscription`,
  `account`; the develop calendar sync apply created a Calendars item with `kind: account` for a new
  account with Calendars on, and a second seed run with `--strict` appended nothing and exited 0.
- A develop-shaped dump of the same content: in-place migrations ran but the probe reported a column
  the baseline gained since (`mail_account_server_settings.caldav_url`); the carry passed (exit 0).
- Refusals, each exiting 2 before touching a database: names that do not match the scratch pattern,
  a cluster holding a non-scratch database (whose contents stayed intact), a non-superuser, 18.x
  client tools against a 16 server, a missing build, a missing `CUTOVER_SCRATCH_ADMIN_URL`; a file
  that is not a dump fails (exit 1) and leaves no scratch database behind.
- Repeating a run with the same `--name` after a `--keep` run dropped the leftovers and passed again.

Not tested: a real production dump, a dump with Hunspell active, more than one tenant, real mail
accounts and their reconnection, `deploy.sh` and `provision.sh` on a host, and the rollback.
