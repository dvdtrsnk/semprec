---
status: accepted
date: 2026-10-17
area: [backend, web]
supersedes: []
superseded-by: null
---

# Secret-bearing links carry their token in the URL fragment

## Context

Some emailed links grant access on their own: a password-reset link (issue #142) and an invitation
link (issue #1040). Before issue #1076, `buildPasswordResetUrl` built
`<APP_BASE_URL>/reset-password?token=…`. Its query string reached the server and could be recorded in
access logs. Under the default `strict-origin-when-cross-origin` referrer policy, same-origin requests
also carry the query string in their `Referer`; cross-origin requests carry only the origin. A more
permissive policy can expose the query string cross-origin too. The web app routes only on `?page=`
query parameters, so the old path-based reset link opened an empty app.

The invitation link has used `/?page=invite#token=…` since issue #1040. This ADR records that existing
fragment-token practice as the rule and applies it to the password-reset link.

The setup wizard (issue #234) already reads its bootstrap token from `?token=` and strips it from the
address bar on mount.

## Decision

A link that carries a secret token puts it in the URL fragment, as `#token=<token>`, not in the query
string. A page that reads such a fragment clears it from the address bar on mount with
`window.history.replaceState`. This removes the token from the address bar and the current
session-history entry; it does not guarantee erasure from global browser history, autocomplete or
synced history. Server-enforced expiry and single use limit reuse of any retained token. The
password-reset page clears its fragment. An invitation page is not implemented yet; when added in
issue #1088, it must read the fragment and clear it on mount.

- The password-reset link is `<APP_BASE_URL>/?page=password-reset#token=<token>`
  (`buildPasswordResetUrl` in `backend/packages/data/src/auth/passwordResetActions.ts`).
- The invitation link is `<APP_BASE_URL>/?page=invite#token=<token>` (`backend/packages/data/src/tenancy/invites.ts`).
- For password reset, the web app reads the fragment in its composition root (`web/src/main.tsx`)
  and passes the token to the page as a prop; the password-reset page clears the fragment
  (`web/src/views/passwordReset/`).

The token is base64url (`backend/packages/data/src/auth/token.ts`), so it needs no encoding inside the
fragment.

## Reason

The browser excludes the fragment from HTTP request URLs and `Referer` headers. A token in the
fragment therefore does not reach access logs or third-party resources through those channels.

## Rejected alternative

Keeping the token in the query string and scrubbing it from access logs and `Referer` headers. Scrubbing
has to be repeated at every log sink and proxy, and a missed one leaks the token silently.

The setup wizard's `?token=` query parameter is not changed by this ADR. It is a bootstrap token for a
page that runs before any user exists, and moving it is a separate decision.

## Consequences

- Any new secret-bearing link follows this rule: the token goes after `#`, and the page that reads it
  clears the fragment on mount.
- The page reads the fragment once, at load, in the composition root. Nothing re-reads the URL afterwards.
- A request made by the page itself still carries the token in its body, not in its URL, so the rule
  covers the link, not every later request.
