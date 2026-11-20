#!/usr/bin/env bash
# Rehearses the cutover of a v0.1.x production database to a develop build
# (docs/operations/production-cutover-to-develop.md) on a scratch PostgreSQL cluster.
#
# Usage: cutover-dry-run.sh --dump FILE --backend DIR --name cutover_scratch_<suffix>
#                           [--emit-dump FILE [--allow-seed-delta]] [--keep]
#
#   --dump FILE          a custom-format pg_dump of the production database (deploy/README.md, backups)
#   --backend DIR        the backend/ directory of a built develop checkout (pnpm -r run build)
#   --name NAME          the scratch database prefix; must match ^cutover_scratch_[a-z0-9_]{1,30}$
#   --emit-dump FILE     after a passing run, writes the carried database as a custom-format dump
#   --allow-seed-delta   lets --emit-dump write a run whose only finding is a seed delta
#   --keep               leaves the scratch databases in place for inspection
#
# CUTOVER_SCRATCH_ADMIN_URL names a superuser of the scratch cluster; it is read from the environment
# so the password never appears in a process list. PG_BIN_DIR, when set, is where psql, pg_dump and
# pg_restore are taken from.
#
# The run creates and drops only the databases <name>_src, <name>_inplace, <name>_ref and
# <name>_dst. It refuses a cluster that holds any database other than postgres, the templates and
# cutover_scratch_* databases, because it also creates cluster roles, which no database scopes.
#
#   <name>_src      the dump, restored; the counts before
#   <name>_inplace  a copy of _src the develop migrations are applied to, to see whether they accept it
#   <name>_ref      a fresh develop database (migrations and seed), the reference system schema
#   <name>_dst      a fresh develop baseline the carried tables are loaded into; the counts after
#
# Exit status: 0 PASS, 3 GAP (carried and verified, but the develop seed defines system databases or
# properties the carried data lacks), 1 FAIL, 2 usage or refused target.
set -euo pipefail

readonly SCRATCH_PATTERN='^cutover_scratch_[a-z0-9_]{1,30}$'

# Never carried, besides the tables the tenant export excludes (read from the develop build): the
# target's own migration ledger and the auth and liveness state of the old processes. Everyone signs
# in again after the cutover.
readonly -a OPERATIONAL_EXCLUSIONS=(
  schema_migrations
  sessions
  login_attempts
  password_reset_tokens
  process_heartbeats
)

dump_file=""
backend_dir=""
scratch_name=""
emit_dump=""
allow_seed_delta=0
keep=0
work_dir=""
cleanup_armed=0
failures=0
gaps=0

usage() {
  sed -n '5,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

refuse() {
  echo "cutover-dry-run: $*" >&2
  exit 2
}

die() {
  echo "cutover-dry-run: FAIL: $*" >&2
  exit 1
}

finding() {
  echo "FAIL: $*"
  failures=$((failures + 1))
}

section() {
  printf '\n== %s\n' "$*"
}

parse_args() {
  while (($# > 0)); do
    case "$1" in
      --dump | --backend | --name | --emit-dump) (($# >= 2)) || usage ;;
    esac
    case "$1" in
      --dump) dump_file="${2:-}"; shift 2 ;;
      --backend) backend_dir="${2:-}"; shift 2 ;;
      --name) scratch_name="${2:-}"; shift 2 ;;
      --emit-dump) emit_dump="${2:-}"; shift 2 ;;
      --allow-seed-delta) allow_seed_delta=1; shift ;;
      --keep) keep=1; shift ;;
      *) usage ;;
    esac
  done
  [[ -n "$dump_file" && -n "$backend_dir" && -n "$scratch_name" ]] || usage
  [[ "$scratch_name" =~ $SCRATCH_PATTERN ]] ||
    refuse "--name '$scratch_name' does not match $SCRATCH_PATTERN; only scratch databases are touched"
  [[ -f "$dump_file" && -r "$dump_file" ]] || refuse "--dump $dump_file is not a readable file"
  if [[ -n "$emit_dump" && -e "$emit_dump" ]]; then
    refuse "--emit-dump $emit_dump already exists; choose a new path"
  fi
  if ((allow_seed_delta)) && [[ -z "$emit_dump" ]]; then
    refuse "--allow-seed-delta only applies to --emit-dump"
  fi
}

require_tools() {
  local tool
  for tool in psql pg_dump pg_restore; do
    if [[ -n "${PG_BIN_DIR:-}" ]]; then
      [[ -x "$PG_BIN_DIR/$tool" ]] || refuse "$PG_BIN_DIR/$tool is not executable"
    else
      command -v "$tool" > /dev/null || refuse "$tool is not on PATH; set PG_BIN_DIR"
    fi
  done
  command -v node > /dev/null || refuse "node is not on PATH"
  local cli
  for cli in db/runMigrationsCli.js db/runSeedCli.js db/verifyTenancyCli.js tenancy/tenantExportJob.js; do
    [[ -f "$backend_dir/packages/data/dist/$cli" ]] ||
      refuse "$backend_dir/packages/data/dist/$cli is missing; build the develop checkout first (pnpm -r run build)"
  done
}

pg_tool() {
  local tool="$1"
  shift
  if [[ -n "${PG_BIN_DIR:-}" ]]; then
    "$PG_BIN_DIR/$tool" "$@"
  else
    "$tool" "$@"
  fi
}

# Splits the admin URL into libpq variables, so no tool gets the password as an argument.
load_admin_connection() {
  [[ -n "${CUTOVER_SCRATCH_ADMIN_URL:-}" ]] || refuse "CUTOVER_SCRATCH_ADMIN_URL is not set"
  local parsed
  parsed="$(node --input-type=module -e '
    const url = new URL(process.env.CUTOVER_SCRATCH_ADMIN_URL);
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") throw new Error("not a postgres URL");
    const parts = [url.hostname, url.port || "5432", decodeURIComponent(url.username), decodeURIComponent(url.password)];
    if (parts.some((part) => part.includes("\n"))) throw new Error("newline in URL");
    process.stdout.write(parts.join("\n"));
  ')" || refuse "CUTOVER_SCRATCH_ADMIN_URL is not a postgres:// URL"
  {
    IFS= read -r PGHOST
    IFS= read -r PGPORT
    IFS= read -r PGUSER
    IFS= read -r PGPASSWORD || true
  } <<< "$parsed"
  export PGHOST PGPORT PGUSER PGPASSWORD
  export PGDATABASE=postgres
  unset PGSERVICE PGPASSFILE
}

# A connection string for the node CLIs, which read DATABASE_URL from the environment.
database_url() {
  DB_NAME="$1" node --input-type=module -e '
    const url = new URL(process.env.CUTOVER_SCRATCH_ADMIN_URL);
    url.pathname = "/" + process.env.DB_NAME;
    process.stdout.write(url.href);
  '
}

sql() {
  local database="$1"
  shift
  pg_tool psql --no-psqlrc --quiet --tuples-only --no-align --field-separator=$'\t' \
    --set=ON_ERROR_STOP=1 --dbname="$database" "$@"
}

assert_scratch_cluster() {
  local superuser others
  superuser="$(sql postgres --command="SELECT rolsuper FROM pg_roles WHERE rolname = current_user")"
  [[ "$superuser" == "t" ]] || refuse "$PGUSER is not a superuser of the scratch cluster"
  others="$(sql postgres --command="SELECT count(*) FROM pg_database
      WHERE NOT datistemplate AND datname <> 'postgres' AND datname !~ '^cutover_scratch_'")"
  [[ "$others" == "0" ]] ||
    refuse "the cluster at $PGHOST:$PGPORT holds $others database(s) that are not cutover_scratch_*; run against a disposable scratch cluster only"
}

# A newer pg_restore writes settings an older server rejects, and an older pg_restore cannot read a
# newer archive, so the tools must be of the scratch server's major version, which in turn must be
# the production server's for the emitted dump to restore there.
assert_matching_tools() {
  local server client
  server="$(sql postgres --command="SELECT current_setting('server_version_num')::int / 10000")"
  client="$(pg_tool pg_dump --version | sed -E 's/^[^0-9]*([0-9]+).*/\1/')"
  [[ "$server" == "$client" ]] ||
    refuse "the client tools are PostgreSQL $client but the scratch server is $server; use tools and a server of the production major version"
}

scratch_databases() {
  printf '%s\n' "${scratch_name}_src" "${scratch_name}_inplace" "${scratch_name}_ref" "${scratch_name}_dst"
}

drop_scratch_databases() {
  local database
  while IFS= read -r database; do
    sql postgres --set=db="$database" <<< 'SET client_min_messages = warning; DROP DATABASE IF EXISTS :"db" WITH (FORCE)'
  done < <(scratch_databases)
}

create_database() {
  sql postgres --set=db="$1" <<< 'CREATE DATABASE :"db"'
}

# A failed cleanup is reported but never replaces the run's own exit status.
cleanup() {
  local status=$?
  if ((cleanup_armed)) && ((keep == 0)); then
    if ! drop_scratch_databases; then
      echo "cutover-dry-run: cleanup: dropping the scratch databases failed; drop $(scratch_databases | tr '\n' ' ')by hand" >&2
    fi
  fi
  if [[ -n "$work_dir" ]]; then
    rm -rf -- "$work_dir" || echo "cutover-dry-run: cleanup: could not remove $work_dir" >&2
  fi
  exit "$status"
}

# The roles the dump's policies name. Created NOLOGIN when missing; the develop baseline keeps
# existing roles as they are.
ensure_cluster_roles() {
  sql postgres << 'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'semprec_side') THEN
    CREATE ROLE semprec_side NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'semprec_data') THEN
    CREATE ROLE semprec_data NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION IN ROLE semprec_side;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'semprec_router') THEN
    CREATE ROLE semprec_router NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;
  END IF;
END
$$;
SQL
}

# Runs one compiled CLI of the develop build against a scratch database; its output goes to a log.
run_cli() {
  local database="$1"
  local cli="$2"
  local log="$3"
  local url
  url="$(database_url "$database")"
  (cd "$backend_dir" && DATABASE_URL="$url" node "packages/data/dist/$cli") > "$log" 2>&1
}

print_log_tail() {
  { grep -v -e 'ExperimentalWarning' -e 'trace-warnings' "$1" || true; } | tail -n "${2:-5}" | sed 's/^/    /'
}

# id, tenant, label, live items, trashed items. The label is read through to_jsonb so a schema
# without one of the columns still answers.
database_counts() {
  sql "$1" << 'SQL'
SELECT d.id, d.tenant_id,
       regexp_replace(coalesce(to_jsonb(d)->>'key', to_jsonb(d)->>'owner_module_id', to_jsonb(d)->>'name', ''),
                      '[[:cntrl:]]', ' ', 'g'),
       count(i.id) FILTER (WHERE i.deleted_at IS NULL),
       count(i.id) FILTER (WHERE i.deleted_at IS NOT NULL)
  FROM databases d LEFT JOIN items i ON i.database_id = d.id
 GROUP BY d.id, d.tenant_id
 ORDER BY 3, 1
SQL
}

# Table name and row count of every public table (a partitioned table counts its partitions' rows).
table_counts() {
  sql "$1" << 'SQL'
SELECT format('SELECT %L, count(*) FROM public.%I', c.relname, c.relname)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
 ORDER BY c.relname
\gexec
SQL
}

# table, column, type, not null, has default.
table_columns() {
  sql "$1" << 'SQL'
SELECT c.relname, a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull, a.atthasdef
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
   AND a.attnum > 0 AND NOT a.attisdropped
 ORDER BY 1, 2
SQL
}

public_sequences() {
  sql "$1" --command="SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'S' ORDER BY 1"
}

# Every foreign key with rows that name a missing parent. Loading runs with triggers disabled, so
# the constraints were not checked while the rows went in.
foreign_key_orphans() {
  sql "$1" << 'SQL'
SELECT format('SELECT %L, count(*) FROM %s c WHERE %s AND NOT EXISTS (SELECT 1 FROM %s p WHERE %s) HAVING count(*) > 0',
              con.conrelid::regclass || '.' || con.conname, con.conrelid::regclass,
              string_agg(format('c.%I IS NOT NULL', ca.attname), ' AND '),
              con.confrelid::regclass,
              string_agg(format('p.%I = c.%I', fa.attname, ca.attname), ' AND '))
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  CROSS JOIN LATERAL unnest(con.conkey, con.confkey) AS k(child_attnum, parent_attnum)
  JOIN pg_attribute ca ON ca.attrelid = con.conrelid AND ca.attnum = k.child_attnum
  JOIN pg_attribute fa ON fa.attrelid = con.confrelid AND fa.attnum = k.parent_attnum
 WHERE con.contype = 'f' AND con.connamespace = 'public'::regnamespace AND NOT rel.relispartition
 GROUP BY con.oid, con.conname, con.conrelid, con.confrelid
 ORDER BY 1
\gexec
SQL
}

# database key, property key and type of every property of a system database.
system_properties() {
  sql "$1" << 'SQL'
SELECT coalesce(to_jsonb(d)->>'key', to_jsonb(d)->>'owner_module_id'), p.key, p.type
  FROM properties p JOIN databases d ON d.id = p.database_id
 WHERE d.system
 ORDER BY 1, 2
SQL
}

system_databases() {
  sql "$1" --command="SELECT DISTINCT coalesce(to_jsonb(d)->>'key', to_jsonb(d)->>'owner_module_id')
    FROM databases d WHERE d.system ORDER BY 1"
}

queued_jobs() {
  sql "$1" << 'SQL'
SELECT CASE
  WHEN to_regclass('graphile_worker._private_jobs') IS NOT NULL THEN (SELECT count(*) FROM graphile_worker._private_jobs)::text
  WHEN to_regclass('graphile_worker.jobs') IS NOT NULL THEN (SELECT count(*) FROM graphile_worker.jobs)::text
  ELSE 'none'
END
SQL
}

export_excluded_tables() {
  node --input-type=module -e '
    const m = await import(process.argv[1]);
    process.stdout.write(m.EXPORT_EXCLUDED_TABLES.join("\n") + "\n");
  ' "$backend_dir/packages/data/dist/tenancy/tenantExportJob.js" 2> /dev/null
}

restore_source() {
  section "Restore"
  local src="${scratch_name}_src"
  create_database "$src"
  if ! pg_tool pg_restore --exit-on-error --no-owner --no-privileges --dbname="$src" "$dump_file" \
    > "$work_dir/restore.log" 2>&1; then
    print_log_tail "$work_dir/restore.log" 10 >&2
    die "pg_restore of $dump_file into $src failed"
  fi
  echo "restored $dump_file into $src"
  local migrations
  migrations="$(sql "$src" --command="SELECT count(*) || ' rows, last ' || coalesce(max(id), '-') FROM schema_migrations" 2> /dev/null ||
    echo "no schema_migrations table")"
  echo "source schema_migrations: $migrations"
  echo "source queued graphile-worker jobs: $(queued_jobs "$src")"
}

probe_in_place() {
  section "In-place migration probe"
  local src="${scratch_name}_src"
  local inplace="${scratch_name}_inplace"
  sql postgres --set=db="$inplace" --set=src="$src" <<< 'CREATE DATABASE :"db" TEMPLATE :"src"'
  if run_cli "$inplace" db/runMigrationsCli.js "$work_dir/inplace.log"; then
    # The baseline is edited in place before the first release, so an applied ledger entry does not
    # mean the schema matches: compare it with a fresh develop database.
    table_columns "$inplace" | cut -f1-3 > "$work_dir/inplace-columns"
    table_columns "${scratch_name}_ref" | cut -f1-3 > "$work_dir/ref-columns"
    local differences
    differences="$(diff "$work_dir/inplace-columns" "$work_dir/ref-columns" | grep -c '^[<>]' || true)"
    if [[ "$differences" == "0" ]]; then
      echo "in-place: the develop migrations accept the restored database and its tables match a fresh develop database"
    else
      echo "in-place: the develop migrations run, but $differences table column(s) differ from a fresh develop database (< in place, > fresh):"
      { diff "$work_dir/inplace-columns" "$work_dir/ref-columns" || true; } | grep '^[<>]' | tr '\t' ' ' | head -n 20 | sed 's/^/    /' || true
    fi
  else
    echo "in-place: the develop migrations refuse the restored database; it must be carried into a fresh baseline:"
    grep -m 1 -E '^([A-Za-z]*Error|error):' "$work_dir/inplace.log" | sed 's/^/    /' || true
  fi
  sql postgres --set=db="$inplace" <<< 'DROP DATABASE :"db" WITH (FORCE)'
}

build_reference() {
  section "Reference develop database"
  local ref="${scratch_name}_ref"
  create_database "$ref"
  run_cli "$ref" db/runMigrationsCli.js "$work_dir/ref-migrate.log" ||
    { print_log_tail "$work_dir/ref-migrate.log" 10 >&2; die "develop migrations failed on an empty database"; }
  run_cli "$ref" db/runSeedCli.js "$work_dir/ref-seed.log" ||
    { print_log_tail "$work_dir/ref-seed.log" 10 >&2; die "develop seed failed on an empty database"; }
  echo "migrated and seeded $ref"
}

# Decides which tables move: common to both schemas, minus the exclusions. Writes
# $work_dir/carried and $work_dir/not-carried (the tables and sequences the data dump leaves out).
plan_carry() {
  section "Carry plan"
  local src="${scratch_name}_src"
  local dst="${scratch_name}_dst"
  create_database "$dst"
  run_cli "$dst" db/runMigrationsCli.js "$work_dir/dst-migrate.log" ||
    { print_log_tail "$work_dir/dst-migrate.log" 10 >&2; die "develop migrations failed on $dst"; }

  table_columns "$src" > "$work_dir/src-columns"
  table_columns "$dst" > "$work_dir/dst-columns"
  cut -f1 "$work_dir/src-columns" | sort -u > "$work_dir/src-tables"
  cut -f1 "$work_dir/dst-columns" | sort -u > "$work_dir/dst-tables"
  table_counts "$src" | sort > "$work_dir/src-table-counts"

  {
    export_excluded_tables || die "cannot read EXPORT_EXCLUDED_TABLES from the develop build"
    printf '%s\n' "${OPERATIONAL_EXCLUSIONS[@]}"
  } | sort -u > "$work_dir/excluded"

  comm -12 "$work_dir/src-tables" "$work_dir/dst-tables" | comm -23 - "$work_dir/excluded" > "$work_dir/carried"
  echo "carried tables: $(wc -l < "$work_dir/carried" | tr -d ' ')"

  local table rows
  echo "not carried, excluded (rows in the source):"
  while IFS= read -r table; do
    rows="$(awk -F'\t' -v t="$table" '$1 == t { print $2 }' "$work_dir/src-table-counts")"
    [[ -n "$rows" ]] && printf '  %-32s %s\n' "$table" "$rows"
  done < "$work_dir/excluded"
  echo "sealed credentials not carried (their accounts must be reconnected), by type:"
  sql "$src" --command="SELECT credential_type, count(*) FROM external_credentials GROUP BY 1 ORDER BY 1" |
    sed 's/^/  /'
  echo "not carried, no such table in develop (rows in the source):"
  while IFS= read -r table; do
    rows="$(awk -F'\t' -v t="$table" '$1 == t { print $2 }' "$work_dir/src-table-counts")"
    printf '  %-32s %s\n' "$table" "$rows"
  done < <(comm -23 "$work_dir/src-tables" "$work_dir/dst-tables")
  echo "new in develop, start empty:"
  comm -13 "$work_dir/src-tables" "$work_dir/dst-tables" | sed 's/^/  /'

  # A source column develop does not have would be lost; a required develop column without a
  # default that the source does not have cannot be filled.
  local carried_columns
  carried_columns="$(awk -F'\t' 'NR == FNR { keep[$1] = 1; next } keep[$1]' "$work_dir/carried" "$work_dir/src-columns")"
  while IFS=$'\t' read -r table column _; do
    [[ -z "$table" ]] && continue
    if ! awk -F'\t' -v t="$table" -v c="$column" '$1 == t && $2 == c { found = 1 } END { exit !found }' "$work_dir/dst-columns"; then
      finding "column $table.$column exists only in the source; its values would be lost"
    fi
  done <<< "$carried_columns"
  while IFS=$'\t' read -r table column _ not_null has_default; do
    [[ "$not_null" == "t" && "$has_default" == "f" ]] || continue
    grep -qx "$table" "$work_dir/carried" || continue
    if ! awk -F'\t' -v t="$table" -v c="$column" '$1 == t && $2 == c { found = 1 } END { exit !found }' "$work_dir/src-columns"; then
      finding "column $table.$column is required in develop, has no default and is not in the source"
    fi
  done < "$work_dir/dst-columns"
  echo "column differences of carried tables (source -> develop):"
  awk -F'\t' 'NR == FNR { keep[$1] = 1; next } keep[$1] { print $1 "." $2 "\t" $3 }' \
    "$work_dir/carried" "$work_dir/src-columns" | sort > "$work_dir/src-carried-columns"
  awk -F'\t' 'NR == FNR { keep[$1] = 1; next } keep[$1] { print $1 "." $2 "\t" $3 }' \
    "$work_dir/carried" "$work_dir/dst-columns" | sort > "$work_dir/dst-carried-columns"
  diff "$work_dir/src-carried-columns" "$work_dir/dst-carried-columns" |
    sed -n -e 's/^< /  source only or other type: /p' -e 's/^> /  develop only or other type: /p' || true

  comm -13 "$work_dir/carried" "$work_dir/src-tables" > "$work_dir/not-carried"
  public_sequences "$src" | sort > "$work_dir/src-sequences"
  public_sequences "$dst" | sort > "$work_dir/dst-sequences"
  comm -23 "$work_dir/src-sequences" "$work_dir/dst-sequences" >> "$work_dir/not-carried"
}

# One transaction: the baseline's own tenant row goes, then every carried table's rows, loaded
# through the partition root with triggers (foreign key checks included) off for the session.
load_carried_tables() {
  section "Load"
  local src="${scratch_name}_src"
  local dst="${scratch_name}_dst"
  local -a excludes=()
  local name
  while IFS= read -r name; do
    [[ -n "$name" ]] && excludes+=("--exclude-table-and-children=public.$name")
  done < "$work_dir/not-carried"

  if ! pg_tool pg_dump --dbname="$src" --data-only --schema=public --load-via-partition-root \
    --no-owner --no-privileges "${excludes[@]}" --file="$work_dir/carry.sql" \
    > "$work_dir/carry-dump.log" 2>&1; then
    print_log_tail "$work_dir/carry-dump.log" 10 >&2
    die "dumping the carried tables of $src failed"
  fi

  cat > "$work_dir/preamble.sql" << 'SQL'
DO $$
BEGIN
  IF (SELECT count(*) FROM tenants) <> 1 OR EXISTS (SELECT 1 FROM databases) THEN
    RAISE EXCEPTION 'the target is not a fresh develop baseline';
  END IF;
END
$$;
DELETE FROM tenant_ai_budgets;
DELETE FROM tenants;
SET session_replication_role = replica;
SQL
  if ! sql "$dst" --single-transaction --file="$work_dir/preamble.sql" --file="$work_dir/carry.sql" \
    > "$work_dir/load.log" 2>&1; then
    print_log_tail "$work_dir/load.log" 10 >&2
    die "loading the carried rows into $dst failed; nothing was loaded"
  fi
  echo "loaded the carried tables into $dst"

  local orphans
  orphans="$(foreign_key_orphans "$dst")"
  if [[ -n "$orphans" ]]; then
    while IFS=$'\t' read -r constraint rows; do
      finding "foreign key $constraint: $rows row(s) name a missing parent"
    done <<< "$orphans"
  else
    echo "foreign keys: every carried row names an existing parent"
  fi
}

seed_and_verify() {
  section "Develop seed and tenancy verification"
  local dst="${scratch_name}_dst"
  if run_cli "$dst" db/runSeedCli.js "$work_dir/dst-seed.log"; then
    grep '^seed:' "$work_dir/dst-seed.log" | sed 's/^/  /' || true
  else
    print_log_tail "$work_dir/dst-seed.log" 5
    finding "the develop seed failed on the carried database"
  fi
  if run_cli "$dst" db/verifyTenancyCli.js "$work_dir/dst-verify.log"; then
    grep -e '^tenancy' "$work_dir/dst-verify.log" | sed 's/^/  /' || true
  else
    print_log_tail "$work_dir/dst-verify.log" 10
    finding "tenancy verification failed on the carried database"
  fi
}

report_counts() {
  section "Items per database (live/trashed)"
  local src="${scratch_name}_src"
  local dst="${scratch_name}_dst"
  database_counts "$src" > "$work_dir/src-database-counts"
  database_counts "$dst" > "$work_dir/dst-database-counts"
  printf '%-28s %-36s %15s %15s  %s\n' "database" "id" "before" "after" "status"
  local mismatched
  mismatched="$(awk -F'\t' '
    NR == FNR { after[$1] = $4 "/" $5; next }
    {
      before = $4 "/" $5
      now = ($1 in after) ? after[$1] : "missing"
      status = (now == before) ? "ok" : "MISMATCH"
      printf "%-28s %-36s %15s %15s  %s\n", substr($3, 1, 28), $1, before, now, status
      if (status != "ok") bad++
      seen[$1] = 1
    }
    END {
      for (id in after) if (!(id in seen)) { printf "%-28s %-36s %15s %15s  %s\n", "(new in develop)", id, "-", after[id], "MISMATCH"; bad++ }
      print bad + 0 > "/dev/stderr"
    }' "$work_dir/dst-database-counts" "$work_dir/src-database-counts" 2> "$work_dir/database-mismatches")"
  echo "$mismatched"
  local bad
  bad="$(cat "$work_dir/database-mismatches")"
  ((bad == 0)) || finding "$bad database(s) have different item counts after the carry"

  section "Rows per carried table (before -> after)"
  table_counts "$dst" | sort > "$work_dir/dst-table-counts"
  local table before after differing=0
  while IFS= read -r table; do
    before="$(awk -F'\t' -v t="$table" '$1 == t { print $2 }' "$work_dir/src-table-counts")"
    after="$(awk -F'\t' -v t="$table" '$1 == t { print $2 }' "$work_dir/dst-table-counts")"
    if [[ "$before" != "$after" ]]; then
      printf '  %-36s %s -> %s\n' "$table" "$before" "$after"
      differing=$((differing + 1))
    fi
  done < "$work_dir/carried"
  if ((differing == 0)); then
    echo "  every carried table has the same row count"
  else
    finding "$differing carried table(s) have a different row count"
  fi
}

# What the develop seed would have created that the carried system databases lack: the seed runs
# once per tenant and skips an already seeded one, so nothing adds these later.
report_seed_delta() {
  section "Seed delta (develop seed vs. carried system databases)"
  local ref="${scratch_name}_ref"
  local dst="${scratch_name}_dst"
  system_databases "$ref" > "$work_dir/ref-system-databases"
  system_databases "$dst" > "$work_dir/dst-system-databases"
  system_properties "$ref" | sort -u > "$work_dir/ref-system-properties"
  system_properties "$dst" | sort -u > "$work_dir/dst-system-properties"
  local missing_databases missing_properties extra_properties
  missing_databases="$(comm -23 "$work_dir/ref-system-databases" "$work_dir/dst-system-databases")"
  missing_properties="$(comm -23 "$work_dir/ref-system-properties" "$work_dir/dst-system-properties")"
  extra_properties="$(comm -13 "$work_dir/ref-system-properties" "$work_dir/dst-system-properties")"
  if [[ -n "$missing_databases" ]]; then
    echo "system databases the develop seed creates and the carried data lacks:"
    sed 's/^/  /' <<< "$missing_databases"
  fi
  if [[ -n "$missing_properties" ]]; then
    echo "system properties (database, key, type) the develop seed defines and the carried data lacks:"
    sed 's/^/  /' <<< "$missing_properties" | tr '\t' ' '
  fi
  if [[ -n "$extra_properties" ]]; then
    echo "system properties of the carried data the develop seed no longer defines (or defines with another type):"
    sed 's/^/  /' <<< "$extra_properties" | tr '\t' ' '
  fi
  if [[ -z "$missing_databases$missing_properties$extra_properties" ]]; then
    echo "none: the carried system databases match the develop seed"
  else
    gaps=1
  fi
}

emit_carried_dump() {
  [[ -n "$emit_dump" ]] || return 0
  section "Emit"
  if ((failures > 0)); then
    echo "not emitting $emit_dump: the run failed"
    return 0
  fi
  if ((gaps > 0 && allow_seed_delta == 0)); then
    echo "not emitting $emit_dump: the seed delta is not empty (pass --allow-seed-delta once the owner accepts it)"
    return 0
  fi
  local partial
  partial="$(mktemp "$(dirname -- "$emit_dump")/.cutover-dump.XXXXXX")"
  if pg_tool pg_dump --dbname="${scratch_name}_dst" --format=custom --file="$partial"; then
    mv -- "$partial" "$emit_dump"
    echo "wrote $emit_dump (objects owned by $PGUSER)"
  else
    rm -f -- "$partial"
    finding "pg_dump of ${scratch_name}_dst failed"
  fi
}

main() {
  parse_args "$@"
  require_tools
  load_admin_connection
  assert_scratch_cluster
  assert_matching_tools

  work_dir="$(mktemp -d "${TMPDIR:-/tmp}/cutover-dry-run.XXXXXX")"
  chmod 0700 "$work_dir"
  trap cleanup EXIT
  cleanup_armed=1

  section "Scratch cluster"
  echo "server: $(sql postgres --command="SELECT version()")"
  echo "jit: $(sql postgres --command="SHOW jit")   client tools: $(pg_tool pg_dump --version)"
  echo "superuser: $PGUSER   databases: $(scratch_databases | tr '\n' ' ')"
  drop_scratch_databases
  ensure_cluster_roles

  restore_source
  section "Items per database in the source (id, tenant, database, live, trashed)"
  database_counts "${scratch_name}_src" | sed 's/^/  /'
  build_reference
  probe_in_place
  plan_carry
  load_carried_tables
  seed_and_verify
  report_counts
  report_seed_delta
  emit_carried_dump

  section "Result"
  if ((failures > 0)); then
    echo "FAIL: $failures finding(s) above"
    exit 1
  fi
  if ((gaps > 0)); then
    echo "GAP: carried and verified, but the seed delta above is not empty"
    exit 3
  fi
  echo "PASS"
}

main "$@"
