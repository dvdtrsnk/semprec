---
status: accepted
date: 2026-11-15
area: [mobile]
supersedes: []
superseded-by: null
---

# The iOS app is delivered ahead of Android, and the architecture checks name what is Apple-only

## Context

The mobile design (the canvas "Semprec iOS") exists for iOS and macOS. The architecture checks of
`mobile/scripts/architecture.mjs` assume that every screen ViewModel has an Android `*Screen` and every copy key
exists on both platforms (`VM-BRIDGE`, `COPY-PARITY`). Building the iOS screens first would fail them for
screens whose Android counterpart is deliberately not written yet, and loosening the rules for everyone would
let a forgotten Android screen go unnoticed.

## Decision

- The shared Kotlin layer, the CoreKit bridge and the Apple feature modules are built for a screen first. The
  Android screen follows in its own change.
- `architecture-policy.json` names what is Apple-only, so that everything else keeps the parity checks:
  `viewModels.appleOnly` lists the ViewModels that need no Android `*Screen` yet, a `copy` entry with
  `"android": null` is Apple-only copy of a feature module, and `appleOnly` in a `copy` entry lists Apple keys of
  a module that has an Android counterpart. Removing a name from these lists is how Android parity is demanded
  again; the rule then fails until the Android side exists.
- Everything else in the policy is unchanged: shared code, module edges and copy of existing screens still need
  both platforms.

## Consequences

- A ViewModel or a copy key that is in the Apple-only lists and later gets an Android screen must be removed from
  the list in the same change, or the list outlives its reason.
- The lists are the inventory of Android work.
