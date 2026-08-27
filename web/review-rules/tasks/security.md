Check for security vulnerabilities:

1. Hardcoded credentials, API keys, or tokens anywhere in the diff —
   critical.
2. User-controlled content rendered without sanitization (raw `innerHTML`,
   `dangerouslySetInnerHTML`, unescaped template interpolation into the
   DOM) — critical.
3. Missing input validation on a form or API call that trusts external
   input without parsing/validating it first — high.
4. A secret, token, or credential value reaching client-side code, a log
   call, or an error message shown to the user — high.
5. An authorization/session check missing on a page or action that
   previously required one — critical.
