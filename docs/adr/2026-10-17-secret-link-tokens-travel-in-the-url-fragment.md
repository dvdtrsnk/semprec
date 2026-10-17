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
link (issue #1040). Their token was a query parameter. A query string reaches the server, so it lands
in access logs, and a browser sends the full URL as the `Referer` of any request the page makes. The
link `?page=password-reset&token=…` built by `buildPasswordResetUrl` before issue #1076 therefore put
a live credential where both could record it. The web app also routes only on `?page=` query
parameters, so a path-based link opened an empty app.

The setup wizard (issue #234) already reads its bootstrap token from `?token=` and strips it from the
address bar on mount.

## Decision

A link that carries a secret token puts it in the URL fragment, as `#token=<token>`, not in the query
string. A page that reads such a fragment clears it from the address bar on mount with
`window.history.replaceState`, so the token is not left in the tab's history entry. The password-reset
page does this; the invitation page is not changed by this ADR.

- The password-reset link is `<APP_BASE_URL>/?page=password-reset#token=<token>`
  (`buildPasswordResetUrl` in `backend/packages/data/src/auth/passwordResetActions.ts`).
- The invitation link is `<APP_BASE_URL>/?page=invite#token=<token>` (`backend/packages/data/src/tenancy/invites.ts`).
- The web app reads the fragment in its composition root (`web/src/main.tsx`) and passes the token to
  the page as a prop; the password-reset page clears the fragment (`web/src/views/passwordReset/`).

The token is base64url (`backend/packages/data/src/auth/token.ts`), so it needs no encoding inside the
fragment.

## Reason

The browser never sends a fragment to the server, and it is not part of the `Referer` header. A token
in the fragment therefore reaches neither access logs nor a third-party resource the page loads.

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
