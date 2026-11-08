Check for security vulnerabilities:

1. Hardcoded credentials, API keys, or tokens anywhere in the diff —
   critical.
2. A secret, token, or credential stored in `UserDefaults` or a plain file
   instead of Keychain — critical.
3. Disabled or weakened TLS/certificate validation (custom
   `URLSessionDelegate` accepting any certificate, ATS exceptions added
   without justification) — critical.
4. A secret, token, or credential value reaching a log call
   (`print`/`os_log`/analytics event) — high.
5. Missing authentication/authorization on a network call that previously
   required it — critical.
6. The App Sandbox entitlement removed from
   `Projects/App/Entitlements/Semprec.entitlements`, or the entitlements no
   longer applied to the macOS build — critical; an entitlement added that the
   linked issue's Task does not call for — high: each one widens what the app,
   and every dependency in it, can reach.
7. A URL scheme, universal link or other external entry point added without
   validating its input before it reaches navigation or data — high.
8. An implementation of the native-session bridge that departs from its
   contract in `docs/auth-bridge.md` — the token reaching the page other than
   through the bridge's reply, or the message handler registered on a web view
   other than the embedded editor's — critical.
