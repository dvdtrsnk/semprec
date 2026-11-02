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

## 2. Verification-owned mail connections and limited TLS diagnosis

The parent inspected the installed nodemailer public socket seam and the shared
policy factories. Gh-1569 cannot reconstruct certificate errors after they have
been erased, nor cancel an IMAP client before the helper returns it. Adopt
[[2026-11-02-mail-credential-verification-owns-bounded-policy-connections]]:
one closed verification path in the existing helper owner, preserving normal
sync/send/IDLE behavior and denied-address privacy. No new SMTP protocol,
private-library interception, global TLS patch or plaintext authentication.

This explicitly reconciles the original all-TLS-failures diagnosis: definite
machine-readable TLS/upgrade refusals map to mail_tls_failed; ambiguous socket
or TLS failures map to mail_server_unreachable. Both reject verification.
Candidate exhaustion prioritizes observed authentication, then definite TLS,
then unreachable. Real certificate/STARTTLS/timeout tests must assert the actual
supported category, not manufacture a lower-level error the library does not
provide. No claim of complete SMTP certificate diagnosis is accepted.

The 15-second whole-attempt limit includes DNS through authentication. The
helper owns cancellation, network teardown and guarded late completion. OS DNS
work may outlive the deadline but must be unable to dial; finite injected DNS
callbacks are settled before test seam restoration. A raced timeout without
owned closure and terminal settlement does not satisfy this decision.

Gh-1569 Touches adds mailServerConnections.ts and its existing test, providerTypes.ts
only for safe verification categories, adapter errorContract unit tests, and
publicSurface.test.ts only for deliberate new public verification/error exports.
Do not change unrelated stored state, outbound policy/resolution rules, default
timeouts or other adapter behavior. Original gh-1478 handover and accepted ADR
bodies remain immutable. This scope supersedes section 1's temporary hold for
these exact changes; all implementation/review/runtime gates remain required.

## 3. ImapFlow pre-connect cancellation ownership

The parent verified ImapFlow 1.7.6 clears its timer in close() before it has an
initialReject callback during pre-connect. Adopt the additive compatibility
decision [[2026-11-02-mail-verification-cancels-imap-through-owned-sockets]].
One checked read-only socket accessor, local to the existing verification
helper, captures actual Socket identities and terminal events. Cancellation
destroys that socket with a fixed owner error while library handlers remain,
awaits actual connect settlement and then performs final public close. Neither
an earlier inner timer nor ImapFlow's synchronous close event proves settlement.
No private-field writes, dependency patch, SMTP interception or new transport.

The parent library-only held-DNS diagnostic in private evidence is supporting
design evidence, not a production test or gate. Its delayed callback returns no
network address. The worker must exercise actual helper phases, late completion
and independent error outcomes before review. Normal adapters remain unchanged.
This adds only the new ADR to gh-1569 Touches; source/test paths already belong
to section 2. Embedded requirements stay complete; the aggregate's redundant
top-level Context alone is compressed to remain below its metadata size cap.
