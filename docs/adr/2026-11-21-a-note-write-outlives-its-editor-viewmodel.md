---
status: accepted
date: 2026-11-21
area: [mobile]
supersedes: []
superseded-by: null
---

# A note's write outlives its editor ViewModel

## Context

[[2026-10-24-shared-screen-viewmodel-lifecycle-and-native-hosting]] runs a shared screen ViewModel's work in
`viewModelScope` and has `close()` (Apple) or the store clearing the instance (Android) cancel it, so nothing a
ViewModel started outlives its screen. The note editor ([[2026-11-19-apple-apps-edit-pages-with-a-native-note-editor]])
writes a page after a pause in typing and one write at a time. Under that rule, a change made just before the editor
goes away is lost: the pause is cancelled before it ends, and a write already sent is cancelled before its answer
arrives. Leaving a note, or the diary moving to another period, ends the editor exactly at that moment.

## Decision

The note editor's writes run in a scope of the page store's own, not in `viewModelScope`:

- Closing or clearing the ViewModel does not cancel that scope. A write already sent finishes, and a change still
  waiting for its pause is written when `viewModelScope` ends.
- Writes stay one at a time, against the version the page was read with, exactly as before; only their lifetime
  changes.
- After the ViewModel is closed, the state a finished write sets reaches no one, because the screen stopped
  observing it, and an effect it emits is dropped, as for any closed ViewModel.
- Everything else the editor does (reading, rereading, the pause itself, effects) keeps running in `viewModelScope`
  and ends with it, as the lifecycle decision says.

This narrows the lifecycle decision for this one case: persisting what the person already typed. A new ViewModel
whose work must survive its screen needs a decision of its own.

## Consequences

- Leaving a note right after an edit, a block action included, keeps the edit.
- A write can still be running after the screen that started it is gone; it holds the page store until its answer
  arrives, then nothing holds it.
- A write that fails after the screen closed shows no problem to anyone; the next time the page is opened, it shows
  what the server holds.
