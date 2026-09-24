- **critical** — an ADR whose body misstates the architecture it claims to document, or a
  change that makes an already-`accepted` decision's historical record no longer match
  what was actually decided at the time; a workflow change the linked issue's Task does
  not call for, or one that weakens or removes a required check (see
  `tasks/ci-workflows.md`).
- **high** — editing an existing ADR's Context/Decision/Consequences to reflect a new
  decision instead of writing a new superseding ADR (see rules.md); reusing an existing
  ADR filename/slug for a different decision; a workflow permission wider than the job
  needs, a secret reachable by pull-request-controlled code, an event expression
  inlined into a `run:` script, a pinned dependency unpinned, or a timeout/concurrency
  setting that can strand a required check; a `review-rules/` rule or task weakened or
  dropped without the Task asking for it, a scope pattern that drops or cannot match
  the files it intends, or a platform left with no task.
- **medium** — an ADR missing required frontmatter fields (`status`, `date`, `area`),
  a sequential-looking filename instead of `YYYY-MM-DD-slug`, or a hand-maintained index
  file reintroduced under `docs/adr/`; a workflow comment that no longer describes the
  YAML beside it; contradicting or factually wrong `review-rules/` content.
- **low** — wording, an ADR that could be more concise, a skill file that restates an
  ADR's rationale instead of linking to it.
