-- A pure, invoker-scoped preselector; the locked TypeScript owner rechecks the series.
CREATE FUNCTION task_recurrence_due_for_rollover(mode text, rule jsonb, occurrence date, anchor date, today date)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
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
    RETURN next_day <= today AND anchor <= today;
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
  RETURN next_day <= today AND latest_found;
END;
$$;
REVOKE ALL ON FUNCTION task_recurrence_due_for_rollover(text,jsonb,date,date,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION task_recurrence_due_for_rollover(text,jsonb,date,date,date) TO semprec_data;
