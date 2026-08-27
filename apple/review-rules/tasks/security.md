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
