---
status: accepted
date: 2026-10-03
area: [web]
supersedes: []
superseded-by: null
---

# A session end reloads the web app to a clean URL

## Context

Semprec is multi-user: more than one person can sign in on the same browser tab,
one after the other. The web client builds its whole in-memory app once at
composition time (route props carrying ids, session-bound adapters, React state
above the session gate) and reads the URL (`?view=`, `?page=`, `?project=`) only
then. Swapping the routed content for the login page in place on logout or on a
mid-session 401 leaves all of that alive, so the next user would inherit the
previous user's URL and state.

## Decision

Logout and a mid-session 401 both move the session to an `ending` state that
renders neither header nor routed content, and end in
`window.location.replace("/")`. No component clears client state on logout; the
reload discards it.

## Rejected alternative

Resetting state in place. Every new piece of client state would need its own
reset, and a forgotten one leaks one user's data to the next.

## Consequences

- Unsaved input and the current deep link are lost when a 401 ends the session.
- New client state needs no logout cleanup.
- Later flows that end a session (for example account deletion) reuse the same
  `ending` state.
