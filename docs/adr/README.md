# Architecture Decision Records

Backend and cross-cutting architecture lives in
[`docs/architecture/`](../architecture/README.md): current, normative documents that are
updated in place. This directory holds the remaining decision records for the mobile and web
clients (and mixed records that carry mobile or web rules), plus a rare genuinely new
cross-cutting decision that fits no architecture document.

## When to write one

Only for a decision that shapes how future mobile or web code is written and had a real
alternative, or for a genuinely new cross-cutting decision. Never for a local pattern (one
screen, one module, one operation): that lives in the code. A backend rule goes into the
relevant `docs/architecture/` document instead.

## Conventions

- **Filename**: `YYYY-MM-DD-kebab-case-slug.md`, never renamed or moved. No sequential
  numbers and no index file: discovery is the directory listing plus the frontmatter.
- **Topic is a tag**, the `area` frontmatter field, not a folder.

```yaml
---
status: accepted        # proposed | accepted | superseded | deprecated
date: 2026-09-10         # creation date, matches the filename, never edited
area: [mobile]           # one or more of: backend, web, mobile, cross-cutting (apple: only ADRs dated before 2026-10-24)
supersedes: []           # slugs of ADRs this one replaces
superseded-by: null      # slug of the ADR that replaced this one, if any
---
```

## Platform discovery

```sh
node .github/scripts/adr.mjs --platform android   # also mobile, shared, apple, ios, macos, web, backend
node .github/scripts/adr.mjs --all --json
```

The default output lists accepted records; each platform includes `cross-cutting`, and the
mobile selections include the historical `apple` tag. For `backend` and `web` the command also
points at `docs/architecture/`.

## Superseding a decision

Reversing a decision never edits the old file's body: write a new ADR with
`supersedes: [old-slug]` and change only the old file's frontmatter to `status: superseded`,
`superseded-by: new-slug`.
