- **critical** — an ADR whose body misstates the architecture it claims to document, or a
  change that makes an already-`accepted` decision's historical record no longer match
  what was actually decided at the time.
- **high** — editing an existing ADR's Context/Decision/Consequences to reflect a new
  decision instead of writing a new superseding ADR (see rules.md); reusing an existing
  ADR filename/slug for a different decision.
- **medium** — an ADR missing required frontmatter fields (`status`, `date`, `area`),
  a sequential-looking filename instead of `YYYY-MM-DD-slug`, or a hand-maintained index
  file reintroduced under `docs/adr/`.
- **low** — wording, an ADR that could be more concise, a skill file that restates an
  ADR's rationale instead of linking to it.
