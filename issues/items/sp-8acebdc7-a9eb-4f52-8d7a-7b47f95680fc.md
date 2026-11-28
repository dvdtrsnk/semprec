---
schemaVersion: 1
id: "sp-8acebdc7-a9eb-4f52-8d7a-7b47f95680fc"
title: "[internet-accounts] Throttle the Graph mail webhook per client address and look each subscription up once per batch"
kind: "implementation"
state: "closed"
stateReason: "completed"
labels: ["spec:approved"]
parent: "sp-85e6cbc4-7de7-4385-81a9-a493c421b817"
assignees: []
milestone: null
createdAt: "2026-11-22T06:52:47.527Z"
updatedAt: "2026-11-22T07:01:31.328Z"
closedAt: "2026-11-22T07:01:31.328Z"
source: null
approval: {"specSha256":"b99c4541555bbc31a249e00023cb817e0ea5c7d2a9e61be2efd6637f9e50d5b8","source":"repository","actor":"claude-delegated-by-david","at":"2026-11-22T06:52:48.432Z"}
resolution: {"pullRequests":[],"commit":"040d6eeffb0a669bd6cb899e796438b9a8bdbbf9","at":"2026-11-22T07:01:31.328Z"}
---
**Blocked by:** none
**Model tier:** medium

## Context

Model tier rationale: Applies an existing edge pattern (the per-address throttle and the batch dedupe of the Graph calendar webhook) to one more public listener.

Found in the end-to-end test campaign after PR #2089. `POST /api/mail/graph/webhook` (`createGraphWebhookRequestListener`, `services/alldots-api/src/graphWebhookHandler.ts`) is public and unauthenticated by design. Unlike the calendar webhooks and the mail OAuth callback (`createClientIpThrottle` in `app.ts`, `calendarWebhookHandlers.ts`, `mailOauthCallbackHandler.ts`) it has no per-address rate limit, and it runs `handleGraphChangeNotification` (a `route_graph_subscription` lookup plus a tenant transaction) once per entry of the batch, with no dedupe and no cap, so one 256 KiB POST can drive thousands of database round trips. This is edge hardening, not a change of Microsoft's behaviour.

Decision: every POST, the validation handshake included, counts under a new throttle action `mailWebhook` (300 per minute per client address, its own budget, so calendar notifications cannot starve mail ones) before the body or the database is read; over the limit it answers an empty 429 with `Retry-After`. The batch goes through the calendar webhook's `distinctGraphNotifications`, moved to a shared `graphNotificationBatch.ts`: the first 100 entries, each distinct `(subscriptionId, clientState)` pair once, at most 20 pairs, ids and client states bounded at 256 characters.

## Task

Load `io-hardening`, `testing`.

1. `clientIpThrottle.ts`: add `mailWebhook`.
2. Move the Graph batch parsing out of `calendarWebhookHandlers.ts` into `graphNotificationBatch.ts`; use it in `graphWebhookHandler.ts`.
3. `graphWebhookHandler.ts`: take `{ trustProxy, clientIpThrottle? }`, throttle first; `app.ts` passes `trustProxy`.
4. Tests in `__tests__/graphWebhookHandler.test.ts` and the limits table in `__tests__/clientIpThrottle.unit.test.ts`.
5. Update `docs/architecture/tenancy-and-security.md` (public throttles).

## Touches

- backend/services/alldots-api/src/clientIpThrottle.ts
- backend/services/alldots-api/src/graphNotificationBatch.ts
- backend/services/alldots-api/src/calendarWebhookHandlers.ts
- backend/services/alldots-api/src/graphWebhookHandler.ts
- backend/services/alldots-api/src/app.ts
- backend/services/alldots-api/src/__tests__/graphWebhookHandler.test.ts
- backend/services/alldots-api/src/__tests__/clientIpThrottle.unit.test.ts
- docs/architecture/tenancy-and-security.md

## Scope

### In scope

- The mail Graph webhook's per-address throttle and its per-batch lookup dedupe and cap.

### Out of scope

- The validation handshake's token length and headers, and `handleGraphChangeNotification` itself.

## Acceptance criteria

- Over its budget an address gets an empty 429 with `Retry-After` for a batch and for the handshake, without any database read.
- A batch with 60 repeats of one subscription and 30 distinct others does 20 `route_graph_subscription` lookups and queues the account's sync once.
- The existing mail and calendar webhook tests stay green.
