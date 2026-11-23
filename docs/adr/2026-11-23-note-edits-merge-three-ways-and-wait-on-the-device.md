---
status: accepted
date: 2026-11-23
area: [mobile]
supersedes: []
superseded-by: null
---

# Note edits merge three ways and wait on the device

## Context

The native note editor ([[2026-11-19-apple-apps-edit-pages-with-a-native-note-editor]]) reads
`GET /api/items/:id/page.md` (canonical Markdown with a strong `ETag`) and replaces it with
`PUT /api/items/:id/page.md` and `If-Match` after a pause in typing. Its §4 makes a stale `ETag` (`409`/`412`) read
the page again and discard the local change, and without a connection a note can be neither read nor saved. Its
writes outlive the editor's ViewModel ([[2026-11-21-a-note-write-outlives-its-editor-viewmodel]]).

The owner asked that notes, the daily note above all, be readable and editable without a connection, and that what
one device writes shows on every other device of the account. Since [[2026-11-23-mobile-keeps-the-answers-of-the-offline-set]]
the device keeps the answers of the offline set, and since
[[2026-11-23-mobile-writes-wait-in-an-ordered-queue-without-a-connection]] it queues the writes made without a
connection. A page's text fits neither: it is one whole-text replacement against a version, so replaying the request
later would either be refused as stale or overwrite what another device wrote meanwhile. The server sends an
`invalidate` frame of scope `doc` (`docId`, `itemId`, `databaseId`, `lastEditedAt`) to every socket of the tenant after
every write of a page, the writer's own included.

Rejected: a replica of the server's Yjs document on the device. Kotlin Multiplatform has no Yjs implementation, Yrs
would need a Rust toolchain and native bindings for every target, and the server's document would need a second write
path beside the Markdown route. Rejected too: last writer wins, which loses what the other device wrote.

## Decision

1. **Kept pages.** The offline store keeps each note page the device read or wrote, beside the answers and not among
   them, in `<account>/pages/<fnv>.json` (`KeptPages`): the item id, the base (the Markdown and `ETag` last read or
   written) and the local Markdown while the server does not hold it. A file is named by a 64-bit FNV-1a hash of the
   item id and repeats it with the account and a version; a file of another version or account, or one that cannot be
   decoded, reads as nothing and is deleted, and one naming another item reads as nothing. Kept pages are not
   evicted; they are removed with everything else at every end of the session.
2. **Reads.** `HttpJournalRepository.page` (and so the note editor) reads through `OfflinePages`. A kept page is
   returned without a request while no change signal came since it was kept, and without a connection. Otherwise the
   server is read and its answer becomes the base; when a local text waits, it is written first and the read answers
   what the device holds afterwards. A period of the diary shows the page the device made for it and the local text.
3. **Writes name their base.** A replacement carries the Markdown the editor edited from
   (`NotePageRepository.replace` and `JournalRepository.replacePage` take `base`). When the device holds another text
   of the page by then (a write in the background or from another window of the device came meanwhile), the change is
   merged three ways with that text first, so nothing either wrote is overwritten. The result is kept before it is
   sent with `If-Match` of the kept base's `ETag` (the editor's `ETag`, with `base` as its text, when no page is kept).
4. **Answers.**
   - Success: the text becomes the base and the page stays fresh; every other kept answer turns stale, because the
     diary's period answer shows the text.
   - `409` or `412`: the server's page is read, base, local and server are merged three ways and the merge is sent
     against the server's `ETag`, up to three rounds. After the third the write answers `Conflict` as before; the
     device keeps the merge, and the next write, the next read that goes to the server or the next background write
     sends it again.
   - No answer, a `5xx` or a `429`: the text waits on the device.
   - `404`: the page is forgotten with its local text, because the server no longer has the item to write it to.
   - Any other failure is returned as it came; the text stays on the device.
   - A page without a version (`ETag`) reads the server first, then writes the local text over an empty page or
     merges with an empty base.
   - `PageWrite` says what the page holds: `Saved` (the server holds the text sent), `Merged` (the page holds the
     merge of the change with what changed elsewhere, on the server or, until it can be reached, on the device),
     `Kept` (the device holds the text sent) or `Conflict`.
5. **One at a time.** Every page read, page write and background write of `OfflinePages` takes one lock that every
   window of the process shares, so a write in the background and the write of a window never interleave, and no
   read keeps an older answer over a text written meanwhile.
6. **The merge** (`NoteMerge` in `:shared:domain`). Blocks are compared by their canonical Markdown alone; the blocks
   both sides kept unchanged (by the longest common subsequence against the base) are fixed points. Between them a
   stretch only one side changed takes that side; one both changed the same way is taken once; one they changed
   differently is paired position by position: a block changed on both sides takes its type, indent, done, toggle
   and page id from the side that changed each (the local one when both did) and merges its text by character with
   each character's inline style, a block deleted on one side and changed on the other keeps the change, and the
   blocks one side added are kept, the local ones first. Text is merged the same way by character, a surrogate pair
   counting as one; a stretch both sides changed keeps the local characters, then the remote ones. Past 4,000,000
   cells of a comparison table the local side is taken for that part. The result is canonical Markdown, and a block
   taken unchanged keeps the lines its side had.
7. **In the background.** After every replay of the queue (whose triggers are the connection coming back), every page
   with a local text is written. A page of an item the device created and the server has not answered yet waits; the
   queue's map of ids names its server id afterwards.
8. **Live rereads.** `SyncFrame` keeps the `doc` frames and the window's `SyncSocket` raises their item on
   `PageChanges`; the offline layer adds every page whose write merged, so the other windows of the device read it
   too. A note editor showing that item reads it again quietly unless a change waits to be written, and keeps the
   ids of the blocks the answer holds unchanged: the server announces this device's own writes too, so a reread
   follows every save, and it must not move the caret.

This narrows §4 of [[2026-11-19-apple-apps-edit-pages-with-a-native-note-editor]]: a stale version is merged instead
of discarding the local change, and a change made without a connection is kept on the device. Everything else in that
decision, and [[2026-11-21-a-note-write-outlives-its-editor-viewmodel]], stays in force. Without a data directory
(`HomeSDK(dataDirectory: null)`) nothing is kept and the editor reads and writes the server as before.

## Consequences

- A note opened before can be read and edited without a connection; the edit survives a restart and reaches the
  server when the connection is back. A note never opened on the device cannot be opened without a connection.
- An edit made while another device changed the same note keeps both changes. When both changed the same words, both
  versions stand side by side and need a manual fix; a restyle of a stretch the other side also changed counts as
  such a change.
- A daily note created on two devices for the same day ends with both texts.
- An open note shows what another device saved without being reopened, unless a local change is waiting.
- With a connection and no concurrent change, a note reads and saves as before, with one more read after a save
  that the server announces.
- Subpage operations (make, duplicate, rename, open) stay online only, and the web and WebView editors are not
  affected.
