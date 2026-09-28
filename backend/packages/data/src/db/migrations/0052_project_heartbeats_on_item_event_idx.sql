-- Issue #673: serves triggerOnItemEventHeartbeats (scheduler/schedulerStore.ts), which runs inside
-- every choke-point item create, update and delete; without this it sequentially scans
-- project_heartbeats while holding the write's row locks. The partial predicate must match that
-- query's WHERE verbatim (`enabled AND rule ->> 'kind' = 'onItemEvent'`) for the planner to use
-- the index. Expand-only: a new index, no change to any existing shape.
CREATE INDEX project_heartbeats_on_item_event_idx
  ON project_heartbeats ((rule ->> 'databaseId'), (rule ->> 'event'))
  WHERE enabled AND rule ->> 'kind' = 'onItemEvent';
