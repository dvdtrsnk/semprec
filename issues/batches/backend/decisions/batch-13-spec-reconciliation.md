# Batch 13 specification reconciliation

## 1. Bounded OAuth rotation transaction exception

Owner-delegated controller thr_pz39tcih5r confirms gh-1481's explicit
credential-lock/exchange/persist transaction conflicts with the general
external-call bracketing ADR. Adopt the narrow additive decision
[[2026-11-02-mail-oauth-rotation-holds-the-credential-lock-through-refresh]].
The accepted historical ADR body is unchanged. This permits only the mail OAuth
refresh owner to hold its tenant credential lock across one bounded request;
it does not authorize arbitrary HTTP in transactions or change mail-thread
guards, SMTP sending, provider sync or approval ownership.

The waiter uses the committed replacement refresh credential in its own
exchange. There is no shared access-token cache. The at-most-once assertion is
for successful committed rotating generations, not repeated use of a valid
nonrotating token or recovery from an ambiguous provider/database outcome.
Preserve 400/401 reauthorization mapping; reject without returning an access
token on persistence/commit failure and retain the documented uncertainty.
No automatic replay, new schema or generic transaction mechanism is authorized.

Gh-1481 Touches now include the additive ADR and the existing
oauthTokenExchange.test.ts for its request deadline/body-cap evidence. Other
implementation and overlap evidence stays in mailOAuthAccess.test.ts. Verify
real runtime tenant isolation, both overlap orders, generation ordering,
independent progress, no return before commit and failure cleanup with owned
bounded resources. Deadline or cancellation alone is not settlement. Keep
secret/error/log assertions discriminating and live provider checks NOT RUN.

Gh-1569's verification-specific TLS classification, deadline and connection
ownership seam is a separate pending adjudication. This section grants no
change to mailServerConnections, default privacy mappings or helper lifecycle.
Continue unaffected member work while that decision is prepared.
