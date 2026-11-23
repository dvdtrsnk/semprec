---
status: accepted
date: 2026-11-23
area: [mobile]
supersedes: []
superseded-by: null
---

# The mobile apps answer from the device at once and read the server again behind the answer

## Context

[[2026-11-23-mobile-keeps-the-answers-of-the-offline-set]] keeps the answers of the offline set on the device. It
answers a kept answer at once only while it is fresh (kept by this process after the last change signal, less than
five minutes ago) or while the process is offline; answers read from disk after a restart are not fresh, so every
screen of a cold start waited for the server, and the app opened on a spinner on every launch. The restore of the
session did the same: it waited for the server's answer before it showed anything, and used the person kept for the
session only when no answer came. The owner asked for the app to open instantly, from what the device keeps, and to
bring the newest data in behind it.

The change signals of that decision exist for consistency: after a write of this window, a reconnect or a frame of the
sync socket, a kept answer may show what is no longer true, and the screens that read again expect the server's
answer, not the one they just showed.

## Decision

This narrows the *Fresh answers*, *Stale and missing answers* and *Opening without a connection* rules of
[[2026-11-23-mobile-keeps-the-answers-of-the-offline-set]]; everything else in it stands.

- **At once, read again behind.** A kept answer that is not fresh is answered at once when no change signal of this
  process made it stale: when this process has not kept it (it was read from disk after a start), or when the only
  thing between its keeping and now is time (it is older than five minutes, with no change signal since). Its request
  then goes out in the layer's background scope, at most one at a time per answer, and its outcome is settled as any
  other read's: a success is kept, `404` removes the kept answer, a request without an answer makes the process
  offline.
- **Telling the windows.** When the answer read again differs from the one given (another body, or `404`), the layer's
  change flow emits, once for every answer that arrives within 150 ms of the first, so a start that reads many answers
  again does not reload every screen for each of them. This emission does not make anything kept stale: the screens
  that read again find the new answers fresh, and the answers still being read again are given at once again, without
  a second request.
- **Change signals still wait.** A kept answer that a change signal of this process made stale (a write, a socket
  connect that followed its keeping, a frame) is not given at once: its read waits for the server as before, so a
  screen that reads after its own write shows the write.
- **Opening at once.** A restore with a person kept for the stored session reports the session signed in as that
  person before its request goes out. The server's answer then decides as before: a session the server confirms
  replaces it (with the person the server names), one it refuses signs the device out, and an answer that is no
  session leaves the app open as it is. Without a kept person the restore waits for the answer as before.
- **The overview** reads its four requests together rather than one after another, the first failure in their order
  being the answer.

## Consequences

- A cold start opens on what the device kept, without a spinner; what the server answers differently replaces it a
  moment later. A screen opened for the first time in a process can show, for that moment, an answer kept before a
  write made earlier in the same process, when it had not read that answer since.
- A session that the server ended while the device was away opens for a moment and then signs out.
- Every start reads each answer its screens use once more in the background, as the warm-up already did; nothing
  more goes to the server than before, only sooner and without the screens waiting for it.
