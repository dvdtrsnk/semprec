---
status: accepted
date: 2026-11-19
area: [mobile]
supersedes: []
superseded-by: null
---

# The Apple apps edit pages with a native note editor

## Context

[[2026-10-28-block-model-for-page-documents]] §7 says iOS, macOS and Android edit page documents through a WebView
running the web's JavaScript/Yjs editor, and that no native JSON block API is built. The Apple apps never embedded
that WebView. They grew three unrelated editors instead: the Journal edits one block at a time as plain text, the
Notes screen only appends blocks at the end, and an item page is replaced as raw Markdown in a text view. None of
them keeps formatting while typing, splits or merges blocks, indents, moves or selects.

The owner asked for one note editor in SwiftUI for every long text of the iOS and macOS apps, full screen (project
notes, subpages) and inline (the daily note, a task's description, an Inbox card's page), with behavior that a
WebView would make hard to match natively: the system text cursor, the hardware keyboard of iPad and Mac, swipe
thresholds with haptics, drag to reorder and the keyboard accessory bar.

## Decision

1. The Apple apps edit page documents with a native SwiftUI note editor, not with the WebView of §7. This supersedes
   §7 for iOS and macOS only; Android keeps §7 until a decision of its own.
2. No new block API is added. The editor works on the canonical Markdown the server already serves and accepts:
   `GET /api/items/:id/page.md` reads the page with its strong ETag, and `PUT /api/items/:id/page.md` replaces it
   with `If-Match`. The server keeps the Yjs document, diffs the replacement into it (unchanged blocks keep their
   ids), renames a subpage whose caption changed and trashes a subpage no longer linked, as it does for every other
   writer. Creating a subpage from blocks and duplicating a subpage with its subtree use the existing
   `POST /api/items/:id/page/subpages` and `POST /api/items/:id/page/duplicate` routes.
3. The editing rules live in the shared Kotlin layer as pure functions over the block list: normalization on read,
   split, merge, indent, type changes, Markdown prefixes, moves, duplication, deletion, paste and inline marks. The
   SwiftUI layer renders and forwards gestures; it decides nothing about the document.
4. Changes are saved continuously (debounced) against the ETag the page was read with. A stale ETag (409/412)
   reloads the page and discards the unsaved local change; nothing overwrites another device's write blindly.
   Concurrent editing therefore converges through the server's Yjs document and the version check, not through a
   Yjs replica on the device.
5. A block being edited uses the system rich text editor (`TextEditor` over `AttributedString`), so formatting stays
   visible and is never dropped while typing. A software keyboard reports no key for Backspace at the start of a
   field, so each edited block carries one zero-width character in front of its text that only the editor sees;
   its deletion is read as Backspace at position 0. A hardware keyboard is read directly through key presses.

## Consequences

- The stored block model, its Markdown and every backend route are unchanged.
- The Journal and Notes editors of the Apple apps are replaced by the shared note editor. A task's description and
  the page content of an Inbox card stay text fields; the light editor writes them as canonical Markdown.
- The Markdown view and raw editor of a generic item's page in Collections are not changed by this decision.
- An edit lost to a conflict is lost on the device that wrote second; the page it reloads shows the other write.
- Android is not affected by this decision.
