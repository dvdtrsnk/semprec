-- The schema of a fresh Alldots database, in its final shape.
--
-- This file replaced the 177 development-era migrations (0001_core_schema.sql through
-- 0177_side_role_cannot_mint_actors.sql) before the first production release: no database with data
-- existed, so their history carried nothing worth keeping. It was generated from a pg_dump of a database
-- those migrations built, regrouped by object, and proven equal to it by schema and seed-data comparison.
-- Every later change is a new numbered migration on top of this one (docs/operations/migrations.md).
--
-- Ownership: every object belongs to the migrating role, except the cross-tenant router functions, which
-- belong to alldots_router (docs/adr/2026-10-07-cross-tenant-router-functions.md). Tenancy annotations
-- (`alldots:tenancy=...`) are table comments that db/tenancyInvariants.ts reads.

-- SQL function bodies below reference tables created later in this file.
SET LOCAL check_function_bodies = false;

-- ====================================================================================================
-- Roles
--
-- The runtime roles are created without a password; a deployment sets one with ALTER ROLE ... WITH PASSWORD.
-- See docs/operations/database-roles.md.
-- ====================================================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'alldots_data') THEN
    CREATE ROLE alldots_data LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'alldots_side') THEN
    CREATE ROLE alldots_side LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'alldots_router') THEN
    CREATE ROLE alldots_router NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;
  END IF;
END
$$;
ALTER ROLE alldots_router NOLOGIN NOSUPERUSER BYPASSRLS;

-- alldots_data (the choke point's role) inherits every side-table grant of alldots_side.
GRANT alldots_side TO alldots_data;

GRANT USAGE ON SCHEMA public TO alldots_data;
GRANT USAGE ON SCHEMA public TO alldots_side;
GRANT USAGE ON SCHEMA public TO alldots_router;

-- ====================================================================================================
-- Extensions
-- ====================================================================================================

CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public;

-- ====================================================================================================
-- Functions
-- ====================================================================================================

CREATE FUNCTION public.activate_czech_hunspell_search() RETURNS boolean
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- Serializes concurrent deploys; the checks below then see each other's committed work.
  PERFORM pg_advisory_xact_lock(hashtext('activate_czech_hunspell_search'));

  IF (
    SELECT count(*)
    FROM pg_ts_config_map m
    JOIN pg_ts_dict d ON d.oid = m.mapdict
    WHERE m.mapcfg = 'czech'::regconfig
      AND m.mapseqno = 1
      AND d.dictname = 'czech_hunspell'
      AND d.dictnamespace = current_schema()::regnamespace
  ) = 6 THEN
    RETURN true;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_ts_dict
    WHERE dictname = 'czech_hunspell' AND dictnamespace = current_schema()::regnamespace
  ) THEN
    BEGIN
      CREATE TEXT SEARCH DICTIONARY czech_hunspell (TEMPLATE = ispell, DictFile = cs_cz, AffFile = cs_cz);
    EXCEPTION WHEN config_file_error THEN
      RAISE WARNING 'Czech Hunspell assets unavailable, keeping unaccent/simple full-text search: %', SQLERRM;
      RETURN false;
    END;
  END IF;

  ALTER TEXT SEARCH CONFIGURATION czech
    ALTER MAPPING FOR asciiword, asciihword, hword_asciipart, word, hword, hword_part
    WITH czech_hunspell, unaccent, simple;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.activate_czech_hunspell_search() FROM PUBLIC;

CREATE FUNCTION public.ai_global_spend() RETURNS TABLE(spent_today numeric, spent_month numeric)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
  SELECT
    COALESCE(SUM(c.cost_usd) FILTER (WHERE c.at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'), 0),
    COALESCE(SUM(c.cost_usd), 0)
  FROM public.ai_gateway_calls c
  WHERE c.at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
$$;

ALTER FUNCTION public.ai_global_spend() OWNER TO alldots_router;

REVOKE ALL ON FUNCTION public.ai_global_spend() FROM PUBLIC;
GRANT ALL ON FUNCTION public.ai_global_spend() TO alldots_side;

CREATE FUNCTION public.ai_tenant_spend() RETURNS TABLE(tenant_id uuid, spent_today_usd numeric, spent_month_usd numeric)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
  SELECT c.tenant_id,
         COALESCE(SUM(c.cost_usd) FILTER (WHERE c.at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'), 0),
         COALESCE(SUM(c.cost_usd), 0)
  FROM public.ai_gateway_calls c
  WHERE c.at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
  GROUP BY c.tenant_id
$$;

ALTER FUNCTION public.ai_tenant_spend() OWNER TO alldots_router;

REVOKE ALL ON FUNCTION public.ai_tenant_spend() FROM PUBLIC;
GRANT ALL ON FUNCTION public.ai_tenant_spend() TO alldots_data;

CREATE FUNCTION public.app_current_tenant() RETURNS uuid
    LANGUAGE sql STABLE
    AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE FUNCTION public.app_sole_tenant() RETURNS uuid
    LANGUAGE sql STABLE
    AS $$ SELECT t.id FROM public.tenants t WHERE (SELECT count(*) FROM public.tenants) = 1 $$;

CREATE FUNCTION public.app_tenant_default() RETURNS uuid
    LANGUAGE sql STABLE
    AS $$ SELECT public.app_current_tenant() $$;

COMMENT ON FUNCTION public.app_tenant_default() IS 'Strict: the tenant of the current scope (app.tenant_id), or NULL outside one. It no longer falls back to the sole tenant.';

CREATE FUNCTION public.enforce_relation_cardinality() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_cardinality text;
  v_conflict boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.relation_definition_id::text, 0));

  SELECT cardinality INTO v_cardinality FROM relation_definitions WHERE id = NEW.relation_definition_id;
  IF v_cardinality IS NULL THEN
    RAISE EXCEPTION 'relation_definitions % not found', NEW.relation_definition_id;
  END IF;

  IF v_cardinality = 'one_to_one' THEN
    SELECT EXISTS (
      SELECT 1 FROM item_relations
      WHERE relation_definition_id = NEW.relation_definition_id
        AND (item_a = NEW.item_a OR item_b = NEW.item_b)
        AND NOT (item_a = NEW.item_a AND item_b = NEW.item_b)
    ) INTO v_conflict;
    IF v_conflict THEN
      RAISE EXCEPTION USING
        ERRCODE = 'SC001',
        MESSAGE = format('cardinality_violation: relation %s is one_to_one and item_a %s or item_b %s already has a different edge', NEW.relation_definition_id, NEW.item_a, NEW.item_b);
    END IF;
  ELSIF v_cardinality = 'one_to_many' THEN
    SELECT EXISTS (
      SELECT 1 FROM item_relations
      WHERE relation_definition_id = NEW.relation_definition_id
        AND item_b = NEW.item_b
        AND NOT (item_a = NEW.item_a AND item_b = NEW.item_b)
    ) INTO v_conflict;
    IF v_conflict THEN
      RAISE EXCEPTION USING
        ERRCODE = 'SC001',
        MESSAGE = format('cardinality_violation: relation %s is one_to_many and item_b %s already has a different item_a', NEW.relation_definition_id, NEW.item_b);
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE FUNCTION public.ops_health_counts() RETURNS TABLE(agent_run_errors_7d bigint, item_automation_errors bigint, alerting_tenant_checks bigint)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
  SELECT
    (SELECT count(*) FROM public.agent_runs WHERE status = 'error' AND started_at >= now() - interval '7 days'),
    (SELECT count(*) FROM public.item_automation WHERE status = 'error'),
    (SELECT count(*) FROM public.tenant_observability_checks WHERE status = 'alerting')
$$;

ALTER FUNCTION public.ops_health_counts() OWNER TO alldots_router;

REVOKE ALL ON FUNCTION public.ops_health_counts() FROM PUBLIC;
GRANT ALL ON FUNCTION public.ops_health_counts() TO alldots_data;

CREATE FUNCTION public.route_gmail_address(email_address text) RETURNS TABLE(tenant_id uuid, mailbox_item_id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
  SELECT s.tenant_id, s.item_id FROM public.mail_account_sync_state s
  WHERE s.sync_mode = 'gmail_api' AND s.gmail_watch_email_address = email_address
$$;

ALTER FUNCTION public.route_gmail_address(email_address text) OWNER TO alldots_router;

REVOKE ALL ON FUNCTION public.route_gmail_address(email_address text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.route_gmail_address(email_address text) TO alldots_data;

CREATE FUNCTION public.route_google_calendar_channel(channel_id text) RETURNS TABLE(tenant_id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
  SELECT c.tenant_id FROM public.calendar_push_channels c
  WHERE c.provider = 'google' AND c.channel_id = route_google_calendar_channel.channel_id
$$;

ALTER FUNCTION public.route_google_calendar_channel(channel_id text) OWNER TO alldots_router;

REVOKE ALL ON FUNCTION public.route_google_calendar_channel(channel_id text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.route_google_calendar_channel(channel_id text) TO alldots_data;

CREATE FUNCTION public.route_graph_calendar_subscription(subscription_id text) RETURNS TABLE(tenant_id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
  SELECT c.tenant_id FROM public.calendar_push_channels c
  WHERE c.provider = 'graph' AND c.channel_id = route_graph_calendar_subscription.subscription_id
$$;

ALTER FUNCTION public.route_graph_calendar_subscription(subscription_id text) OWNER TO alldots_router;

REVOKE ALL ON FUNCTION public.route_graph_calendar_subscription(subscription_id text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.route_graph_calendar_subscription(subscription_id text) TO alldots_data;

CREATE FUNCTION public.route_graph_subscription(subscription_id text) RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
  SELECT s.tenant_id FROM public.mail_account_sync_state s WHERE s.graph_subscription_id = subscription_id
$$;

ALTER FUNCTION public.route_graph_subscription(subscription_id text) OWNER TO alldots_router;

REVOKE ALL ON FUNCTION public.route_graph_subscription(subscription_id text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.route_graph_subscription(subscription_id text) TO alldots_data;

CREATE FUNCTION public.route_mail_oauth_state(state_hash text) RETURNS TABLE(tenant_id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
  SELECT s.tenant_id FROM public.mail_oauth_states s
  WHERE s.state_hash = route_mail_oauth_state.state_hash AND s.used_at IS NULL AND s.expires_at > now()
$$;

ALTER FUNCTION public.route_mail_oauth_state(state_hash text) OWNER TO alldots_router;

REVOKE ALL ON FUNCTION public.route_mail_oauth_state(state_hash text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.route_mail_oauth_state(state_hash text) TO alldots_data;

CREATE FUNCTION public.task_recurrence_due_for_rollover(mode text, rule jsonb, occurrence date, anchor date, today date) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO 'pg_catalog'
    AS $$
DECLARE
  kind text;
  unit text;
  n numeric;
  weekday integer;
  candidate date;
  next_day date;
  lower_day date;
  upper_day date;
  k numeric;
  matched boolean;
  latest_found boolean := false;
  entry jsonb;
  v numeric;
  month_num integer;
  day_num integer;
  month_last date;
BEGIN
  IF mode IS NULL OR rule IS NULL OR occurrence IS NULL OR anchor IS NULL OR today IS NULL THEN
    RETURN false;
  END IF;
  IF jsonb_typeof(rule) <> 'object' OR mode NOT IN ('fixed', 'floating') THEN
    RAISE EXCEPTION 'Invalid recurrence rule';
  END IF;
  IF mode = 'floating' THEN
    unit := rule->>'unit';
    IF unit IS NULL OR unit NOT IN ('days', 'weeks', 'months') OR jsonb_typeof(rule->'n') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'Invalid floating recurrence';
    END IF;
    n := (rule->>'n')::numeric;
    IF n <> trunc(n) OR n <= 0 OR n > 2147483647 THEN RAISE EXCEPTION 'Invalid floating recurrence interval'; END IF;
    IF unit = 'days' OR unit = 'weeks' THEN
      IF unit = 'weeks' THEN n := n * 7; END IF;
      k := greatest(1, floor((occurrence - anchor)::numeric / n) + 1);
      IF k*n > 2147483647 THEN RAISE EXCEPTION 'Floating recurrence date out of range'; END IF;
      next_day := anchor + (k*n)::integer;
    ELSE
      k := greatest(1, floor(((extract(year from occurrence)-extract(year from anchor))*12 +
        extract(month from occurrence)-extract(month from anchor)) / n));
      IF k*n > 2147483647 THEN RAISE EXCEPTION 'Floating recurrence date out of range'; END IF;
      next_day := (anchor + make_interval(months => (k*n)::integer))::date;
      IF next_day <= occurrence THEN
        k := k + 1;
        IF k*n > 2147483647 THEN RAISE EXCEPTION 'Floating recurrence date out of range'; END IF;
        next_day := (anchor + make_interval(months => (k*n)::integer))::date;
      END IF;
    END IF;
    RETURN (next_day <= today OR next_day >= DATE '10000-01-01') AND anchor <= today;
  END IF;

  kind := rule->>'kind';
  IF kind IS NULL OR kind NOT IN ('weekdays','monthDates','nthWeekday','yearDates') THEN
    RAISE EXCEPTION 'Invalid fixed recurrence';
  END IF;
  IF kind = 'weekdays' THEN
    IF jsonb_typeof(rule->'days') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid weekdays'; END IF;
    IF jsonb_array_length(rule->'days') = 0 THEN RAISE EXCEPTION 'Invalid weekdays'; END IF;
    FOR entry IN SELECT value FROM jsonb_array_elements(rule->'days') LOOP
      IF jsonb_typeof(entry) <> 'string' OR (entry #>> '{}') NOT IN ('mon','tue','wed','thu','fri','sat','sun') THEN
        RAISE EXCEPTION 'Invalid weekday';
      END IF;
    END LOOP;
    upper_day := occurrence + 7;
  ELSIF kind = 'monthDates' THEN
    IF jsonb_typeof(rule->'dates') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid month dates'; END IF;
    IF jsonb_array_length(rule->'dates') = 0 THEN RAISE EXCEPTION 'Invalid month dates'; END IF;
    FOR entry IN SELECT value FROM jsonb_array_elements(rule->'dates') LOOP
      IF jsonb_typeof(entry) <> 'number' THEN RAISE EXCEPTION 'Invalid month date'; END IF;
      v := (entry #>> '{}')::numeric;
      IF v <> trunc(v) OR v < 1 OR v > 31 THEN RAISE EXCEPTION 'Invalid month date'; END IF;
    END LOOP;
    upper_day := occurrence + 366;
  ELSIF kind = 'nthWeekday' THEN
    IF jsonb_typeof(rule->'n') IS DISTINCT FROM 'number' OR jsonb_typeof(rule->'weekday') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'Invalid nth weekday';
    END IF;
    n := (rule->>'n')::numeric;
    IF n <> trunc(n) OR n = 0 THEN RAISE EXCEPTION 'Invalid nth weekday'; END IF;
    weekday := array_position(ARRAY['mon','tue','wed','thu','fri','sat','sun'], rule->>'weekday');
    IF weekday IS NULL THEN RAISE EXCEPTION 'Invalid weekday'; END IF;
    upper_day := (date_trunc('month', occurrence::timestamp) + interval '13 months - 1 day')::date;
  ELSE
    IF jsonb_typeof(rule->'month') IS DISTINCT FROM 'number' OR jsonb_typeof(rule->'day') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'Invalid year date';
    END IF;
    v := (rule->>'month')::numeric;
    IF v <> trunc(v) OR v < 1 OR v > 12 THEN RAISE EXCEPTION 'Invalid year month'; END IF;
    month_num := v::integer;
    v := (rule->>'day')::numeric;
    IF v <> trunc(v) OR v < 1 OR v > (ARRAY[31,29,31,30,31,30,31,31,30,31,30,31])[month_num] THEN
      RAISE EXCEPTION 'Invalid year day';
    END IF;
    day_num := v::integer;
    upper_day := make_date(extract(year from occurrence)::integer + 8, 12, 31);
  END IF;

  -- Match a bounded calendar day range twice: first for the next date, then for the latest-date existence guard.
  lower_day := occurrence + 1;
  FOR pass IN 1..2 LOOP
    IF pass = 2 THEN
      IF today < anchor THEN RETURN false; END IF;
      lower_day := greatest(anchor, today - 8*366);
      upper_day := today;
    END IF;
    FOR candidate IN SELECT g::date FROM generate_series(lower_day::timestamp, upper_day::timestamp, interval '1 day') AS g LOOP
      matched := false;
      IF kind = 'weekdays' THEN
        matched := (rule->'days') ? (ARRAY['mon','tue','wed','thu','fri','sat','sun'])[extract(isodow from candidate)::integer];
      ELSIF kind = 'monthDates' THEN
        matched := (rule->'dates') @> jsonb_build_array(extract(day from candidate)::integer);
      ELSIF kind = 'nthWeekday' AND extract(isodow from candidate)::integer = weekday THEN
        month_last := (date_trunc('month', candidate::timestamp) + interval '1 month - 1 day')::date;
        matched := CASE WHEN n > 0 THEN ((extract(day from candidate)::integer - 1) / 7 + 1)::numeric = n
          ELSE -((extract(day from month_last)::integer - extract(day from candidate)::integer) / 7 + 1)::numeric = n END;
      ELSIF kind = 'yearDates' THEN
        matched := extract(month from candidate)::integer = month_num AND extract(day from candidate)::integer = day_num;
      END IF;
      IF matched THEN
        IF pass = 1 THEN next_day := candidate; ELSE latest_found := true; END IF;
        EXIT;
      END IF;
    END LOOP;
    IF pass = 1 AND next_day IS NULL THEN RAISE EXCEPTION 'Fixed recurrence matched no date within horizon'; END IF;
  END LOOP;
  RETURN (next_day <= today OR next_day >= DATE '10000-01-01') AND latest_found;
END;
$$;

REVOKE ALL ON FUNCTION public.task_recurrence_due_for_rollover(mode text, rule jsonb, occurrence date, anchor date, today date) FROM PUBLIC;
GRANT ALL ON FUNCTION public.task_recurrence_due_for_rollover(mode text, rule jsonb, occurrence date, anchor date, today date) TO alldots_data;

-- ====================================================================================================
-- Text search
-- ====================================================================================================

CREATE TEXT SEARCH CONFIGURATION public.czech (
    PARSER = pg_catalog."default" );

ALTER TEXT SEARCH CONFIGURATION public.czech
    ADD MAPPING FOR asciiword WITH public.unaccent, simple;

ALTER TEXT SEARCH CONFIGURATION public.czech
    ADD MAPPING FOR word WITH public.unaccent, simple;

ALTER TEXT SEARCH CONFIGURATION public.czech
    ADD MAPPING FOR numword WITH simple;

ALTER TEXT SEARCH CONFIGURATION public.czech
    ADD MAPPING FOR email WITH simple;

ALTER TEXT SEARCH CONFIGURATION public.czech
    ADD MAPPING FOR url WITH simple;

ALTER TEXT SEARCH CONFIGURATION public.czech
    ADD MAPPING FOR host WITH simple;

ALTER TEXT SEARCH CONFIGURATION public.czech
    ADD MAPPING FOR sfloat WITH simple;

ALTER TEXT SEARCH CONFIGURATION public.czech
    ADD MAPPING FOR version WITH simple;

ALTER TEXT SEARCH CONFIGURATION public.czech
    ADD MAPPING FOR hword_numpart WITH simple;

ALTER TEXT SEARCH CONFIGURATION public.czech
    ADD MAPPING FOR hword_part WITH public.unaccent, simple;

ALTER TEXT SEARCH CONFIGURATION public.czech
    ADD MAPPING FOR hword_asciipart WITH public.unaccent, simple;

ALTER TEXT SEARCH CONFIGURATION public.czech
    ADD MAPPING FOR numhword WITH simple;

ALTER TEXT SEARCH CONFIGURATION public.czech
    ADD MAPPING FOR asciihword WITH public.unaccent, simple;

ALTER TEXT SEARCH CONFIGURATION public.czech
    ADD MAPPING FOR hword WITH public.unaccent, simple;

ALTER TEXT SEARCH CONFIGURATION public.czech
    ADD MAPPING FOR url_path WITH simple;

ALTER TEXT SEARCH CONFIGURATION public.czech
    ADD MAPPING FOR file WITH simple;

ALTER TEXT SEARCH CONFIGURATION public.czech
    ADD MAPPING FOR "float" WITH simple;

ALTER TEXT SEARCH CONFIGURATION public.czech
    ADD MAPPING FOR "int" WITH simple;

ALTER TEXT SEARCH CONFIGURATION public.czech
    ADD MAPPING FOR uint WITH simple;

CREATE TEXT SEARCH CONFIGURATION public.czech_simple (
    PARSER = pg_catalog."default" );

ALTER TEXT SEARCH CONFIGURATION public.czech_simple
    ADD MAPPING FOR asciiword WITH public.unaccent, simple;

ALTER TEXT SEARCH CONFIGURATION public.czech_simple
    ADD MAPPING FOR word WITH public.unaccent, simple;

ALTER TEXT SEARCH CONFIGURATION public.czech_simple
    ADD MAPPING FOR numword WITH simple;

ALTER TEXT SEARCH CONFIGURATION public.czech_simple
    ADD MAPPING FOR email WITH simple;

ALTER TEXT SEARCH CONFIGURATION public.czech_simple
    ADD MAPPING FOR url WITH simple;

ALTER TEXT SEARCH CONFIGURATION public.czech_simple
    ADD MAPPING FOR host WITH simple;

ALTER TEXT SEARCH CONFIGURATION public.czech_simple
    ADD MAPPING FOR sfloat WITH simple;

ALTER TEXT SEARCH CONFIGURATION public.czech_simple
    ADD MAPPING FOR version WITH simple;

ALTER TEXT SEARCH CONFIGURATION public.czech_simple
    ADD MAPPING FOR hword_numpart WITH simple;

ALTER TEXT SEARCH CONFIGURATION public.czech_simple
    ADD MAPPING FOR hword_part WITH public.unaccent, simple;

ALTER TEXT SEARCH CONFIGURATION public.czech_simple
    ADD MAPPING FOR hword_asciipart WITH public.unaccent, simple;

ALTER TEXT SEARCH CONFIGURATION public.czech_simple
    ADD MAPPING FOR numhword WITH simple;

ALTER TEXT SEARCH CONFIGURATION public.czech_simple
    ADD MAPPING FOR asciihword WITH public.unaccent, simple;

ALTER TEXT SEARCH CONFIGURATION public.czech_simple
    ADD MAPPING FOR hword WITH public.unaccent, simple;

ALTER TEXT SEARCH CONFIGURATION public.czech_simple
    ADD MAPPING FOR url_path WITH simple;

ALTER TEXT SEARCH CONFIGURATION public.czech_simple
    ADD MAPPING FOR file WITH simple;

ALTER TEXT SEARCH CONFIGURATION public.czech_simple
    ADD MAPPING FOR "float" WITH simple;

ALTER TEXT SEARCH CONFIGURATION public.czech_simple
    ADD MAPPING FOR "int" WITH simple;

ALTER TEXT SEARCH CONFIGURATION public.czech_simple
    ADD MAPPING FOR uint WITH simple;

-- ====================================================================================================
-- Tables
--
-- Each table with its comments, sequences, defaults, keys, checks, indexes, triggers and grants.
-- Foreign keys and row-level security follow in their own sections.
-- ====================================================================================================

-- ----------------------------------------------------------------------------------------------------
-- admin_audit_log
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.admin_audit_log (
    id bigint NOT NULL,
    actor_user_id uuid NOT NULL,
    action text NOT NULL,
    target_tenant_id uuid,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

COMMENT ON TABLE public.admin_audit_log IS 'alldots:tenancy=global';

CREATE SEQUENCE public.admin_audit_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.admin_audit_log_id_seq OWNED BY public.admin_audit_log.id;

ALTER TABLE ONLY public.admin_audit_log ALTER COLUMN id SET DEFAULT nextval('public.admin_audit_log_id_seq'::regclass);

ALTER TABLE ONLY public.admin_audit_log
    ADD CONSTRAINT admin_audit_log_pkey PRIMARY KEY (id);

CREATE INDEX admin_audit_log_created_at_idx ON public.admin_audit_log USING btree (created_at);

GRANT SELECT,INSERT ON TABLE public.admin_audit_log TO alldots_data;

GRANT SELECT,USAGE ON SEQUENCE public.admin_audit_log_id_seq TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- agent_database_grants
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.agent_database_grants (
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL,
    project_item_id uuid NOT NULL,
    database_id uuid NOT NULL,
    access text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agent_database_grants_access_check CHECK ((access = ANY (ARRAY['none'::text, 'read'::text, 'write'::text])))
);

COMMENT ON TABLE public.agent_database_grants IS 'alldots:tenancy=tenant';

ALTER TABLE ONLY public.agent_database_grants
    ADD CONSTRAINT agent_database_grants_pkey PRIMARY KEY (tenant_id, project_item_id, database_id);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.agent_database_grants TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- agent_guidance_drift_findings
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.agent_guidance_drift_findings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_item_id uuid NOT NULL,
    fingerprint text NOT NULL,
    payload jsonb NOT NULL,
    status text NOT NULL,
    first_seen_at timestamp with time zone NOT NULL,
    last_seen_at timestamp with time zone NOT NULL,
    resolved_at timestamp with time zone,
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL,
    resolved_by uuid,
    resolution_choice text,
    CONSTRAINT agent_guidance_drift_findings_resolution_choice_check CHECK ((resolution_choice = ANY (ARRAY['allow'::text, 'forbid'::text, 'dismiss'::text]))),
    CONSTRAINT agent_guidance_drift_findings_status_check CHECK ((status = ANY (ARRAY['active'::text, 'resolved'::text, 'dismissed'::text])))
);

COMMENT ON TABLE public.agent_guidance_drift_findings IS 'alldots:tenancy=tenant';

ALTER TABLE ONLY public.agent_guidance_drift_findings
    ADD CONSTRAINT agent_guidance_drift_findings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.agent_guidance_drift_findings
    ADD CONSTRAINT agent_guidance_drift_findings_project_item_id_fingerprint_key UNIQUE (project_item_id, fingerprint);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.agent_guidance_drift_findings TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- agent_run_events
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.agent_run_events (
    id bigint NOT NULL,
    agent_run_id uuid NOT NULL,
    kind text NOT NULL,
    payload jsonb NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL,
    CONSTRAINT agent_run_events_kind_check CHECK ((kind = ANY (ARRAY['turn_start'::text, 'message'::text, 'tool_use'::text, 'tool_result'::text, 'turn_end'::text, 'run_status'::text, 'compaction'::text, 'user_message'::text])))
);

COMMENT ON TABLE public.agent_run_events IS 'alldots:tenancy=tenant';

CREATE SEQUENCE public.agent_run_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.agent_run_events_id_seq OWNED BY public.agent_run_events.id;

ALTER TABLE ONLY public.agent_run_events ALTER COLUMN id SET DEFAULT nextval('public.agent_run_events_id_seq'::regclass);

ALTER TABLE ONLY public.agent_run_events
    ADD CONSTRAINT agent_run_events_pkey PRIMARY KEY (id);

CREATE INDEX agent_run_events_run_idx ON public.agent_run_events USING btree (agent_run_id, id);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.agent_run_events TO alldots_side;

GRANT SELECT,USAGE ON SEQUENCE public.agent_run_events_id_seq TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- agent_run_mcp_credentials
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.agent_run_mcp_credentials (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    agent_run_id uuid NOT NULL,
    token_hash text NOT NULL,
    capabilities text[] NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL
);

COMMENT ON TABLE public.agent_run_mcp_credentials IS 'alldots:tenancy=global';

ALTER TABLE ONLY public.agent_run_mcp_credentials
    ADD CONSTRAINT agent_run_mcp_credentials_pkey PRIMARY KEY (id);

CREATE UNIQUE INDEX agent_run_mcp_credentials_agent_run_id_key ON public.agent_run_mcp_credentials USING btree (agent_run_id);

CREATE UNIQUE INDEX agent_run_mcp_credentials_token_hash_key ON public.agent_run_mcp_credentials USING btree (token_hash);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.agent_run_mcp_credentials TO alldots_data;

-- ----------------------------------------------------------------------------------------------------
-- agent_run_read_allowances
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.agent_run_read_allowances (
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL,
    agent_run_id uuid NOT NULL,
    item_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

COMMENT ON TABLE public.agent_run_read_allowances IS 'alldots:tenancy=tenant';

ALTER TABLE ONLY public.agent_run_read_allowances
    ADD CONSTRAINT agent_run_read_allowances_pkey PRIMARY KEY (tenant_id, agent_run_id, item_id);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.agent_run_read_allowances TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- agent_runs
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.agent_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_item_id uuid,
    parent_run_id uuid,
    heartbeat_id uuid,
    triggered_by text NOT NULL,
    unit text DEFAULT 'invocation'::text NOT NULL,
    task text NOT NULL,
    status text DEFAULT 'running'::text NOT NULL,
    result text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    wake_seq bigint NOT NULL,
    actor_user_id uuid NOT NULL,
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL,
    thread_id uuid,
    error_code text,
    error_detail jsonb,
    retry_of_run_id uuid,
    attempt integer DEFAULT 1 NOT NULL,
    heartbeat_occurrence_id uuid,
    mcp_client_name text,
    CONSTRAINT agent_runs_attempt_check CHECK ((attempt >= 1)),
    CONSTRAINT agent_runs_error_code_check CHECK ((error_code = ANY (ARRAY['budgetExceeded'::text, 'modelError'::text, 'cancelled'::text, 'interrupted'::text, 'internal'::text]))),
    CONSTRAINT agent_runs_mcp_client_name_check CHECK (((mcp_client_name IS NULL) OR (char_length(mcp_client_name) <= 64))),
    CONSTRAINT agent_runs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'done'::text, 'error'::text]))),
    CONSTRAINT agent_runs_triggered_by_check CHECK ((triggered_by = ANY (ARRAY['user'::text, 'heartbeat'::text, 'supervisor'::text, 'mcp'::text]))),
    CONSTRAINT agent_runs_unit_check CHECK ((unit = ANY (ARRAY['invocation'::text, 'session'::text])))
);

COMMENT ON TABLE public.agent_runs IS 'alldots:tenancy=tenant';

CREATE SEQUENCE public.agent_runs_wake_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.agent_runs_wake_seq_seq OWNED BY public.agent_runs.wake_seq;

ALTER TABLE ONLY public.agent_runs ALTER COLUMN wake_seq SET DEFAULT nextval('public.agent_runs_wake_seq_seq'::regclass);

ALTER TABLE ONLY public.agent_runs
    ADD CONSTRAINT agent_runs_pkey PRIMARY KEY (id);

CREATE INDEX agent_runs_heartbeat_id_idx ON public.agent_runs USING btree (heartbeat_id);

CREATE INDEX agent_runs_occurrence_idx ON public.agent_runs USING btree (tenant_id, heartbeat_occurrence_id, attempt);

CREATE INDEX agent_runs_parent_run_id_idx ON public.agent_runs USING btree (parent_run_id);

CREATE INDEX agent_runs_project_item_id_idx ON public.agent_runs USING btree (project_item_id);

CREATE INDEX agent_runs_session_wake_idx ON public.agent_runs USING btree (project_item_id, triggered_by, parent_run_id, wake_seq) WHERE (unit = 'session'::text);

CREATE UNIQUE INDEX agent_runs_tenant_id_id_uq ON public.agent_runs USING btree (tenant_id, id);

CREATE INDEX agent_runs_tenant_project_started_idx ON public.agent_runs USING btree (tenant_id, project_item_id, started_at DESC, id DESC);

CREATE UNIQUE INDEX agent_runs_tenant_retry_of_run_id_uq ON public.agent_runs USING btree (tenant_id, retry_of_run_id);

CREATE INDEX agent_runs_thread_wake_idx ON public.agent_runs USING btree (tenant_id, thread_id, wake_seq);

GRANT SELECT ON TABLE public.agent_runs TO alldots_side;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.agent_runs TO alldots_data;

GRANT SELECT(status) ON TABLE public.agent_runs TO alldots_router;

GRANT SELECT(started_at) ON TABLE public.agent_runs TO alldots_router;

GRANT SELECT,USAGE ON SEQUENCE public.agent_runs_wake_seq_seq TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- ai_gateway_calls
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.ai_gateway_calls (
    id bigint NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL,
    provider text NOT NULL,
    model text NOT NULL,
    input_tokens integer,
    output_tokens integer,
    audio_seconds numeric,
    cost_usd numeric NOT NULL,
    agent_run_id uuid,
    project_item_id uuid,
    operation text,
    status text DEFAULT 'settled'::text NOT NULL,
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL,
    semp_message_id uuid,
    CONSTRAINT ai_gateway_calls_status_check CHECK ((status = ANY (ARRAY['reserved'::text, 'settled'::text, 'failed'::text])))
);

COMMENT ON TABLE public.ai_gateway_calls IS 'alldots:tenancy=tenant';

CREATE SEQUENCE public.ai_gateway_calls_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.ai_gateway_calls_id_seq OWNED BY public.ai_gateway_calls.id;

ALTER TABLE ONLY public.ai_gateway_calls ALTER COLUMN id SET DEFAULT nextval('public.ai_gateway_calls_id_seq'::regclass);

ALTER TABLE ONLY public.ai_gateway_calls
    ADD CONSTRAINT ai_gateway_calls_pkey PRIMARY KEY (id);

CREATE INDEX ai_gateway_calls_agent_run_idx ON public.ai_gateway_calls USING btree (agent_run_id);

CREATE INDEX ai_gateway_calls_at_idx ON public.ai_gateway_calls USING btree (at);

CREATE INDEX ai_gateway_calls_tenant_at_idx ON public.ai_gateway_calls USING btree (tenant_id, at);

CREATE INDEX ai_gateway_calls_tenant_semp_message_idx ON public.ai_gateway_calls USING btree (tenant_id, semp_message_id);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.ai_gateway_calls TO alldots_side;

GRANT SELECT(at) ON TABLE public.ai_gateway_calls TO alldots_router;

GRANT SELECT(cost_usd) ON TABLE public.ai_gateway_calls TO alldots_router;

GRANT SELECT(tenant_id) ON TABLE public.ai_gateway_calls TO alldots_router;

GRANT SELECT,USAGE ON SEQUENCE public.ai_gateway_calls_id_seq TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- approval_requests
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.approval_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    agent_run_id uuid NOT NULL,
    tool_name text NOT NULL,
    risk_class text NOT NULL,
    payload jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    decided_at timestamp with time zone,
    decided_by uuid,
    executed_at timestamp with time zone,
    execution_error boolean,
    execution_result text,
    resource_snapshot jsonb NOT NULL,
    execution_status text DEFAULT 'not_approved'::text NOT NULL,
    execution_result_jsonb jsonb,
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL,
    reason text,
    tool_call_id text,
    description jsonb,
    CONSTRAINT approval_requests_execution_status_check CHECK ((execution_status = ANY (ARRAY['not_approved'::text, 'queued'::text, 'succeeded'::text, 'conflict'::text]))),
    CONSTRAINT approval_requests_reason_length_check CHECK (((reason IS NULL) OR (char_length(reason) <= 500))),
    CONSTRAINT approval_requests_risk_class_check CHECK ((risk_class = ANY (ARRAY['unclassified'::text, 'read'::text, 'write'::text, 'destructive'::text, 'outbound'::text, 'breaksLink'::text]))),
    CONSTRAINT approval_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text])))
);

COMMENT ON TABLE public.approval_requests IS 'alldots:tenancy=tenant';

ALTER TABLE ONLY public.approval_requests
    ADD CONSTRAINT approval_requests_pkey PRIMARY KEY (id);

CREATE INDEX approval_requests_agent_run_idx ON public.approval_requests USING btree (agent_run_id);

CREATE UNIQUE INDEX approval_requests_run_tool_call_unique ON public.approval_requests USING btree (tenant_id, agent_run_id, tool_call_id) WHERE (tool_call_id IS NOT NULL);

CREATE INDEX approval_requests_status_idx ON public.approval_requests USING btree (status);

CREATE INDEX approval_requests_tenant_decided_idx ON public.approval_requests USING btree (tenant_id, decided_at DESC) WHERE (status <> 'pending'::text);

CREATE INDEX approval_requests_tenant_status_requested_idx ON public.approval_requests USING btree (tenant_id, status, requested_at DESC);

GRANT SELECT ON TABLE public.approval_requests TO alldots_side;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.approval_requests TO alldots_data;

-- ----------------------------------------------------------------------------------------------------
-- blobs
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.blobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    mime_type text NOT NULL,
    byte_size bigint NOT NULL,
    storage_key text NOT NULL,
    source_url text,
    content_hash text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL,
    detected_mime_type text
);

COMMENT ON TABLE public.blobs IS 'alldots:tenancy=tenant';

ALTER TABLE ONLY public.blobs
    ADD CONSTRAINT blobs_pkey PRIMARY KEY (id);

CREATE UNIQUE INDEX blobs_tenant_content_hash_uq ON public.blobs USING btree (tenant_id, content_hash) WHERE (content_hash IS NOT NULL);

CREATE UNIQUE INDEX blobs_tenant_id_id_uq ON public.blobs USING btree (tenant_id, id);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.blobs TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- calendar_account_sync_state
-- ----------------------------------------------------------------------------------------------------

-- The calendar side of an internet account (a Mailboxes item): the outcome of its last calendar sync pass and the
-- pass whose batches are applying (`apply_pass_id`, cleared by its success). Written by the calendar sync and the
-- manual sync route while Calendars is on; deleted when Calendars is switched off or the account is removed.
CREATE TABLE public.calendar_account_sync_state (
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL,
    account_item_id uuid NOT NULL,
    status text DEFAULT 'never'::text NOT NULL,
    last_successful_sync_at timestamp with time zone,
    failing_since timestamp with time zone,
    last_error_code text,
    initial_sync_completed_at timestamp with time zone,
    manual_sync_requested_at timestamp with time zone,
    apply_pass_id uuid,
    CONSTRAINT calendar_account_sync_state_status_check CHECK ((status = ANY (ARRAY['ok'::text, 'error'::text, 'never'::text, 'needsReauthorization'::text, 'needsConsent'::text])))
);

COMMENT ON TABLE public.calendar_account_sync_state IS 'alldots:tenancy=tenant';

ALTER TABLE ONLY public.calendar_account_sync_state
    ADD CONSTRAINT calendar_account_sync_state_pkey PRIMARY KEY (tenant_id, account_item_id);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.calendar_account_sync_state TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- calendar_event_push_state
-- ----------------------------------------------------------------------------------------------------

-- The desired state of an account calendar Event that a user's or agent's change must bring to its provider: the
-- operation last recorded, a revision every recorded change raises, the push job's outcome, and the lease of the one
-- push job running for the Event (`lease_id` until `lease_until`). Written in the transaction of the Event's write
-- and by the `calendarEventPush` job.
CREATE TABLE public.calendar_event_push_state (
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL,
    event_item_id uuid NOT NULL,
    operation text NOT NULL,
    desired_revision bigint DEFAULT 1 NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    last_error_code text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    lease_id uuid,
    lease_until timestamp with time zone,
    CONSTRAINT calendar_event_push_state_lease_check CHECK (((lease_id IS NULL) = (lease_until IS NULL))),
    CONSTRAINT calendar_event_push_state_operation_check CHECK ((operation = ANY (ARRAY['create'::text, 'update'::text, 'delete'::text, 'move'::text]))),
    CONSTRAINT calendar_event_push_state_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sent'::text, 'conflict'::text, 'failed'::text]))),
    CONSTRAINT calendar_event_push_state_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT calendar_event_push_state_desired_revision_check CHECK ((desired_revision >= 1))
);

COMMENT ON TABLE public.calendar_event_push_state IS 'alldots:tenancy=tenant';

ALTER TABLE ONLY public.calendar_event_push_state
    ADD CONSTRAINT calendar_event_push_state_pkey PRIMARY KEY (tenant_id, event_item_id);

CREATE INDEX calendar_event_push_state_pending_idx ON public.calendar_event_push_state USING btree (tenant_id, event_item_id) WHERE (status = 'pending'::text);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.calendar_event_push_state TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- calendar_feed_state
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.calendar_feed_state (
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL,
    calendar_item_id uuid NOT NULL,
    etag text,
    last_modified text,
    feed_url_hash text,
    last_fetched_at timestamp with time zone,
    last_status integer,
    last_error_code text
);

COMMENT ON TABLE public.calendar_feed_state IS 'alldots:tenancy=tenant';

ALTER TABLE ONLY public.calendar_feed_state
    ADD CONSTRAINT calendar_feed_state_pkey PRIMARY KEY (tenant_id, calendar_item_id);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.calendar_feed_state TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- calendar_push_channels
-- ----------------------------------------------------------------------------------------------------

-- The push channels of internet accounts' calendars at their provider: a Google Calendar `events.watch` channel per
-- tracked calendar (`resource_id` is what stopping it takes), a Microsoft Graph subscription on `/me/events` per
-- account. `secret` is the channel token or `clientState` the provider sends back with every notification, so the
-- table is left out of the tenant export. Written by the calendar push maintenance and the account's removal.
CREATE TABLE public.calendar_push_channels (
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL,
    provider text NOT NULL,
    channel_id text NOT NULL,
    account_item_id uuid NOT NULL,
    calendar_item_id uuid,
    resource_id text,
    secret text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT calendar_push_channels_provider_check CHECK ((provider = ANY (ARRAY['google'::text, 'graph'::text]))),
    CONSTRAINT calendar_push_channels_shape_check CHECK ((CASE WHEN (provider = 'google'::text) THEN ((calendar_item_id IS NOT NULL) AND (resource_id IS NOT NULL)) ELSE ((calendar_item_id IS NULL) AND (resource_id IS NULL)) END))
);

COMMENT ON TABLE public.calendar_push_channels IS 'alldots:tenancy=tenant';

ALTER TABLE ONLY public.calendar_push_channels
    ADD CONSTRAINT calendar_push_channels_pkey PRIMARY KEY (tenant_id, provider, channel_id);

CREATE INDEX calendar_push_channels_account_idx ON public.calendar_push_channels USING btree (tenant_id, account_item_id);

CREATE INDEX calendar_push_channels_calendar_idx ON public.calendar_push_channels USING btree (tenant_id, calendar_item_id);

-- For route_google_calendar_channel and route_graph_calendar_subscription, which look a channel up before any tenant
-- is known.
CREATE INDEX calendar_push_channels_channel_idx ON public.calendar_push_channels USING btree (provider, channel_id);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.calendar_push_channels TO alldots_side;

GRANT SELECT(tenant_id) ON TABLE public.calendar_push_channels TO alldots_router;

GRANT SELECT(provider) ON TABLE public.calendar_push_channels TO alldots_router;

GRANT SELECT(channel_id) ON TABLE public.calendar_push_channels TO alldots_router;

-- ----------------------------------------------------------------------------------------------------
-- calendar_remote_state
-- ----------------------------------------------------------------------------------------------------

-- An account calendar's identity at its provider and its sync cursors; written by the calendar sync.
CREATE TABLE public.calendar_remote_state (
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL,
    calendar_item_id uuid NOT NULL,
    remote_id text NOT NULL,
    remote_url text,
    sync_token text,
    ctag text,
    last_synced_at timestamp with time zone,
    last_error_code text
);

COMMENT ON TABLE public.calendar_remote_state IS 'alldots:tenancy=tenant';

ALTER TABLE ONLY public.calendar_remote_state
    ADD CONSTRAINT calendar_remote_state_pkey PRIMARY KEY (tenant_id, calendar_item_id);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.calendar_remote_state TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- credential_access_log
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.credential_access_log (
    id bigint NOT NULL,
    item_id uuid NOT NULL,
    actor_type text NOT NULL,
    actor_id text,
    purpose text NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL,
    CONSTRAINT credential_access_log_actor_type_check CHECK ((actor_type = ANY (ARRAY['user'::text, 'sync_worker'::text, 'smtp_send'::text, 'mcp_connection_manager'::text, 'ai_agent'::text])))
);

COMMENT ON TABLE public.credential_access_log IS 'alldots:tenancy=tenant';

CREATE SEQUENCE public.credential_access_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.credential_access_log_id_seq OWNED BY public.credential_access_log.id;

ALTER TABLE ONLY public.credential_access_log ALTER COLUMN id SET DEFAULT nextval('public.credential_access_log_id_seq'::regclass);

ALTER TABLE ONLY public.credential_access_log
    ADD CONSTRAINT credential_access_log_pkey PRIMARY KEY (id);

CREATE INDEX credential_access_log_item_id_idx ON public.credential_access_log USING btree (item_id);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.credential_access_log TO alldots_side;

GRANT SELECT,USAGE ON SEQUENCE public.credential_access_log_id_seq TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- databases
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.databases (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text,
    parent_item_id uuid,
    owner_project_item_id uuid,
    owner_module_id text,
    schema_locked boolean DEFAULT false NOT NULL,
    system boolean DEFAULT false NOT NULL,
    archived_at timestamp with time zone,
    migration_cursor uuid,
    key text,
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL,
    icon text,
    color text,
    overview_hidden boolean DEFAULT false NOT NULL,
    sensitive boolean DEFAULT false NOT NULL,
    purge_at timestamp with time zone,
    CONSTRAINT databases_color_format CHECK (((color IS NULL) OR (color ~ '^#[0-9A-F]{6}$'::text))),
    CONSTRAINT databases_icon_format CHECK (((icon IS NULL) OR (icon ~ '^[a-z][a-z0-9-]{0,63}$'::text)))
);

COMMENT ON TABLE public.databases IS 'alldots:tenancy=tenant';

ALTER TABLE ONLY public.databases
    ADD CONSTRAINT databases_key_unique UNIQUE (tenant_id, key);

ALTER TABLE ONLY public.databases
    ADD CONSTRAINT databases_pkey PRIMARY KEY (id);

CREATE INDEX databases_owner_project_item_id_idx ON public.databases USING btree (owner_project_item_id) WHERE (owner_project_item_id IS NOT NULL);

CREATE INDEX databases_parent_item_id_idx ON public.databases USING btree (parent_item_id) WHERE (parent_item_id IS NOT NULL);

CREATE INDEX databases_purge_at_idx ON public.databases USING btree (purge_at) WHERE (purge_at IS NOT NULL);

CREATE UNIQUE INDEX databases_tenant_id_id_uq ON public.databases USING btree (tenant_id, id);

CREATE UNIQUE INDEX databases_tenant_system_module_uq ON public.databases USING btree (tenant_id, owner_module_id) WHERE system;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.databases TO alldots_data;
GRANT SELECT ON TABLE public.databases TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- doc_history_updates
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.doc_history_updates (
    update_id bigint NOT NULL,
    doc_id uuid NOT NULL,
    update bytea NOT NULL,
    created_by text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL,
    CONSTRAINT doc_history_updates_created_by_check CHECK ((created_by = ANY (ARRAY['user'::text, 'ai_agent'::text, 'system'::text])))
);

COMMENT ON TABLE public.doc_history_updates IS 'alldots:tenancy=tenant';

ALTER TABLE ONLY public.doc_history_updates
    ADD CONSTRAINT doc_history_updates_pkey PRIMARY KEY (update_id);

CREATE INDEX doc_history_updates_doc_id_created_at_update_id_idx ON public.doc_history_updates USING btree (doc_id, created_at, update_id);

CREATE INDEX doc_history_updates_expires_at_idx ON public.doc_history_updates USING btree (expires_at);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.doc_history_updates TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- doc_snapshot_history
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.doc_snapshot_history (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    doc_id uuid NOT NULL,
    state bytea NOT NULL,
    taken_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    created_by text NOT NULL,
    through_update_id bigint DEFAULT 0 NOT NULL,
    represented_at timestamp with time zone NOT NULL,
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL,
    CONSTRAINT doc_snapshot_history_created_by_check CHECK ((created_by = ANY (ARRAY['user'::text, 'ai_agent'::text, 'system'::text])))
);

COMMENT ON TABLE public.doc_snapshot_history IS 'alldots:tenancy=tenant';

ALTER TABLE ONLY public.doc_snapshot_history
    ADD CONSTRAINT doc_snapshot_history_pkey PRIMARY KEY (id);

CREATE INDEX doc_snapshot_history_doc_id_represented_at_idx ON public.doc_snapshot_history USING btree (doc_id, represented_at);

CREATE INDEX doc_snapshot_history_doc_id_taken_at_idx ON public.doc_snapshot_history USING btree (doc_id, taken_at);

CREATE INDEX doc_snapshot_history_expires_at_idx ON public.doc_snapshot_history USING btree (expires_at);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.doc_snapshot_history TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- doc_snapshots
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.doc_snapshots (
    doc_id uuid NOT NULL,
    state bytea NOT NULL,
    state_vector bytea NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL
);

COMMENT ON TABLE public.doc_snapshots IS 'alldots:tenancy=tenant';

ALTER TABLE ONLY public.doc_snapshots
    ADD CONSTRAINT doc_snapshots_pkey PRIMARY KEY (doc_id);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.doc_snapshots TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- doc_updates
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.doc_updates (
    id bigint NOT NULL,
    doc_id uuid NOT NULL,
    update bytea NOT NULL,
    created_by text DEFAULT 'user'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL,
    CONSTRAINT doc_updates_created_by_check CHECK ((created_by = ANY (ARRAY['user'::text, 'ai_agent'::text, 'system'::text])))
);

COMMENT ON TABLE public.doc_updates IS 'alldots:tenancy=tenant';

CREATE SEQUENCE public.doc_updates_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.doc_updates_id_seq OWNED BY public.doc_updates.id;

ALTER TABLE ONLY public.doc_updates ALTER COLUMN id SET DEFAULT nextval('public.doc_updates_id_seq'::regclass);

ALTER TABLE ONLY public.doc_updates
    ADD CONSTRAINT doc_updates_pkey PRIMARY KEY (id);

CREATE INDEX doc_updates_doc_id_idx ON public.doc_updates USING btree (doc_id, id);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.doc_updates TO alldots_side;

GRANT SELECT,USAGE ON SEQUENCE public.doc_updates_id_seq TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- docs
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.docs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    item_id uuid NOT NULL,
    kind text DEFAULT 'page'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    history_available_from timestamp with time zone,
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL,
    last_edited_at timestamp with time zone,
    last_edited_by text,
    CONSTRAINT docs_kind_check CHECK ((kind = ANY (ARRAY['page'::text, 'canvas'::text]))),
    CONSTRAINT docs_last_edited_by_check CHECK ((last_edited_by = ANY (ARRAY['user'::text, 'ai_agent'::text, 'system'::text])))
);

COMMENT ON TABLE public.docs IS 'alldots:tenancy=tenant';

ALTER TABLE ONLY public.docs
    ADD CONSTRAINT docs_pkey PRIMARY KEY (id);

CREATE UNIQUE INDEX docs_tenant_id_id_uq ON public.docs USING btree (tenant_id, id);

CREATE UNIQUE INDEX docs_tenant_item_id_uq ON public.docs USING btree (tenant_id, item_id);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.docs TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- event_remote_state
-- ----------------------------------------------------------------------------------------------------

-- An account calendar Event's identity at its provider and `base_snapshot`, the field values of the last sync (the
-- base of the three-way merge); written by the calendar sync.
CREATE TABLE public.event_remote_state (
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL,
    event_item_id uuid NOT NULL,
    calendar_item_id uuid NOT NULL,
    remote_id text NOT NULL,
    remote_href text,
    etag text,
    base_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT event_remote_state_base_snapshot_check CHECK ((jsonb_typeof(base_snapshot) = 'object'::text))
);

COMMENT ON TABLE public.event_remote_state IS 'alldots:tenancy=tenant';

ALTER TABLE ONLY public.event_remote_state
    ADD CONSTRAINT event_remote_state_pkey PRIMARY KEY (tenant_id, event_item_id);

CREATE UNIQUE INDEX event_remote_state_tenant_calendar_remote_id_uq ON public.event_remote_state USING btree (tenant_id, calendar_item_id, remote_id);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.event_remote_state TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- external_credentials
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.external_credentials (
    item_id uuid NOT NULL,
    credential_type text NOT NULL,
    ciphertext bytea NOT NULL,
    nonce bytea NOT NULL,
    key_version smallint DEFAULT 1 NOT NULL,
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL,
    scheme text DEFAULT 'master'::text NOT NULL,
    CONSTRAINT external_credentials_credential_type_check CHECK ((credential_type = ANY (ARRAY['oauth2_refresh_token'::text, 'app_password'::text, 'plain_password'::text, 'api_key'::text, 'bearer_token'::text]))),
    CONSTRAINT external_credentials_scheme_check CHECK ((scheme = ANY (ARRAY['master'::text, 'tenant'::text]))),
    CONSTRAINT external_credentials_scheme_tenant_only CHECK ((scheme = 'tenant'::text))
);

COMMENT ON TABLE public.external_credentials IS 'alldots:tenancy=tenant';

ALTER TABLE ONLY public.external_credentials
    ADD CONSTRAINT external_credentials_pkey PRIMARY KEY (item_id);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.external_credentials TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- heartbeat_occurrences
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.heartbeat_occurrences (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    heartbeat_id uuid NOT NULL,
    scheduled_for timestamp with time zone NOT NULL,
    rule_snapshot jsonb NOT NULL,
    first_started_at timestamp with time zone,
    status text NOT NULL,
    last_error text,
    generation integer DEFAULT 1 NOT NULL,
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL,
    CONSTRAINT heartbeat_occurrences_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text])))
);

COMMENT ON TABLE public.heartbeat_occurrences IS 'alldots:tenancy=tenant';

ALTER TABLE ONLY public.heartbeat_occurrences
    ADD CONSTRAINT heartbeat_occurrences_heartbeat_id_scheduled_for_key UNIQUE (heartbeat_id, scheduled_for);

ALTER TABLE ONLY public.heartbeat_occurrences
    ADD CONSTRAINT heartbeat_occurrences_pkey PRIMARY KEY (id);

CREATE INDEX heartbeat_occurrences_heartbeat_idx ON public.heartbeat_occurrences USING btree (heartbeat_id);

CREATE UNIQUE INDEX heartbeat_occurrences_tenant_id_id_uq ON public.heartbeat_occurrences USING btree (tenant_id, id);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.heartbeat_occurrences TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- idempotency_keys
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.idempotency_keys (
    key text NOT NULL,
    database_id uuid NOT NULL,
    item_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL
);

COMMENT ON TABLE public.idempotency_keys IS 'alldots:tenancy=tenant';

ALTER TABLE ONLY public.idempotency_keys
    ADD CONSTRAINT idempotency_keys_pkey PRIMARY KEY (tenant_id, key);

CREATE INDEX idempotency_keys_tenant_item_idx ON public.idempotency_keys USING btree (tenant_id, item_id);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.idempotency_keys TO alldots_data;
GRANT SELECT ON TABLE public.idempotency_keys TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- idempotent_responses
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.idempotent_responses (
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL,
    user_id uuid NOT NULL,
    key text NOT NULL,
    route text NOT NULL,
    request_hash text NOT NULL,
    status integer NOT NULL,
    body jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL
);

COMMENT ON TABLE public.idempotent_responses IS 'alldots:tenancy=tenant';

ALTER TABLE ONLY public.idempotent_responses
    ADD CONSTRAINT idempotent_responses_pkey PRIMARY KEY (tenant_id, user_id, key, route);

CREATE INDEX idempotent_responses_expires_at_idx ON public.idempotent_responses USING btree (expires_at);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.idempotent_responses TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- inbox_attachments
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.inbox_attachments (
    attachment_id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL,
    inbox_item_id uuid NOT NULL,
    blob_id uuid NOT NULL,
    "position" integer NOT NULL,
    source text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    metadata jsonb,
    thumbnail_blob_id uuid,
    reduced_blob_id uuid,
    extraction jsonb,
    CONSTRAINT inbox_attachments_source_check CHECK ((source = ANY (ARRAY['camera'::text, 'scan'::text, 'photoLibrary'::text, 'files'::text, 'share'::text])))
);

COMMENT ON TABLE public.inbox_attachments IS 'alldots:tenancy=tenant';

ALTER TABLE ONLY public.inbox_attachments
    ADD CONSTRAINT inbox_attachments_pkey PRIMARY KEY (attachment_id);

CREATE UNIQUE INDEX inbox_attachments_item_position_uq ON public.inbox_attachments USING btree (tenant_id, inbox_item_id, "position");

CREATE INDEX inbox_attachments_tenant_blob_idx ON public.inbox_attachments USING btree (tenant_id, blob_id);

CREATE INDEX inbox_attachments_tenant_reduced_blob_idx ON public.inbox_attachments USING btree (tenant_id, reduced_blob_id);

CREATE INDEX inbox_attachments_tenant_thumbnail_blob_idx ON public.inbox_attachments USING btree (tenant_id, thumbnail_blob_id);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.inbox_attachments TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- invites
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.invites (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email text NOT NULL,
    token_hash text NOT NULL,
    invited_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    accepted_at timestamp with time zone,
    revoked_at timestamp with time zone
);

COMMENT ON TABLE public.invites IS 'alldots:tenancy=global';

ALTER TABLE ONLY public.invites
    ADD CONSTRAINT invites_pkey PRIMARY KEY (id);

CREATE INDEX invites_email_idx ON public.invites USING btree (email);

CREATE UNIQUE INDEX invites_token_hash_key ON public.invites USING btree (token_hash);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.invites TO alldots_data;

-- ----------------------------------------------------------------------------------------------------
-- item_automation
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.item_automation (
    item_id uuid NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    error text,
    attempts integer DEFAULT 0 NOT NULL,
    last_attempt_at timestamp with time zone,
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL,
    error_code text,
    source text,
    CONSTRAINT item_automation_source_check CHECK ((source = ANY (ARRAY['openLibrary'::text, 'googleBooks'::text, 'tmdb'::text]))),
    CONSTRAINT item_automation_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'done'::text, 'error'::text, 'locked'::text, 'notFound'::text])))
);

COMMENT ON TABLE public.item_automation IS 'alldots:tenancy=tenant';

ALTER TABLE ONLY public.item_automation
    ADD CONSTRAINT item_automation_pkey PRIMARY KEY (item_id);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.item_automation TO alldots_side;

GRANT SELECT(status) ON TABLE public.item_automation TO alldots_router;

-- ----------------------------------------------------------------------------------------------------
-- item_origins
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.item_origins (
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL,
    item_id uuid NOT NULL,
    proposal_id uuid NOT NULL,
    inbox_item_id uuid,
    source_transcript_id uuid,
    captured_at timestamp with time zone,
    capture_channel text NOT NULL,
    capture_time_basis text NOT NULL,
    CONSTRAINT item_origins_capture_channel_check CHECK ((capture_channel = ANY (ARRAY['inbox'::text, 'transcript'::text]))),
    CONSTRAINT item_origins_capture_provenance_check CHECK ((((capture_time_basis = 'inboxCapture'::text) AND (captured_at IS NOT NULL)) OR ((capture_time_basis = 'unknown'::text) AND (captured_at IS NULL)))),
    CONSTRAINT item_origins_capture_time_basis_check CHECK ((capture_time_basis = ANY (ARRAY['inboxCapture'::text, 'unknown'::text])))
);

COMMENT ON TABLE public.item_origins IS 'alldots:tenancy=tenant';

ALTER TABLE ONLY public.item_origins
    ADD CONSTRAINT item_origins_pkey PRIMARY KEY (tenant_id, item_id);

CREATE INDEX item_origins_tenant_proposal_idx ON public.item_origins USING btree (tenant_id, proposal_id);

CREATE INDEX item_origins_tenant_inbox_item_idx ON public.item_origins USING btree (tenant_id, inbox_item_id) WHERE (inbox_item_id IS NOT NULL);

CREATE INDEX item_origins_tenant_source_transcript_idx ON public.item_origins USING btree (tenant_id, source_transcript_id) WHERE (source_transcript_id IS NOT NULL);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.item_origins TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- item_relations
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.item_relations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    relation_definition_id uuid NOT NULL,
    item_a uuid NOT NULL,
    item_b uuid NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL
);

COMMENT ON TABLE public.item_relations IS 'alldots:tenancy=tenant';

ALTER TABLE ONLY public.item_relations
    ADD CONSTRAINT item_relations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.item_relations
    ADD CONSTRAINT item_relations_relation_definition_id_item_a_item_b_key UNIQUE (relation_definition_id, item_a, item_b);

CREATE INDEX item_relations_item_a_idx ON public.item_relations USING btree (item_a);

CREATE INDEX item_relations_item_b_idx ON public.item_relations USING btree (item_b);

CREATE TRIGGER item_relations_cardinality_trigger BEFORE INSERT ON public.item_relations FOR EACH ROW EXECUTE FUNCTION public.enforce_relation_cardinality();

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.item_relations TO alldots_data;
GRANT SELECT ON TABLE public.item_relations TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- item_search_index
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.item_search_index (
    item_id uuid NOT NULL,
    database_id uuid NOT NULL,
    search_vector tsvector NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL,
    body text,
    page_text text
);

COMMENT ON TABLE public.item_search_index IS 'alldots:tenancy=tenant';

ALTER TABLE ONLY public.item_search_index
    ADD CONSTRAINT item_search_index_pkey PRIMARY KEY (item_id);

CREATE INDEX item_search_index_db_id ON public.item_search_index USING btree (database_id);

CREATE INDEX item_search_index_gin ON public.item_search_index USING gin (search_vector);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.item_search_index TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- items
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    database_id uuid NOT NULL,
    properties jsonb DEFAULT '{}'::jsonb NOT NULL,
    computed jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    version bigint DEFAULT 1 NOT NULL
);

COMMENT ON TABLE public.items IS 'alldots:tenancy=tenant';

COMMENT ON COLUMN public.items.version IS 'Optimistic-concurrency token (ifVersion): incremented by every write that advances updated_at.';

ALTER TABLE ONLY public.items
    ADD CONSTRAINT items_pkey PRIMARY KEY (id);

-- The target of every (tenant_id, <item column>) foreign key: FK checks ignore RLS, so naming another tenant's item
-- fails exactly like naming a random id.
ALTER TABLE ONLY public.items
    ADD CONSTRAINT items_tenant_id_id_uq UNIQUE (tenant_id, id);

-- Item reads filter by database and page by id (`listItems`, keyset `(database_id, id)` sweeps).
CREATE INDEX items_database_id_id_idx ON public.items USING btree (database_id, id);

-- Trash reads and the purge sweep run per tenant: led by tenant_id, a scan reads only the tenant's trashed rows.
CREATE INDEX items_deleted_at_idx ON public.items USING btree (tenant_id, deleted_at DESC, id) WHERE (deleted_at IS NOT NULL);

CREATE INDEX items_props_gin ON public.items USING gin (properties jsonb_path_ops);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.items TO alldots_data;
GRANT SELECT ON TABLE public.items TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- library_cover_candidates
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.library_cover_candidates (
    item_id uuid NOT NULL,
    idx smallint NOT NULL,
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL,
    source text NOT NULL,
    title text,
    subtitle text,
    image_url text NOT NULL,
    fetched_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT library_cover_candidates_idx_check CHECK (((idx >= 0) AND (idx <= 2)))
);

COMMENT ON TABLE public.library_cover_candidates IS 'alldots:tenancy=tenant';

ALTER TABLE ONLY public.library_cover_candidates
    ADD CONSTRAINT library_cover_candidates_pkey PRIMARY KEY (item_id, idx);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.library_cover_candidates TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- login_attempts
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.login_attempts (
    id bigint NOT NULL,
    email text NOT NULL,
    ip inet NOT NULL,
    succeeded boolean NOT NULL,
    attempted_at timestamp with time zone DEFAULT now() NOT NULL
);

COMMENT ON TABLE public.login_attempts IS 'alldots:tenancy=global';

CREATE SEQUENCE public.login_attempts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.login_attempts_id_seq OWNED BY public.login_attempts.id;

ALTER TABLE ONLY public.login_attempts ALTER COLUMN id SET DEFAULT nextval('public.login_attempts_id_seq'::regclass);

ALTER TABLE ONLY public.login_attempts
    ADD CONSTRAINT login_attempts_pkey PRIMARY KEY (id);

CREATE INDEX login_attempts_email_ip_idx ON public.login_attempts USING btree (email, ip, attempted_at DESC);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.login_attempts TO alldots_data;

GRANT SELECT,USAGE ON SEQUENCE public.login_attempts_id_seq TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- mail_account_server_settings
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.mail_account_server_settings (
    mailbox_item_id uuid NOT NULL,
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL,
    imap_host text,
    imap_port integer,
    imap_security text,
    smtp_host text,
    smtp_port integer,
    smtp_security text,
    username text NOT NULL,
    caldav_url text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT mail_account_server_settings_caldav_url_length CHECK ((char_length(caldav_url) <= 2048)),
    CONSTRAINT mail_account_server_settings_imap_all_or_none CHECK ((((imap_host IS NULL) AND (imap_port IS NULL) AND (imap_security IS NULL)) OR ((imap_host IS NOT NULL) AND (imap_port IS NOT NULL) AND (imap_security IS NOT NULL)))),
    CONSTRAINT mail_account_server_settings_imap_port_check CHECK ((imap_port = ANY (ARRAY[993, 143, 465, 587]))),
    CONSTRAINT mail_account_server_settings_imap_security_check CHECK ((imap_security = ANY (ARRAY['tls'::text, 'starttls'::text]))),
    CONSTRAINT mail_account_server_settings_smtp_all_or_none CHECK ((((smtp_host IS NULL) AND (smtp_port IS NULL) AND (smtp_security IS NULL)) OR ((smtp_host IS NOT NULL) AND (smtp_port IS NOT NULL) AND (smtp_security IS NOT NULL)))),
    CONSTRAINT mail_account_server_settings_smtp_port_check CHECK ((smtp_port = ANY (ARRAY[993, 143, 465, 587]))),
    CONSTRAINT mail_account_server_settings_smtp_security_check CHECK ((smtp_security = ANY (ARRAY['tls'::text, 'starttls'::text])))
);

COMMENT ON TABLE public.mail_account_server_settings IS 'alldots:tenancy=tenant';

ALTER TABLE ONLY public.mail_account_server_settings
    ADD CONSTRAINT mail_account_server_settings_pkey PRIMARY KEY (mailbox_item_id);

CREATE INDEX mail_account_server_settings_tenant_idx ON public.mail_account_server_settings USING btree (tenant_id);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.mail_account_server_settings TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- mail_account_sync_state
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.mail_account_sync_state (
    item_id uuid NOT NULL,
    sync_mode text NOT NULL,
    gmail_history_id text,
    gmail_watch_expires_at timestamp with time zone,
    graph_subscription_id text,
    graph_subscription_expires_at timestamp with time zone,
    graph_delta_link text,
    last_error text,
    last_activity_at timestamp with time zone,
    next_expected_activity_at timestamp with time zone,
    graph_client_state text,
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL,
    gmail_watch_email_address text,
    last_successful_sync_at timestamp with time zone,
    failing_since timestamp with time zone,
    initial_sync_completed_at timestamp with time zone,
    last_failure_kind text,
    provider_account_address text,
    sync_paused_at timestamp with time zone,
    granted_scopes text[],
    pass_lease_token uuid,
    pass_lease_expires_at timestamp with time zone,
    pass_rerun_requested boolean DEFAULT false NOT NULL,
    connected_at timestamp with time zone,
    gmail_listing_phase text,
    gmail_listing_page_token text,
    graph_delta_next_link text,
    CONSTRAINT mail_account_sync_state_gmail_listing_phase_check CHECK ((gmail_listing_phase = ANY (ARRAY['full'::text, 'index'::text]))),
    CONSTRAINT mail_account_sync_state_last_failure_kind_check CHECK ((last_failure_kind = ANY (ARRAY['reauthorization'::text, 'connectionLimit'::text, 'other'::text]))),
    CONSTRAINT mail_account_sync_state_sync_mode_check CHECK ((sync_mode = ANY (ARRAY['imap'::text, 'gmail_api'::text, 'graph_api'::text])))
);

COMMENT ON TABLE public.mail_account_sync_state IS 'alldots:tenancy=tenant';

COMMENT ON COLUMN public.mail_account_sync_state.connected_at IS 'Anchor of the account''s mail: set by the first sync pass that finds it NULL, cleared when Mail is switched off.';

COMMENT ON COLUMN public.mail_account_sync_state.gmail_listing_phase IS 'Gmail full listing in progress: ''full'' lists the messages inside the full-content window, ''index'' the older ones; NULL when no listing runs.';

COMMENT ON COLUMN public.mail_account_sync_state.gmail_listing_page_token IS 'The messages.list page token the Gmail listing resumes at; NULL at the start of its phase.';

COMMENT ON COLUMN public.mail_account_sync_state.graph_delta_next_link IS 'The nextLink of the Graph delta round in progress; promoted to graph_delta_link only when the round''s deltaLink arrives.';

ALTER TABLE ONLY public.mail_account_sync_state
    ADD CONSTRAINT mail_account_sync_state_pkey PRIMARY KEY (item_id);

CREATE INDEX mail_account_sync_state_gmail_watch_email_idx ON public.mail_account_sync_state USING btree (gmail_watch_email_address) WHERE (gmail_watch_email_address IS NOT NULL);

CREATE UNIQUE INDEX mail_account_sync_state_graph_subscription_id_uq ON public.mail_account_sync_state USING btree (graph_subscription_id) WHERE (graph_subscription_id IS NOT NULL);

CREATE UNIQUE INDEX mail_account_sync_state_tenant_provider_address_uq ON public.mail_account_sync_state USING btree (tenant_id, provider_account_address) WHERE (provider_account_address IS NOT NULL);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.mail_account_sync_state TO alldots_side;

GRANT SELECT(item_id) ON TABLE public.mail_account_sync_state TO alldots_router;

GRANT SELECT(sync_mode) ON TABLE public.mail_account_sync_state TO alldots_router;

GRANT SELECT(graph_subscription_id) ON TABLE public.mail_account_sync_state TO alldots_router;

GRANT SELECT(tenant_id) ON TABLE public.mail_account_sync_state TO alldots_router;

GRANT SELECT(gmail_watch_email_address) ON TABLE public.mail_account_sync_state TO alldots_router;

-- ----------------------------------------------------------------------------------------------------
-- mail_attachments
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.mail_attachments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    message_item_id uuid NOT NULL,
    blob_id uuid,
    filename text NOT NULL,
    content_type text NOT NULL,
    content_id text,
    disposition text NOT NULL,
    byte_size bigint NOT NULL,
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL,
    provider_part text,
    CONSTRAINT mail_attachments_disposition_check CHECK ((disposition = ANY (ARRAY['attachment'::text, 'inline'::text]))),
    CONSTRAINT mail_attachments_stored_or_located_check CHECK (((blob_id IS NOT NULL) OR (provider_part IS NOT NULL)))
);

COMMENT ON TABLE public.mail_attachments IS 'alldots:tenancy=tenant';

COMMENT ON COLUMN public.mail_attachments.blob_id IS 'The stored bytes; NULL for an attachment of an index message, recorded by its metadata alone.';

COMMENT ON COLUMN public.mail_attachments.provider_part IS 'Where the provider holds the bytes (the IMAP body part id); NULL where the adapter records none.';

COMMENT ON COLUMN public.mail_attachments.byte_size IS 'Bytes stored; for an attachment without stored bytes, the size the provider''s body structure gives.';

ALTER TABLE ONLY public.mail_attachments
    ADD CONSTRAINT mail_attachments_pkey PRIMARY KEY (id);

CREATE INDEX mail_attachments_message_item_id_idx ON public.mail_attachments USING btree (message_item_id);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.mail_attachments TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- mail_drafts
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.mail_drafts (
    email_item_id uuid NOT NULL,
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL,
    mailbox_item_id uuid NOT NULL,
    thread_id uuid,
    mode text NOT NULL,
    source_email_item_id uuid,
    in_reply_to text,
    "references" text[] DEFAULT '{}'::text[] NOT NULL,
    from_address text NOT NULL,
    to_recipients jsonb DEFAULT '[]'::jsonb NOT NULL,
    cc_recipients jsonb DEFAULT '[]'::jsonb NOT NULL,
    bcc_recipients jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_by text NOT NULL,
    last_edited_by text NOT NULL,
    agent_run_id uuid,
    conversation_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    sent_at timestamp with time zone,
    CONSTRAINT mail_drafts_bcc_recipients_check CHECK ((jsonb_typeof(bcc_recipients) = 'array'::text)),
    CONSTRAINT mail_drafts_cc_recipients_check CHECK ((jsonb_typeof(cc_recipients) = 'array'::text)),
    CONSTRAINT mail_drafts_created_by_check CHECK ((created_by = ANY (ARRAY['user'::text, 'agent'::text]))),
    CONSTRAINT mail_drafts_last_edited_by_check CHECK ((last_edited_by = ANY (ARRAY['user'::text, 'agent'::text]))),
    CONSTRAINT mail_drafts_mode_check CHECK ((mode = ANY (ARRAY['new'::text, 'reply'::text, 'replyAll'::text, 'forward'::text]))),
    CONSTRAINT mail_drafts_to_recipients_check CHECK ((jsonb_typeof(to_recipients) = 'array'::text))
);

COMMENT ON TABLE public.mail_drafts IS 'alldots:tenancy=tenant';

ALTER TABLE ONLY public.mail_drafts
    ADD CONSTRAINT mail_drafts_pkey PRIMARY KEY (email_item_id);

CREATE UNIQUE INDEX mail_drafts_one_unsent_agent_per_thread_uq ON public.mail_drafts USING btree (tenant_id, thread_id) WHERE ((created_by = 'agent'::text) AND (sent_at IS NULL) AND (thread_id IS NOT NULL));

CREATE INDEX mail_drafts_tenant_mailbox_idx ON public.mail_drafts USING btree (tenant_id, mailbox_item_id);

CREATE INDEX mail_drafts_tenant_source_email_idx ON public.mail_drafts USING btree (tenant_id, source_email_item_id) WHERE (source_email_item_id IS NOT NULL);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.mail_drafts TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- mail_folder_sync_state
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.mail_folder_sync_state (
    item_id uuid NOT NULL,
    uidvalidity bigint,
    uidnext bigint,
    highestmodseq bigint,
    message_count bigint,
    last_full_reconcile_at timestamp with time zone,
    last_error text,
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL,
    live_from_uid bigint,
    backfill_below_uid bigint,
    backfill_index_only boolean DEFAULT false NOT NULL,
    client_backfill_lease_token uuid,
    client_backfill_lease_until timestamp with time zone,
    CONSTRAINT mail_folder_sync_state_client_lease_check CHECK (((client_backfill_lease_token IS NULL) = (client_backfill_lease_until IS NULL)))
);

COMMENT ON TABLE public.mail_folder_sync_state IS 'alldots:tenancy=tenant';

COMMENT ON COLUMN public.mail_folder_sync_state.live_from_uid IS 'The folder''s UIDNEXT when its state was first established or reset after a UIDVALIDITY change; a message with a UID at or above it arrived live.';

COMMENT ON COLUMN public.mail_folder_sync_state.backfill_below_uid IS 'Every UID from 1 up to, not including, this value still awaits the backfill, which runs from it downwards. Set to live_from_uid when the state is established; NULL with live_from_uid set means the backfill is done, NULL with live_from_uid NULL that the state is not established yet.';

COMMENT ON COLUMN public.mail_folder_sync_state.backfill_index_only IS 'The descending backfill reached a message older than the full-content window: what is left below backfill_below_uid is history stored as an index, which a native client may upload. Cleared with the state on a UIDVALIDITY change.';

COMMENT ON COLUMN public.mail_folder_sync_state.client_backfill_lease_token IS 'The native client lease on the folder''s backfill (history upload); while client_backfill_lease_until is in the future the server''s backfill skips the folder. Set together with client_backfill_lease_until.';

COMMENT ON COLUMN public.mail_folder_sync_state.client_backfill_lease_until IS 'When the client backfill lease ends unless renewed; NULL when no client holds one.';

ALTER TABLE ONLY public.mail_folder_sync_state
    ADD CONSTRAINT mail_folder_sync_state_pkey PRIMARY KEY (item_id);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.mail_folder_sync_state TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- mail_message_content_cache
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.mail_message_content_cache (
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL,
    item_id uuid NOT NULL,
    body_html text,
    body_text text,
    fetched_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL
);

COMMENT ON TABLE public.mail_message_content_cache IS 'alldots:tenancy=tenant';

COMMENT ON COLUMN public.mail_message_content_cache.body_html IS 'The HTML part of an index message as its provider returned it on demand, unsanitized like Emails.body; NULL when the message has none.';

COMMENT ON COLUMN public.mail_message_content_cache.body_text IS 'The text part of an index message as its provider returned it on demand; NULL when the message has none.';

COMMENT ON COLUMN public.mail_message_content_cache.expires_at IS 'fetched_at plus seven days; readers ignore the row from then on and the daily sweep deletes it.';

ALTER TABLE ONLY public.mail_message_content_cache
    ADD CONSTRAINT mail_message_content_cache_pkey PRIMARY KEY (tenant_id, item_id);

CREATE INDEX mail_message_content_cache_tenant_expires_idx ON public.mail_message_content_cache USING btree (tenant_id, expires_at);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.mail_message_content_cache TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- mail_message_flag_sync_state
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.mail_message_flag_sync_state (
    message_item_id uuid NOT NULL,
    property_key text NOT NULL,
    desired_state boolean NOT NULL,
    current_state boolean,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL,
    CONSTRAINT mail_message_flag_sync_state_property_key_check CHECK ((property_key = ANY (ARRAY['read'::text, 'flagged'::text])))
);

COMMENT ON TABLE public.mail_message_flag_sync_state IS 'alldots:tenancy=tenant';

ALTER TABLE ONLY public.mail_message_flag_sync_state
    ADD CONSTRAINT mail_message_flag_sync_state_pkey PRIMARY KEY (message_item_id, property_key);

CREATE INDEX mail_message_flag_sync_state_pending_idx ON public.mail_message_flag_sync_state USING btree (message_item_id) WHERE (current_state IS DISTINCT FROM desired_state);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.mail_message_flag_sync_state TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- mail_message_meta
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.mail_message_meta (
    item_id uuid NOT NULL,
    message_id text NOT NULL,
    in_reply_to text,
    "references" text[],
    thread_id uuid,
    provider_thread_id text,
    provider_message_id text,
    envelope jsonb DEFAULT '{}'::jsonb NOT NULL,
    delivered_to_address text,
    message_kind text DEFAULT 'message'::text NOT NULL,
    dsn_original_message_id text,
    mailbox_item_id uuid,
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL,
    preview_text text,
    ingested_at timestamp with time zone,
    is_bulk boolean DEFAULT false NOT NULL,
    arrival text NOT NULL,
    content_state text NOT NULL,
    folder_copy_removed_at timestamp with time zone,
    CONSTRAINT mail_message_meta_arrival_check CHECK ((arrival = ANY (ARRAY['live'::text, 'backfill'::text]))),
    CONSTRAINT mail_message_meta_content_state_check CHECK ((content_state = ANY (ARRAY['full'::text, 'index'::text]))),
    CONSTRAINT mail_message_meta_message_kind_check CHECK ((message_kind = ANY (ARRAY['message'::text, 'dsn'::text])))
);

COMMENT ON TABLE public.mail_message_meta IS 'alldots:tenancy=tenant';

COMMENT ON COLUMN public.mail_message_meta.preview_text IS 'Plain-text preview of the message body, whitespace collapsed, at most 200 characters.';

COMMENT ON COLUMN public.mail_message_meta.ingested_at IS 'When the message entered Alldots (ingest or send claim).';

COMMENT ON COLUMN public.mail_message_meta.arrival IS 'live = new mail after the account connected, backfill = imported history; decided once at ingest.';

COMMENT ON COLUMN public.mail_message_meta.content_state IS 'full = body and attachment bytes stored, index = envelope, preview and attachment metadata only; decided once at ingest.';

COMMENT ON COLUMN public.mail_message_meta.folder_copy_removed_at IS 'When an IMAP pass last removed one of the message''s folder edges; set until a pass''s final transaction decides whether the Email keeps a folder copy.';

ALTER TABLE ONLY public.mail_message_meta
    ADD CONSTRAINT mail_message_meta_pkey PRIMARY KEY (item_id);

CREATE INDEX mail_message_meta_dsn_original_message_id_idx ON public.mail_message_meta USING btree (dsn_original_message_id) WHERE (dsn_original_message_id IS NOT NULL);

CREATE INDEX mail_message_meta_envelope_gin_idx ON public.mail_message_meta USING gin (envelope jsonb_path_ops);

CREATE INDEX mail_message_meta_folder_copy_removed_idx ON public.mail_message_meta USING btree (tenant_id, mailbox_item_id) WHERE (folder_copy_removed_at IS NOT NULL);

CREATE INDEX mail_message_meta_in_reply_to_idx ON public.mail_message_meta USING btree (in_reply_to) WHERE (in_reply_to IS NOT NULL);

CREATE UNIQUE INDEX mail_message_meta_mailbox_message_uq ON public.mail_message_meta USING btree (message_id, mailbox_item_id);

CREATE INDEX mail_message_meta_references_gin ON public.mail_message_meta USING gin ("references");

CREATE UNIQUE INDEX mail_message_meta_tenant_provider_msg_uq ON public.mail_message_meta USING btree (tenant_id, provider_message_id) WHERE (provider_message_id IS NOT NULL);

CREATE INDEX mail_message_meta_tenant_thread_idx ON public.mail_message_meta USING btree (tenant_id, thread_id);

CREATE INDEX mail_message_meta_thread_id_idx ON public.mail_message_meta USING btree (thread_id) WHERE (thread_id IS NOT NULL);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.mail_message_meta TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- mail_message_move_sync_state
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.mail_message_move_sync_state (
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL,
    message_item_id uuid NOT NULL,
    mailbox_item_id uuid NOT NULL,
    desired_purpose text NOT NULL,
    source_evidence jsonb NOT NULL,
    current_purpose text,
    restore_purpose text,
    desired_revision bigint DEFAULT 1 NOT NULL,
    operation_token uuid,
    captured_revision bigint,
    captured_purpose text,
    operation_phase text,
    operation_step text,
    operation_evidence jsonb,
    attempts integer DEFAULT 0 NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    failure_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT mail_message_move_sync_state_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT mail_message_move_sync_state_captured_purpose_check CHECK ((captured_purpose = ANY (ARRAY['archive'::text, 'trash'::text, 'inbox'::text, 'sent'::text]))),
    CONSTRAINT mail_message_move_sync_state_captured_revision_check CHECK ((captured_revision > 0)),
    CONSTRAINT mail_message_move_sync_state_check CHECK ((((operation_token IS NULL) AND (captured_revision IS NULL) AND (captured_purpose IS NULL) AND (operation_phase IS NULL) AND (operation_step IS NULL) AND (operation_evidence IS NULL)) OR ((operation_token IS NOT NULL) AND (captured_revision IS NOT NULL) AND (captured_purpose IS NOT NULL) AND (operation_phase IS NOT NULL) AND (operation_step IS NOT NULL) AND (operation_evidence IS NOT NULL)))),
    CONSTRAINT mail_message_move_sync_state_current_purpose_check CHECK ((current_purpose = ANY (ARRAY['archive'::text, 'trash'::text, 'inbox'::text, 'sent'::text]))),
    CONSTRAINT mail_message_move_sync_state_desired_purpose_check CHECK ((desired_purpose = ANY (ARRAY['archive'::text, 'trash'::text, 'inbox'::text, 'sent'::text]))),
    CONSTRAINT mail_message_move_sync_state_desired_revision_check CHECK ((desired_revision > 0)),
    CONSTRAINT mail_message_move_sync_state_restore_purpose_check CHECK ((restore_purpose = ANY (ARRAY['inbox'::text, 'sent'::text]))),
    CONSTRAINT mail_message_move_sync_state_failure_reason_check CHECK ((failure_reason = ANY (ARRAY['messageMissing'::text, 'providerRejected'::text, 'unsupportedCapability'::text]))),
    CONSTRAINT mail_message_move_sync_state_operation_evidence_check CHECK (((operation_evidence IS NULL) OR ((jsonb_typeof(operation_evidence) = 'object'::text) AND (octet_length((operation_evidence)::text) <= 8192)))),
    CONSTRAINT mail_message_move_sync_state_operation_phase_check CHECK ((operation_phase = ANY (ARRAY['in_flight'::text, 'between_steps'::text, 'uncertain'::text]))),
    CONSTRAINT mail_message_move_sync_state_operation_step_check CHECK ((operation_step = ANY (ARRAY['move'::text, 'copy'::text, 'mark_deleted'::text, 'expunge'::text, 'untrash'::text, 'modify_labels'::text, 'trash'::text]))),
    CONSTRAINT mail_message_move_sync_state_source_evidence_check CHECK (((jsonb_typeof(source_evidence) = 'object'::text) AND (octet_length((source_evidence)::text) <= 4096))),
    CONSTRAINT mail_message_move_sync_state_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'done'::text, 'failed'::text])))
);

COMMENT ON TABLE public.mail_message_move_sync_state IS 'alldots:tenancy=tenant';

ALTER TABLE ONLY public.mail_message_move_sync_state
    ADD CONSTRAINT mail_message_move_sync_state_pkey PRIMARY KEY (tenant_id, message_item_id);

ALTER TABLE ONLY public.mail_message_move_sync_state
    ADD CONSTRAINT mail_message_move_sync_state_tenant_id_operation_token_key UNIQUE (tenant_id, operation_token);

CREATE INDEX mail_message_move_sync_pending_idx ON public.mail_message_move_sync_state USING btree (tenant_id, mailbox_item_id, status);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.mail_message_move_sync_state TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- mail_oauth_states
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.mail_oauth_states (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL,
    user_id uuid NOT NULL,
    provider text NOT NULL,
    mailbox_item_id uuid,
    state_hash text NOT NULL,
    code_verifier_ciphertext bytea NOT NULL,
    code_verifier_nonce bytea NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '00:10:00'::interval) NOT NULL,
    used_at timestamp with time zone,
    services text[] NOT NULL,
    redirect_target text,
    CONSTRAINT mail_oauth_states_provider_check CHECK ((provider = ANY (ARRAY['gmail'::text, 'outlook'::text]))),
    CONSTRAINT mail_oauth_states_services_check CHECK (((cardinality(services) > 0) AND (services <@ ARRAY['mail'::text, 'calendars'::text]))),
    CONSTRAINT mail_oauth_states_redirect_target_check CHECK ((redirect_target = 'app'::text))
);

COMMENT ON TABLE public.mail_oauth_states IS 'alldots:tenancy=tenant';

ALTER TABLE ONLY public.mail_oauth_states
    ADD CONSTRAINT mail_oauth_states_pkey PRIMARY KEY (id);

CREATE UNIQUE INDEX mail_oauth_states_state_hash_uq ON public.mail_oauth_states USING btree (tenant_id, state_hash);

CREATE INDEX mail_oauth_states_tenant_expires_idx ON public.mail_oauth_states USING btree (tenant_id, expires_at);

CREATE INDEX mail_oauth_states_tenant_mailbox_idx ON public.mail_oauth_states USING btree (tenant_id, mailbox_item_id) WHERE (mailbox_item_id IS NOT NULL);

CREATE INDEX mail_oauth_states_user_idx ON public.mail_oauth_states USING btree (user_id);

-- For route_mail_oauth_state, which looks a state up before any tenant is known.
CREATE INDEX mail_oauth_states_state_hash_idx ON public.mail_oauth_states USING btree (state_hash);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.mail_oauth_states TO alldots_side;

GRANT SELECT(tenant_id) ON TABLE public.mail_oauth_states TO alldots_router;

GRANT SELECT(state_hash) ON TABLE public.mail_oauth_states TO alldots_router;

GRANT SELECT(used_at) ON TABLE public.mail_oauth_states TO alldots_router;

GRANT SELECT(expires_at) ON TABLE public.mail_oauth_states TO alldots_router;

-- ----------------------------------------------------------------------------------------------------
-- mail_sent_copies
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.mail_sent_copies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL,
    mailbox_item_id uuid NOT NULL,
    message_id text NOT NULL,
    raw bytea NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    failed_at timestamp with time zone,
    CONSTRAINT mail_sent_copies_message_id_check CHECK (((length(message_id) >= 1) AND (length(message_id) <= 998)))
);

COMMENT ON TABLE public.mail_sent_copies IS 'alldots:tenancy=tenant';

ALTER TABLE ONLY public.mail_sent_copies
    ADD CONSTRAINT mail_sent_copies_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.mail_sent_copies
    ADD CONSTRAINT mail_sent_copies_tenant_id_mailbox_item_id_message_id_key UNIQUE (tenant_id, mailbox_item_id, message_id);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.mail_sent_copies TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- mail_thread_aliases
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.mail_thread_aliases (
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL,
    from_thread_id uuid NOT NULL,
    to_thread_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT mail_thread_aliases_not_self CHECK ((from_thread_id <> to_thread_id))
);

COMMENT ON TABLE public.mail_thread_aliases IS 'alldots:tenancy=tenant';

ALTER TABLE ONLY public.mail_thread_aliases
    ADD CONSTRAINT mail_thread_aliases_pkey PRIMARY KEY (tenant_id, from_thread_id);

CREATE INDEX mail_thread_aliases_to_thread_idx ON public.mail_thread_aliases USING btree (tenant_id, to_thread_id);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.mail_thread_aliases TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- mail_thread_change_counters
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.mail_thread_change_counters (
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL,
    epoch uuid DEFAULT gen_random_uuid() NOT NULL,
    seq bigint DEFAULT 0 NOT NULL,
    reset_seq bigint DEFAULT 0 NOT NULL,
    CONSTRAINT mail_thread_change_counters_reset_seq_check CHECK ((reset_seq <= seq))
);

COMMENT ON TABLE public.mail_thread_change_counters IS 'alldots:tenancy=tenant';

COMMENT ON COLUMN public.mail_thread_change_counters.seq IS 'The tenant''s mail list change sequence: one step per committed transaction that changed a thread list row, taken under this row''s lock right before COMMIT, so its order is the commit order.';

COMMENT ON COLUMN public.mail_thread_change_counters.reset_seq IS 'The step of the last change too wide to list per thread (a mailbox''s name or addresses, a folder''s purpose); a delta cursor before it is answered with reset.';

COMMENT ON COLUMN public.mail_thread_change_counters.epoch IS 'Names this counter in a delta cursor, so a cursor of a recreated database is not read against it.';

ALTER TABLE ONLY public.mail_thread_change_counters
    ADD CONSTRAINT mail_thread_change_counters_pkey PRIMARY KEY (tenant_id);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.mail_thread_change_counters TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- mail_thread_changes
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.mail_thread_changes (
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL,
    thread_id uuid NOT NULL,
    seq bigint NOT NULL
);

COMMENT ON TABLE public.mail_thread_changes IS 'alldots:tenancy=tenant';

COMMENT ON COLUMN public.mail_thread_changes.thread_id IS 'A mail thread id, live, merged away or deleted: no foreign key, so the row outlives its thread and a delta reports it removed.';

COMMENT ON COLUMN public.mail_thread_changes.seq IS 'mail_thread_change_counters.seq of the last committed transaction that changed the thread''s list row.';

ALTER TABLE ONLY public.mail_thread_changes
    ADD CONSTRAINT mail_thread_changes_pkey PRIMARY KEY (tenant_id, thread_id);

CREATE INDEX mail_thread_changes_tenant_seq_idx ON public.mail_thread_changes USING btree (tenant_id, seq);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.mail_thread_changes TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- mail_threads
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.mail_threads (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    subject_hint text,
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL,
    item_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

COMMENT ON TABLE public.mail_threads IS 'alldots:tenancy=tenant';

ALTER TABLE ONLY public.mail_threads
    ADD CONSTRAINT mail_threads_pkey PRIMARY KEY (id);

CREATE UNIQUE INDEX mail_threads_tenant_id_id_uq ON public.mail_threads USING btree (tenant_id, id);

CREATE UNIQUE INDEX mail_threads_tenant_item_id_idx ON public.mail_threads USING btree (tenant_id, item_id) WHERE (item_id IS NOT NULL);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.mail_threads TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- manifest_drift_findings
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.manifest_drift_findings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    kind text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    dedupe_key text,
    resolved_at timestamp with time zone,
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL
);

COMMENT ON TABLE public.manifest_drift_findings IS 'alldots:tenancy=tenant';

ALTER TABLE ONLY public.manifest_drift_findings
    ADD CONSTRAINT manifest_drift_findings_pkey PRIMARY KEY (id);

CREATE UNIQUE INDEX manifest_drift_findings_tenant_active_idx ON public.manifest_drift_findings USING btree (tenant_id, kind, dedupe_key) WHERE ((resolved_at IS NULL) AND (dedupe_key IS NOT NULL));

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.manifest_drift_findings TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- mcp_server_connection_state
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.mcp_server_connection_state (
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL,
    mcp_server_item_id uuid NOT NULL,
    last_connected_at timestamp with time zone,
    last_error_reason text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT mcp_server_connection_state_last_error_reason_check CHECK (((last_error_reason IS NULL) OR (last_error_reason = ANY (ARRAY['invalid_config'::text, 'transport_not_allowed'::text, 'stdio_sandbox_unavailable'::text, 'credential_decryption_failed'::text, 'address_not_allowed'::text, 'handshake_failed'::text, 'connect_timeout'::text]))))
);

COMMENT ON TABLE public.mcp_server_connection_state IS 'alldots:tenancy=tenant';

ALTER TABLE ONLY public.mcp_server_connection_state
    ADD CONSTRAINT mcp_server_connection_state_pkey PRIMARY KEY (tenant_id, mcp_server_item_id);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.mcp_server_connection_state TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- mcp_tool_registrations
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.mcp_tool_registrations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    mcp_server_item_id uuid NOT NULL,
    tool_name text NOT NULL,
    tool_schema jsonb NOT NULL,
    description text,
    active boolean DEFAULT true NOT NULL,
    requires_approval boolean DEFAULT true NOT NULL,
    risk_class text DEFAULT 'unclassified'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL,
    display_label jsonb,
    classification_source text DEFAULT 'annotation'::text NOT NULL,
    CONSTRAINT mcp_tool_registrations_classification_source_check CHECK ((classification_source = ANY (ARRAY['annotation'::text, 'manual'::text]))),
    CONSTRAINT mcp_tool_registrations_display_label_object CHECK (((display_label IS NULL) OR (jsonb_typeof(display_label) = 'object'::text)))
);

COMMENT ON TABLE public.mcp_tool_registrations IS 'alldots:tenancy=tenant';

ALTER TABLE ONLY public.mcp_tool_registrations
    ADD CONSTRAINT mcp_tool_registrations_mcp_server_item_id_tool_name_key UNIQUE (mcp_server_item_id, tool_name);

ALTER TABLE ONLY public.mcp_tool_registrations
    ADD CONSTRAINT mcp_tool_registrations_pkey PRIMARY KEY (id);

CREATE INDEX mcp_tool_registrations_server_item_idx ON public.mcp_tool_registrations USING btree (mcp_server_item_id);

CREATE UNIQUE INDEX mcp_tool_registrations_tenant_id_id_uq ON public.mcp_tool_registrations USING btree (tenant_id, id);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.mcp_tool_registrations TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- notification_preferences
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.notification_preferences (
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL,
    user_id uuid NOT NULL,
    approvals boolean DEFAULT true NOT NULL,
    invites boolean DEFAULT true NOT NULL,
    reminders boolean DEFAULT true NOT NULL,
    problems_level text DEFAULT 'critical'::text NOT NULL,
    problems_summary boolean DEFAULT true NOT NULL,
    badge_approvals boolean DEFAULT true NOT NULL,
    badge_invites boolean DEFAULT true NOT NULL,
    badge_inbox boolean DEFAULT false NOT NULL,
    calendar_changes boolean DEFAULT true NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT notification_preferences_problems_level_check CHECK ((problems_level = ANY (ARRAY['off'::text, 'critical'::text, 'all'::text])))
);

COMMENT ON TABLE public.notification_preferences IS 'alldots:tenancy=tenant';

ALTER TABLE ONLY public.notification_preferences
    ADD CONSTRAINT notification_preferences_pkey PRIMARY KEY (tenant_id, user_id);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.notification_preferences TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- notifications
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.notifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    kind text NOT NULL,
    title text NOT NULL,
    link_href text,
    source_table text NOT NULL,
    source_id text NOT NULL,
    transition_instance text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    read_at timestamp with time zone,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL,
    resolved_at timestamp with time zone,
    body text,
    CONSTRAINT notifications_kind_check CHECK ((kind = ANY (ARRAY['approval_pending'::text, 'agent_run_error'::text, 'heartbeat_error'::text, 'automation_error'::text, 'mail_sync_error'::text, 'process_stale'::text, 'queue_backlog'::text, 'mail_sync_stalled'::text, 'backup_restore_failed'::text, 'agent_guidance_drift'::text, 'agent_guidance_drift_resolved'::text, 'semp_problem'::text, 'calendar_invitation'::text, 'calendar_event_added'::text, 'calendar_event_changed'::text, 'calendar_event_cancelled'::text, 'calendar_change_overwritten'::text])))
);

COMMENT ON TABLE public.notifications IS 'alldots:tenancy=tenant';

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);

CREATE INDEX notifications_resolved_idx ON public.notifications USING btree (tenant_id, user_id, resolved_at) WHERE (resolved_at IS NOT NULL);

CREATE UNIQUE INDEX notifications_tenant_dedupe_idx ON public.notifications USING btree (tenant_id, user_id, source_table, source_id, kind, transition_instance);

CREATE UNIQUE INDEX notifications_tenant_id_id_uq ON public.notifications USING btree (tenant_id, id);

CREATE INDEX notifications_unread_idx ON public.notifications USING btree (user_id) WHERE (read_at IS NULL);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.notifications TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- observability_checks
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.observability_checks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    check_key text NOT NULL,
    status text NOT NULL,
    detail jsonb DEFAULT '{}'::jsonb NOT NULL,
    changed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT observability_checks_status_check CHECK ((status = ANY (ARRAY['ok'::text, 'alerting'::text])))
);

COMMENT ON TABLE public.observability_checks IS 'alldots:tenancy=global';

ALTER TABLE ONLY public.observability_checks
    ADD CONSTRAINT observability_checks_check_key_key UNIQUE (check_key);

ALTER TABLE ONLY public.observability_checks
    ADD CONSTRAINT observability_checks_pkey PRIMARY KEY (id);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.observability_checks TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- password_reset_tokens
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.password_reset_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    token_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone
);

COMMENT ON TABLE public.password_reset_tokens IS 'alldots:tenancy=global';

ALTER TABLE ONLY public.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_pkey PRIMARY KEY (id);

CREATE UNIQUE INDEX password_reset_tokens_token_hash_key ON public.password_reset_tokens USING btree (token_hash);

CREATE INDEX password_reset_tokens_user_id_idx ON public.password_reset_tokens USING btree (user_id);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.password_reset_tokens TO alldots_data;

-- ----------------------------------------------------------------------------------------------------
-- person_email_index
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.person_email_index (
    email text NOT NULL,
    item_id uuid NOT NULL,
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL
);

COMMENT ON TABLE public.person_email_index IS 'alldots:tenancy=tenant';

ALTER TABLE ONLY public.person_email_index
    ADD CONSTRAINT person_email_index_pkey PRIMARY KEY (tenant_id, email);

CREATE INDEX person_email_index_item_id_idx ON public.person_email_index USING btree (item_id);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.person_email_index TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- process_heartbeats
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.process_heartbeats (
    process text NOT NULL,
    pid integer NOT NULL,
    version text NOT NULL,
    started_at timestamp with time zone NOT NULL,
    beat_at timestamp with time zone NOT NULL
);

COMMENT ON TABLE public.process_heartbeats IS 'alldots:tenancy=global';

ALTER TABLE ONLY public.process_heartbeats
    ADD CONSTRAINT process_heartbeats_pkey PRIMARY KEY (process);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.process_heartbeats TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- project_agent_guidance
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.project_agent_guidance (
    project_item_id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    markdown text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL
);

COMMENT ON TABLE public.project_agent_guidance IS 'alldots:tenancy=tenant';

ALTER TABLE ONLY public.project_agent_guidance
    ADD CONSTRAINT project_agent_guidance_pkey PRIMARY KEY (project_item_id);

CREATE INDEX project_agent_guidance_owner_user_id_idx ON public.project_agent_guidance USING btree (owner_user_id);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.project_agent_guidance TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- project_agent_guidance_versions
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.project_agent_guidance_versions (
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL,
    project_item_id uuid NOT NULL,
    last_version timestamp with time zone
);

COMMENT ON TABLE public.project_agent_guidance_versions IS 'alldots:tenancy=tenant';

ALTER TABLE ONLY public.project_agent_guidance_versions
    ADD CONSTRAINT project_agent_guidance_versions_pkey PRIMARY KEY (tenant_id, project_item_id);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.project_agent_guidance_versions TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- project_heartbeats
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.project_heartbeats (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_item_id uuid NOT NULL,
    name text NOT NULL,
    rule jsonb NOT NULL,
    action_id text NOT NULL,
    action_config jsonb DEFAULT '{}'::jsonb NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    next_fire_at timestamp with time zone,
    last_fired_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL,
    origin text DEFAULT 'system'::text NOT NULL,
    CONSTRAINT project_heartbeats_origin_check CHECK ((origin = ANY (ARRAY['user'::text, 'system'::text])))
);

COMMENT ON TABLE public.project_heartbeats IS 'alldots:tenancy=tenant';

ALTER TABLE ONLY public.project_heartbeats
    ADD CONSTRAINT project_heartbeats_pkey PRIMARY KEY (id);

CREATE INDEX project_heartbeats_due_idx ON public.project_heartbeats USING btree (next_fire_at) WHERE (enabled AND (next_fire_at IS NOT NULL));

CREATE UNIQUE INDEX project_heartbeats_guidance_drift_unique ON public.project_heartbeats USING btree (project_item_id, action_id) WHERE (action_id = 'core.agentGuidanceDrift'::text);

CREATE INDEX project_heartbeats_on_item_event_idx ON public.project_heartbeats USING btree (((rule ->> 'databaseId'::text)), ((rule ->> 'event'::text))) WHERE (enabled AND ((rule ->> 'kind'::text) = 'onItemEvent'::text));

CREATE INDEX project_heartbeats_project_idx ON public.project_heartbeats USING btree (project_item_id);

CREATE INDEX project_heartbeats_tenant_due_idx ON public.project_heartbeats USING btree (tenant_id, next_fire_at) WHERE (enabled AND (next_fire_at IS NOT NULL));

CREATE UNIQUE INDEX project_heartbeats_tenant_id_id_uq ON public.project_heartbeats USING btree (tenant_id, id);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.project_heartbeats TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- project_kept_dates
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.project_kept_dates (
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL,
    item_id uuid NOT NULL,
    kept_date jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

COMMENT ON TABLE public.project_kept_dates IS 'alldots:tenancy=tenant';

ALTER TABLE ONLY public.project_kept_dates
    ADD CONSTRAINT project_kept_dates_pkey PRIMARY KEY (tenant_id, item_id);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.project_kept_dates TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- project_mail_signals
-- ----------------------------------------------------------------------------------------------------

-- What marks a mail thread as a project's, besides the project's people: written only by the mail module
-- (`mail/projectMailSignalsStore.ts`), read by the signal match of the preview, the assignment and live triage.
CREATE TABLE public.project_mail_signals (
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL,
    project_item_id uuid NOT NULL,
    domains text[] DEFAULT '{}'::text[] NOT NULL,
    addresses text[] DEFAULT '{}'::text[] NOT NULL,
    keywords text[] DEFAULT '{}'::text[] NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT project_mail_signals_counts_check CHECK (((cardinality(domains) <= 50) AND (cardinality(addresses) <= 100) AND (cardinality(keywords) <= 50)))
);

COMMENT ON TABLE public.project_mail_signals IS 'alldots:tenancy=tenant';

COMMENT ON COLUMN public.project_mail_signals.domains IS 'Lower-case hosts without www.; a sender or recipient at the host or a subdomain of it matches. A freemail host is kept but never matches.';

COMMENT ON COLUMN public.project_mail_signals.addresses IS 'Lower-case, trimmed e-mail addresses; a sender or recipient with one of them matches.';

COMMENT ON COLUMN public.project_mail_signals.keywords IS 'Trimmed words or phrases matched against the message search text with the Czech ending rule of mail/mailSignalKeywords.ts.';

ALTER TABLE ONLY public.project_mail_signals
    ADD CONSTRAINT project_mail_signals_pkey PRIMARY KEY (tenant_id, project_item_id);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.project_mail_signals TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- project_mcp_grants
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.project_mcp_grants (
    project_item_id uuid NOT NULL,
    mcp_tool_registration_id uuid NOT NULL,
    granted boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL
);

COMMENT ON TABLE public.project_mcp_grants IS 'alldots:tenancy=tenant';

ALTER TABLE ONLY public.project_mcp_grants
    ADD CONSTRAINT project_mcp_grants_pkey PRIMARY KEY (project_item_id, mcp_tool_registration_id);

CREATE INDEX project_mcp_grants_tool_registration_idx ON public.project_mcp_grants USING btree (mcp_tool_registration_id);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.project_mcp_grants TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- properties
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.properties (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    database_id uuid NOT NULL,
    key text NOT NULL,
    name text,
    type text NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    locked boolean DEFAULT false NOT NULL,
    owner text DEFAULT 'user'::text NOT NULL,
    owner_process text,
    migration_status text DEFAULT 'stable'::text NOT NULL,
    migration_dropped_values boolean DEFAULT false NOT NULL,
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL,
    initial_position integer,
    CONSTRAINT properties_initial_position_check CHECK (((initial_position IS NULL) OR (initial_position >= 0))),
    CONSTRAINT properties_migration_status_check CHECK ((migration_status = ANY (ARRAY['stable'::text, 'pending'::text, 'running'::text, 'done'::text, 'partial'::text]))),
    CONSTRAINT properties_owner_check CHECK ((owner = ANY (ARRAY['user'::text, 'system'::text])))
);

COMMENT ON TABLE public.properties IS 'alldots:tenancy=tenant';

ALTER TABLE ONLY public.properties
    ADD CONSTRAINT properties_database_id_key_key UNIQUE (database_id, key);

ALTER TABLE ONLY public.properties
    ADD CONSTRAINT properties_pkey PRIMARY KEY (id);

CREATE UNIQUE INDEX properties_tenant_id_id_uq ON public.properties USING btree (tenant_id, id);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.properties TO alldots_data;
GRANT SELECT ON TABLE public.properties TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- push_deliveries
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.push_deliveries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    notification_id uuid NOT NULL,
    push_subscription_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    delivered_at timestamp with time zone,
    failed_permanently_at timestamp with time zone,
    last_error text,
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL
);

COMMENT ON TABLE public.push_deliveries IS 'alldots:tenancy=tenant';

ALTER TABLE ONLY public.push_deliveries
    ADD CONSTRAINT push_deliveries_pkey PRIMARY KEY (id);

CREATE INDEX push_deliveries_notification_id_idx ON public.push_deliveries USING btree (notification_id);

CREATE UNIQUE INDEX push_deliveries_pair_idx ON public.push_deliveries USING btree (notification_id, push_subscription_id);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.push_deliveries TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- push_subscriptions
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.push_subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    session_id uuid,
    channel text NOT NULL,
    platform text NOT NULL,
    endpoint text,
    p256dh text,
    auth_secret text,
    device_token text,
    apns_environment text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    CONSTRAINT push_subscriptions_apns_environment_check CHECK ((apns_environment = ANY (ARRAY['sandbox'::text, 'production'::text]))),
    CONSTRAINT push_subscriptions_channel_check CHECK ((channel = ANY (ARRAY['web_push'::text, 'apns'::text]))),
    CONSTRAINT push_subscriptions_channel_fields_chk CHECK ((((channel = 'web_push'::text) AND (endpoint IS NOT NULL) AND (p256dh IS NOT NULL) AND (auth_secret IS NOT NULL) AND (device_token IS NULL) AND (apns_environment IS NULL)) OR ((channel = 'apns'::text) AND (device_token IS NOT NULL) AND (apns_environment IS NOT NULL) AND (endpoint IS NULL) AND (p256dh IS NULL) AND (auth_secret IS NULL)))),
    CONSTRAINT push_subscriptions_channel_platform_chk CHECK ((((channel = 'web_push'::text) AND (platform = 'web'::text)) OR ((channel = 'apns'::text) AND (platform = ANY (ARRAY['ios'::text, 'macos'::text]))))),
    CONSTRAINT push_subscriptions_platform_check CHECK ((platform = ANY (ARRAY['web'::text, 'ios'::text, 'macos'::text])))
);

COMMENT ON TABLE public.push_subscriptions IS 'alldots:tenancy=global';

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_pkey PRIMARY KEY (id);

CREATE UNIQUE INDEX push_subscriptions_active_device_token_idx ON public.push_subscriptions USING btree (device_token) WHERE ((revoked_at IS NULL) AND (device_token IS NOT NULL));

CREATE UNIQUE INDEX push_subscriptions_active_endpoint_idx ON public.push_subscriptions USING btree (endpoint) WHERE ((revoked_at IS NULL) AND (endpoint IS NOT NULL));

CREATE INDEX push_subscriptions_session_id_idx ON public.push_subscriptions USING btree (session_id) WHERE (session_id IS NOT NULL);

CREATE INDEX push_subscriptions_user_id_idx ON public.push_subscriptions USING btree (user_id);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.push_subscriptions TO alldots_data;

-- ----------------------------------------------------------------------------------------------------
-- recording_requests
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.recording_requests (
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL,
    file_item_id uuid NOT NULL,
    event_item_id uuid,
    recorded_at timestamp with time zone,
    name text,
    language text,
    num_speakers_exact integer,
    num_speakers_min integer,
    project_item_id uuid,
    event_decision text DEFAULT 'none'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

COMMENT ON TABLE public.recording_requests IS 'alldots:tenancy=tenant';

ALTER TABLE ONLY public.recording_requests
    ADD CONSTRAINT recording_requests_pkey PRIMARY KEY (tenant_id, file_item_id);

CREATE INDEX recording_requests_tenant_event_item_idx ON public.recording_requests USING btree (tenant_id, event_item_id) WHERE (event_item_id IS NOT NULL);

CREATE INDEX recording_requests_tenant_project_item_idx ON public.recording_requests USING btree (tenant_id, project_item_id) WHERE (project_item_id IS NOT NULL);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.recording_requests TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- relation_definitions
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.relation_definitions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    property_id_a uuid NOT NULL,
    property_id_b uuid,
    cardinality text DEFAULT 'many_to_many'::text NOT NULL,
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL,
    CONSTRAINT relation_definitions_cardinality_check CHECK ((cardinality = ANY (ARRAY['one_to_one'::text, 'one_to_many'::text, 'many_to_many'::text])))
);

COMMENT ON TABLE public.relation_definitions IS 'alldots:tenancy=tenant';

ALTER TABLE ONLY public.relation_definitions
    ADD CONSTRAINT relation_definitions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.relation_definitions
    ADD CONSTRAINT relation_definitions_property_id_a_key UNIQUE (property_id_a);

ALTER TABLE ONLY public.relation_definitions
    ADD CONSTRAINT relation_definitions_property_id_b_key UNIQUE (property_id_b);

CREATE UNIQUE INDEX relation_definitions_tenant_id_id_uq ON public.relation_definitions USING btree (tenant_id, id);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.relation_definitions TO alldots_data;
GRANT SELECT ON TABLE public.relation_definitions TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- rollup_dependencies
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.rollup_dependencies (
    rollup_property_id uuid NOT NULL,
    relation_definition_id uuid NOT NULL,
    source_database_id uuid NOT NULL,
    source_property_key text,
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL
);

COMMENT ON TABLE public.rollup_dependencies IS 'alldots:tenancy=tenant';

ALTER TABLE ONLY public.rollup_dependencies
    ADD CONSTRAINT rollup_dependencies_pkey PRIMARY KEY (rollup_property_id);

CREATE INDEX rollup_dependencies_reldef_idx ON public.rollup_dependencies USING btree (relation_definition_id);

CREATE INDEX rollup_dependencies_source_idx ON public.rollup_dependencies USING btree (source_database_id, source_property_key);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.rollup_dependencies TO alldots_data;
GRANT SELECT ON TABLE public.rollup_dependencies TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- semp_message_speech
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.semp_message_speech (
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL,
    message_id uuid NOT NULL,
    voice text NOT NULL,
    blob_id uuid NOT NULL,
    audio_seconds double precision NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT semp_message_speech_audio_seconds_check CHECK ((audio_seconds >= (0)::double precision))
);

COMMENT ON TABLE public.semp_message_speech IS 'alldots:tenancy=tenant';

ALTER TABLE ONLY public.semp_message_speech
    ADD CONSTRAINT semp_message_speech_pkey PRIMARY KEY (tenant_id, message_id, voice);

CREATE INDEX semp_message_speech_tenant_blob_idx ON public.semp_message_speech USING btree (tenant_id, blob_id);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.semp_message_speech TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- semp_messages
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.semp_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL,
    thread_id uuid NOT NULL,
    role text NOT NULL,
    text text,
    system_key text,
    system_params jsonb,
    context jsonb DEFAULT '[]'::jsonb NOT NULL,
    reply_to_message_id uuid,
    agent_run_id uuid,
    event_from_id bigint,
    event_to_id bigint,
    status text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    error_code text,
    source text,
    search_vector tsvector,
    steps jsonb,
    duration_ms integer,
    tokens jsonb,
    changes jsonb,
    error_params jsonb,
    attempt integer DEFAULT 1 NOT NULL,
    replaced_by_message_id uuid,
    CONSTRAINT semp_messages_error_code_check CHECK (((error_code IS NULL) OR (error_code = ANY (ARRAY['budgetExceeded'::text, 'modelError'::text, 'cancelled'::text, 'interrupted'::text, 'internal'::text])))),
    CONSTRAINT semp_messages_error_params_check CHECK (((error_params IS NULL) OR (jsonb_typeof(error_params) = 'object'::text))),
    CONSTRAINT semp_messages_role_check CHECK ((role = ANY (ARRAY['user'::text, 'assistant'::text, 'system'::text]))),
    CONSTRAINT semp_messages_source_check CHECK (((source IS NULL) OR (source = 'voice'::text))),
    CONSTRAINT semp_messages_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'done'::text, 'error'::text]))),
    CONSTRAINT semp_messages_system_columns_check CHECK (((role = 'system'::text) OR ((system_key IS NULL) AND (system_params IS NULL))))
);

COMMENT ON TABLE public.semp_messages IS 'alldots:tenancy=tenant';

ALTER TABLE ONLY public.semp_messages
    ADD CONSTRAINT semp_messages_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.semp_messages
    ADD CONSTRAINT semp_messages_tenant_id_id_uq UNIQUE (tenant_id, id);

CREATE UNIQUE INDEX semp_messages_reply_attempt_uq ON public.semp_messages USING btree (tenant_id, reply_to_message_id, attempt) WHERE (role = 'assistant'::text);

CREATE INDEX semp_messages_search_vector_idx ON public.semp_messages USING gin (search_vector);

CREATE INDEX semp_messages_thread_created_idx ON public.semp_messages USING btree (tenant_id, thread_id, created_at DESC, id DESC);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.semp_messages TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- semp_problem_occurrences
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.semp_problem_occurrences (
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL,
    problem_id uuid NOT NULL,
    occurrence_key text NOT NULL
);

COMMENT ON TABLE public.semp_problem_occurrences IS 'alldots:tenancy=tenant';

ALTER TABLE ONLY public.semp_problem_occurrences
    ADD CONSTRAINT semp_problem_occurrences_pkey PRIMARY KEY (tenant_id, problem_id, occurrence_key);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.semp_problem_occurrences TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- semp_problems
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.semp_problems (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL,
    user_id uuid NOT NULL,
    category text NOT NULL,
    kind text NOT NULL,
    severity text NOT NULL,
    source_table text NOT NULL,
    source_id uuid NOT NULL,
    dedupe_key text NOT NULL,
    project_item_id uuid,
    occurrence_count integer DEFAULT 1 NOT NULL,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_occurrence_key text,
    resolved_at timestamp with time zone,
    resolution_kind text,
    CONSTRAINT semp_problems_category_check CHECK ((category = ANY (ARRAY['mail'::text, 'agents'::text, 'guidance'::text, 'automation'::text, 'transcription'::text, 'backup'::text]))),
    CONSTRAINT semp_problems_occurrence_count_check CHECK ((occurrence_count >= 1)),
    CONSTRAINT semp_problems_resolution_check CHECK (((resolved_at IS NULL) = (resolution_kind IS NULL))),
    CONSTRAINT semp_problems_severity_check CHECK ((severity = ANY (ARRAY['critical'::text, 'warning'::text])))
);

COMMENT ON TABLE public.semp_problems IS 'alldots:tenancy=tenant';

ALTER TABLE ONLY public.semp_problems
    ADD CONSTRAINT semp_problems_pkey PRIMARY KEY (id);

CREATE UNIQUE INDEX semp_problems_active_dedupe_uq ON public.semp_problems USING btree (tenant_id, dedupe_key) WHERE (resolved_at IS NULL);

CREATE INDEX semp_problems_tenant_project_item_idx ON public.semp_problems USING btree (tenant_id, project_item_id) WHERE (project_item_id IS NOT NULL);

CREATE INDEX semp_problems_tenant_active_idx ON public.semp_problems USING btree (tenant_id, last_seen_at DESC, id DESC) WHERE (resolved_at IS NULL);

CREATE UNIQUE INDEX semp_problems_tenant_id_id_uq ON public.semp_problems USING btree (tenant_id, id);

CREATE INDEX semp_problems_tenant_resolved_idx ON public.semp_problems USING btree (tenant_id, resolved_at DESC, id DESC) WHERE (resolved_at IS NOT NULL);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.semp_problems TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- semp_threads
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.semp_threads (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL,
    kind text NOT NULL,
    title text,
    title_source text DEFAULT 'auto'::text NOT NULL,
    subject_inbox_item_id uuid,
    subject_proposal_id uuid,
    heartbeat_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_activity_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT semp_threads_kind_check CHECK ((kind = ANY (ARRAY['chat'::text, 'item'::text, 'tick'::text]))),
    CONSTRAINT semp_threads_kind_columns_check CHECK ((((kind = 'chat'::text) AND (subject_inbox_item_id IS NULL) AND (subject_proposal_id IS NULL) AND (heartbeat_id IS NULL)) OR ((kind = 'item'::text) AND (subject_inbox_item_id IS NOT NULL) AND (heartbeat_id IS NULL)) OR ((kind = 'tick'::text) AND (heartbeat_id IS NOT NULL) AND (subject_inbox_item_id IS NULL) AND (subject_proposal_id IS NULL)))),
    CONSTRAINT semp_threads_title_chat_check CHECK (((title IS NULL) OR (kind = 'chat'::text))),
    CONSTRAINT semp_threads_title_source_check CHECK ((title_source = ANY (ARRAY['auto'::text, 'user'::text])))
);

COMMENT ON TABLE public.semp_threads IS 'alldots:tenancy=tenant';

ALTER TABLE ONLY public.semp_threads
    ADD CONSTRAINT semp_threads_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.semp_threads
    ADD CONSTRAINT semp_threads_tenant_id_id_uq UNIQUE (tenant_id, id);

CREATE UNIQUE INDEX semp_threads_item_subject_uq ON public.semp_threads USING btree (tenant_id, subject_inbox_item_id) WHERE (kind = 'item'::text);

CREATE INDEX semp_threads_tenant_activity_idx ON public.semp_threads USING btree (tenant_id, last_activity_at DESC, id DESC);

CREATE INDEX semp_threads_tenant_subject_proposal_idx ON public.semp_threads USING btree (tenant_id, subject_proposal_id) WHERE (subject_proposal_id IS NOT NULL);

CREATE UNIQUE INDEX semp_threads_tick_heartbeat_uq ON public.semp_threads USING btree (tenant_id, heartbeat_id) WHERE (kind = 'tick'::text);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.semp_threads TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- sessions
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    token_hash text NOT NULL,
    platform text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    user_agent text,
    revoked_at timestamp with time zone,
    device_id uuid,
    device_name text,
    device_kind text,
    os_version text,
    app_version text,
    CONSTRAINT sessions_device_kind_check CHECK ((device_kind = ANY (ARRAY['iphone'::text, 'ipad'::text, 'mac'::text, 'browser'::text]))),
    CONSTRAINT sessions_platform_check CHECK ((platform = ANY (ARRAY['web'::text, 'ios'::text, 'macos'::text])))
);

COMMENT ON TABLE public.sessions IS 'alldots:tenancy=global';

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);

CREATE INDEX sessions_active_lookup_idx ON public.sessions USING btree (token_hash, expires_at, revoked_at);

CREATE UNIQUE INDEX sessions_token_hash_key ON public.sessions USING btree (token_hash);

CREATE INDEX sessions_user_device_active_idx ON public.sessions USING btree (user_id, device_id) WHERE (revoked_at IS NULL);

CREATE INDEX sessions_user_id_idx ON public.sessions USING btree (user_id);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sessions TO alldots_data;

-- ----------------------------------------------------------------------------------------------------
-- task_recurrence
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.task_recurrence (
    item_id uuid NOT NULL,
    mode text NOT NULL,
    rule jsonb NOT NULL,
    active boolean DEFAULT true NOT NULL,
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL,
    series_id uuid,
    anchor_date date,
    template jsonb,
    trashed_active_item_id uuid,
    CONSTRAINT task_recurrence_mode_check CHECK ((mode = ANY (ARRAY['fixed'::text, 'floating'::text])))
);

COMMENT ON TABLE public.task_recurrence IS 'alldots:tenancy=tenant';

ALTER TABLE ONLY public.task_recurrence
    ADD CONSTRAINT task_recurrence_pkey PRIMARY KEY (item_id);

CREATE INDEX task_recurrence_tenant_trashed_active_item_idx ON public.task_recurrence USING btree (tenant_id, trashed_active_item_id) WHERE (trashed_active_item_id IS NOT NULL);

CREATE UNIQUE INDEX task_recurrence_tenant_series_id_uq ON public.task_recurrence USING btree (tenant_id, series_id);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.task_recurrence TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- tenant_ai_budgets
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.tenant_ai_budgets (
    tenant_id uuid NOT NULL,
    daily_cap_usd numeric,
    monthly_cap_usd numeric,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT tenant_ai_budgets_daily_cap_usd_check CHECK ((daily_cap_usd >= (0)::numeric)),
    CONSTRAINT tenant_ai_budgets_monthly_cap_usd_check CHECK ((monthly_cap_usd >= (0)::numeric))
);

COMMENT ON TABLE public.tenant_ai_budgets IS 'alldots:tenancy=global';

ALTER TABLE ONLY public.tenant_ai_budgets
    ADD CONSTRAINT tenant_ai_budgets_pkey PRIMARY KEY (tenant_id);

GRANT SELECT ON TABLE public.tenant_ai_budgets TO alldots_side;
GRANT SELECT,INSERT,UPDATE ON TABLE public.tenant_ai_budgets TO alldots_data;

-- ----------------------------------------------------------------------------------------------------
-- tenant_deletions
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.tenant_deletions (
    tenant_id uuid NOT NULL,
    requested_at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone DEFAULT now() NOT NULL
);

COMMENT ON TABLE public.tenant_deletions IS 'alldots:tenancy=global';

ALTER TABLE ONLY public.tenant_deletions
    ADD CONSTRAINT tenant_deletions_pkey PRIMARY KEY (tenant_id);

GRANT SELECT,INSERT ON TABLE public.tenant_deletions TO alldots_data;

-- ----------------------------------------------------------------------------------------------------
-- tenant_exports
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.tenant_exports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL,
    requested_by uuid NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    storage_key text,
    byte_size bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    expires_at timestamp with time zone,
    CONSTRAINT tenant_exports_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text, 'ready'::text, 'failed'::text])))
);

COMMENT ON TABLE public.tenant_exports IS 'alldots:tenancy=tenant';

ALTER TABLE ONLY public.tenant_exports
    ADD CONSTRAINT tenant_exports_pkey PRIMARY KEY (id);

CREATE UNIQUE INDEX tenant_exports_active_uq ON public.tenant_exports USING btree (tenant_id) WHERE (status = ANY (ARRAY['pending'::text, 'running'::text]));

CREATE INDEX tenant_exports_tenant_created_idx ON public.tenant_exports USING btree (tenant_id, created_at DESC);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.tenant_exports TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- tenant_keys
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.tenant_keys (
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL,
    wrapped_key bytea NOT NULL,
    wrap_nonce bytea NOT NULL,
    master_key_version smallint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

COMMENT ON TABLE public.tenant_keys IS 'alldots:tenancy=tenant';

ALTER TABLE ONLY public.tenant_keys
    ADD CONSTRAINT tenant_keys_pkey PRIMARY KEY (tenant_id);

GRANT SELECT,INSERT,DELETE ON TABLE public.tenant_keys TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- tenant_observability_checks
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.tenant_observability_checks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL,
    check_key text NOT NULL,
    status text NOT NULL,
    detail jsonb DEFAULT '{}'::jsonb NOT NULL,
    changed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tenant_observability_checks_status_check CHECK ((status = ANY (ARRAY['ok'::text, 'alerting'::text])))
);

COMMENT ON TABLE public.tenant_observability_checks IS 'alldots:tenancy=tenant';

ALTER TABLE ONLY public.tenant_observability_checks
    ADD CONSTRAINT tenant_observability_checks_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.tenant_observability_checks
    ADD CONSTRAINT tenant_observability_checks_tenant_id_check_key_key UNIQUE (tenant_id, check_key);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.tenant_observability_checks TO alldots_side;

GRANT SELECT(status) ON TABLE public.tenant_observability_checks TO alldots_router;

-- ----------------------------------------------------------------------------------------------------
-- tenants
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.tenants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    status text DEFAULT 'provisioning'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    status_changed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tenants_status_check CHECK ((status = ANY (ARRAY['provisioning'::text, 'active'::text, 'suspended'::text, 'deleting'::text])))
);

COMMENT ON TABLE public.tenants IS 'alldots:tenancy=global';

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT tenants_pkey PRIMARY KEY (id);

GRANT SELECT ON TABLE public.tenants TO alldots_side;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.tenants TO alldots_data;

-- ----------------------------------------------------------------------------------------------------
-- transcript_action_item_states
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.transcript_action_item_states (
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL,
    transcript_item_id uuid NOT NULL,
    action_item_id integer NOT NULL,
    state text NOT NULL,
    task_item_id uuid,
    owner_person_id uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT transcript_action_item_states_action_item_id_check CHECK ((action_item_id >= 0)),
    CONSTRAINT transcript_action_item_states_state_check CHECK ((state = ANY (ARRAY['added'::text, 'noted'::text, 'dismissed'::text])))
);

COMMENT ON TABLE public.transcript_action_item_states IS 'alldots:tenancy=tenant';

ALTER TABLE ONLY public.transcript_action_item_states
    ADD CONSTRAINT transcript_action_item_states_pkey PRIMARY KEY (tenant_id, transcript_item_id, action_item_id);

CREATE INDEX transcript_action_item_states_tenant_owner_person_idx ON public.transcript_action_item_states USING btree (tenant_id, owner_person_id) WHERE (owner_person_id IS NOT NULL);

CREATE INDEX transcript_action_item_states_tenant_task_item_idx ON public.transcript_action_item_states USING btree (tenant_id, task_item_id) WHERE (task_item_id IS NOT NULL);

GRANT SELECT ON TABLE public.transcript_action_item_states TO alldots_side;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.transcript_action_item_states TO alldots_data;

-- ----------------------------------------------------------------------------------------------------
-- users
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    email text NOT NULL,
    password_hash text NOT NULL,
    locale text DEFAULT 'cs'::text NOT NULL,
    tenant_id uuid NOT NULL,
    role text DEFAULT 'member'::text NOT NULL,
    display_name text,
    CONSTRAINT users_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'member'::text])))
);

COMMENT ON TABLE public.users IS 'alldots:tenancy=global';

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

CREATE UNIQUE INDEX users_email_key ON public.users USING btree (email);

CREATE UNIQUE INDEX users_tenant_id_id_uq ON public.users USING btree (tenant_id, id);

CREATE UNIQUE INDEX users_tenant_id_key ON public.users USING btree (tenant_id);

GRANT SELECT ON TABLE public.users TO alldots_side;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.users TO alldots_data;

-- ----------------------------------------------------------------------------------------------------
-- value_link_sources
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.value_link_sources (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL,
    link_id uuid NOT NULL,
    source_kind text NOT NULL,
    source_item_id uuid,
    source_property_key text NOT NULL,
    domain text,
    CONSTRAINT value_link_sources_kind_columns_check CHECK ((((source_kind = 'item'::text) AND (source_item_id IS NOT NULL) AND (domain IS NULL)) OR ((source_kind = 'senderDomain'::text) AND (domain IS NOT NULL) AND (source_item_id IS NULL)))),
    CONSTRAINT value_link_sources_source_kind_check CHECK ((source_kind = ANY (ARRAY['item'::text, 'senderDomain'::text])))
);

COMMENT ON TABLE public.value_link_sources IS 'alldots:tenancy=tenant';

ALTER TABLE ONLY public.value_link_sources
    ADD CONSTRAINT value_link_sources_pkey PRIMARY KEY (id);

CREATE UNIQUE INDEX value_link_sources_domain_uq ON public.value_link_sources USING btree (tenant_id, link_id, domain, source_property_key) WHERE (source_kind = 'senderDomain'::text);

CREATE UNIQUE INDEX value_link_sources_item_uq ON public.value_link_sources USING btree (tenant_id, link_id, source_item_id, source_property_key) WHERE (source_kind = 'item'::text);

CREATE INDEX value_link_sources_source_item_idx ON public.value_link_sources USING btree (tenant_id, source_item_id);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.value_link_sources TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- value_links
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.value_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL,
    item_id uuid NOT NULL,
    property_key text NOT NULL,
    rule_key text NOT NULL,
    state text DEFAULT 'on'::text NOT NULL,
    broken_by text,
    broken_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT value_links_broken_by_check CHECK ((broken_by = ANY (ARRAY['user'::text, 'agent'::text]))),
    CONSTRAINT value_links_state_check CHECK ((state = ANY (ARRAY['on'::text, 'broken'::text]))),
    CONSTRAINT value_links_state_columns_check CHECK ((((state = 'on'::text) AND (broken_by IS NULL) AND (broken_at IS NULL)) OR ((state = 'broken'::text) AND (broken_by IS NOT NULL) AND (broken_at IS NOT NULL))))
);

COMMENT ON TABLE public.value_links IS 'alldots:tenancy=tenant';

ALTER TABLE ONLY public.value_links
    ADD CONSTRAINT value_links_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.value_links
    ADD CONSTRAINT value_links_tenant_id_id_uq UNIQUE (tenant_id, id);

ALTER TABLE ONLY public.value_links
    ADD CONSTRAINT value_links_tenant_item_property_uq UNIQUE (tenant_id, item_id, property_key);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.value_links TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- view_items
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.view_items (
    view_id uuid NOT NULL,
    item_id uuid NOT NULL,
    "position" integer NOT NULL,
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL
);

COMMENT ON TABLE public.view_items IS 'alldots:tenancy=tenant';

ALTER TABLE ONLY public.view_items
    ADD CONSTRAINT view_items_pkey PRIMARY KEY (view_id, item_id);

CREATE INDEX view_items_item_id_idx ON public.view_items USING btree (item_id);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.view_items TO alldots_data;
GRANT SELECT ON TABLE public.view_items TO alldots_side;

-- ----------------------------------------------------------------------------------------------------
-- views
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.views (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    database_id uuid,
    type text NOT NULL,
    name text NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    owner_module_id text,
    created_by text DEFAULT 'user'::text NOT NULL,
    creator_project_item_id uuid,
    tenant_id uuid DEFAULT public.app_tenant_default() NOT NULL,
    CONSTRAINT views_created_by_check CHECK ((created_by = ANY (ARRAY['user'::text, 'ai_agent'::text, 'system'::text]))),
    CONSTRAINT views_curated_no_db CHECK (((database_id IS NULL) = (NOT ((config ->> 'membership'::text) IS DISTINCT FROM 'manual'::text))))
);

COMMENT ON TABLE public.views IS 'alldots:tenancy=tenant';

ALTER TABLE ONLY public.views
    ADD CONSTRAINT views_pkey PRIMARY KEY (id);

CREATE INDEX views_creator_project_item_id_idx ON public.views USING btree (creator_project_item_id);

CREATE UNIQUE INDEX views_database_system_key_uq ON public.views USING btree (database_id, ((config ->> 'systemKey'::text))) WHERE (config ? 'systemKey'::text);

CREATE UNIQUE INDEX views_one_default_per_db ON public.views USING btree (database_id) WHERE is_default;

CREATE UNIQUE INDEX views_tenant_id_id_uq ON public.views USING btree (tenant_id, id);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.views TO alldots_data;
GRANT SELECT ON TABLE public.views TO alldots_side;

-- ====================================================================================================
-- Foreign keys
-- ====================================================================================================

ALTER TABLE ONLY public.agent_database_grants
    ADD CONSTRAINT agent_database_grants_database_fkey FOREIGN KEY (tenant_id, database_id) REFERENCES public.databases(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.agent_database_grants
    ADD CONSTRAINT agent_database_grants_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.agent_guidance_drift_findings
    ADD CONSTRAINT agent_guidance_drift_findings_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.users(id);

ALTER TABLE ONLY public.agent_guidance_drift_findings
    ADD CONSTRAINT agent_guidance_drift_findings_resolved_by_tenant_fkey FOREIGN KEY (tenant_id, resolved_by) REFERENCES public.users(tenant_id, id);

ALTER TABLE ONLY public.agent_guidance_drift_findings
    ADD CONSTRAINT agent_guidance_drift_findings_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.agent_run_events
    ADD CONSTRAINT agent_run_events_agent_run_id_fkey FOREIGN KEY (agent_run_id) REFERENCES public.agent_runs(id);

ALTER TABLE ONLY public.agent_run_events
    ADD CONSTRAINT agent_run_events_agent_run_id_tenant_fkey FOREIGN KEY (tenant_id, agent_run_id) REFERENCES public.agent_runs(tenant_id, id);

ALTER TABLE ONLY public.agent_run_events
    ADD CONSTRAINT agent_run_events_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.agent_run_mcp_credentials
    ADD CONSTRAINT agent_run_mcp_credentials_agent_run_id_fkey FOREIGN KEY (agent_run_id) REFERENCES public.agent_runs(id);

ALTER TABLE ONLY public.agent_run_mcp_credentials
    ADD CONSTRAINT agent_run_mcp_credentials_agent_run_id_tenant_fkey FOREIGN KEY (tenant_id, agent_run_id) REFERENCES public.agent_runs(tenant_id, id);

ALTER TABLE ONLY public.agent_run_mcp_credentials
    ADD CONSTRAINT agent_run_mcp_credentials_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.agent_run_read_allowances
    ADD CONSTRAINT agent_run_read_allowances_agent_run_fkey FOREIGN KEY (tenant_id, agent_run_id) REFERENCES public.agent_runs(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.agent_run_read_allowances
    ADD CONSTRAINT agent_run_read_allowances_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.agent_runs
    ADD CONSTRAINT agent_runs_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES public.users(id);

ALTER TABLE ONLY public.agent_runs
    ADD CONSTRAINT agent_runs_actor_user_id_tenant_fkey FOREIGN KEY (tenant_id, actor_user_id) REFERENCES public.users(tenant_id, id);

ALTER TABLE ONLY public.agent_runs
    ADD CONSTRAINT agent_runs_heartbeat_id_fkey FOREIGN KEY (heartbeat_id) REFERENCES public.project_heartbeats(id);

ALTER TABLE ONLY public.agent_runs
    ADD CONSTRAINT agent_runs_heartbeat_id_tenant_fkey FOREIGN KEY (tenant_id, heartbeat_id) REFERENCES public.project_heartbeats(tenant_id, id);

ALTER TABLE ONLY public.agent_runs
    ADD CONSTRAINT agent_runs_heartbeat_occurrence_id_fkey FOREIGN KEY (tenant_id, heartbeat_occurrence_id) REFERENCES public.heartbeat_occurrences(tenant_id, id);

ALTER TABLE ONLY public.agent_runs
    ADD CONSTRAINT agent_runs_parent_run_id_fkey FOREIGN KEY (parent_run_id) REFERENCES public.agent_runs(id);

ALTER TABLE ONLY public.agent_runs
    ADD CONSTRAINT agent_runs_parent_run_id_tenant_fkey FOREIGN KEY (tenant_id, parent_run_id) REFERENCES public.agent_runs(tenant_id, id);

ALTER TABLE ONLY public.agent_runs
    ADD CONSTRAINT agent_runs_retry_of_run_id_fkey FOREIGN KEY (tenant_id, retry_of_run_id) REFERENCES public.agent_runs(tenant_id, id);

ALTER TABLE ONLY public.agent_runs
    ADD CONSTRAINT agent_runs_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.agent_runs
    ADD CONSTRAINT agent_runs_thread_id_fkey FOREIGN KEY (tenant_id, thread_id) REFERENCES public.semp_threads(tenant_id, id) ON DELETE SET NULL (thread_id);

ALTER TABLE ONLY public.ai_gateway_calls
    ADD CONSTRAINT ai_gateway_calls_agent_run_id_fkey FOREIGN KEY (agent_run_id) REFERENCES public.agent_runs(id);

ALTER TABLE ONLY public.ai_gateway_calls
    ADD CONSTRAINT ai_gateway_calls_agent_run_id_tenant_fkey FOREIGN KEY (tenant_id, agent_run_id) REFERENCES public.agent_runs(tenant_id, id);

ALTER TABLE ONLY public.ai_gateway_calls
    ADD CONSTRAINT ai_gateway_calls_semp_message_id_tenant_fkey FOREIGN KEY (tenant_id, semp_message_id) REFERENCES public.semp_messages(tenant_id, id);

ALTER TABLE ONLY public.ai_gateway_calls
    ADD CONSTRAINT ai_gateway_calls_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.approval_requests
    ADD CONSTRAINT approval_requests_agent_run_id_fkey FOREIGN KEY (agent_run_id) REFERENCES public.agent_runs(id);

ALTER TABLE ONLY public.approval_requests
    ADD CONSTRAINT approval_requests_agent_run_id_tenant_fkey FOREIGN KEY (tenant_id, agent_run_id) REFERENCES public.agent_runs(tenant_id, id);

ALTER TABLE ONLY public.approval_requests
    ADD CONSTRAINT approval_requests_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES public.users(id);

ALTER TABLE ONLY public.approval_requests
    ADD CONSTRAINT approval_requests_decided_by_tenant_fkey FOREIGN KEY (tenant_id, decided_by) REFERENCES public.users(tenant_id, id);

ALTER TABLE ONLY public.approval_requests
    ADD CONSTRAINT approval_requests_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.blobs
    ADD CONSTRAINT blobs_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.calendar_account_sync_state
    ADD CONSTRAINT calendar_account_sync_state_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.calendar_event_push_state
    ADD CONSTRAINT calendar_event_push_state_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.calendar_feed_state
    ADD CONSTRAINT calendar_feed_state_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.calendar_push_channels
    ADD CONSTRAINT calendar_push_channels_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.calendar_remote_state
    ADD CONSTRAINT calendar_remote_state_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.event_remote_state
    ADD CONSTRAINT event_remote_state_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.credential_access_log
    ADD CONSTRAINT credential_access_log_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.databases
    ADD CONSTRAINT databases_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.doc_history_updates
    ADD CONSTRAINT doc_history_updates_doc_id_fkey FOREIGN KEY (doc_id) REFERENCES public.docs(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.doc_history_updates
    ADD CONSTRAINT doc_history_updates_doc_id_tenant_fkey FOREIGN KEY (tenant_id, doc_id) REFERENCES public.docs(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.doc_history_updates
    ADD CONSTRAINT doc_history_updates_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.doc_snapshot_history
    ADD CONSTRAINT doc_snapshot_history_doc_id_fkey FOREIGN KEY (doc_id) REFERENCES public.docs(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.doc_snapshot_history
    ADD CONSTRAINT doc_snapshot_history_doc_id_tenant_fkey FOREIGN KEY (tenant_id, doc_id) REFERENCES public.docs(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.doc_snapshot_history
    ADD CONSTRAINT doc_snapshot_history_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.doc_snapshots
    ADD CONSTRAINT doc_snapshots_doc_id_fkey FOREIGN KEY (doc_id) REFERENCES public.docs(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.doc_snapshots
    ADD CONSTRAINT doc_snapshots_doc_id_tenant_fkey FOREIGN KEY (tenant_id, doc_id) REFERENCES public.docs(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.doc_snapshots
    ADD CONSTRAINT doc_snapshots_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.doc_updates
    ADD CONSTRAINT doc_updates_doc_id_fkey FOREIGN KEY (doc_id) REFERENCES public.docs(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.doc_updates
    ADD CONSTRAINT doc_updates_doc_id_tenant_fkey FOREIGN KEY (tenant_id, doc_id) REFERENCES public.docs(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.doc_updates
    ADD CONSTRAINT doc_updates_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.docs
    ADD CONSTRAINT docs_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.external_credentials
    ADD CONSTRAINT external_credentials_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.heartbeat_occurrences
    ADD CONSTRAINT heartbeat_occurrences_heartbeat_id_fkey FOREIGN KEY (heartbeat_id) REFERENCES public.project_heartbeats(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.heartbeat_occurrences
    ADD CONSTRAINT heartbeat_occurrences_heartbeat_id_tenant_fkey FOREIGN KEY (tenant_id, heartbeat_id) REFERENCES public.project_heartbeats(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.heartbeat_occurrences
    ADD CONSTRAINT heartbeat_occurrences_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.idempotency_keys
    ADD CONSTRAINT idempotency_keys_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.idempotent_responses
    ADD CONSTRAINT idempotent_responses_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.inbox_attachments
    ADD CONSTRAINT inbox_attachments_blob_id_fkey FOREIGN KEY (blob_id) REFERENCES public.blobs(id);

ALTER TABLE ONLY public.inbox_attachments
    ADD CONSTRAINT inbox_attachments_blob_id_tenant_fkey FOREIGN KEY (tenant_id, blob_id) REFERENCES public.blobs(tenant_id, id);

ALTER TABLE ONLY public.inbox_attachments
    ADD CONSTRAINT inbox_attachments_reduced_blob_id_fkey FOREIGN KEY (tenant_id, reduced_blob_id) REFERENCES public.blobs(tenant_id, id);

ALTER TABLE ONLY public.inbox_attachments
    ADD CONSTRAINT inbox_attachments_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.inbox_attachments
    ADD CONSTRAINT inbox_attachments_thumbnail_blob_id_fkey FOREIGN KEY (tenant_id, thumbnail_blob_id) REFERENCES public.blobs(tenant_id, id);

ALTER TABLE ONLY public.invites
    ADD CONSTRAINT invites_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.item_automation
    ADD CONSTRAINT item_automation_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.item_origins
    ADD CONSTRAINT item_origins_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.item_relations
    ADD CONSTRAINT item_relations_relation_definition_id_fkey FOREIGN KEY (relation_definition_id) REFERENCES public.relation_definitions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.item_relations
    ADD CONSTRAINT item_relations_relation_definition_id_tenant_fkey FOREIGN KEY (tenant_id, relation_definition_id) REFERENCES public.relation_definitions(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.item_relations
    ADD CONSTRAINT item_relations_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.item_search_index
    ADD CONSTRAINT item_search_index_database_id_fkey FOREIGN KEY (database_id) REFERENCES public.databases(id);

ALTER TABLE ONLY public.item_search_index
    ADD CONSTRAINT item_search_index_database_id_tenant_fkey FOREIGN KEY (tenant_id, database_id) REFERENCES public.databases(tenant_id, id);

ALTER TABLE ONLY public.item_search_index
    ADD CONSTRAINT item_search_index_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.items
    ADD CONSTRAINT items_database_id_fkey FOREIGN KEY (database_id) REFERENCES public.databases(id);

ALTER TABLE ONLY public.items
    ADD CONSTRAINT items_database_id_tenant_fkey FOREIGN KEY (tenant_id, database_id) REFERENCES public.databases(tenant_id, id);

ALTER TABLE ONLY public.items
    ADD CONSTRAINT items_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.library_cover_candidates
    ADD CONSTRAINT library_cover_candidates_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.mail_account_server_settings
    ADD CONSTRAINT mail_account_server_settings_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.mail_account_sync_state
    ADD CONSTRAINT mail_account_sync_state_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.mail_attachments
    ADD CONSTRAINT mail_attachments_blob_id_fkey FOREIGN KEY (blob_id) REFERENCES public.blobs(id);

ALTER TABLE ONLY public.mail_attachments
    ADD CONSTRAINT mail_attachments_blob_id_tenant_fkey FOREIGN KEY (tenant_id, blob_id) REFERENCES public.blobs(tenant_id, id);

ALTER TABLE ONLY public.mail_attachments
    ADD CONSTRAINT mail_attachments_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.mail_drafts
    ADD CONSTRAINT mail_drafts_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.mail_folder_sync_state
    ADD CONSTRAINT mail_folder_sync_state_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.mail_message_content_cache
    ADD CONSTRAINT mail_message_content_cache_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.mail_message_flag_sync_state
    ADD CONSTRAINT mail_message_flag_sync_state_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.mail_message_meta
    ADD CONSTRAINT mail_message_meta_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.mail_message_meta
    ADD CONSTRAINT mail_message_meta_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.mail_threads(id);

ALTER TABLE ONLY public.mail_message_meta
    ADD CONSTRAINT mail_message_meta_thread_id_tenant_fkey FOREIGN KEY (tenant_id, thread_id) REFERENCES public.mail_threads(tenant_id, id);

ALTER TABLE ONLY public.mail_message_move_sync_state
    ADD CONSTRAINT mail_message_move_sync_state_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.mail_oauth_states
    ADD CONSTRAINT mail_oauth_states_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.mail_oauth_states
    ADD CONSTRAINT mail_oauth_states_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.mail_oauth_states
    ADD CONSTRAINT mail_oauth_states_user_id_tenant_fkey FOREIGN KEY (tenant_id, user_id) REFERENCES public.users(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.mail_sent_copies
    ADD CONSTRAINT mail_sent_copies_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.mail_thread_aliases
    ADD CONSTRAINT mail_thread_aliases_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.mail_thread_aliases
    ADD CONSTRAINT mail_thread_aliases_to_thread_fkey FOREIGN KEY (tenant_id, to_thread_id) REFERENCES public.mail_threads(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.mail_thread_change_counters
    ADD CONSTRAINT mail_thread_change_counters_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.mail_thread_changes
    ADD CONSTRAINT mail_thread_changes_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.mail_threads
    ADD CONSTRAINT mail_threads_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.manifest_drift_findings
    ADD CONSTRAINT manifest_drift_findings_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.mcp_server_connection_state
    ADD CONSTRAINT mcp_server_connection_state_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.mcp_tool_registrations
    ADD CONSTRAINT mcp_tool_registrations_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.notification_preferences
    ADD CONSTRAINT notification_preferences_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.notification_preferences
    ADD CONSTRAINT notification_preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);

ALTER TABLE ONLY public.notification_preferences
    ADD CONSTRAINT notification_preferences_user_id_tenant_fkey FOREIGN KEY (tenant_id, user_id) REFERENCES public.users(tenant_id, id);

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_user_id_tenant_fkey FOREIGN KEY (tenant_id, user_id) REFERENCES public.users(tenant_id, id);

ALTER TABLE ONLY public.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);

ALTER TABLE ONLY public.person_email_index
    ADD CONSTRAINT person_email_index_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.project_agent_guidance
    ADD CONSTRAINT project_agent_guidance_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);

ALTER TABLE ONLY public.project_agent_guidance
    ADD CONSTRAINT project_agent_guidance_owner_user_id_tenant_fkey FOREIGN KEY (tenant_id, owner_user_id) REFERENCES public.users(tenant_id, id);

ALTER TABLE ONLY public.project_agent_guidance
    ADD CONSTRAINT project_agent_guidance_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.project_agent_guidance_versions
    ADD CONSTRAINT project_agent_guidance_versions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.project_heartbeats
    ADD CONSTRAINT project_heartbeats_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.project_kept_dates
    ADD CONSTRAINT project_kept_dates_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.project_mcp_grants
    ADD CONSTRAINT project_mcp_grants_mcp_tool_registration_id_fkey FOREIGN KEY (mcp_tool_registration_id) REFERENCES public.mcp_tool_registrations(id);

ALTER TABLE ONLY public.project_mcp_grants
    ADD CONSTRAINT project_mcp_grants_mcp_tool_registration_id_tenant_fkey FOREIGN KEY (tenant_id, mcp_tool_registration_id) REFERENCES public.mcp_tool_registrations(tenant_id, id);

ALTER TABLE ONLY public.project_mail_signals
    ADD CONSTRAINT project_mail_signals_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.project_mcp_grants
    ADD CONSTRAINT project_mcp_grants_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.properties
    ADD CONSTRAINT properties_database_id_fkey FOREIGN KEY (database_id) REFERENCES public.databases(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.properties
    ADD CONSTRAINT properties_database_id_tenant_fkey FOREIGN KEY (tenant_id, database_id) REFERENCES public.databases(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.properties
    ADD CONSTRAINT properties_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.push_deliveries
    ADD CONSTRAINT push_deliveries_notification_id_fkey FOREIGN KEY (notification_id) REFERENCES public.notifications(id);

ALTER TABLE ONLY public.push_deliveries
    ADD CONSTRAINT push_deliveries_notification_id_tenant_fkey FOREIGN KEY (tenant_id, notification_id) REFERENCES public.notifications(tenant_id, id);

ALTER TABLE ONLY public.push_deliveries
    ADD CONSTRAINT push_deliveries_push_subscription_id_fkey FOREIGN KEY (push_subscription_id) REFERENCES public.push_subscriptions(id);

ALTER TABLE ONLY public.push_deliveries
    ADD CONSTRAINT push_deliveries_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.sessions(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);

ALTER TABLE ONLY public.recording_requests
    ADD CONSTRAINT recording_requests_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.relation_definitions
    ADD CONSTRAINT relation_definitions_property_id_a_fkey FOREIGN KEY (property_id_a) REFERENCES public.properties(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.relation_definitions
    ADD CONSTRAINT relation_definitions_property_id_a_tenant_fkey FOREIGN KEY (tenant_id, property_id_a) REFERENCES public.properties(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.relation_definitions
    ADD CONSTRAINT relation_definitions_property_id_b_fkey FOREIGN KEY (property_id_b) REFERENCES public.properties(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.relation_definitions
    ADD CONSTRAINT relation_definitions_property_id_b_tenant_fkey FOREIGN KEY (tenant_id, property_id_b) REFERENCES public.properties(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.relation_definitions
    ADD CONSTRAINT relation_definitions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.rollup_dependencies
    ADD CONSTRAINT rollup_dependencies_relation_definition_id_fkey FOREIGN KEY (relation_definition_id) REFERENCES public.relation_definitions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.rollup_dependencies
    ADD CONSTRAINT rollup_dependencies_relation_definition_id_tenant_fkey FOREIGN KEY (tenant_id, relation_definition_id) REFERENCES public.relation_definitions(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.rollup_dependencies
    ADD CONSTRAINT rollup_dependencies_rollup_property_id_fkey FOREIGN KEY (rollup_property_id) REFERENCES public.properties(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.rollup_dependencies
    ADD CONSTRAINT rollup_dependencies_rollup_property_id_tenant_fkey FOREIGN KEY (tenant_id, rollup_property_id) REFERENCES public.properties(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.rollup_dependencies
    ADD CONSTRAINT rollup_dependencies_source_database_id_fkey FOREIGN KEY (source_database_id) REFERENCES public.databases(id);

ALTER TABLE ONLY public.rollup_dependencies
    ADD CONSTRAINT rollup_dependencies_source_database_id_tenant_fkey FOREIGN KEY (tenant_id, source_database_id) REFERENCES public.databases(tenant_id, id);

ALTER TABLE ONLY public.rollup_dependencies
    ADD CONSTRAINT rollup_dependencies_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.semp_message_speech
    ADD CONSTRAINT semp_message_speech_blob_fkey FOREIGN KEY (tenant_id, blob_id) REFERENCES public.blobs(tenant_id, id);

ALTER TABLE ONLY public.semp_message_speech
    ADD CONSTRAINT semp_message_speech_message_fkey FOREIGN KEY (tenant_id, message_id) REFERENCES public.semp_messages(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.semp_message_speech
    ADD CONSTRAINT semp_message_speech_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.semp_messages
    ADD CONSTRAINT semp_messages_agent_run_fkey FOREIGN KEY (tenant_id, agent_run_id) REFERENCES public.agent_runs(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.semp_messages
    ADD CONSTRAINT semp_messages_replaced_by_fkey FOREIGN KEY (tenant_id, replaced_by_message_id) REFERENCES public.semp_messages(tenant_id, id);

ALTER TABLE ONLY public.semp_messages
    ADD CONSTRAINT semp_messages_reply_to_fkey FOREIGN KEY (tenant_id, reply_to_message_id) REFERENCES public.semp_messages(tenant_id, id);

ALTER TABLE ONLY public.semp_messages
    ADD CONSTRAINT semp_messages_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.semp_messages
    ADD CONSTRAINT semp_messages_thread_fkey FOREIGN KEY (tenant_id, thread_id) REFERENCES public.semp_threads(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.semp_problem_occurrences
    ADD CONSTRAINT semp_problem_occurrences_problem_id_fkey FOREIGN KEY (problem_id) REFERENCES public.semp_problems(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.semp_problem_occurrences
    ADD CONSTRAINT semp_problem_occurrences_problem_id_tenant_fkey FOREIGN KEY (tenant_id, problem_id) REFERENCES public.semp_problems(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.semp_problem_occurrences
    ADD CONSTRAINT semp_problem_occurrences_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.semp_problems
    ADD CONSTRAINT semp_problems_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.semp_problems
    ADD CONSTRAINT semp_problems_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);

ALTER TABLE ONLY public.semp_problems
    ADD CONSTRAINT semp_problems_user_id_tenant_fkey FOREIGN KEY (tenant_id, user_id) REFERENCES public.users(tenant_id, id);

ALTER TABLE ONLY public.semp_threads
    ADD CONSTRAINT semp_threads_heartbeat_fkey FOREIGN KEY (tenant_id, heartbeat_id) REFERENCES public.project_heartbeats(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.semp_threads
    ADD CONSTRAINT semp_threads_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);

ALTER TABLE ONLY public.task_recurrence
    ADD CONSTRAINT task_recurrence_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.tenant_ai_budgets
    ADD CONSTRAINT tenant_ai_budgets_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.tenant_ai_budgets
    ADD CONSTRAINT tenant_ai_budgets_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.tenant_exports
    ADD CONSTRAINT tenant_exports_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.users(id);

ALTER TABLE ONLY public.tenant_exports
    ADD CONSTRAINT tenant_exports_requested_by_tenant_fkey FOREIGN KEY (tenant_id, requested_by) REFERENCES public.users(tenant_id, id);

ALTER TABLE ONLY public.tenant_exports
    ADD CONSTRAINT tenant_exports_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.tenant_keys
    ADD CONSTRAINT tenant_keys_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.tenant_observability_checks
    ADD CONSTRAINT tenant_observability_checks_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.transcript_action_item_states
    ADD CONSTRAINT transcript_action_item_states_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.value_link_sources
    ADD CONSTRAINT value_link_sources_link_fkey FOREIGN KEY (tenant_id, link_id) REFERENCES public.value_links(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.value_link_sources
    ADD CONSTRAINT value_link_sources_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.value_links
    ADD CONSTRAINT value_links_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.view_items
    ADD CONSTRAINT view_items_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.view_items
    ADD CONSTRAINT view_items_view_id_fkey FOREIGN KEY (view_id) REFERENCES public.views(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.view_items
    ADD CONSTRAINT view_items_view_id_tenant_fkey FOREIGN KEY (tenant_id, view_id) REFERENCES public.views(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.views
    ADD CONSTRAINT views_database_id_fkey FOREIGN KEY (database_id) REFERENCES public.databases(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.views
    ADD CONSTRAINT views_database_id_tenant_fkey FOREIGN KEY (tenant_id, database_id) REFERENCES public.databases(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.views
    ADD CONSTRAINT views_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

-- ----------------------------------------------------------------------------------------------------
-- Foreign keys to items
--
-- Every key names (tenant_id, <column>) against items (tenant_id, id), so another tenant's item id fails exactly like
-- a random one. Every key is checked at commit (DEFERRABLE INITIALLY DEFERRED): a dependent row written before its
-- item (an idempotency reservation), or before the writer locks the item, takes no lock on the item ahead of the
-- writer's own row lock, and the purge may delete an item before the dependents its owners remove. Delete actions
-- (CASCADE, SET NULL) still run at the statement. The behaviour of each column, and why some item columns carry no
-- key, is the decision table in docs/architecture/data-model-and-writes.md (Storage).
-- ----------------------------------------------------------------------------------------------------

-- Derived or bookkeeping rows whose removal has no side effect: they go with their item.
ALTER TABLE ONLY public.agent_database_grants
    ADD CONSTRAINT agent_database_grants_project_item_id_tenant_fkey FOREIGN KEY (tenant_id, project_item_id) REFERENCES public.items(tenant_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.calendar_account_sync_state
    ADD CONSTRAINT calendar_account_sync_state_account_item_id_tenant_fkey FOREIGN KEY (tenant_id, account_item_id) REFERENCES public.items(tenant_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.calendar_event_push_state
    ADD CONSTRAINT calendar_event_push_state_event_item_id_tenant_fkey FOREIGN KEY (tenant_id, event_item_id) REFERENCES public.items(tenant_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.calendar_feed_state
    ADD CONSTRAINT calendar_feed_state_calendar_item_id_tenant_fkey FOREIGN KEY (tenant_id, calendar_item_id) REFERENCES public.items(tenant_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.calendar_push_channels
    ADD CONSTRAINT calendar_push_channels_account_item_id_tenant_fkey FOREIGN KEY (tenant_id, account_item_id) REFERENCES public.items(tenant_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.calendar_push_channels
    ADD CONSTRAINT calendar_push_channels_calendar_item_id_tenant_fkey FOREIGN KEY (tenant_id, calendar_item_id) REFERENCES public.items(tenant_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.calendar_remote_state
    ADD CONSTRAINT calendar_remote_state_calendar_item_id_tenant_fkey FOREIGN KEY (tenant_id, calendar_item_id) REFERENCES public.items(tenant_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.event_remote_state
    ADD CONSTRAINT event_remote_state_event_item_id_tenant_fkey FOREIGN KEY (tenant_id, event_item_id) REFERENCES public.items(tenant_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.event_remote_state
    ADD CONSTRAINT event_remote_state_calendar_item_id_tenant_fkey FOREIGN KEY (tenant_id, calendar_item_id) REFERENCES public.items(tenant_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.docs
    ADD CONSTRAINT docs_item_id_tenant_fkey FOREIGN KEY (tenant_id, item_id) REFERENCES public.items(tenant_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.external_credentials
    ADD CONSTRAINT external_credentials_item_id_tenant_fkey FOREIGN KEY (tenant_id, item_id) REFERENCES public.items(tenant_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.item_automation
    ADD CONSTRAINT item_automation_item_id_tenant_fkey FOREIGN KEY (tenant_id, item_id) REFERENCES public.items(tenant_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.item_origins
    ADD CONSTRAINT item_origins_item_id_tenant_fkey FOREIGN KEY (tenant_id, item_id) REFERENCES public.items(tenant_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.item_relations
    ADD CONSTRAINT item_relations_item_a_tenant_fkey FOREIGN KEY (tenant_id, item_a) REFERENCES public.items(tenant_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.item_relations
    ADD CONSTRAINT item_relations_item_b_tenant_fkey FOREIGN KEY (tenant_id, item_b) REFERENCES public.items(tenant_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.item_search_index
    ADD CONSTRAINT item_search_index_item_id_tenant_fkey FOREIGN KEY (tenant_id, item_id) REFERENCES public.items(tenant_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.library_cover_candidates
    ADD CONSTRAINT library_cover_candidates_item_id_tenant_fkey FOREIGN KEY (tenant_id, item_id) REFERENCES public.items(tenant_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.mail_account_server_settings
    ADD CONSTRAINT mail_account_server_settings_mailbox_item_id_tenant_fkey FOREIGN KEY (tenant_id, mailbox_item_id) REFERENCES public.items(tenant_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.mail_account_sync_state
    ADD CONSTRAINT mail_account_sync_state_item_id_tenant_fkey FOREIGN KEY (tenant_id, item_id) REFERENCES public.items(tenant_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.mail_attachments
    ADD CONSTRAINT mail_attachments_message_item_id_tenant_fkey FOREIGN KEY (tenant_id, message_item_id) REFERENCES public.items(tenant_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.mail_drafts
    ADD CONSTRAINT mail_drafts_email_item_id_tenant_fkey FOREIGN KEY (tenant_id, email_item_id) REFERENCES public.items(tenant_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.mail_folder_sync_state
    ADD CONSTRAINT mail_folder_sync_state_item_id_tenant_fkey FOREIGN KEY (tenant_id, item_id) REFERENCES public.items(tenant_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.mail_message_content_cache
    ADD CONSTRAINT mail_message_content_cache_item_id_tenant_fkey FOREIGN KEY (tenant_id, item_id) REFERENCES public.items(tenant_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.mail_message_flag_sync_state
    ADD CONSTRAINT mail_message_flag_sync_state_message_item_id_tenant_fkey FOREIGN KEY (tenant_id, message_item_id) REFERENCES public.items(tenant_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.mail_oauth_states
    ADD CONSTRAINT mail_oauth_states_mailbox_item_id_tenant_fkey FOREIGN KEY (tenant_id, mailbox_item_id) REFERENCES public.items(tenant_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.mail_sent_copies
    ADD CONSTRAINT mail_sent_copies_mailbox_item_id_tenant_fkey FOREIGN KEY (tenant_id, mailbox_item_id) REFERENCES public.items(tenant_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.mcp_server_connection_state
    ADD CONSTRAINT mcp_server_connection_state_mcp_server_item_id_tenant_fkey FOREIGN KEY (tenant_id, mcp_server_item_id) REFERENCES public.items(tenant_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.person_email_index
    ADD CONSTRAINT person_email_index_item_id_tenant_fkey FOREIGN KEY (tenant_id, item_id) REFERENCES public.items(tenant_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.project_kept_dates
    ADD CONSTRAINT project_kept_dates_item_id_tenant_fkey FOREIGN KEY (tenant_id, item_id) REFERENCES public.items(tenant_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.project_mail_signals
    ADD CONSTRAINT project_mail_signals_project_item_id_tenant_fkey FOREIGN KEY (tenant_id, project_item_id) REFERENCES public.items(tenant_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.recording_requests
    ADD CONSTRAINT recording_requests_file_item_id_tenant_fkey FOREIGN KEY (tenant_id, file_item_id) REFERENCES public.items(tenant_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.task_recurrence
    ADD CONSTRAINT task_recurrence_item_id_tenant_fkey FOREIGN KEY (tenant_id, item_id) REFERENCES public.items(tenant_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.transcript_action_item_states
    ADD CONSTRAINT transcript_action_item_states_transcript_item_id_tenant_fkey FOREIGN KEY (tenant_id, transcript_item_id) REFERENCES public.items(tenant_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.value_links
    ADD CONSTRAINT value_links_item_id_tenant_fkey FOREIGN KEY (tenant_id, item_id) REFERENCES public.items(tenant_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.view_items
    ADD CONSTRAINT view_items_item_id_tenant_fkey FOREIGN KEY (tenant_id, item_id) REFERENCES public.items(tenant_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- Reserved before its item is inserted in the same transaction (`insertItemWithReplay`).
ALTER TABLE ONLY public.idempotency_keys
    ADD CONSTRAINT idempotency_keys_item_id_tenant_fkey FOREIGN KEY (tenant_id, item_id) REFERENCES public.items(tenant_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- Rows whose removal has domain side effects (blob release, emptied value links and their invalidations, mail
-- thread cleanup). The purge deletes them through their owners after the item, in the same transaction; a delete
-- of a referenced item that leaves one of them behind is refused at commit.
ALTER TABLE ONLY public.inbox_attachments
    ADD CONSTRAINT inbox_attachments_inbox_item_id_tenant_fkey FOREIGN KEY (tenant_id, inbox_item_id) REFERENCES public.items(tenant_id, id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.mail_message_meta
    ADD CONSTRAINT mail_message_meta_item_id_tenant_fkey FOREIGN KEY (tenant_id, item_id) REFERENCES public.items(tenant_id, id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.value_link_sources
    ADD CONSTRAINT value_link_sources_source_item_id_tenant_fkey FOREIGN KEY (tenant_id, source_item_id) REFERENCES public.items(tenant_id, id) DEFERRABLE INITIALLY DEFERRED;

-- Optional references whose row outlives the item, with the reference dropped.
ALTER TABLE ONLY public.item_origins
    ADD CONSTRAINT item_origins_inbox_item_id_tenant_fkey FOREIGN KEY (tenant_id, inbox_item_id) REFERENCES public.items(tenant_id, id) ON DELETE SET NULL (inbox_item_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.item_origins
    ADD CONSTRAINT item_origins_source_transcript_id_tenant_fkey FOREIGN KEY (tenant_id, source_transcript_id) REFERENCES public.items(tenant_id, id) ON DELETE SET NULL (source_transcript_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.mail_drafts
    ADD CONSTRAINT mail_drafts_source_email_item_id_tenant_fkey FOREIGN KEY (tenant_id, source_email_item_id) REFERENCES public.items(tenant_id, id) ON DELETE SET NULL (source_email_item_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.recording_requests
    ADD CONSTRAINT recording_requests_event_item_id_tenant_fkey FOREIGN KEY (tenant_id, event_item_id) REFERENCES public.items(tenant_id, id) ON DELETE SET NULL (event_item_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.recording_requests
    ADD CONSTRAINT recording_requests_project_item_id_tenant_fkey FOREIGN KEY (tenant_id, project_item_id) REFERENCES public.items(tenant_id, id) ON DELETE SET NULL (project_item_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.semp_problems
    ADD CONSTRAINT semp_problems_project_item_id_tenant_fkey FOREIGN KEY (tenant_id, project_item_id) REFERENCES public.items(tenant_id, id) ON DELETE SET NULL (project_item_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.semp_threads
    ADD CONSTRAINT semp_threads_subject_proposal_id_tenant_fkey FOREIGN KEY (tenant_id, subject_proposal_id) REFERENCES public.items(tenant_id, id) ON DELETE SET NULL (subject_proposal_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.task_recurrence
    ADD CONSTRAINT task_recurrence_trashed_active_item_id_tenant_fkey FOREIGN KEY (tenant_id, trashed_active_item_id) REFERENCES public.items(tenant_id, id) ON DELETE SET NULL (trashed_active_item_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.transcript_action_item_states
    ADD CONSTRAINT transcript_action_item_states_owner_person_id_tenant_fkey FOREIGN KEY (tenant_id, owner_person_id) REFERENCES public.items(tenant_id, id) ON DELETE SET NULL (owner_person_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.transcript_action_item_states
    ADD CONSTRAINT transcript_action_item_states_task_item_id_tenant_fkey FOREIGN KEY (tenant_id, task_item_id) REFERENCES public.items(tenant_id, id) ON DELETE SET NULL (task_item_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.views
    ADD CONSTRAINT views_creator_project_item_id_tenant_fkey FOREIGN KEY (tenant_id, creator_project_item_id) REFERENCES public.items(tenant_id, id) ON DELETE SET NULL (creator_project_item_id) DEFERRABLE INITIALLY DEFERRED;

-- ====================================================================================================
-- Row-level security
--
-- Tenant isolation: docs/adr/2026-10-03-tenant-isolation-through-row-level-security.md.
-- ====================================================================================================

ALTER TABLE public.agent_database_grants ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.agent_database_grants AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.agent_database_grants USING (true) WITH CHECK (true);

ALTER TABLE public.agent_guidance_drift_findings ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.agent_guidance_drift_findings AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.agent_guidance_drift_findings USING (true) WITH CHECK (true);

ALTER TABLE public.agent_run_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.agent_run_events AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.agent_run_events USING (true) WITH CHECK (true);

ALTER TABLE public.agent_run_read_allowances ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.agent_run_read_allowances AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.agent_run_read_allowances USING (true) WITH CHECK (true);

ALTER TABLE public.agent_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.agent_runs AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.agent_runs USING (true) WITH CHECK (true);

ALTER TABLE public.ai_gateway_calls ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.ai_gateway_calls AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.ai_gateway_calls USING (true) WITH CHECK (true);

ALTER TABLE public.approval_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.approval_requests AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.approval_requests USING (true) WITH CHECK (true);

ALTER TABLE public.blobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.blobs AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.blobs USING (true) WITH CHECK (true);

ALTER TABLE public.calendar_account_sync_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.calendar_account_sync_state AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.calendar_account_sync_state USING (true) WITH CHECK (true);

ALTER TABLE public.calendar_event_push_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.calendar_event_push_state AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.calendar_event_push_state USING (true) WITH CHECK (true);

ALTER TABLE public.calendar_feed_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.calendar_feed_state AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.calendar_feed_state USING (true) WITH CHECK (true);

ALTER TABLE public.calendar_push_channels ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.calendar_push_channels AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.calendar_push_channels USING (true) WITH CHECK (true);

ALTER TABLE public.calendar_remote_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.calendar_remote_state AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.calendar_remote_state USING (true) WITH CHECK (true);

ALTER TABLE public.event_remote_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.event_remote_state AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.event_remote_state USING (true) WITH CHECK (true);

ALTER TABLE public.credential_access_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.credential_access_log AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.credential_access_log USING (true) WITH CHECK (true);

ALTER TABLE public.databases ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.databases AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.databases USING (true) WITH CHECK (true);

ALTER TABLE public.doc_history_updates ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.doc_history_updates AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.doc_history_updates USING (true) WITH CHECK (true);

ALTER TABLE public.doc_snapshot_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.doc_snapshot_history AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.doc_snapshot_history USING (true) WITH CHECK (true);

ALTER TABLE public.doc_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.doc_snapshots AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.doc_snapshots USING (true) WITH CHECK (true);

ALTER TABLE public.doc_updates ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.doc_updates AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.doc_updates USING (true) WITH CHECK (true);

ALTER TABLE public.docs ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.docs AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.docs USING (true) WITH CHECK (true);

ALTER TABLE public.external_credentials ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.external_credentials AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.external_credentials USING (true) WITH CHECK (true);

ALTER TABLE public.heartbeat_occurrences ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.heartbeat_occurrences AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.heartbeat_occurrences USING (true) WITH CHECK (true);

ALTER TABLE public.idempotency_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.idempotency_keys AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.idempotency_keys USING (true) WITH CHECK (true);

ALTER TABLE public.idempotent_responses ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.idempotent_responses AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.idempotent_responses USING (true) WITH CHECK (true);

ALTER TABLE public.inbox_attachments ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.inbox_attachments AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.inbox_attachments USING (true) WITH CHECK (true);

ALTER TABLE public.item_automation ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.item_automation AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.item_automation USING (true) WITH CHECK (true);

ALTER TABLE public.item_origins ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.item_origins AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.item_origins USING (true) WITH CHECK (true);

ALTER TABLE public.item_relations ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.item_relations AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.item_relations USING (true) WITH CHECK (true);

ALTER TABLE public.item_search_index ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.item_search_index AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.item_search_index USING (true) WITH CHECK (true);

ALTER TABLE public.items ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.items AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.items USING (true) WITH CHECK (true);

ALTER TABLE public.library_cover_candidates ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.library_cover_candidates AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.library_cover_candidates USING (true) WITH CHECK (true);

ALTER TABLE public.mail_account_server_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.mail_account_server_settings AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.mail_account_server_settings USING (true) WITH CHECK (true);

ALTER TABLE public.mail_account_sync_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.mail_account_sync_state AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.mail_account_sync_state USING (true) WITH CHECK (true);

ALTER TABLE public.mail_attachments ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.mail_attachments AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.mail_attachments USING (true) WITH CHECK (true);

ALTER TABLE public.mail_drafts ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.mail_drafts AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.mail_drafts USING (true) WITH CHECK (true);

ALTER TABLE public.mail_folder_sync_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.mail_folder_sync_state AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.mail_folder_sync_state USING (true) WITH CHECK (true);

ALTER TABLE public.mail_message_content_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.mail_message_content_cache AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.mail_message_content_cache USING (true) WITH CHECK (true);

ALTER TABLE public.mail_message_flag_sync_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.mail_message_flag_sync_state AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.mail_message_flag_sync_state USING (true) WITH CHECK (true);

ALTER TABLE public.mail_message_meta ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.mail_message_meta AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.mail_message_meta USING (true) WITH CHECK (true);

ALTER TABLE public.mail_message_move_sync_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.mail_message_move_sync_state AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.mail_message_move_sync_state USING (true) WITH CHECK (true);

ALTER TABLE public.mail_oauth_states ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.mail_oauth_states AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.mail_oauth_states USING (true) WITH CHECK (true);

ALTER TABLE public.mail_sent_copies ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.mail_sent_copies AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.mail_sent_copies USING (true) WITH CHECK (true);

ALTER TABLE public.mail_thread_aliases ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.mail_thread_aliases AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.mail_thread_aliases USING (true) WITH CHECK (true);

ALTER TABLE public.mail_thread_change_counters ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.mail_thread_change_counters AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.mail_thread_change_counters USING (true) WITH CHECK (true);

ALTER TABLE public.mail_thread_changes ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.mail_thread_changes AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.mail_thread_changes USING (true) WITH CHECK (true);

ALTER TABLE public.mail_threads ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.mail_threads AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.mail_threads USING (true) WITH CHECK (true);

ALTER TABLE public.manifest_drift_findings ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.manifest_drift_findings AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.manifest_drift_findings USING (true) WITH CHECK (true);

ALTER TABLE public.mcp_server_connection_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.mcp_server_connection_state AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.mcp_server_connection_state USING (true) WITH CHECK (true);

ALTER TABLE public.mcp_tool_registrations ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.mcp_tool_registrations AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.mcp_tool_registrations USING (true) WITH CHECK (true);

ALTER TABLE public.notification_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.notification_preferences AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.notification_preferences USING (true) WITH CHECK (true);

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.notifications AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.notifications USING (true) WITH CHECK (true);

ALTER TABLE public.person_email_index ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.person_email_index AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.person_email_index USING (true) WITH CHECK (true);

ALTER TABLE public.project_agent_guidance ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.project_agent_guidance AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.project_agent_guidance USING (true) WITH CHECK (true);

ALTER TABLE public.project_agent_guidance_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.project_agent_guidance_versions AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.project_agent_guidance_versions USING (true) WITH CHECK (true);

ALTER TABLE public.project_heartbeats ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.project_heartbeats AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.project_heartbeats USING (true) WITH CHECK (true);

ALTER TABLE public.project_kept_dates ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.project_kept_dates AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.project_kept_dates USING (true) WITH CHECK (true);

ALTER TABLE public.project_mail_signals ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.project_mail_signals AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.project_mail_signals USING (true) WITH CHECK (true);

ALTER TABLE public.project_mcp_grants ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.project_mcp_grants AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.project_mcp_grants USING (true) WITH CHECK (true);

ALTER TABLE public.properties ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.properties AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.properties USING (true) WITH CHECK (true);

ALTER TABLE public.push_deliveries ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.push_deliveries AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.push_deliveries USING (true) WITH CHECK (true);

ALTER TABLE public.recording_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.recording_requests AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.recording_requests USING (true) WITH CHECK (true);

ALTER TABLE public.relation_definitions ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.relation_definitions AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.relation_definitions USING (true) WITH CHECK (true);

ALTER TABLE public.rollup_dependencies ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.rollup_dependencies AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.rollup_dependencies USING (true) WITH CHECK (true);

ALTER TABLE public.semp_message_speech ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.semp_message_speech AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.semp_message_speech USING (true) WITH CHECK (true);

ALTER TABLE public.semp_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.semp_messages AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.semp_messages USING (true) WITH CHECK (true);

ALTER TABLE public.semp_problem_occurrences ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.semp_problem_occurrences AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.semp_problem_occurrences USING (true) WITH CHECK (true);

ALTER TABLE public.semp_problems ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.semp_problems AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.semp_problems USING (true) WITH CHECK (true);

ALTER TABLE public.semp_threads ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.semp_threads AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.semp_threads USING (true) WITH CHECK (true);

ALTER TABLE public.task_recurrence ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.task_recurrence AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.task_recurrence USING (true) WITH CHECK (true);

ALTER TABLE public.tenant_exports ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.tenant_exports AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.tenant_exports USING (true) WITH CHECK (true);

ALTER TABLE public.tenant_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.tenant_keys AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.tenant_keys USING (true) WITH CHECK (true);

ALTER TABLE public.tenant_observability_checks ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.tenant_observability_checks AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.tenant_observability_checks USING (true) WITH CHECK (true);

ALTER TABLE public.transcript_action_item_states ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.transcript_action_item_states AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.transcript_action_item_states USING (true) WITH CHECK (true);

ALTER TABLE public.value_link_sources ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.value_link_sources AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.value_link_sources USING (true) WITH CHECK (true);

ALTER TABLE public.value_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.value_links AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.value_links USING (true) WITH CHECK (true);

ALTER TABLE public.view_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.view_items AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.view_items USING (true) WITH CHECK (true);

ALTER TABLE public.views ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.views AS RESTRICTIVE USING ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default))) WITH CHECK ((tenant_id = ( SELECT public.app_tenant_default() AS app_tenant_default)));

CREATE POLICY tenant_rows ON public.views USING (true) WITH CHECK (true);

-- ====================================================================================================
-- Default privileges
-- ====================================================================================================

ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA public GRANT SELECT,USAGE ON SEQUENCES TO alldots_side;

-- ====================================================================================================
-- Migration bookkeeping
--
-- The runner (db/migrate.ts) creates schema_migrations before it applies this file.
-- ====================================================================================================

COMMENT ON TABLE schema_migrations IS 'alldots:tenancy=global';

-- ====================================================================================================
-- Data
--
-- Tenant zero exists on every fresh install, with the default AI budget (50 USD a day, no monthly cap).
-- The Czech Hunspell dictionary is activated when deploy/provision.sh installed its assets; without them the
-- unaccent + simple mapping above stays (a WARNING, not an error).
-- ====================================================================================================

INSERT INTO tenants (status) VALUES ('active');
INSERT INTO tenant_ai_budgets (tenant_id, daily_cap_usd, monthly_cap_usd) SELECT id, 50, NULL FROM tenants;
SELECT activate_czech_hunspell_search();
