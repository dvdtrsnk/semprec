---
status: accepted
date: 2026-11-28
area: [mobile]
supersedes: []
superseded-by: null
---

# The Apple app opens one universal link, for password resets

## Context

The server mails a password-reset link as `<APP_BASE_URL>/?page=password-reset#token=<token>`, with
`APP_BASE_URL` `https://alldots.app`, and serves `/.well-known/apple-app-site-association` on that
domain with `applinks` for `CX4M83TG32.cz.alldots.app` and the one component `/` with the query
`page=password-reset`. The Apple app could ask for a link (the sign-in form) but not open one, so a reset
only worked in the browser.

Until now the Apple app's only external entry point was the URL scheme `alldots`, registered in
`CFBundleURLTypes` so that a Google or Microsoft sign-in returns to `alldots://oauth`. The sign-in's own
`ASWebAuthenticationSession` catches that address; no scene reads a URL it is opened with. Every entry point
an outside party can trigger widens what reaches the app's navigation and data, so each one is a decision
([[2026-10-24-app-owned-mobile-navigation-through-feature-routers]] left the first deep link to its own).

Rejected:

- A custom-scheme link (`alldots://reset?token=`) in the mail. Any app can claim a custom scheme, so the token
  could go to another app, and the mail would carry a second link next to the web one.
- Claiming the domain without handling the link, or handling every path of it. The first breaks the reset that
  works in the browser; the second turns any address of the domain into an entry point.
- Parsing the link in shared Kotlin. The URL arrives at the SwiftUI scene, which owns the window's sheets, and
  the Android app opens no link; the decision about what the reset does stays in shared code (below).

## Decision

- **Entry points.** The Apple app has exactly two external entry points: the OAuth callback scheme
  `alldots://oauth`, caught by the browser sign-in's own session, and the universal link
  `https://alldots.app/?page=password-reset#token=<token>`. Both apps declare
  `com.apple.developer.associated-domains` with only `applinks:alldots.app` (iOS and macOS entitlements).
  Another entry point (a scheme, a domain, another path) needs its own ADR.
- **Strict parsing before anything else.** Each window's `AppScene` reads the URLs it is handed
  (`onOpenURL`, and `onContinueUserActivity` of `NSUserActivityTypeBrowsingWeb`) through `PasswordResetLink`,
  which accepts only `https` on the host `alldots.app` with no port, user or path, exactly one `page`
  parameter of value `password-reset`, and a fragment that is exactly `token=` with a base64url token of at
  most 256 characters. Every other URL, the OAuth callback included, is ignored. The server of the link is
  its origin, `https://alldots.app`, whatever server the window is signed in to.
- **What it opens.** A valid link opens the "Set a new password" sheet over the window, signed in or not,
  after closing the sheets of the window's stacks; a later link replaces it. A link that arrives while the
  wake guard blocks the window's navigation is dropped, as every route is then.
- **Where the decision lives.** The sheet is the Auth feature's `PasswordResetScreen` over the shared
  `PasswordResetViewModel` (`HomeSDK.passwordReset`), which decides whether the form can be sent and sends
  `POST /api/auth/password-reset/consume` through `ResetPassword` and the `AuthRepository` port. Each refusal
  the server names (`password_reset_token_invalid`, `_expired`, `_consumed`, and a `validation_failed` of
  `newPassword`) is its own state. The reset signs nobody in: the person signs in afterwards.
- **The token stays out of logs.** The token goes only to the link's server; nothing writes it, or the URL
  that carries it, to a log, analytics or storage.

## Consequences

- A fresh link of the mail opens the app on a device where the domain's association is verified; elsewhere,
  and on Android, the link keeps opening the web page.
- The server's association file and the app's parsing must agree: a new path or query in the mailed link
  needs both changed, and a change to `APP_BASE_URL` to another host makes the app ignore the links.
- A link is not queued: it opens the sheet of the window the system hands it to, at once.
