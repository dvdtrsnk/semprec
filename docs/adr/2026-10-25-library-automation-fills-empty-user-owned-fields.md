---
status: accepted
date: 2026-10-25
area: [backend]
supersedes: []
superseded-by: null
---

# Library automation may fill declared empty user fields

## Context

Library metadata sources can supply fields that users own. The ownership model
in [[2026-09-10-single-writer-ownership-model]] requires an explicit handoff
when automation participates in writing those fields.

## Decision

The Books and Movies library contracts declare the user-owned keys that their
metadata automation may fill. After fetching, the job checks the automation
lock and the current item in its write transaction. It fills a declared field
only when the current value is missing, null, or an empty string. Users retain
ownership and may change a filled value afterwards. The job uses the ordinary
item write path, and an invalid select option is skipped.

## Consequences

User-entered values are preserved, including values entered while a fetch is in
flight. The handoff is limited to declared keys instead of giving the metadata
job unrestricted ownership. Separate system-owned source fields with a
user-value fallback were considered and rejected because they duplicate the
fields and require consumers to resolve two values.
