---
status: accepted
date: 2026-11-22
area: [mobile]
supersedes: []
superseded-by: null
---

# Mobile keeps mail thread lists in a file cache

## Context

The mail thread list read its first page from the server every time it opened, so it showed a wait on every open and
nothing without a connection, and every refresh read the whole first page again. The server index stays the only
source of truth and every user write stays a server call; what the client lacked was a copy of what it last saw and a
way to ask only for what changed since. The server now answers `changesCursor` beside each list page and
`GET /api/mail/threads/changes?since=` with the changed rows, the removed ids and a reset flag
(`docs/architecture/domain-mail-and-inbox.md`, Thread list changes). The mobile apps had no persistence besides the
session in the Keychain; a database library (SQLDelight) or a key-value store (DataStore) would have been the first
dependency of its kind in the shared layer.

## Decision

- The shared layer keeps the thread lists itself, as JSON files written with kotlinx.serialization:
  `FileMailThreadListCache` in `:shared:data` behind the `MailThreadListCache` port of `:shared:domain`. The file access
  is four `expect` functions (`CacheFiles.kt`) with `java.io` actuals for the JVM and Android and `NSFileManager` and
  `NSString` actuals for Apple; a file is written beside its target and moved over it, so a reader never sees half of
  one. No persistence library is added.
- The directory is the app's cache directory, which the system may empty, handed to `HomeSDK(cacheDirectory:)` by the
  native owner as the session storage is: the Apple app passes `FileManager`'s caches directory for the Keychain
  session store and `nil` for the in-memory one its tests use, the Android app `Context.cacheDir` through Koin.
  `null` keeps nothing (`NoMailThreadListCache`).
- One directory per account, named by a SHA-1 of the server and the session token so neither appears in a path; a
  write for one account removes every other account's lists, and signing out removes all. Per view (the list's
  filters without search and page cursor) one file holds the rows, the changes cursor, the next page cursor and the
  key of the last row read. At most 20 views (least recently used out) and 500 rows per view: a longer list is not
  written and the file before it stays, because any kept list with its own cursor is still a correct place to go on
  from. A file that cannot be decoded, or that names another version, account or view, reads as nothing and is
  deleted. Search results are never kept.
- `SyncMailThreadList` (`:shared:domain`) decides: with a kept list it asks for the changes since its cursor and merges
  them (a changed or removed thread leaves, a changed row in the view comes back in its place; before the last page
  was read, a row that sorts after the last row read is left to the next page), without one or on `reset` it reads the
  first page. `MailThreadsViewModel` shows the kept rows first (`fromCache`), then the merged ones; a failed refresh
  keeps the kept rows and raises the failure banner. It refreshes the list on a `mailThread` frame of the sync socket
  (`SyncTopic.MAIL_THREADS`) or a `MAIL_ACCOUNTS` change, once they have been quiet for 500 ms.

## Consequences

- The thread list opens with the rows of its last visit, also offline, and a refresh moves only the changed rows.
- The cache is a convenience the system may delete at any time; nothing reads it as the truth, and a cursor the server
  no longer accepts costs one first-page read.
- Another screen that wants to keep server data writes its own port and file format on the same `CacheFiles`
  functions; a store that needs queries or transactions would need its own decision.
