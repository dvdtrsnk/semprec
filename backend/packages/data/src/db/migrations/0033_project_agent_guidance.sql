-- Canonical hand-written project-agent guidance (issue #214). `project_item_id` is the
-- sole primary key: there is exactly one guidance document per project, replaced in place
-- by an upsert rather than versioned. No FK to `items` — `items` is a partitioned table with
-- one partition per database and cannot supply a direct FK target, so the application layer
-- validates `project_item_id` against the Projects system database itself before writing here.
--
-- `owner_user_id` is who may edit this guidance and the notification recipient for #85's
-- drift findings; it is a plain FK to `users`, not to the project item.
CREATE TABLE project_agent_guidance (
  project_item_id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  markdown text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX project_agent_guidance_owner_user_id_idx ON project_agent_guidance (owner_user_id);
