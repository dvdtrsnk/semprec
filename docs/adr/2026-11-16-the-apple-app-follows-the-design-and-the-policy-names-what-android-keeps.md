---
status: accepted
date: 2026-11-16
area: [mobile]
supersedes: []
superseded-by: null
---

# The Apple app follows the design, and the policy names what only Android keeps

## Context

[[2026-11-15-apple-first-delivery-of-the-mobile-design]] lets the Apple app ship screens ahead of Android and
names what is Apple-only. The first design screens replace the placeholder Home, Detail and Settings screens of the
Apple app with the three tabs of the design (Overview, Calendar, Journal). Android still hosts the placeholder
screens and their shared ViewModels (`HomeViewModel`, `DetailViewModel`, `SettingsViewModel`), so the shared code
and the Android modules stay. The architecture checks assumed the reverse of Apple-first: every shared ViewModel has
exactly one CoreKit bridge (`VM-BRIDGE`) and every copy entry names an Apple target (`COPY-PARITY`).

## Decision

- `viewModels.androidOnly` in `architecture-policy.json` lists the shared ViewModels that only Android hosts. They
  keep their test and their Android screen requirement, need no CoreKit bridge, and fail the check if a bridge
  exists, so the list cannot outlive its reason.
- A `copy` entry with `"apple": null` is Android-only copy of a module whose screens the Apple app does not have.
  `COPY-PARITY` checks only its Android side.
- `androidOnly` keys of an entry that has an Apple target (the Android tab labels of the app) stay Android-only
  there, as the existing `androidOnly` rule says.

## Consequences

- Android's placeholder screens are the inventory of what to replace when Android adopts the design; removing a name
  from `androidOnly` demands the Apple bridge again.
- The Apple app has no Home or Settings code and no UI of its own for the Kotlin placeholder ViewModels.
